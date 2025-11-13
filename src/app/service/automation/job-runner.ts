import { randomUUID } from 'crypto';
import { Repository } from 'typeorm';

import { chatCompletionByProjectModel } from '../controllers/chat-by-project-model.js';
import { ds } from '../db.js';
import { UserEntity, UserRole, UserRoleEntity } from '../entity/auth.entity.js';
import {
    AutomationJobEntity,
    AutomationJobStatus,
    AutomationJobTrigger,
    AutomationTaskEntity,
    AutomationTaskStatus,
    AutomationTaskType,
} from '../entity/automation.entity.js';
import {
    MessageEntity,
    MessageGroupEntity,
    ThreadEntity,
    ThreadGroupEntity,
} from '../entity/project-models.entity.js';
import { cloneTaskForExecution } from './job-manager.js';

const DEFAULT_POLL_INTERVAL_MS = 5000;
const DEFAULT_BATCH_SIZE = 5;
const DEFAULT_SYSTEM_IP = '127.0.0.1';
const DEFAULT_LEASE_DURATION_MS = 2 * 60 * 1000; // 2 minutes

type TaskExecutionResult = {
    status: AutomationTaskStatus;
    outputPreview?: string | null;
    tokens?: number | null;
    durationSeconds?: number | null;
    errorMessage?: string | null;
};

type UserExecutionContext = {
    userId: string;
    orgKey: string;
    name?: string;
    email: string;
    role: string;
    status: string;
    roleList: UserRole[];
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class AutomationJobRunner {
    private readonly pollIntervalMs: number;
    private readonly batchSize: number;
    private readonly leaseDurationMs: number;
    private timer?: NodeJS.Timeout;
    private polling = false;
    private readonly activeJobs = new Set<string>();

    constructor(options?: { pollIntervalMs?: number; batchSize?: number; leaseDurationMs?: number }) {
        this.pollIntervalMs = options?.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
        this.batchSize = options?.batchSize ?? DEFAULT_BATCH_SIZE;
        this.leaseDurationMs = options?.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS;
    }

    start(): void {
        if (this.timer) {
            return;
        }
        // Kick off immediately, then follow interval
        void this.poll();
        this.timer = setInterval(() => {
            void this.poll();
        }, this.pollIntervalMs);
    }

    stop(): void {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = undefined;
        }
    }

    private async poll(): Promise<void> {
        console.log(`[AutomationJobRunner] polling for jobs started ${new Date().toISOString()} ${this.polling}`);
        if (this.polling) {
            return;
        }
        if (!ds.isInitialized) {
            return;
        }
        this.polling = true;
        try {
            const jobRepo = ds.getRepository(AutomationJobEntity);
            const now = new Date();
            const candidateJobs = await jobRepo.createQueryBuilder('job')
                .where('((job.status = :running) OR (job.status = :pending AND job.trigger = :schedule))', {
                    running: AutomationJobStatus.Running,
                    pending: AutomationJobStatus.Pending,
                    schedule: AutomationJobTrigger.Schedule,
                })
                .andWhere('job.completedAt IS NULL')
                .andWhere('(job.leaseId IS NULL OR job.leaseExpiresAt <= :now)', { now })
                .orderBy('job.updatedAt', 'ASC')
                .limit(this.batchSize)
                .getMany();

            for (const candidate of candidateJobs) {
                if (this.activeJobs.has(candidate.id)) {
                    continue;
                }
                this.activeJobs.add(candidate.id);
                void this.prepareAndProcessJob(candidate).finally(() => {
                    this.activeJobs.delete(candidate.id);
                });
            }
        } catch (error) {
            console.error('[AutomationJobRunner] polling error', error);
        } finally {
            this.polling = false;
        }
    }

    private async prepareAndProcessJob(rawJob: AutomationJobEntity): Promise<void> {
        if (!ds.isInitialized) {
            return;
        }
        const leaseId = randomUUID();
        let claimedJob: AutomationJobEntity | null = null;
        try {
            claimedJob = await this.claimJob(rawJob, leaseId);
            if (!claimedJob) {
                return;
            }

            await this.processJob(claimedJob, leaseId);
        } catch (error) {
            console.error('[AutomationJobRunner] job preparation error', error);
        } finally {
            if (claimedJob) {
                await this.releaseLease(claimedJob, leaseId);
            }
        }
    }

    private async processJob(job: AutomationJobEntity, leaseId: string): Promise<void> {
        const jobRepo = ds.getRepository(AutomationJobEntity);
        const taskRepo = ds.getRepository(AutomationTaskEntity);

        const systemIp = job.updatedIp ?? job.createdIp ?? DEFAULT_SYSTEM_IP;
        const systemUser = job.updatedBy ?? job.createdBy;

        if (!(await this.ensureLease(job, leaseId))) {
            return;
        }

        const refreshedJob = await jobRepo.findOne({
            where: { orgKey: job.orgKey, id: job.id },
        });

        if (!refreshedJob || refreshedJob.leaseId !== leaseId) {
            return;
        }

        job = refreshedJob;

        if (job.status !== AutomationJobStatus.Running) {
            return;
        }

        if (!job.startedAt) {
            const startedAt = new Date();
            const runId = `run_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
            const updateResult = await jobRepo.createQueryBuilder()
                .update(AutomationJobEntity)
                .set({
                    startedAt,
                    lastRunId: runId,
                    updatedIp: systemIp,
                    updatedBy: systemUser,
                })
                .where('orgKey = :orgKey', { orgKey: job.orgKey })
                .andWhere('id = :id', { id: job.id })
                .andWhere('leaseId = :leaseId', { leaseId })
                .execute();

            if (!updateResult.affected) {
                return;
            }

            job.startedAt = startedAt;
            job.lastRunId = runId;
            job.updatedIp = systemIp;
            job.updatedBy = systemUser;
        }

        // テンプレートタスクを取得
        const templateTasks = await taskRepo.find({
            where: { orgKey: job.orgKey, jobId: job.id, taskType: AutomationTaskType.Template },
            order: { seq: 'ASC' },
        });

        let tasks: AutomationTaskEntity[];

        if (templateTasks.length > 0) {
            // 既に実行インスタンスが存在するかチェック
            const existingExecutionTasks = await taskRepo.find({
                where: { orgKey: job.orgKey, jobId: job.id, taskType: AutomationTaskType.Execution },
                order: { seq: 'ASC' },
            });

            if (existingExecutionTasks.length > 0) {
                // 既に実行インスタンスが存在する場合はそれを使用
                tasks = existingExecutionTasks;
            } else {
                // テンプレートから実行インスタンスを作成
                const executionTasks = await ds.transaction(async (manager) => {
                    const userContext = {
                        userId: systemUser,
                        orgKey: job.orgKey,
                        ip: systemIp,
                    };

                    const createdTasks: AutomationTaskEntity[] = [];
                    for (const templateTask of templateTasks) {
                        const threadGroup = await manager.findOne(ThreadGroupEntity, {
                            where: { orgKey: job.orgKey, id: templateTask.threadGroupId },
                        });

                        if (!threadGroup) {
                            console.error('[AutomationJobRunner] ThreadGroup not found for template task', {
                                jobId: job.id,
                                templateTaskId: templateTask.id,
                                threadGroupId: templateTask.threadGroupId,
                            });
                            continue;
                        }

                        const { task } = await cloneTaskForExecution(
                            templateTask,
                            threadGroup,
                            job.lastRunId || `run_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
                            userContext,
                            manager,
                        );
                        createdTasks.push(task);
                    }
                    return createdTasks;
                });

                tasks = executionTasks;
            }
        } else {
            // テンプレートがない場合は、従来通りデフォルトタスクを作成
            tasks = await taskRepo.find({
                where: { orgKey: job.orgKey, jobId: job.id },
                order: { createdAt: 'ASC' },
            });

            if (tasks.length === 0) {
                tasks = await this.createDefaultTasks(job, taskRepo, systemUser, systemIp);
            }
        }

        for (const task of tasks) {
            if (!(await this.ensureLease(job, leaseId))) {
                return;
            }

            if (![AutomationTaskStatus.Pending, AutomationTaskStatus.Running].includes(task.status)) {
                continue;
            }
            await this.runTask(job, task, taskRepo, systemUser, systemIp, leaseId);
        }

        // 実行インスタンスのタスクのみを再取得してチェック（テンプレートは除外）
        const executionTasks = templateTasks.length > 0
            ? await taskRepo.find({
                where: { orgKey: job.orgKey, jobId: job.id, taskType: AutomationTaskType.Execution },
            })
            : await taskRepo.find({
                where: { orgKey: job.orgKey, jobId: job.id },
            });

        const hasPending = executionTasks.some((task) =>
            [AutomationTaskStatus.Pending, AutomationTaskStatus.Running].includes(task.status)
        );
        if (hasPending) {
            return;
        }

        const freshJob = await jobRepo.findOne({
            where: { orgKey: job.orgKey, id: job.id },
        });

        if (!freshJob || freshJob.leaseId !== leaseId) {
            return;
        }

        if (freshJob.status !== AutomationJobStatus.Running) {
            // Respect external status changes (e.g. stop/cancel)
            await this.releaseLease(freshJob, leaseId);
            return;
        }

        const hasErrors = executionTasks.some((task) => task.status === AutomationTaskStatus.Error);
        const hasStops = executionTasks.some((task) => task.status === AutomationTaskStatus.Stopped);
        const now = new Date();
        const durationSeconds = job.startedAt
            ? Math.max(0, Math.round((now.getTime() - job.startedAt.getTime()) / 1000))
            : null;
        const status = hasStops
            ? AutomationJobStatus.Stopped
            : hasErrors
                ? AutomationJobStatus.Error
                : AutomationJobStatus.Completed;

        const finalizeResult = await jobRepo.createQueryBuilder()
            .update(AutomationJobEntity)
            .set({
                completedAt: now,
                durationSeconds,
                status,
                updatedBy: systemUser,
                updatedIp: systemIp,
                estimatedCostUsd: this.calculateEstimatedCost(executionTasks),
                leaseId: null,
                leaseExpiresAt: null,
            })
            .where('orgKey = :orgKey', { orgKey: job.orgKey })
            .andWhere('id = :id', { id: job.id })
            .andWhere('leaseId = :leaseId', { leaseId })
            .execute();

        if (!finalizeResult.affected) {
            return;
        }
    }

    private computeLeaseExpiry(): Date {
        return new Date(Date.now() + this.leaseDurationMs);
    }

    private async claimJob(rawJob: AutomationJobEntity, leaseId: string): Promise<AutomationJobEntity | null> {
        const jobRepo = ds.getRepository(AutomationJobEntity);
        const leaseExpiresAt = this.computeLeaseExpiry();
        const now = new Date();

        const updatePayload: Record<string, unknown> = {
            leaseId,
            leaseExpiresAt,
        };

        if (rawJob.status === AutomationJobStatus.Pending && rawJob.trigger === AutomationJobTrigger.Schedule) {
            updatePayload.status = AutomationJobStatus.Running;
            updatePayload.updatedBy = rawJob.updatedBy ?? rawJob.createdBy;
            updatePayload.updatedIp = rawJob.updatedIp ?? rawJob.createdIp ?? DEFAULT_SYSTEM_IP;
        }

        try {
            const result = await jobRepo.createQueryBuilder()
                .update(AutomationJobEntity)
                .set(updatePayload as any)
                .where('orgKey = :orgKey', { orgKey: rawJob.orgKey })
                .andWhere('id = :id', { id: rawJob.id })
                .andWhere('completedAt IS NULL')
                .andWhere('(leaseId IS NULL OR leaseExpiresAt <= :now)', { now })
                .andWhere(
                    '(status = :running OR (status = :pending AND trigger = :schedule))',
                    {
                        running: AutomationJobStatus.Running,
                        pending: AutomationJobStatus.Pending,
                        schedule: AutomationJobTrigger.Schedule,
                    },
                )
                .execute();

            if (!result.affected) {
                return null;
            }

            const claimedJob = await jobRepo.findOne({
                where: { orgKey: rawJob.orgKey, id: rawJob.id },
            });

            if (!claimedJob) {
                return null;
            }

            claimedJob.leaseId = leaseId;
            claimedJob.leaseExpiresAt = leaseExpiresAt;
            return claimedJob;
        } catch (error) {
            console.error('[AutomationJobRunner] failed to claim job', { jobId: rawJob.id, error });
            return null;
        }
    }

    private async ensureLease(job: AutomationJobEntity, leaseId: string): Promise<boolean> {
        if (job.leaseId !== leaseId) {
            return false;
        }

        const jobRepo = ds.getRepository(AutomationJobEntity);
        const now = Date.now();
        const currentExpiry = job.leaseExpiresAt?.getTime();
        const refreshThreshold = now + Math.floor(this.leaseDurationMs / 2);

        if (currentExpiry && currentExpiry > refreshThreshold) {
            return true;
        }

        const leaseExpiresAt = this.computeLeaseExpiry();
        try {
            const result = await jobRepo.createQueryBuilder()
                .update(AutomationJobEntity)
                .set({ leaseExpiresAt })
                .where('orgKey = :orgKey', { orgKey: job.orgKey })
                .andWhere('id = :id', { id: job.id })
                .andWhere('leaseId = :leaseId', { leaseId })
                .execute();

            if (!result.affected) {
                return false;
            }

            job.leaseExpiresAt = leaseExpiresAt;
            return true;
        } catch (error) {
            console.error('[AutomationJobRunner] failed to refresh lease', { jobId: job.id, error });
            return false;
        }
    }

    private async releaseLease(job: AutomationJobEntity, leaseId: string): Promise<void> {
        const jobRepo = ds.getRepository(AutomationJobEntity);
        try {
            await jobRepo.createQueryBuilder()
                .update(AutomationJobEntity)
                .set({
                    leaseId: null,
                    leaseExpiresAt: null,
                })
                .where('orgKey = :orgKey', { orgKey: job.orgKey })
                .andWhere('id = :id', { id: job.id })
                .andWhere('leaseId = :leaseId', { leaseId })
                .execute();
        } catch (error) {
            console.error('[AutomationJobRunner] failed to release lease', { jobId: job.id, error });
        }
    }

    private async createDefaultTasks(
        job: AutomationJobEntity,
        taskRepo: Repository<AutomationTaskEntity>,
        systemUser: string,
        systemIp: string,
    ): Promise<AutomationTaskEntity[]> {
        const previewSource = job.promptTemplate || job.snapshotPrompt || job.name;
        const task = taskRepo.create({
            orgKey: job.orgKey,
            projectId: job.projectId,
            jobId: job.id,
            status: AutomationTaskStatus.Pending,
            inputPreview: previewSource ? previewSource.slice(0, 180) : `Job ${job.name}`,
            createdBy: systemUser,
            updatedBy: systemUser,
            createdIp: systemIp,
            updatedIp: systemIp,
        });

        try {
            const saved = await taskRepo.save(task);
            return [saved];
        } catch (error) {
            console.error('[AutomationJobRunner] failed to seed tasks', { jobId: job.id, error });
            return [];
        }
    }

    private async runTask(
        job: AutomationJobEntity,
        task: AutomationTaskEntity,
        taskRepo: Repository<AutomationTaskEntity>,
        systemUser: string,
        systemIp: string,
        leaseId: string,
    ): Promise<void> {
        const start = Date.now();
        const maxRetries = job.retryLimit ?? 0;
        let attemptCount = 0;
        let lastError: Error | null = null;

        while (attemptCount <= maxRetries) {
            if (!(await this.ensureLease(job, leaseId))) {
                return;
            }

            try {
                await taskRepo.update(
                    { orgKey: task.orgKey, id: task.id },
                    {
                        status: AutomationTaskStatus.Running,
                        updatedBy: systemUser,
                        updatedIp: systemIp,
                    },
                );

                const result = await this.executeTask(job, task);
                const elapsedSeconds = Math.max(0.1, (Date.now() - start) / 1000);
                await this.ensureLease(job, leaseId);

                await taskRepo.update(
                    { orgKey: task.orgKey, id: task.id },
                    {
                        status: result.status,
                        outputPreview: result.outputPreview ?? task.outputPreview ?? undefined,
                        tokens: result.tokens ?? task.tokens ?? 0,
                        durationSeconds: result.durationSeconds ?? Number(elapsedSeconds.toFixed(2)),
                        errorMessage: result.errorMessage ?? undefined,
                        updatedBy: systemUser,
                        updatedIp: systemIp,
                    },
                );

                // Success - exit retry loop
                if (result.status === AutomationTaskStatus.Completed) {
                    return;
                }

                // Task returned error status
                lastError = new Error(result.errorMessage ?? 'Task execution failed');
                attemptCount++;

                if (attemptCount <= maxRetries) {
                    console.warn('[AutomationJobRunner] task failed, retrying', {
                        jobId: job.id,
                        taskId: task.id,
                        attempt: attemptCount,
                        maxRetries,
                    });
                    await sleep(Math.min(30000, 1000 * Math.pow(2, attemptCount - 1))); // Exponential backoff
                }
            } catch (error) {
                await this.ensureLease(job, leaseId);
                lastError = error instanceof Error ? error : new Error('Unknown error');
                attemptCount++;

                console.error('[AutomationJobRunner] task execution error', {
                    jobId: job.id,
                    taskId: task.id,
                    attempt: attemptCount,
                    maxRetries,
                    error: lastError,
                });

                if (attemptCount <= maxRetries) {
                    await sleep(Math.min(30000, 1000 * Math.pow(2, attemptCount - 1))); // Exponential backoff
                }
            }
        }

        // All retries exhausted
        const elapsedSeconds = Math.max(0.1, (Date.now() - start) / 1000);
        if (!(await this.ensureLease(job, leaseId))) {
            return;
        }
        await taskRepo.update(
            { orgKey: task.orgKey, id: task.id },
            {
                status: AutomationTaskStatus.Error,
                errorMessage: lastError?.message ?? 'Unknown error after retries',
                durationSeconds: Number(elapsedSeconds.toFixed(2)),
                updatedBy: systemUser,
                updatedIp: systemIp,
            },
        );
    }

    private async executeTask(job: AutomationJobEntity, task: AutomationTaskEntity): Promise<TaskExecutionResult> {
        // Execute task with the execution user's permissions
        const executionUserId = job.executionUserId;
        if (!executionUserId) {
            throw new Error('Job execution user not found');
        }

        // Load user context for execution
        const userContext = await this.loadUserContext(job.orgKey, executionUserId);
        if (!userContext) {
            throw new Error(`Execution user not found: ${executionUserId}`);
        }

        // Execute task with user's context
        return await this.runTaskWithUserContext(job, task, userContext);
    }

    private async loadUserContext(orgKey: string, userId: string): Promise<UserExecutionContext | null> {
        try {
            const userRepo = ds.getRepository(UserEntity);
            const user = await userRepo.findOne({
                where: { orgKey, id: userId },
            });

            if (!user) {
                console.error('[AutomationJobRunner] User not found', { orgKey, userId });
                return null;
            }

            const roles = await ds.getRepository(UserRoleEntity).find({
                where: { orgKey, userId: user.id },
            });

            return {
                userId: user.id,
                orgKey: user.orgKey,
                name: user.name,
                email: user.email,
                role: user.role,
                status: user.status,
                roleList: roles,
            };
        } catch (error) {
            console.error('[AutomationJobRunner] Failed to load user context', { orgKey, userId, error });
            return null;
        }
    }

    private async runTaskWithUserContext(
        job: AutomationJobEntity,
        task: AutomationTaskEntity,
        userContext: UserExecutionContext,
    ): Promise<TaskExecutionResult> {
        try {
            const startTime = Date.now();

            // 1. ThreadGroupからThread、MessageGroup、Messageを取得
            const threadGroup = await ds.getRepository(ThreadGroupEntity).findOne({
                where: { orgKey: userContext.orgKey, id: task.threadGroupId },
            });

            if (!threadGroup) {
                throw new Error(`ThreadGroup not found: ${task.threadGroupId}`);
            }

            const threads = await ds.getRepository(ThreadEntity).find({
                where: { orgKey: userContext.orgKey, threadGroupId: threadGroup.id },
                order: { seq: 'ASC' },
            });

            if (threads.length === 0) {
                throw new Error(`No threads found for ThreadGroup: ${threadGroup.id}`);
            }

            const thread = threads[0];

            const messageGroups = await ds.getRepository(MessageGroupEntity).find({
                where: { orgKey: userContext.orgKey, threadId: thread.id },
                order: { seq: 'ASC' },
            });

            if (messageGroups.length === 0) {
                throw new Error(`No message groups found for Thread: ${thread.id}`);
            }

            const lastMessageGroup = messageGroups[messageGroups.length - 1];
            const messages = await ds.getRepository(MessageEntity).find({
                where: { orgKey: userContext.orgKey, messageGroupId: lastMessageGroup.id },
                order: { seq: 'DESC' },
            });

            if (messages.length === 0) {
                throw new Error('No messages found in last message group');
            }

            const lastMessage = messages[0];

            // 2. chatCompletionByProjectModel配列の最後のハンドラーを取得
            const handler = chatCompletionByProjectModel[chatCompletionByProjectModel.length - 1] as (req: any, res: any) => Promise<void>;

            // 3. モックのreq/resオブジェクトを作成
            const connectionId = task.id;
            const streamId = randomUUID();

            const mockReq = {
                query: {
                    connectionId,
                    streamId,
                    type: 'message',
                    id: lastMessage.id,
                },
                body: {
                    toolCallPartCommandList: [],
                    options: { labelPrefix: `task` },
                },
                info: {
                    user: {
                        id: userContext.userId,
                        orgKey: userContext.orgKey,
                        email: userContext.email,
                        role: userContext.role,
                        status: userContext.status,
                        roleList: userContext.roleList,
                    },
                    ip: DEFAULT_SYSTEM_IP,
                },
            };

            let capturedResponse = '';
            let capturedTokens = 0;

            const mockRes = {
                writeHead: (_statusCode: number, _headers?: any) => {
                    // ストリーミングヘッダーを無視
                },
                write: (chunk: any) => {
                    // ストリーミングデータを蓄積
                    if (typeof chunk === 'string') {
                        capturedResponse += chunk;
                    } else if (Buffer.isBuffer(chunk)) {
                        capturedResponse += chunk.toString('utf-8');
                    }
                },
                end: (data?: any) => {
                    if (data) {
                        if (typeof data === 'string') {
                            capturedResponse += data;
                        } else if (Buffer.isBuffer(data)) {
                            capturedResponse += data.toString('utf-8');
                        }
                    }
                },
                setHeader: (_name: string, _value: string) => {
                    // ヘッダーを無視
                },
                status: (_code: number) => mockRes,
                json: (_data: any) => mockRes,
                set: (_field: any, _value: any) => mockRes,
            };

            // 4. ハンドラーを呼び出し
            await handler(mockReq, mockRes);

            // 5. レスポンスからデータを抽出
            // ストリーミングレスポンスを行ごとにパース
            const lines = capturedResponse.split('\n').filter(line => line.trim());
            let fullText = '';

            for (const line of lines) {
                if (line.startsWith('data: ')) {
                    const jsonStr = line.substring(6);
                    if (jsonStr === '[DONE]') {
                        break;
                    }
                    try {
                        const chunk = JSON.parse(jsonStr);
                        if (chunk.choices?.[0]?.delta?.content) {
                            fullText += chunk.choices[0].delta.content;
                        }
                        if (chunk.usage?.total_tokens) {
                            capturedTokens = chunk.usage.total_tokens;
                        }
                    } catch (e) {
                        // JSON parse error - skip
                    }
                }
            }

            const durationSeconds = (Date.now() - startTime) / 1000;

            console.log('[AutomationJobRunner] Task executed successfully', {
                jobId: job.id,
                taskId: task.id,
                userId: userContext.userId,
                tokens: capturedTokens,
                outputLength: fullText.length,
            });

            return {
                status: AutomationTaskStatus.Completed,
                outputPreview: fullText.slice(0, 500),
                tokens: capturedTokens,
                durationSeconds,
            };
        } catch (error) {
            console.error('[AutomationJobRunner] Task execution failed', {
                jobId: job.id,
                taskId: task.id,
                error,
            });

            return {
                status: AutomationTaskStatus.Error,
                errorMessage: error instanceof Error ? error.message : 'Unknown error',
                durationSeconds: 0,
            };
        }
    }

    private calculateEstimatedCost(tasks: AutomationTaskEntity[]): string | null {
        const totalTokens = tasks.reduce((sum, task) => sum + (task.tokens ?? 0), 0);
        if (totalTokens === 0) {
            return '0';
        }
        // Simple heuristic: $0.000002 per token (~$0.002 per 1K tokens)
        const cost = totalTokens * 0.000002;
        return cost.toFixed(4);
    }
}

export const automationJobRunner = new AutomationJobRunner();

import { Request, Response } from 'express';
import { body, param, query } from 'express-validator';
import { In, MoreThanOrEqual, Not } from 'typeorm';

import { ds } from '../db.js';
import {
    AutomationJobEntity,
    AutomationJobStatus,
    AutomationJobTrigger,
    AutomationTaskEntity,
    AutomationTaskStatus,
} from '../entity/automation.entity.js';
import { ProjectEntity, TeamMemberEntity } from '../entity/project-models.entity.js';
import { validationErrorHandler } from '../middleware/validation.js';
import { UserRequest } from '../models/info.js';
import { ProjectStatus, ProjectVisibility } from '../models/values.js';
import { createTaskTemplate } from '../automation/job-manager.js';

const MAX_PAGE_SIZE = 100;

const JOB_SORT_FIELDS: Record<string, keyof AutomationJobEntity | 'startedAt' | 'name' | 'status' | 'createdAt' | 'updatedAt' | 'estimatedCostUsd'> = {
    startedAt: 'startedAt',
    name: 'name',
    status: 'status',
    createdAt: 'createdAt',
    updatedAt: 'updatedAt',
    estimatedCostUsd: 'estimatedCostUsd',
};

const ACTION_STATUS_MAP: Record<string, AutomationJobStatus> = {
    stop: AutomationJobStatus.Stopped,
    cancel: AutomationJobStatus.Stopped,
    resume: AutomationJobStatus.Running,
};

const DAY_IN_MS = 24 * 60 * 60 * 1000;

const loadAccessibleProjectIds = async (req: UserRequest): Promise<string[]> => {
    const orgKey = req.info.user.orgKey;
    const userId = req.info.user.id;

    const membershipList = await ds.getRepository(TeamMemberEntity).find({
        select: ['teamId'],
        where: { orgKey, userId },
    });
    const teamIds = [...new Set(membershipList.map((member) => member.teamId))];

    const projectWhere: Array<Record<string, unknown>> = [
        { orgKey, visibility: ProjectVisibility.Public, status: Not(ProjectStatus.Deleted) },
        { orgKey, visibility: ProjectVisibility.Login, status: Not(ProjectStatus.Deleted) },
    ];

    if (teamIds.length > 0) {
        projectWhere.push({
            orgKey,
            teamId: In(teamIds),
            status: Not(ProjectStatus.Deleted),
        });
    }

    const projects = await ds.getRepository(ProjectEntity).find({
        select: ['id'],
        where: projectWhere,
    });

    return [...new Set(projects.map((project) => project.id))];
};

const verifyProjectAccess = async (req: UserRequest, projectId: string) => {
    const orgKey = req.info.user.orgKey;
    const project = await ds.getRepository(ProjectEntity).findOne({
        select: ['id', 'teamId', 'visibility', 'status'],
        where: { orgKey, id: projectId },
    });

    if (!project || project.status === ProjectStatus.Deleted) {
        return {
            ok: false as const,
            status: 404,
            error: {
                code: 'PROJECT_NOT_FOUND',
                message: 'Project not found',
                details: [],
            },
        };
    }

    if (project.visibility === ProjectVisibility.Public || project.visibility === ProjectVisibility.Login) {
        return { ok: true as const, project };
    }

    const membership = await ds.getRepository(TeamMemberEntity).findOne({
        select: ['id'],
        where: { orgKey, teamId: project.teamId, userId: req.info.user.id },
    });

    if (!membership) {
        return {
            ok: false as const,
            status: 403,
            error: {
                code: 'PROJECT_FORBIDDEN',
                message: 'Forbidden',
                details: [],
            },
        };
    }

    return { ok: true as const, project };
};

const isAutomationJobStatus = (value: unknown): value is AutomationJobStatus =>
    typeof value === 'string' && Object.values(AutomationJobStatus).includes(value as AutomationJobStatus);

const isAutomationTaskStatus = (value: unknown): value is AutomationTaskStatus =>
    typeof value === 'string' && Object.values(AutomationTaskStatus).includes(value as AutomationTaskStatus);

const toDurationHuman = (seconds?: number | null): string | undefined => {
    if (seconds == null || Number.isNaN(seconds)) {
        return undefined;
    }
    const totalSeconds = Math.floor(seconds);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const secs = totalSeconds % 60;
    const parts = [];
    if (hours > 0) parts.push(`${hours}h`);
    if (minutes > 0 || hours > 0) parts.push(`${minutes}m`);
    parts.push(`${secs}s`);
    return parts.join(' ');
};

const parseStatusList = (value: unknown): AutomationJobStatus[] => {
    if (value === undefined || value === null) {
        return [];
    }
    const rawList = Array.isArray(value) ? value : `${value}`.split(',');
    return rawList
        .map((item) => `${item}`.trim())
        .filter((item): item is AutomationJobStatus => isAutomationJobStatus(item));
};

const parseTaskStatusList = (value: unknown): AutomationTaskStatus[] => {
    if (value === undefined || value === null) {
        return [];
    }
    const rawList = Array.isArray(value) ? value : `${value}`.split(',');
    return rawList
        .map((item) => `${item}`.trim())
        .filter((item): item is AutomationTaskStatus => isAutomationTaskStatus(item));
};

const buildSnapshotParameters = (job: AutomationJobEntity) => {
    if (job.snapshotParameters && Object.keys(job.snapshotParameters).length > 0) {
        return job.snapshotParameters;
    }
    const parameters: Record<string, unknown> = {
        parallel: job.parallelism,
        retry: job.retryLimit,
    };
    if (job.schedule) {
        parameters.schedule = job.schedule;
    }
    if (job.input) {
        parameters.input = job.input;
    }
    return parameters;
};

const buildJobDetailResponse = async (job: AutomationJobEntity, orgKey: string) => {
    const taskTotals = await ds.getRepository(AutomationTaskEntity)
        .createQueryBuilder('task')
        .select('COUNT(*)', 'total')
        .addSelect(`SUM(CASE WHEN task.status = :completed THEN 1 ELSE 0 END)`, 'completed')
        .addSelect(`SUM(CASE WHEN task.status = :error THEN 1 ELSE 0 END)`, 'errors')
        .where('task.orgKey = :orgKey', { orgKey })
        .andWhere('task.jobId = :jobId', { jobId: job.id })
        .setParameters({
            completed: AutomationTaskStatus.Completed,
            error: AutomationTaskStatus.Error,
        })
        .getRawOne<{ total: string | null; completed: string | null; errors: string | null }>();

    const totalTasks = Number(taskTotals?.total ?? 0);
    const completedTasks = Number(taskTotals?.completed ?? 0);
    const errorTasks = Number(taskTotals?.errors ?? 0);

    return {
        jobId: job.id,
        name: job.name,
        status: job.status,
        trigger: job.trigger,
        startedAt: job.startedAt ? job.startedAt.toISOString() : null,
        durationSeconds: job.durationSeconds ?? null,
        durationHuman: toDurationHuman(job.durationSeconds) ?? null,
        projectId: job.projectId,
        model: job.model ?? null,
        totals: {
            tasks: totalTasks,
            completed: completedTasks,
            errors: errorTasks,
            costUsd: Number(job.estimatedCostUsd ?? 0),
        },
        snapshot: {
            prompt: job.snapshotPrompt ?? job.promptTemplate ?? '',
            parameters: buildSnapshotParameters(job),
        },
        lastRunId: job.lastRunId ?? null,
    };
};

export const getAutomationJobsSummary = [
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        const orgKey = req.info.user.orgKey;
        const accessibleProjectIds = await loadAccessibleProjectIds(req);

        if (accessibleProjectIds.length === 0) {
            res.json({
                runningJobs: 0,
                pendingJobs: 0,
                completedJobsToday: 0,
                errorsLast24h: 0,
                estimatedCostTodayUsd: 0,
            });
            return;
        }

        const jobRepo = ds.getRepository(AutomationJobEntity);
        const now = new Date();
        const startOfToday = new Date(now);
        startOfToday.setHours(0, 0, 0, 0);

        const [
            runningJobs,
            pendingJobs,
            completedJobsToday,
            errorsLast24h,
            costRow,
        ] = await Promise.all([
            jobRepo.count({ where: { orgKey, status: AutomationJobStatus.Running, projectId: In(accessibleProjectIds) } }),
            jobRepo.count({ where: { orgKey, status: AutomationJobStatus.Pending, projectId: In(accessibleProjectIds) } }),
            jobRepo.count({
                where: {
                    orgKey,
                    status: AutomationJobStatus.Completed,
                    completedAt: MoreThanOrEqual(startOfToday),
                    projectId: In(accessibleProjectIds),
                },
            }),
            jobRepo.count({
                where: {
                    orgKey,
                    status: AutomationJobStatus.Error,
                    updatedAt: MoreThanOrEqual(new Date(now.getTime() - DAY_IN_MS)),
                    projectId: In(accessibleProjectIds),
                },
            }),
            jobRepo
                .createQueryBuilder('job')
                .select('COALESCE(SUM(job.estimatedCostUsd), 0)', 'sum')
                .where('job.orgKey = :orgKey', { orgKey })
                .andWhere('job.projectId IN (:...projectIds)', { projectIds: accessibleProjectIds })
                .andWhere('job.startedAt >= :startOfToday', { startOfToday })
                .getRawOne<{ sum: string }>(),
        ]);

        res.json({
            runningJobs,
            pendingJobs,
            completedJobsToday,
            errorsLast24h,
            estimatedCostTodayUsd: Number(costRow?.sum ?? 0),
        });
    },
];

export const getAutomationJobs = [
    query('page').optional().isInt({ min: 1 }).toInt(),
    query('pageSize').optional().isInt({ min: 1, max: MAX_PAGE_SIZE }).toInt(),
    query('trigger').optional().isString(),
    query('sort').optional().isString(),
    query('search').optional().isString(),
    query('projectId').optional().isUUID(),
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        const orgKey = req.info.user.orgKey;

        const page = (req.query.page as number | undefined) ?? 1;
        const pageSize = (req.query.pageSize as number | undefined) ?? 25;
        const triggerParam = req.query.trigger as string | undefined;
        const search = req.query.search as string | undefined;
        const sortParamRaw = req.query.sort as string | undefined;
        const statusList = parseStatusList(req.query.status);
        const projectIdFilter = req.query.projectId as string | undefined;

        const accessibleProjectIds = await loadAccessibleProjectIds(req);

        let projectIdsForQuery = accessibleProjectIds;
        if (projectIdFilter) {
            const accessCheck = await verifyProjectAccess(req, projectIdFilter);
            if (!accessCheck.ok) {
                res.status(accessCheck.status).json(accessCheck.error);
                return;
            }
            projectIdsForQuery = [projectIdFilter];
        }

        if (projectIdsForQuery.length === 0) {
            res.json({
                items: [],
                pagination: {
                    page,
                    pageSize,
                    totalItems: 0,
                    totalPages: 0,
                },
            });
            return;
        }

        const jobRepo = ds.getRepository(AutomationJobEntity);
        const qb = jobRepo.createQueryBuilder('job')
            .where('job.orgKey = :orgKey', { orgKey });

        if (statusList.length > 0) {
            qb.andWhere('job.status IN (:...statusList)', { statusList });
        }

        if (triggerParam && Object.values(AutomationJobTrigger).includes(triggerParam as AutomationJobTrigger)) {
            qb.andWhere('job.trigger = :trigger', { trigger: triggerParam });
        }

        if (search) {
            qb.andWhere('(job.name ILIKE :search OR job.id::text ILIKE :search)', { search: `%${search}%` });
        }

        if (projectIdsForQuery.length === 1) {
            qb.andWhere('job.projectId = :projectId', { projectId: projectIdsForQuery[0] });
        } else {
            qb.andWhere('job.projectId IN (:...projectIds)', { projectIds: projectIdsForQuery });
        }

        if (sortParamRaw) {
            const [field, directionRaw] = sortParamRaw.split(':');
            const normalizedField = field?.trim();
            const normalizedDirection = directionRaw?.toLowerCase() === 'asc' ? 'ASC' : 'DESC';
            const sortField = normalizedField && JOB_SORT_FIELDS[normalizedField];
            if (sortField) {
                qb.orderBy(`job.${sortField}`, normalizedDirection);
            }
        }

        if (!qb.expressionMap.orderBys || Object.keys(qb.expressionMap.orderBys).length === 0) {
            qb.orderBy('job.updatedAt', 'DESC');
        }

        qb.skip((page - 1) * pageSize).take(pageSize);

        const [jobs, totalItems] = await qb.getManyAndCount();
        const jobIds = jobs.map((job) => job.id);

        const taskStats = jobIds.length > 0
            ? await ds.getRepository(AutomationTaskEntity)
                .createQueryBuilder('task')
                .select('task.jobId', 'jobId')
                .addSelect('COUNT(*)', 'total')
                .addSelect(`SUM(CASE WHEN task.status = :completed THEN 1 ELSE 0 END)`, 'completed')
                .addSelect(`SUM(CASE WHEN task.status = :error THEN 1 ELSE 0 END)`, 'errors')
                .where('task.orgKey = :orgKey', { orgKey })
                .andWhere('task.jobId IN (:...jobIds)', { jobIds })
                .groupBy('task.jobId')
                .setParameters({
                    completed: AutomationTaskStatus.Completed,
                    error: AutomationTaskStatus.Error,
                })
                .getRawMany<{ jobId: string; total: string | null; completed: string | null; errors: string | null }>()
            : [];

        const statsMap = new Map<string, { total: number; completed: number; errors: number }>();
        for (const stat of taskStats) {
            statsMap.set(stat.jobId, {
                total: Number(stat.total ?? 0),
                completed: Number(stat.completed ?? 0),
                errors: Number(stat.errors ?? 0),
            });
        }

        const items = jobs.map((job) => {
            const stats = statsMap.get(job.id) ?? { total: 0, completed: 0, errors: 0 };
            const percent = stats.total > 0 ? Math.round((stats.completed / stats.total) * 100) : 0;
            return {
                id: job.id,
                projectId: job.projectId,
                name: job.name,
                status: job.status,
                trigger: job.trigger,
                startedAt: job.startedAt ? job.startedAt.toISOString() : null,
                durationSeconds: job.durationSeconds ?? null,
                durationHuman: toDurationHuman(job.durationSeconds),
                progress: {
                    current: stats.completed,
                    total: stats.total,
                    percent,
                },
                lastRunId: job.lastRunId ?? null,
                estimatedCostUsd: Number(job.estimatedCostUsd ?? 0),
            };
        });

        res.json({
            items,
            pagination: {
                page,
                pageSize,
                totalItems,
                totalPages: Math.ceil(totalItems / pageSize),
            },
        });
    },
];

export const getAutomationJob = [
    param('jobId').isUUID(),
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        const orgKey = req.info.user.orgKey;
        const jobId = req.params.jobId;

        const job = await ds.getRepository(AutomationJobEntity).findOne({
            where: { orgKey, id: jobId },
        });

        if (!job) {
            res.status(404).json({
                code: 'AUTOMATION_JOB_NOT_FOUND',
                message: 'Automation job not found',
                details: [],
            });
            return;
        }

        const projectAccess = await verifyProjectAccess(req, job.projectId);
        if (!projectAccess.ok) {
            res.status(projectAccess.status).json(projectAccess.error);
            return;
        }

        const detail = await buildJobDetailResponse(job, orgKey);
        res.json(detail);
    },
];

export const getAutomationJobTasks = [
    param('jobId').isUUID(),
    query('page').optional().isInt({ min: 1 }).toInt(),
    query('pageSize').optional().isInt({ min: 1, max: MAX_PAGE_SIZE }).toInt(),
    query('status').optional(),
    query('search').optional().isString(),
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        const orgKey = req.info.user.orgKey;
        const jobId = req.params.jobId;
        const page = (req.query.page as number | undefined) ?? 1;
        const pageSize = (req.query.pageSize as number | undefined) ?? 50;
        const search = req.query.search as string | undefined;
        const statusList = parseTaskStatusList(req.query.status);

        const job = await ds.getRepository(AutomationJobEntity).findOne({
            where: { orgKey, id: jobId },
        });
        if (!job) {
            res.status(404).json({
                code: 'AUTOMATION_JOB_NOT_FOUND',
                message: 'Automation job not found',
                details: [],
            });
            return;
        }

        const projectAccess = await verifyProjectAccess(req, job.projectId);
        if (!projectAccess.ok) {
            res.status(projectAccess.status).json(projectAccess.error);
            return;
        }

        const taskRepo = ds.getRepository(AutomationTaskEntity);
        const qb = taskRepo.createQueryBuilder('task')
            .where('task.orgKey = :orgKey', { orgKey })
            .andWhere('task.jobId = :jobId', { jobId });

        if (statusList.length > 0) {
            qb.andWhere('task.status IN (:...statusList)', { statusList });
        }

        if (search) {
            qb.andWhere(
                '(task.inputPreview ILIKE :search OR task.outputPreview ILIKE :search OR task.id::text ILIKE :search)',
                { search: `%${search}%` },
            );
        }

        qb.orderBy('task.createdAt', 'DESC')
            .skip((page - 1) * pageSize)
            .take(pageSize);

        const [tasks, totalItems] = await qb.getManyAndCount();

        const items = tasks.map((task) => ({
            taskId: task.id,
            status: task.status,
            inputPreview: task.inputPreview ?? '',
            outputPreview: task.outputPreview ?? null,
            tokens: task.tokens ?? 0,
            durationSeconds: task.durationSeconds ?? 0,
            ...(task.errorMessage ? { errorMessage: task.errorMessage } : {}),
        }));

        res.json({
            items,
            pagination: {
                page,
                pageSize,
                totalItems,
                totalPages: Math.ceil(totalItems / pageSize),
            },
        });
    },
];

export const createAutomationJob = [
    body('name').isString().notEmpty(),
    body('description').optional().isString(),
    body('trigger').isIn(Object.values(AutomationJobTrigger)),
    body('schedule').optional().isObject(),
    body('model').isObject(),
    body('model.provider').isString().notEmpty(),
    body('model.modelId').isString().notEmpty(),
    body('promptTemplate').isString().notEmpty(),
    body('input').optional().isObject(),
    body('parallelism').optional().isInt({ min: 1 }).toInt(),
    body('retryLimit').optional().isInt({ min: 0 }).toInt(),
    body('projectId').isUUID(),
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        const orgKey = req.info.user.orgKey;
        const userId = req.info.user.id;
        const bodyPayload = req.body;

        if (bodyPayload.trigger === AutomationJobTrigger.Schedule) {
            if (!bodyPayload.schedule || typeof bodyPayload.schedule.cron !== 'string' || typeof bodyPayload.schedule.timezone !== 'string') {
                res.status(400).json({
                    code: 'INVALID_SCHEDULE_PAYLOAD',
                    message: 'Schedule payload is required when trigger is schedule.',
                    details: [],
                });
                return;
            }
        }

        if (bodyPayload.input?.source === 'upload' && typeof bodyPayload.input.fileId !== 'string') {
            res.status(400).json({
                code: 'INVALID_INPUT_PAYLOAD',
                message: 'fileId is required when input source is upload.',
                details: [],
            });
            return;
        }

        const projectAccess = await verifyProjectAccess(req, bodyPayload.projectId);
        if (!projectAccess.ok) {
            res.status(projectAccess.status).json(projectAccess.error);
            return;
        }

        const jobRepo = ds.getRepository(AutomationJobEntity);
        const newJob = jobRepo.create({
            orgKey,
            projectId: bodyPayload.projectId,
            name: bodyPayload.name,
            description: bodyPayload.description,
            status: AutomationJobStatus.Pending,
            trigger: bodyPayload.trigger,
            schedule: bodyPayload.trigger === AutomationJobTrigger.Schedule ? bodyPayload.schedule : null,
            model: bodyPayload.model,
            promptTemplate: bodyPayload.promptTemplate,
            input: bodyPayload.input ?? null,
            parallelism: bodyPayload.parallelism ?? 1,
            retryLimit: bodyPayload.retryLimit ?? 0,
            snapshotPrompt: bodyPayload.promptTemplate,
            snapshotParameters: {
                parallel: bodyPayload.parallelism ?? 1,
                retry: bodyPayload.retryLimit ?? 0,
                ...(bodyPayload.trigger === AutomationJobTrigger.Schedule && bodyPayload.schedule
                    ? { schedule: bodyPayload.schedule }
                    : {}),
            },
            metadata: {},
            executionUserId: userId,
            createdBy: userId,
            updatedBy: userId,
            createdIp: req.info.ip,
            updatedIp: req.info.ip,
            estimatedCostUsd: '0',
        });

        const savedJob = await jobRepo.save(newJob);

        // タスクテンプレートを作成
        const userContext = {
            userId,
            orgKey,
            ip: req.info.ip,
        };

        try {
            await ds.transaction(async (manager) => {
                // promptTemplateからタスクテンプレートを作成
                // 現在は単一タスクのみサポート（将来的には複数タスクに対応可能）
                await createTaskTemplate(
                    savedJob,
                    {
                        name: savedJob.name,
                        description: savedJob.description,
                        prompt: savedJob.promptTemplate || '',
                        model: savedJob.model || undefined,
                    },
                    0, // 最初のタスクはseq=0
                    userContext,
                    manager,
                );
            });
        } catch (error) {
            console.error('[AutomationJob] Failed to create task template', { jobId: savedJob.id, error });
            // テンプレート作成に失敗してもジョブ自体は作成済みなので、エラーログのみ
        }

        res.status(201).json({
            jobId: savedJob.id,
            status: savedJob.status,
            projectId: savedJob.projectId,
            createdAt: savedJob.createdAt.toISOString(),
        });
    },
];

export const postAutomationJobAction = [
    param('jobId').isUUID(),
    body('action').isIn(['stop', 'retry', 'retryErrors', 'cancel', 'resume']),
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        const orgKey = req.info.user.orgKey;
        const userId = req.info.user.id;
        const jobId = req.params.jobId;
        const { action } = req.body as { action: 'stop' | 'retry' | 'retryErrors' | 'cancel' | 'resume' };

        const jobRepo = ds.getRepository(AutomationJobEntity);
        const job = await jobRepo.findOne({ where: { orgKey, id: jobId } });

        if (!job) {
            res.status(404).json({
                code: 'AUTOMATION_JOB_NOT_FOUND',
                message: 'Automation job not found',
                details: [],
            });
            return;
        }

        const projectAccess = await verifyProjectAccess(req, job.projectId);
        if (!projectAccess.ok) {
            res.status(projectAccess.status).json(projectAccess.error);
            return;
        }

        const taskRepo = ds.getRepository(AutomationTaskEntity);
        const now = new Date();

        if (action === 'retry' || action === 'retryErrors') {
            const statusCondition = action === 'retry'
                ? { statusList: Object.values(AutomationTaskStatus) }
                : { statusList: [AutomationTaskStatus.Error] };

            await taskRepo.createQueryBuilder()
                .update(AutomationTaskEntity)
                .set({
                    status: AutomationTaskStatus.Pending,
                    updatedBy: userId,
                    updatedIp: req.info.ip,
                    updatedAt: () => 'CURRENT_TIMESTAMP',
                })
                .where('orgKey = :orgKey', { orgKey })
                .andWhere('jobId = :jobId', { jobId })
                .andWhere('status IN (:...statusList)', statusCondition)
                .execute();

            job.status = AutomationJobStatus.Pending;
            job.startedAt = null;
            job.completedAt = null;
            job.durationSeconds = null;
            job.lastRunId = null;
            job.leaseId = null;
            job.leaseExpiresAt = null;
        } else if (action === 'resume') {
            job.status = AutomationJobStatus.Running;
            job.completedAt = null;
            job.durationSeconds = null;
            job.leaseId = null;
            job.leaseExpiresAt = null;
            if (!job.startedAt) {
                job.startedAt = now;
            }
        } else if (action === 'stop' || action === 'cancel') {
            await taskRepo.createQueryBuilder()
                .update(AutomationTaskEntity)
                .set({
                    status: AutomationTaskStatus.Stopped,
                    updatedBy: userId,
                    updatedIp: req.info.ip,
                    updatedAt: () => 'CURRENT_TIMESTAMP',
                })
                .where('orgKey = :orgKey', { orgKey })
                .andWhere('jobId = :jobId', { jobId })
                .andWhere('status IN (:...statusList)', { statusList: [AutomationTaskStatus.Pending, AutomationTaskStatus.Running] })
                .execute();

            job.status = AutomationJobStatus.Stopped;
            if (job.startedAt) {
                job.durationSeconds = Math.max(0, Math.round((now.getTime() - job.startedAt.getTime()) / 1000));
            }
            job.completedAt = now;
            job.leaseId = null;
            job.leaseExpiresAt = null;
        }

        if (ACTION_STATUS_MAP[action]) {
            job.status = ACTION_STATUS_MAP[action];
        }

        if (ACTION_STATUS_MAP[action] !== AutomationJobStatus.Running) {
            job.leaseId = null;
            job.leaseExpiresAt = null;
        }

        job.updatedBy = userId;
        job.updatedIp = req.info.ip;

        await jobRepo.save(job);
        const detail = await buildJobDetailResponse(job, orgKey);
        res.json(detail);
    },
];

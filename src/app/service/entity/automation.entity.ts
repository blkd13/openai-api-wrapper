import { Column, Entity, Index, Generated } from 'typeorm';
import { MyBaseEntity } from './base.js';

export enum AutomationJobStatus {
    Pending = 'pending',
    Running = 'running',
    Completed = 'completed',
    Error = 'error',
    Stopped = 'stopped',
}

export enum AutomationJobTrigger {
    Manual = 'manual',
    Schedule = 'schedule',
}

export type AutomationJobSchedule = {
    cron: string;
    timezone: string;
};

export type AutomationJobModel = {
    provider: string;
    modelId: string;
};

export type AutomationJobInput =
    | { source: 'upload'; fileId: string }
    | { source: string;[key: string]: any };

export enum AutomationTaskStatus {
    Pending = 'pending',
    Running = 'running',
    Completed = 'completed',
    Error = 'error',
    Stopped = 'stopped',
}

export enum AutomationTaskType {
    Template = 'template',      // タスクテンプレート
    Execution = 'execution',    // 実行インスタンス
}

@Entity()
@Index(['orgKey', 'projectId'])
@Index(['orgKey', 'projectId', 'status'])
@Index(['orgKey', 'projectId', 'trigger'])
@Index(['orgKey', 'projectId', 'createdAt'])
export class AutomationJobEntity extends MyBaseEntity {
    @Column({ type: 'uuid' })
    projectId!: string;

    @Column({ length: 255 })
    name!: string;

    @Column({ type: 'text', nullable: true })
    description?: string;

    @Column({ type: 'enum', enum: AutomationJobStatus, default: AutomationJobStatus.Pending })
    status!: AutomationJobStatus;

    @Column({ type: 'enum', enum: AutomationJobTrigger, default: AutomationJobTrigger.Manual })
    trigger!: AutomationJobTrigger;

    @Column({ type: 'timestamptz', nullable: true })
    startedAt?: Date | null;

    @Column({ type: 'timestamptz', nullable: true })
    completedAt?: Date | null;

    @Column({ type: 'integer', nullable: true })
    durationSeconds?: number | null;

    @Column({ type: 'varchar', length: 128, nullable: true })
    lastRunId?: string | null;

    @Column({ type: 'uuid', nullable: true })
    leaseId?: string | null;

    @Column({ type: 'timestamptz', nullable: true })
    leaseExpiresAt?: Date | null;

    @Column({ type: 'numeric', precision: 16, scale: 4, nullable: true })
    estimatedCostUsd?: string | null;

    @Column({ type: 'jsonb', nullable: true })
    schedule?: AutomationJobSchedule | null;

    @Column({ type: 'jsonb', nullable: true })
    model?: AutomationJobModel | null;

    @Column({ type: 'text', nullable: true })
    promptTemplate?: string | null;

    @Column({ type: 'jsonb', nullable: true })
    input?: AutomationJobInput | null;

    @Column({ type: 'integer', default: 1 })
    parallelism!: number;

    @Column({ type: 'integer', default: 0 })
    retryLimit!: number;

    @Column({ type: 'text', nullable: true })
    snapshotPrompt?: string | null;

    @Column({ type: 'jsonb', nullable: true })
    snapshotParameters?: Record<string, any> | null;

    @Column({ type: 'jsonb', nullable: true })
    metadata?: Record<string, any> | null;

    @Column({ type: 'uuid', nullable: true })
    executionUserId?: string | null;
}

@Entity()
@Index(['orgKey', 'projectId'])
@Index(['orgKey', 'projectId', 'status'])
@Index(['orgKey', 'jobId'])
@Index(['orgKey', 'jobId', 'status'])
@Index(['orgKey', 'jobId', 'seq'])
@Index(['orgKey', 'jobId', 'taskType'])
@Index(['orgKey', 'projectId', 'taskType'])
@Index(['orgKey', 'jobId', 'threadGroupId'])
@Index(['orgKey', 'jobId', 'templateTaskId'])
export class AutomationTaskEntity extends MyBaseEntity {
    @Column({ type: 'uuid' })
    jobId!: string;

    @Column({ type: 'uuid' })
    projectId!: string;

    @Column({ type: 'uuid' })
    threadGroupId!: string;

    @Column({ type: 'enum', enum: AutomationTaskType, default: AutomationTaskType.Template })
    taskType!: AutomationTaskType;

    @Column({ type: 'integer' })
    @Generated('increment')
    seq!: number;

    @Column({ type: 'uuid', nullable: true })
    templateTaskId?: string | null;

    @Column({ type: 'enum', enum: AutomationTaskStatus, default: AutomationTaskStatus.Pending })
    status!: AutomationTaskStatus;

    @Column({ type: 'text', nullable: true })
    inputPreview?: string;

    @Column({ type: 'text', nullable: true })
    outputPreview?: string;

    @Column({ type: 'text', nullable: true })
    errorMessage?: string;

    @Column({ type: 'integer', nullable: true })
    tokens?: number;

    @Column({ type: 'double precision', nullable: true })
    durationSeconds?: number;

    @Column({ type: 'jsonb', nullable: true })
    metadata?: Record<string, any>;

    @Column({ type: 'varchar', length: 128, nullable: true })
    runId?: string | null;
}

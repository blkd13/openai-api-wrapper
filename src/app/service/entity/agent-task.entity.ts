import { Entity, Index, Column } from 'typeorm';
import { MyBaseEntity } from './base.js';

export enum AgentTaskStatus {
    Pending = 'Pending',
    InProgress = 'InProgress',
    Completed = 'Completed',
    Cancelled = 'Cancelled',
}

export enum AgentTaskPriority {
    Low = 'Low',
    Medium = 'Medium',
    High = 'High',
}

@Entity()
@Index(['orgKey', 'status'])
@Index(['orgKey', 'label'])
@Index(['orgKey', 'threadId'])
export class AgentTaskEntity extends MyBaseEntity {
    @Column()
    title!: string;

    @Column({ type: 'text', nullable: true })
    description?: string;

    @Column({ type: 'enum', enum: AgentTaskStatus, default: AgentTaskStatus.Pending })
    status!: AgentTaskStatus;

    @Column({ type: 'enum', enum: AgentTaskPriority, default: AgentTaskPriority.Medium })
    priority!: AgentTaskPriority;

    @Column({ type: 'timestamptz', nullable: true })
    dueAt?: Date;

    @Column({ nullable: true })
    label?: string; // セッションや計画の識別用

    @Column({ type: 'uuid', nullable: true })
    threadId?: string;

    @Column({ type: 'uuid', nullable: true })
    messageId?: string;

    @Column({ type: 'text', nullable: true })
    resultNote?: string; // 完了時のメモ

    @Column({ type: 'jsonb', nullable: true })
    metadata?: any; // 任意の追加情報

    @Column({ type: 'timestamptz', nullable: true })
    completedAt?: Date;
}


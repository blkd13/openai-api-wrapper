import { Column, Entity } from 'typeorm';
import { MyBaseEntity } from './base.js';

// ============================================
// Enums
// ============================================

export enum ContextResourceProviderType {
    Local = 'local',
    Box = 'box',
    Confluence = 'confluence',
    Jira = 'jira',
    GitLab = 'gitlab',
    Gitea = 'gitea',
    Mattermost = 'mattermost',
    Web = 'web',
}

export enum ContextResourceSyncStatus {
    Pending = 'pending',
    Syncing = 'syncing',
    Synced = 'synced',
    Error = 'error',
    Disabled = 'disabled',
}

export enum ContextSearchMode {
    Realtime = 'realtime',
    Vector = 'vector',
}

// ============================================
// Context Hub Entity
// ============================================

@Entity()
export class ContextHubEntity extends MyBaseEntity {
    @Column({ type: 'uuid' })
    projectId!: string;

    @Column()
    name!: string;

    @Column({ nullable: true })
    description?: string;

    @Column({ default: true })
    isActive!: boolean;
}

// ============================================
// Context Resource Entity
// ============================================

@Entity()
export class ContextResourceEntity extends MyBaseEntity {
    @Column({ type: 'uuid' })
    contextHubId!: string;

    @Column({
        type: 'enum',
        enum: ContextResourceProviderType,
    })
    providerType!: ContextResourceProviderType;

    @Column()
    providerName!: string;

    @Column()
    label!: string;

    @Column({ nullable: true })
    description?: string;

    @Column({ default: true })
    isActive!: boolean;

    @Column({
        type: 'enum',
        enum: ContextResourceSyncStatus,
        default: ContextResourceSyncStatus.Pending,
    })
    syncStatus!: ContextResourceSyncStatus;

    @Column({ type: 'timestamptz', nullable: true })
    lastSyncAt?: Date;

    @Column({ nullable: true })
    lastError?: string;

    @Column({ default: 0 })
    sortOrder!: number;

    @Column({ type: 'jsonb', nullable: true })
    config?: Record<string, unknown>;

    @Column({ nullable: true })
    itemCount?: number;

    @Column({
        type: 'enum',
        enum: ContextSearchMode,
        default: ContextSearchMode.Realtime,
    })
    searchMode!: ContextSearchMode;
}

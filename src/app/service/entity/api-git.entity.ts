import { Column, Entity, In, Index, Unique, UpdateDateColumn } from 'typeorm';
import { MyBaseEntity } from './base.js';

export enum GitProjectCommitStatus {
    Initialized = "Initialized",
    Creating = "Creating",
    Normal = "Normal",
    Error = "Error",
}

export enum GitProjectStatus {
    Initialized = "Initialized",
    Cloning = "Cloning",
    Fetching = "Fetching",
    Normal = "Normal",
    Error = "Error",
}

@Entity() // テーブル名を指定
@Unique(['tenantKey', 'provider', 'gitProjectId', 'commitId']) // ここで複合ユニーク制約を設定
@Index(['tenantKey', 'provider']) // インデックスを追加
@Index(['tenantKey', 'fileGroupId']) // インデックスを追加
export class GitProjectCommitEntity extends MyBaseEntity {

    @Column() @Index()
    provider!: string;

    @Column()
    gitProjectId!: number;

    @Column()
    commitId!: string;

    @Column() @Index()
    fileGroupId!: string;

    @Column({ type: 'enum', enum: GitProjectCommitStatus, default: GitProjectCommitStatus.Initialized })
    status!: GitProjectCommitStatus;
}

@Entity() // テーブル名を指定
@Unique(['tenantKey', 'provider', 'gitProjectId']) // ここで複合ユニーク制約を設定
@Index(['tenantKey', 'provider']) // インデックスを追加
export class GitProjectEntity extends MyBaseEntity {

    @Column() @Index()
    provider!: string;

    @Column()
    gitProjectId!: number;

    @Column({ type: 'enum', enum: GitProjectStatus, default: GitProjectStatus.Initialized })
    status!: GitProjectStatus;

    @UpdateDateColumn({ type: 'timestamptz' })
    lastFetchAt!: Date;

    @Column({ nullable: true })
    lastFetchError?: string;
}

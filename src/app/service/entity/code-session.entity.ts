import { Column, Entity, Index } from 'typeorm';
import { MyBaseEntity } from './base.js';

/**
 * Code Session データソースの種類
 */
export enum DataSourceType {
    CLAUDE_CODE = 'claude-code',
    GEMINI_CLI = 'gemini-cli',
    CODEX_CLI = 'codex-cli',
}

/**
 * Code Session データソースエンティティ
 * ユーザーごとにClaude Code等のセッションデータの保存場所を管理する
 */
@Entity()
@Index(['orgKey', 'userId'])
@Index(['orgKey', 'projectId'])
export class CodeSessionDataSourceEntity extends MyBaseEntity {
    /**
     * データソースを所有するユーザーのID
     */
    @Column({ type: 'uuid' })
    userId!: string;

    /**
     * コンテナプロジェクトとの紐付け（nullの場合は手動設定のデータソース）
     */
    @Column({ type: 'uuid', nullable: true })
    projectId?: string;

    /**
     * データソースの表示名（例: "My MacBook", "Work PC"）
     */
    @Column()
    name!: string;

    /**
     * データソースの種類
     */
    @Column({ type: 'enum', enum: DataSourceType, default: DataSourceType.CLAUDE_CODE })
    type!: DataSourceType;

    /**
     * セッションデータのベースパス（例: "/home/user/.claude/projects"）
     */
    @Column()
    basePath!: string;

    /**
     * パス変換マッピング（WSL <-> Windows等の変換用）
     * 例: { "-mnt-c-Users-": "/c/Users/" }
     */
    @Column({ type: 'json', nullable: true })
    pathMapping?: Record<string, string>;

    /**
     * アクティブフラグ（論理削除用）
     */
    @Column({ default: true })
    isActive!: boolean;

    /**
     * 最後にスキャンした日時
     */
    @Column({ type: 'timestamptz', nullable: true })
    lastSyncAt?: Date;
}

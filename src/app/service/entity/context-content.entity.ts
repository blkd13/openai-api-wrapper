import { Column, Entity, Index } from 'typeorm';
import { MyBaseEntity } from './base.js';

// ============================================
// Context Content Entity
// コンテンツキャッシュ（チャンク分割対応）
// ============================================

@Entity()
@Index(['orgKey', 'contextResourceId'])
@Index(['orgKey', 'contextResourceId', 'contentHash'])
export class ContextContentEntity extends MyBaseEntity {
    @Column({ type: 'uuid' })
    contextResourceId!: string;

    /** コンテンツのハッシュ（重複チェック用） */
    @Column()
    contentHash!: string;

    /** テキストコンテンツ */
    @Column({ type: 'text' })
    content!: string;

    /** メタデータ（タイトル、パス、URL等） */
    @Column({ type: 'jsonb', nullable: true })
    metadata?: ContextContentMetadata;

    /** チャンク分割時のインデックス（0始まり） */
    @Column({ nullable: true })
    chunkIndex?: number;

    /** 元コンテンツの総チャンク数 */
    @Column({ nullable: true })
    totalChunks?: number;

    /** トークン数（推定） */
    @Column({ nullable: true })
    tokenCount?: number;

    /** ベクトル埋め込み (jsonb形式で保存) */
    @Column({ type: 'jsonb', nullable: true })
    embedding?: number[];

    /** Embedding生成に使用したモデル */
    @Column({ nullable: true })
    embeddingModel?: string;
}

// ============================================
// Types
// ============================================

export interface ContextContentMetadata {
    /** コンテンツのタイトル */
    title?: string;
    /** ファイルパス or ページパス */
    path?: string;
    /** URL（Webリソースの場合） */
    url?: string;
    /** 最終更新日時 */
    lastModified?: Date;
    /** プロバイダー固有のID */
    sourceId?: string;
    /** プロバイダー固有の型（file, page, issue, mr等） */
    sourceType?: string;
    /** MIMEタイプ */
    mimeType?: string;
}

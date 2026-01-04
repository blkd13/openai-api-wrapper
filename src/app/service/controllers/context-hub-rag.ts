import { Request, Response } from 'express';
import { body, param } from 'express-validator';
import { In } from 'typeorm';

import { embeddings } from '../../common/openai-api-wrapper.js';
import { Utils } from '../../common/utils.js';
import { ds } from '../db.js';
import { ContextContentEntity } from '../entity/context-content.entity.js';
import { ContextHubEntity, ContextResourceEntity } from '../entity/context-hub.entity.js';
import { validationErrorHandler } from '../middleware/validation.js';
import { UserRequest } from '../models/info.js';
import { getAIProvider } from './chat-by-project-model.js';

// ============================================
// Constants
// ============================================

const DEFAULT_EMBEDDING_MODEL = 'text-embedding-3-small';
const DEFAULT_TOP_K = 5;
const DEFAULT_MIN_SCORE = 0.5;

// ============================================
// Embedding Generation
// ============================================

/**
 * コンテンツにEmbeddingを生成して保存
 */
export async function generateEmbeddingForContent(
    contentId: string,
    orgKey: string,
    userId: string,
    ip: string,
    model: string = DEFAULT_EMBEDDING_MODEL
): Promise<void> {
    const content = await ds.getRepository(ContextContentEntity).findOne({
        where: { orgKey, id: contentId }
    });

    if (!content) {
        throw new Error(`Content not found: ${contentId}`);
    }

    // 既にEmbeddingがある場合はスキップ
    if (content.embedding && content.embeddingModel === model) {
        return;
    }

    try {
        // UserTokenPayloadWithRoleの簡易版を作成
        const user = { orgKey, id: userId } as any;
        const { aiProviderClient } = await getAIProvider(user, model);

        const result = await embeddings(orgKey, userId, ip, model, aiProviderClient, content.content);

        // Embeddingを保存
        content.embedding = result.data[0].embedding;
        content.embeddingModel = model;
        await ds.getRepository(ContextContentEntity).save(content);
    } catch (error) {
        console.error(`Error generating embedding for content ${contentId}:`, error);
        throw error;
    }
}

/**
 * リソースの全コンテンツにEmbeddingを生成
 */
export async function generateEmbeddingsForResource(
    resourceId: string,
    orgKey: string,
    userId: string,
    ip: string,
    model: string = DEFAULT_EMBEDDING_MODEL
): Promise<number> {
    const contents = await ds.getRepository(ContextContentEntity).find({
        where: { orgKey, contextResourceId: resourceId }
    });

    let count = 0;
    for (const content of contents) {
        try {
            await generateEmbeddingForContent(content.id, orgKey, userId, ip, model);
            count++;
        } catch (error) {
            console.error(`Error generating embedding for content ${content.id}:`, error);
        }
    }

    return count;
}

// ============================================
// Vector Search
// ============================================

/**
 * コサイン類似度を計算
 */
function cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) {
        throw new Error('Vectors must have the same length');
    }

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
        dotProduct += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
    }

    if (normA === 0 || normB === 0) {
        return 0;
    }

    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * ベクトル検索を実行
 */
async function vectorSearch(
    queryEmbedding: number[],
    resourceIds: string[],
    orgKey: string,
    topK: number,
    minScore: number
): Promise<Array<{ content: ContextContentEntity; score: number }>> {
    // 対象リソースのコンテンツを取得（Embeddingがあるもののみ）
    const contents = await ds.getRepository(ContextContentEntity).find({
        where: {
            orgKey,
            contextResourceId: In(resourceIds),
        }
    });

    // Embeddingがあるコンテンツのみフィルタ
    const contentsWithEmbedding = contents.filter(c => c.embedding && c.embedding.length > 0);

    // 類似度を計算
    const scored = contentsWithEmbedding.map(content => ({
        content,
        score: cosineSimilarity(queryEmbedding, content.embedding!)
    }));

    // スコアでソートしてtopK取得
    return scored
        .filter(item => item.score >= minScore)
        .sort((a, b) => b.score - a.score)
        .slice(0, topK);
}

// ============================================
// API Endpoints
// ============================================

/**
 * プロジェクトのContext Hubを取得するヘルパー関数
 */
async function getHubByProjectId(orgKey: string, projectId: string): Promise<ContextHubEntity | null> {
    return await ds.getRepository(ContextHubEntity).findOne({
        where: { orgKey, projectId }
    });
}

/**
 * [user認証] RAG検索を実行
 * POST /project/:projectId/context-hub/search
 */
export const searchContextHub = [
    param('projectId').notEmpty().isUUID(),
    body('query').notEmpty().isString(),
    body('resourceIds').optional().isArray(),
    body('topK').optional().isInt({ min: 1, max: 50 }),
    body('minScore').optional().isFloat({ min: 0, max: 1 }),
    body('model').optional().isString(),
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        const { projectId } = req.params;
        const {
            query,
            resourceIds,
            topK = DEFAULT_TOP_K,
            minScore = DEFAULT_MIN_SCORE,
            model = DEFAULT_EMBEDDING_MODEL
        } = req.body as {
            query: string;
            resourceIds?: string[];
            topK?: number;
            minScore?: number;
            model?: string;
        };

        try {
            const hub = await getHubByProjectId(req.info.user.orgKey, projectId);

            if (!hub) {
                res.status(404).json({ message: '指定されたプロジェクトのContext Hubが見つかりません' });
                return;
            }

            // 対象リソースを取得
            let targetResourceIds: string[];
            if (resourceIds && resourceIds.length > 0) {
                // 指定されたリソースIDを検証
                const resources = await ds.getRepository(ContextResourceEntity).find({
                    where: {
                        orgKey: req.info.user.orgKey,
                        contextHubId: hub.id,
                        id: In(resourceIds),
                        isActive: true,
                    }
                });
                targetResourceIds = resources.map(r => r.id);
            } else {
                // 全アクティブリソースを対象
                const resources = await ds.getRepository(ContextResourceEntity).find({
                    where: {
                        orgKey: req.info.user.orgKey,
                        contextHubId: hub.id,
                        isActive: true,
                    }
                });
                targetResourceIds = resources.map(r => r.id);
            }

            if (targetResourceIds.length === 0) {
                res.status(200).json({ results: [], query });
                return;
            }

            // クエリのEmbeddingを生成
            const { aiProviderClient } = await getAIProvider(req.info.user, model);
            const queryEmbeddingResult = await embeddings(
                req.info.user.orgKey,
                req.info.user.id,
                req.info.ip,
                model,
                aiProviderClient,
                query
            );
            const queryEmbedding = queryEmbeddingResult.data[0].embedding;

            // ベクトル検索を実行
            const searchResults = await vectorSearch(
                queryEmbedding,
                targetResourceIds,
                req.info.user.orgKey,
                topK,
                minScore
            );

            // リソース情報を取得
            const resourceMap = new Map<string, ContextResourceEntity>();
            if (searchResults.length > 0) {
                const resources = await ds.getRepository(ContextResourceEntity).find({
                    where: {
                        orgKey: req.info.user.orgKey,
                        id: In([...new Set(searchResults.map(r => r.content.contextResourceId))])
                    }
                });
                resources.forEach(r => resourceMap.set(r.id, r));
            }

            // レスポンスを構築
            const results = searchResults.map(item => {
                const resource = resourceMap.get(item.content.contextResourceId);
                return {
                    resourceId: item.content.contextResourceId,
                    resourceLabel: resource?.label || 'Unknown',
                    contentId: item.content.id,
                    content: item.content.content,
                    score: item.score,
                    metadata: item.content.metadata,
                    chunkIndex: item.content.chunkIndex,
                    totalChunks: item.content.totalChunks,
                };
            });

            res.status(200).json({ results, query });
        } catch (error) {
            console.error('Error searching context hub:', JSON.stringify(error, Utils.genJsonSafer()) === '{}' ? error : JSON.stringify(error, Utils.genJsonSafer()));
            res.status(500).json({ message: 'RAG検索中にエラーが発生しました' });
        }
    }
];

/**
 * [user認証] リソースのEmbeddingを生成
 * POST /context-hub/resource/:resourceId/generate-embeddings
 */
export const generateResourceEmbeddings = [
    param('resourceId').notEmpty().isUUID(),
    body('model').optional().isString(),
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        const { resourceId } = req.params;
        const { model = DEFAULT_EMBEDDING_MODEL } = req.body as { model?: string };

        try {
            // リソースの存在確認
            const resource = await ds.getRepository(ContextResourceEntity).findOne({
                where: {
                    orgKey: req.info.user.orgKey,
                    id: resourceId,
                }
            });

            if (!resource) {
                res.status(404).json({ message: '指定されたContext Resourceが見つかりません' });
                return;
            }

            // Embeddingを生成
            const count = await generateEmbeddingsForResource(
                resourceId,
                req.info.user.orgKey,
                req.info.user.id,
                req.info.ip,
                model
            );

            res.status(200).json({
                message: 'Embeddingを生成しました',
                resourceId,
                embeddingCount: count,
                model,
            });
        } catch (error) {
            console.error('Error generating embeddings:', JSON.stringify(error, Utils.genJsonSafer()) === '{}' ? error : JSON.stringify(error, Utils.genJsonSafer()));
            res.status(500).json({ message: 'Embedding生成中にエラーが発生しました' });
        }
    }
];

/**
 * [user認証] プロジェクトのHub内全リソースのEmbeddingを生成
 * POST /project/:projectId/context-hub/generate-embeddings
 */
export const generateHubEmbeddings = [
    param('projectId').notEmpty().isUUID(),
    body('resourceIds').optional().isArray(),
    body('model').optional().isString(),
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        const { projectId } = req.params;
        const {
            resourceIds,
            model = DEFAULT_EMBEDDING_MODEL
        } = req.body as { resourceIds?: string[]; model?: string };

        try {
            const hub = await getHubByProjectId(req.info.user.orgKey, projectId);

            if (!hub) {
                res.status(404).json({ message: '指定されたプロジェクトのContext Hubが見つかりません' });
                return;
            }

            // 対象リソースを取得
            let resources = await ds.getRepository(ContextResourceEntity).find({
                where: {
                    orgKey: req.info.user.orgKey,
                    contextHubId: hub.id,
                    isActive: true,
                    ...(resourceIds && resourceIds.length > 0 ? { id: In(resourceIds) } : {}),
                }
            });

            const results: { resourceId: string; embeddingCount: number; error?: string }[] = [];

            for (const resource of resources) {
                try {
                    const count = await generateEmbeddingsForResource(
                        resource.id,
                        req.info.user.orgKey,
                        req.info.user.id,
                        req.info.ip,
                        model
                    );
                    results.push({ resourceId: resource.id, embeddingCount: count });
                } catch (error) {
                    console.error(`Error generating embeddings for resource ${resource.id}:`, error);
                    results.push({
                        resourceId: resource.id,
                        embeddingCount: 0,
                        error: error instanceof Error ? error.message : String(error)
                    });
                }
            }

            res.status(200).json({ results, model });
        } catch (error) {
            console.error('Error generating hub embeddings:', JSON.stringify(error, Utils.genJsonSafer()) === '{}' ? error : JSON.stringify(error, Utils.genJsonSafer()));
            res.status(500).json({ message: 'Embedding生成中にエラーが発生しました' });
        }
    }
];

import * as crypto from 'crypto';
import { Request, Response } from 'express';
import { body, param, query } from 'express-validator';
import { promises as fs } from 'fs';
import { EntityNotFoundError, In } from 'typeorm';
import { detect } from 'jschardet';

import { Utils } from '../../common/utils.js';
import { ds } from '../db.js';
import { ContextContentEntity, ContextContentMetadata } from '../entity/context-content.entity.js';
import { ContextHubEntity, ContextResourceEntity, ContextResourceProviderType } from '../entity/context-hub.entity.js';
import { FileBodyEntity, FileEntity } from '../entity/file-models.entity.js';
import { validationErrorHandler } from '../middleware/validation.js';
import { UserRequest } from '../models/info.js';
import { getExtApiClient } from './auth.js';

// ============================================
// Content Fetch API
// ============================================

/**
 * プロジェクトのContext Hubを取得するヘルパー関数
 */
async function getHubByProjectId(orgKey: string, projectId: string): Promise<ContextHubEntity | null> {
    return await ds.getRepository(ContextHubEntity).findOne({
        where: {
            orgKey,
            projectId,
        }
    });
}

/**
 * コンテンツハッシュを生成
 */
function generateContentHash(content: string): string {
    const hash = crypto.createHash('sha256');
    hash.update(content);
    return hash.digest('hex');
}

/**
 * テキストかどうかを判定
 */
function isTextContent(mimeType: string): boolean {
    const textMimes = [
        'text/',
        'application/json',
        'application/xml',
        'application/javascript',
        'application/typescript',
        'application/x-yaml',
        'application/x-python',
        'application/x-sh',
    ];
    return textMimes.some(m => mimeType.startsWith(m) || mimeType.includes(m));
}

/**
 * バイナリからテキストを抽出（可能な場合）
 */
async function extractTextFromBuffer(buffer: Buffer, mimeType: string): Promise<string | null> {
    // テキストファイルの場合
    if (isTextContent(mimeType)) {
        const detected = detect(buffer);
        const encoding = detected?.encoding || 'utf-8';
        try {
            // iconv-liteを使わずにシンプルにデコード
            return buffer.toString(encoding as BufferEncoding);
        } catch {
            return buffer.toString('utf-8');
        }
    }

    // PDFの場合はスキップ（将来的にpdf-parseなどで対応）
    if (mimeType === 'application/pdf') {
        return null; // TODO: PDF対応
    }

    return null;
}

/**
 * チャンク分割（簡易版）
 * TODO: トークンベースの分割に改善
 */
function splitIntoChunks(content: string, maxChunkSize: number = 4000): string[] {
    const chunks: string[] = [];

    // 段落区切りで分割を試みる
    const paragraphs = content.split(/\n\n+/);
    let currentChunk = '';

    for (const paragraph of paragraphs) {
        if (currentChunk.length + paragraph.length + 2 > maxChunkSize) {
            if (currentChunk) {
                chunks.push(currentChunk.trim());
            }
            // 段落自体が大きい場合はさらに分割
            if (paragraph.length > maxChunkSize) {
                const subChunks = paragraph.match(new RegExp(`.{1,${maxChunkSize}}`, 'g')) || [];
                chunks.push(...subChunks);
                currentChunk = '';
            } else {
                currentChunk = paragraph;
            }
        } else {
            currentChunk += (currentChunk ? '\n\n' : '') + paragraph;
        }
    }

    if (currentChunk) {
        chunks.push(currentChunk.trim());
    }

    return chunks.filter(c => c.length > 0);
}

/**
 * [user認証] プロジェクトのContext Hubのコンテンツを取得・キャッシュ
 * POST /project/:projectId/context-hub/fetch-content
 */
export const fetchContextHubContent = [
    param('projectId').notEmpty().isUUID(),
    body('resourceIds').optional().isArray(),
    body('force').optional().isBoolean(),
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        const { projectId } = req.params;
        const { resourceIds, force } = req.body as { resourceIds?: string[]; force?: boolean };

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
                },
                order: { sortOrder: 'ASC', createdAt: 'ASC' }
            });

            const results: { resourceId: string; contentCount: number; error?: string }[] = [];

            for (const resource of resources) {
                try {
                    const count = await fetchContentForResource(resource, req, force || false);
                    results.push({ resourceId: resource.id, contentCount: count });
                } catch (error) {
                    console.error(`Error fetching content for resource ${resource.id}:`, error);
                    results.push({
                        resourceId: resource.id,
                        contentCount: 0,
                        error: error instanceof Error ? error.message : String(error)
                    });
                }
            }

            res.status(200).json({ results });
        } catch (error) {
            console.error('Error fetching context hub content:', JSON.stringify(error, Utils.genJsonSafer()) === '{}' ? error : JSON.stringify(error, Utils.genJsonSafer()));
            res.status(500).json({ message: 'コンテンツ取得中にエラーが発生しました' });
        }
    }
];

/**
 * [user認証] リソースのキャッシュ済みコンテンツを取得
 * GET /context-hub/resource/:resourceId/content
 */
export const getResourceContent = [
    param('resourceId').notEmpty().isUUID(),
    query('limit').optional().isInt({ min: 1, max: 100 }),
    query('offset').optional().isInt({ min: 0 }),
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        const { resourceId } = req.params;
        const limit = parseInt(req.query.limit as string) || 50;
        const offset = parseInt(req.query.offset as string) || 0;

        try {
            // リソースの存在確認
            await ds.getRepository(ContextResourceEntity).findOneOrFail({
                where: {
                    orgKey: req.info.user.orgKey,
                    id: resourceId,
                }
            });

            // コンテンツを取得
            const [contents, total] = await ds.getRepository(ContextContentEntity).findAndCount({
                where: {
                    orgKey: req.info.user.orgKey,
                    contextResourceId: resourceId,
                },
                order: { createdAt: 'ASC', chunkIndex: 'ASC' },
                take: limit,
                skip: offset,
            });

            res.status(200).json({
                contents,
                total,
                limit,
                offset,
            });
        } catch (error) {
            console.error('Error getting resource content:', JSON.stringify(error, Utils.genJsonSafer()) === '{}' ? error : JSON.stringify(error, Utils.genJsonSafer()));
            if (error instanceof EntityNotFoundError) {
                res.status(404).json({ message: '指定されたContext Resourceが見つかりません' });
            } else {
                res.status(500).json({ message: 'コンテンツ取得中にエラーが発生しました' });
            }
        }
    }
];

/**
 * [user認証] リソースのキャッシュ済みコンテンツを削除
 * DELETE /context-hub/resource/:resourceId/content
 */
export const deleteResourceContent = [
    param('resourceId').notEmpty().isUUID(),
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        const { resourceId } = req.params;

        try {
            // リソースの存在確認
            await ds.getRepository(ContextResourceEntity).findOneOrFail({
                where: {
                    orgKey: req.info.user.orgKey,
                    id: resourceId,
                }
            });

            // コンテンツを削除
            const result = await ds.getRepository(ContextContentEntity).delete({
                orgKey: req.info.user.orgKey,
                contextResourceId: resourceId,
            });

            res.status(200).json({
                message: 'コンテンツを削除しました',
                deletedCount: result.affected || 0,
            });
        } catch (error) {
            console.error('Error deleting resource content:', JSON.stringify(error, Utils.genJsonSafer()) === '{}' ? error : JSON.stringify(error, Utils.genJsonSafer()));
            if (error instanceof EntityNotFoundError) {
                res.status(404).json({ message: '指定されたContext Resourceが見つかりません' });
            } else {
                res.status(500).json({ message: 'コンテンツ削除中にエラーが発生しました' });
            }
        }
    }
];

// ============================================
// Provider-specific content fetchers
// ============================================

async function fetchContentForResource(
    resource: ContextResourceEntity,
    req: UserRequest,
    force: boolean
): Promise<number> {
    switch (resource.providerType) {
        case ContextResourceProviderType.Local:
            return fetchLocalContent(resource, req, force);
        case ContextResourceProviderType.Box:
            return fetchBoxContent(resource, req, force);
        case ContextResourceProviderType.GitLab:
            return fetchGitLabContent(resource, req, force);
        case ContextResourceProviderType.Gitea:
            return fetchGiteaContent(resource, req, force);
        case ContextResourceProviderType.Mattermost:
            return fetchMattermostContent(resource, req, force);
        case ContextResourceProviderType.Confluence:
            return fetchConfluenceContent(resource, req, force);
        case ContextResourceProviderType.Jira:
            return fetchJiraContent(resource, req, force);
        case ContextResourceProviderType.Web:
            return fetchWebContent(resource, req, force);
        default:
            throw new Error(`Unknown provider type: ${resource.providerType}`);
    }
}

/**
 * コンテンツをDBに保存
 */
async function saveContent(
    resourceId: string,
    content: string,
    metadata: ContextContentMetadata,
    req: UserRequest
): Promise<number> {
    const contentHash = generateContentHash(content);

    // 既存のコンテンツをチェック
    const existing = await ds.getRepository(ContextContentEntity).findOne({
        where: {
            orgKey: req.info.user.orgKey,
            contextResourceId: resourceId,
            contentHash,
        }
    });

    if (existing) {
        // 既に同じコンテンツが存在する場合はスキップ
        return 0;
    }

    // チャンク分割
    const chunks = splitIntoChunks(content);
    const totalChunks = chunks.length;

    // 同じsourceIdの古いコンテンツを削除
    if (metadata.sourceId) {
        await ds.getRepository(ContextContentEntity).delete({
            orgKey: req.info.user.orgKey,
            contextResourceId: resourceId,
        });
    }

    // チャンクを保存
    for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const entity = new ContextContentEntity();
        entity.contextResourceId = resourceId;
        entity.contentHash = generateContentHash(chunk);
        entity.content = chunk;
        entity.metadata = metadata;
        entity.chunkIndex = i;
        entity.totalChunks = totalChunks;
        entity.tokenCount = Math.ceil(chunk.length / 4); // 簡易推定
        entity.orgKey = req.info.user.orgKey;
        entity.createdBy = req.info.user.id;
        entity.updatedBy = req.info.user.id;
        entity.createdIp = req.info.ip;
        entity.updatedIp = req.info.ip;

        await ds.getRepository(ContextContentEntity).save(entity);
    }

    return chunks.length;
}

// --- Local ---
async function fetchLocalContent(
    resource: ContextResourceEntity,
    req: UserRequest,
    force: boolean
): Promise<number> {
    const config = resource.config as { fileGroupId?: string } | undefined;
    if (!config?.fileGroupId) {
        return 0;
    }

    // ファイル一覧を取得
    const files = await ds.getRepository(FileEntity).find({
        where: {
            orgKey: req.info.user.orgKey,
            fileGroupId: config.fileGroupId,
            isActive: true,
        }
    });

    let totalCount = 0;

    for (const file of files) {
        try {
            const fileBody = await ds.getRepository(FileBodyEntity).findOne({
                where: {
                    orgKey: req.info.user.orgKey,
                    id: file.fileBodyId,
                }
            });

            if (!fileBody) continue;

            // テキストファイルのみ処理
            if (!isTextContent(fileBody.fileType)) continue;

            // ファイルを読み込み
            const buffer = await fs.readFile(fileBody.innerPath);
            const text = await extractTextFromBuffer(buffer, fileBody.fileType);

            if (text) {
                const count = await saveContent(
                    resource.id,
                    text,
                    {
                        title: file.fileName,
                        path: file.filePath,
                        sourceId: file.id,
                        sourceType: 'file',
                        mimeType: fileBody.fileType,
                    },
                    req
                );
                totalCount += count;
            }
        } catch (error) {
            console.error(`Error fetching local file ${file.id}:`, error);
        }
    }

    return totalCount;
}

// --- Box ---
async function fetchBoxContent(
    resource: ContextResourceEntity,
    req: UserRequest,
    force: boolean
): Promise<number> {
    const config = resource.config as { folderId?: string; maxFiles?: number } | undefined;
    if (!config?.folderId) {
        return 0;
    }

    const provider = `box-${resource.providerName}`;
    const e = await getExtApiClient(req.info.user.orgKey, provider);
    const axiosWithAuth = await (await e.axiosWithAuth)(req.info.user.id);
    const baseUrl = e.uriBase || 'https://api.box.com';

    let totalCount = 0;
    const maxFiles = config.maxFiles || 100;

    try {
        // フォルダ内のアイテムを取得
        const response = await axiosWithAuth.get(`${baseUrl}/2.0/folders/${config.folderId}/items`, {
            params: { fields: 'id,name,type,size', limit: maxFiles }
        });

        const items = response.data?.entries || [];

        for (const item of items) {
            if (item.type !== 'file') continue;

            // テキストファイルかどうかを名前で判定
            const ext = item.name.split('.').pop()?.toLowerCase();
            const textExtensions = ['txt', 'md', 'json', 'xml', 'yaml', 'yml', 'js', 'ts', 'py', 'java', 'go', 'rs', 'c', 'cpp', 'h', 'css', 'html', 'sql'];
            if (!textExtensions.includes(ext || '')) continue;

            try {
                // ファイル内容を取得
                const contentResponse = await axiosWithAuth.get(`${baseUrl}/2.0/files/${item.id}/content`, {
                    responseType: 'arraybuffer'
                });

                const text = Buffer.from(contentResponse.data).toString('utf-8');

                const count = await saveContent(
                    resource.id,
                    text,
                    {
                        title: item.name,
                        sourceId: item.id,
                        sourceType: 'file',
                    },
                    req
                );
                totalCount += count;
            } catch (error) {
                console.error(`Error fetching Box file ${item.id}:`, error);
            }
        }
    } catch (error) {
        console.error('Error fetching Box folder:', error);
    }

    return totalCount;
}

// --- GitLab ---
async function fetchGitLabContent(
    resource: ContextResourceEntity,
    req: UserRequest,
    force: boolean
): Promise<number> {
    const config = resource.config as {
        projectId?: number;
        includeTargets?: string[];
        branch?: string;
        maxFiles?: number;
    } | undefined;

    if (!config?.projectId) {
        return 0;
    }

    const provider = `gitlab-${resource.providerName}`;
    const e = await getExtApiClient(req.info.user.orgKey, provider);
    const axiosWithAuth = await (await e.axiosWithAuth)(req.info.user.id);
    const baseUrl = e.uriBase || '';

    let totalCount = 0;
    const includeTargets = config.includeTargets || ['source'];
    const branch = config.branch || 'main';
    const maxFiles = config.maxFiles || 50;

    // ソースファイル
    if (includeTargets.includes('source')) {
        try {
            const treeResponse = await axiosWithAuth.get(`${baseUrl}/api/v4/projects/${config.projectId}/repository/tree`, {
                params: { recursive: true, per_page: maxFiles, ref: branch }
            });

            const files = treeResponse.data || [];
            const textExtensions = ['txt', 'md', 'json', 'xml', 'yaml', 'yml', 'js', 'ts', 'py', 'java', 'go', 'rs', 'c', 'cpp', 'h', 'css', 'html', 'sql', 'sh'];

            for (const file of files) {
                if (file.type !== 'blob') continue;

                const ext = file.path.split('.').pop()?.toLowerCase();
                if (!textExtensions.includes(ext || '')) continue;

                try {
                    const contentResponse = await axiosWithAuth.get(
                        `${baseUrl}/api/v4/projects/${config.projectId}/repository/files/${encodeURIComponent(file.path)}/raw`,
                        { params: { ref: branch } }
                    );

                    const count = await saveContent(
                        resource.id,
                        contentResponse.data,
                        {
                            title: file.name,
                            path: file.path,
                            sourceId: file.id,
                            sourceType: 'file',
                        },
                        req
                    );
                    totalCount += count;
                } catch (error) {
                    console.error(`Error fetching GitLab file ${file.path}:`, error);
                }
            }
        } catch (error) {
            console.error('Error fetching GitLab tree:', error);
        }
    }

    // MR
    if (includeTargets.includes('mr')) {
        try {
            const mrResponse = await axiosWithAuth.get(`${baseUrl}/api/v4/projects/${config.projectId}/merge_requests`, {
                params: { state: 'opened', per_page: 20 }
            });

            for (const mr of mrResponse.data || []) {
                const content = `# ${mr.title}\n\n${mr.description || ''}\n\n---\nAuthor: ${mr.author?.name || 'Unknown'}\nState: ${mr.state}`;

                const count = await saveContent(
                    resource.id,
                    content,
                    {
                        title: mr.title,
                        url: mr.web_url,
                        sourceId: String(mr.iid),
                        sourceType: 'merge_request',
                    },
                    req
                );
                totalCount += count;
            }
        } catch (error) {
            console.error('Error fetching GitLab MRs:', error);
        }
    }

    // Issues
    if (includeTargets.includes('issues')) {
        try {
            const issueResponse = await axiosWithAuth.get(`${baseUrl}/api/v4/projects/${config.projectId}/issues`, {
                params: { state: 'opened', per_page: 20 }
            });

            for (const issue of issueResponse.data || []) {
                const content = `# ${issue.title}\n\n${issue.description || ''}\n\n---\nAuthor: ${issue.author?.name || 'Unknown'}\nState: ${issue.state}\nLabels: ${issue.labels?.join(', ') || 'None'}`;

                const count = await saveContent(
                    resource.id,
                    content,
                    {
                        title: issue.title,
                        url: issue.web_url,
                        sourceId: String(issue.iid),
                        sourceType: 'issue',
                    },
                    req
                );
                totalCount += count;
            }
        } catch (error) {
            console.error('Error fetching GitLab issues:', error);
        }
    }

    return totalCount;
}

// --- Gitea ---
async function fetchGiteaContent(
    resource: ContextResourceEntity,
    req: UserRequest,
    force: boolean
): Promise<number> {
    const config = resource.config as {
        owner?: string;
        repo?: string;
        includeTargets?: string[];
        branch?: string;
        maxFiles?: number;
    } | undefined;

    if (!config?.owner || !config?.repo) {
        return 0;
    }

    const provider = `gitea-${resource.providerName}`;
    const e = await getExtApiClient(req.info.user.orgKey, provider);
    const axiosWithAuth = await (await e.axiosWithAuth)(req.info.user.id);

    let totalCount = 0;
    const includeTargets = config.includeTargets || ['source'];
    const branch = config.branch || 'main';

    // ソースファイル
    if (includeTargets.includes('source')) {
        try {
            const treeResponse = await axiosWithAuth.get(
                `/api/v1/repos/${config.owner}/${config.repo}/git/trees/${branch}`,
                { params: { recursive: true } }
            );

            const files = treeResponse.data?.tree || [];
            const textExtensions = ['txt', 'md', 'json', 'xml', 'yaml', 'yml', 'js', 'ts', 'py', 'java', 'go', 'rs', 'c', 'cpp', 'h', 'css', 'html', 'sql', 'sh'];

            for (const file of files.slice(0, config.maxFiles || 50)) {
                if (file.type !== 'blob') continue;

                const ext = file.path.split('.').pop()?.toLowerCase();
                if (!textExtensions.includes(ext || '')) continue;

                try {
                    const contentResponse = await axiosWithAuth.get(
                        `/api/v1/repos/${config.owner}/${config.repo}/contents/${file.path}`,
                        { params: { ref: branch } }
                    );

                    // Base64デコード
                    const content = Buffer.from(contentResponse.data.content || '', 'base64').toString('utf-8');

                    const count = await saveContent(
                        resource.id,
                        content,
                        {
                            title: file.path.split('/').pop() || file.path,
                            path: file.path,
                            sourceId: file.sha,
                            sourceType: 'file',
                        },
                        req
                    );
                    totalCount += count;
                } catch (error) {
                    console.error(`Error fetching Gitea file ${file.path}:`, error);
                }
            }
        } catch (error) {
            console.error('Error fetching Gitea tree:', error);
        }
    }

    // PR
    if (includeTargets.includes('pr')) {
        try {
            const prResponse = await axiosWithAuth.get(
                `/api/v1/repos/${config.owner}/${config.repo}/pulls`,
                { params: { state: 'open', limit: 20 } }
            );

            for (const pr of prResponse.data || []) {
                const content = `# ${pr.title}\n\n${pr.body || ''}\n\n---\nAuthor: ${pr.user?.login || 'Unknown'}\nState: ${pr.state}`;

                const count = await saveContent(
                    resource.id,
                    content,
                    {
                        title: pr.title,
                        url: pr.html_url,
                        sourceId: String(pr.number),
                        sourceType: 'pull_request',
                    },
                    req
                );
                totalCount += count;
            }
        } catch (error) {
            console.error('Error fetching Gitea PRs:', error);
        }
    }

    // Issues
    if (includeTargets.includes('issues')) {
        try {
            const issueResponse = await axiosWithAuth.get(
                `/api/v1/repos/${config.owner}/${config.repo}/issues`,
                { params: { state: 'open', limit: 20 } }
            );

            for (const issue of issueResponse.data || []) {
                const content = `# ${issue.title}\n\n${issue.body || ''}\n\n---\nAuthor: ${issue.user?.login || 'Unknown'}\nState: ${issue.state}`;

                const count = await saveContent(
                    resource.id,
                    content,
                    {
                        title: issue.title,
                        url: issue.html_url,
                        sourceId: String(issue.number),
                        sourceType: 'issue',
                    },
                    req
                );
                totalCount += count;
            }
        } catch (error) {
            console.error('Error fetching Gitea issues:', error);
        }
    }

    return totalCount;
}

// --- Mattermost ---
async function fetchMattermostContent(
    resource: ContextResourceEntity,
    req: UserRequest,
    force: boolean
): Promise<number> {
    const config = resource.config as {
        sourceType?: 'channel' | 'timeline';
        channelIds?: string[];
        maxPosts?: number;
    } | undefined;

    if (!config?.channelIds || config.channelIds.length === 0) {
        return 0;
    }

    const provider = `mattermost-${resource.providerName}`;
    const e = await getExtApiClient(req.info.user.orgKey, provider);
    const axiosWithAuth = await (await e.axiosWithAuth)(req.info.user.id);
    const baseUrl = e.uriBase || '';

    let totalCount = 0;
    const maxPosts = config.maxPosts || 100;

    for (const channelId of config.channelIds) {
        try {
            // チャンネル情報
            const channelResponse = await axiosWithAuth.get(`${baseUrl}/api/v4/channels/${channelId}`);
            const channelName = channelResponse.data?.display_name || channelId;

            // 投稿を取得
            const postsResponse = await axiosWithAuth.get(`${baseUrl}/api/v4/channels/${channelId}/posts`, {
                params: { per_page: maxPosts }
            });

            const postsData = postsResponse.data;
            const order = postsData?.order || [];
            const posts = postsData?.posts || {};

            // 投稿を時系列順に結合
            const messages = order
                .map((id: string) => posts[id])
                .filter((p: any) => p && p.message)
                .reverse()
                .map((p: any) => `[${new Date(p.create_at).toISOString()}] ${p.message}`)
                .join('\n\n');

            if (messages) {
                const count = await saveContent(
                    resource.id,
                    `# ${channelName}\n\n${messages}`,
                    {
                        title: channelName,
                        sourceId: channelId,
                        sourceType: 'channel',
                    },
                    req
                );
                totalCount += count;
            }
        } catch (error) {
            console.error(`Error fetching Mattermost channel ${channelId}:`, error);
        }
    }

    return totalCount;
}

// --- Confluence ---
async function fetchConfluenceContent(
    resource: ContextResourceEntity,
    req: UserRequest,
    force: boolean
): Promise<number> {
    const config = resource.config as {
        spaceKey?: string;
        pageId?: string;
        maxPages?: number;
    } | undefined;

    if (!config?.spaceKey) {
        return 0;
    }

    const provider = `confluence-${resource.providerName}`;
    const e = await getExtApiClient(req.info.user.orgKey, provider);
    const axiosWithAuth = await (await e.axiosWithAuth)(req.info.user.id);
    const baseUrl = e.uriBase || '';

    let totalCount = 0;
    const maxPages = config.maxPages || 50;

    try {
        let pages: any[] = [];

        if (config.pageId) {
            // 特定ページの子ページを取得
            const childResponse = await axiosWithAuth.get(
                `${baseUrl}/wiki/rest/api/content/${config.pageId}/child/page`,
                { params: { limit: maxPages, expand: 'body.storage' } }
            );
            pages = childResponse.data?.results || [];

            // 親ページも取得
            const parentResponse = await axiosWithAuth.get(
                `${baseUrl}/wiki/rest/api/content/${config.pageId}`,
                { params: { expand: 'body.storage' } }
            );
            if (parentResponse.data) {
                pages.unshift(parentResponse.data);
            }
        } else {
            // スペース内のページを取得
            const contentResponse = await axiosWithAuth.get(`${baseUrl}/wiki/rest/api/content`, {
                params: { spaceKey: config.spaceKey, limit: maxPages, expand: 'body.storage' }
            });
            pages = contentResponse.data?.results || [];
        }

        for (const page of pages) {
            try {
                // HTMLからテキストを抽出（簡易版）
                const htmlContent = page.body?.storage?.value || '';
                const textContent = htmlContent
                    .replace(/<[^>]*>/g, ' ')
                    .replace(/&nbsp;/g, ' ')
                    .replace(/&amp;/g, '&')
                    .replace(/&lt;/g, '<')
                    .replace(/&gt;/g, '>')
                    .replace(/\s+/g, ' ')
                    .trim();

                if (textContent) {
                    const count = await saveContent(
                        resource.id,
                        `# ${page.title}\n\n${textContent}`,
                        {
                            title: page.title,
                            url: page._links?.webui,
                            sourceId: page.id,
                            sourceType: 'page',
                        },
                        req
                    );
                    totalCount += count;
                }
            } catch (error) {
                console.error(`Error processing Confluence page ${page.id}:`, error);
            }
        }
    } catch (error) {
        console.error('Error fetching Confluence content:', error);
    }

    return totalCount;
}

// --- Jira ---
async function fetchJiraContent(
    resource: ContextResourceEntity,
    req: UserRequest,
    force: boolean
): Promise<number> {
    const config = resource.config as {
        queryType?: 'project' | 'jql';
        projectKey?: string;
        jql?: string;
        maxIssues?: number;
    } | undefined;

    if (!config) {
        return 0;
    }

    const provider = `jira-${resource.providerName}`;
    const e = await getExtApiClient(req.info.user.orgKey, provider);
    const axiosWithAuth = await (await e.axiosWithAuth)(req.info.user.id);
    const baseUrl = e.uriBase || '';

    let totalCount = 0;
    const maxIssues = config.maxIssues || 50;

    try {
        let jql = '';
        if (config.queryType === 'project' && config.projectKey) {
            jql = `project = ${config.projectKey} ORDER BY updated DESC`;
        } else if (config.queryType === 'jql' && config.jql) {
            jql = config.jql;
        } else {
            return 0;
        }

        const searchResponse = await axiosWithAuth.get(`${baseUrl}/rest/api/3/search`, {
            params: {
                jql,
                maxResults: maxIssues,
                fields: 'summary,description,status,assignee,reporter,labels,comment'
            }
        });

        for (const issue of searchResponse.data?.issues || []) {
            const fields = issue.fields || {};

            // ADF形式のdescriptionをテキストに変換（簡易版）
            let description = '';
            if (fields.description?.content) {
                description = extractTextFromADF(fields.description);
            }

            const content = `# ${issue.key}: ${fields.summary}

## Description
${description || 'No description'}

## Details
- Status: ${fields.status?.name || 'Unknown'}
- Assignee: ${fields.assignee?.displayName || 'Unassigned'}
- Reporter: ${fields.reporter?.displayName || 'Unknown'}
- Labels: ${fields.labels?.join(', ') || 'None'}
`;

            const count = await saveContent(
                resource.id,
                content,
                {
                    title: `${issue.key}: ${fields.summary}`,
                    sourceId: issue.key,
                    sourceType: 'issue',
                },
                req
            );
            totalCount += count;
        }
    } catch (error) {
        console.error('Error fetching Jira content:', error);
    }

    return totalCount;
}

/**
 * Atlassian Document Format (ADF) からテキストを抽出
 */
function extractTextFromADF(adf: any): string {
    if (!adf || !adf.content) return '';

    const extractFromNode = (node: any): string => {
        if (node.type === 'text') {
            return node.text || '';
        }
        if (node.content) {
            return node.content.map(extractFromNode).join('');
        }
        return '';
    };

    return adf.content.map(extractFromNode).join('\n').trim();
}

// --- Web ---
async function fetchWebContent(
    resource: ContextResourceEntity,
    req: UserRequest,
    force: boolean
): Promise<number> {
    const config = resource.config as {
        sourceType?: 'url' | 'sitelist';
        urls?: string[];
        sitelistContent?: string;
    } | undefined;

    if (!config) {
        return 0;
    }

    let urls: string[] = [];

    if (config.sourceType === 'url' && config.urls) {
        urls = config.urls;
    } else if (config.sourceType === 'sitelist' && config.sitelistContent) {
        urls = config.sitelistContent.split('\n').filter(line => line.trim()).map(line => line.trim());
    }

    let totalCount = 0;

    for (const url of urls) {
        try {
            // 簡易的なWebスクレイピング（fetch使用）
            const response = await fetch(url, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (compatible; ContextHub/1.0)'
                }
            });

            if (!response.ok) continue;

            const html = await response.text();

            // HTMLからテキストを抽出（簡易版）
            const textContent = html
                .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
                .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
                .replace(/<[^>]*>/g, ' ')
                .replace(/&nbsp;/g, ' ')
                .replace(/&amp;/g, '&')
                .replace(/&lt;/g, '<')
                .replace(/&gt;/g, '>')
                .replace(/\s+/g, ' ')
                .trim();

            // タイトルを抽出
            const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
            const title = titleMatch ? titleMatch[1].trim() : url;

            if (textContent) {
                const count = await saveContent(
                    resource.id,
                    `# ${title}\n\nSource: ${url}\n\n${textContent}`,
                    {
                        title,
                        url,
                        sourceId: url,
                        sourceType: 'webpage',
                    },
                    req
                );
                totalCount += count;
            }
        } catch (error) {
            console.error(`Error fetching web page ${url}:`, error);
        }
    }

    return totalCount;
}

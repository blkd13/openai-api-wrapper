import { Request } from 'express';
import { In } from 'typeorm';
import { Utils } from '../../common/utils.js';
import { ds } from '../db.js';
import { ContextResourceEntity, ContextResourceProviderType, ContextResourceSyncStatus } from '../entity/context-hub.entity.js';
import { FileEntity, FileGroupEntity } from '../entity/file-models.entity.js';
import { UserRequest } from '../models/info.js';
import { getExtApiClient } from './auth.js';

// ============================================
// Sync Service
// ============================================

/**
 * 単一リソースの同期処理
 */
export async function syncResource(resource: ContextResourceEntity, _req: Request): Promise<ContextResourceEntity> {
    const req = _req as UserRequest;

    // syncStatus を 'syncing' に更新
    resource.syncStatus = ContextResourceSyncStatus.Syncing;
    resource.lastError = undefined;
    resource.updatedBy = req.info.user.id;
    resource.updatedIp = req.info.ip;
    await ds.getRepository(ContextResourceEntity).save(resource);

    try {
        // プロバイダーごとの同期処理
        const metadata = await syncByProviderType(resource, req);

        // 成功時の更新
        resource.syncStatus = ContextResourceSyncStatus.Synced;
        resource.lastSyncAt = new Date();
        resource.itemCount = metadata.itemCount;
        resource.lastError = undefined;
        resource.updatedBy = req.info.user.id;
        resource.updatedIp = req.info.ip;

        return await ds.getRepository(ContextResourceEntity).save(resource);
    } catch (error) {
        // エラー時の更新
        resource.syncStatus = ContextResourceSyncStatus.Error;
        resource.lastError = error instanceof Error ? error.message : String(error);
        resource.updatedBy = req.info.user.id;
        resource.updatedIp = req.info.ip;

        await ds.getRepository(ContextResourceEntity).save(resource);
        throw error;
    }
}

/**
 * Hub内の全リソースの同期処理
 */
export async function syncAllResources(hubId: string, _req: Request): Promise<ContextResourceEntity[]> {
    const req = _req as UserRequest;

    const resources = await ds.getRepository(ContextResourceEntity).find({
        where: {
            orgKey: req.info.user.orgKey,
            contextHubId: hubId,
            isActive: true,
        },
        order: { sortOrder: 'ASC', createdAt: 'ASC' }
    });

    const results: ContextResourceEntity[] = [];

    for (const resource of resources) {
        try {
            const synced = await syncResource(resource, req);
            results.push(synced);
        } catch (error) {
            // エラーが発生しても続行
            console.error(`Error syncing resource ${resource.id}:`, error);
            results.push(resource);
        }
    }

    return results;
}

// ============================================
// Provider-specific sync handlers
// ============================================

interface SyncMetadata {
    itemCount: number;
}

async function syncByProviderType(resource: ContextResourceEntity, req: UserRequest): Promise<SyncMetadata> {
    switch (resource.providerType) {
        case ContextResourceProviderType.Local:
            return syncLocalResource(resource, req);
        case ContextResourceProviderType.Box:
            return syncBoxResource(resource, req);
        case ContextResourceProviderType.GitLab:
            return syncGitLabResource(resource, req);
        case ContextResourceProviderType.Gitea:
            return syncGiteaResource(resource, req);
        case ContextResourceProviderType.Mattermost:
            return syncMattermostResource(resource, req);
        case ContextResourceProviderType.Confluence:
            return syncConfluenceResource(resource, req);
        case ContextResourceProviderType.Jira:
            return syncJiraResource(resource, req);
        case ContextResourceProviderType.Web:
            return syncWebResource(resource, req);
        default:
            throw new Error(`Unknown provider type: ${resource.providerType}`);
    }
}

// --- Local ---
async function syncLocalResource(resource: ContextResourceEntity, req: UserRequest): Promise<SyncMetadata> {
    const config = resource.config as { fileGroupId?: string } | undefined;
    if (!config?.fileGroupId) {
        return { itemCount: 0 };
    }

    const fileCount = await ds.getRepository(FileEntity).count({
        where: {
            orgKey: req.info.user.orgKey,
            fileGroupId: config.fileGroupId,
        }
    });

    return { itemCount: fileCount };
}

// --- Box ---
async function syncBoxResource(resource: ContextResourceEntity, req: UserRequest): Promise<SyncMetadata> {
    const config = resource.config as { folderId?: string } | undefined;
    if (!config?.folderId) {
        return { itemCount: 0 };
    }

    const provider = `box-${resource.providerName}`;
    const e = await getExtApiClient(req.info.user.orgKey, provider);
    const axiosWithAuth = await (await e.axiosWithAuth)(req.info.user.id);

    // Box API: Get folder items count
    const response = await axiosWithAuth.get(`/2.0/folders/${config.folderId}`, {
        params: { fields: 'item_collection' }
    });

    const itemCount = response.data?.item_collection?.total_count ?? 0;
    return { itemCount };
}

// --- GitLab ---
async function syncGitLabResource(resource: ContextResourceEntity, req: UserRequest): Promise<SyncMetadata> {
    const config = resource.config as { projectId?: number; includeTargets?: string[] } | undefined;
    if (!config?.projectId) {
        return { itemCount: 0 };
    }

    const provider = `gitlab-${resource.providerName}`;
    const e = await getExtApiClient(req.info.user.orgKey, provider);
    const axiosWithAuth = await (await e.axiosWithAuth)(req.info.user.id);

    let totalCount = 0;
    const includeTargets = config.includeTargets || ['source'];

    // ファイル数を取得（リポジトリツリー）
    if (includeTargets.includes('source')) {
        try {
            const treeResponse = await axiosWithAuth.get(`/api/v4/projects/${config.projectId}/repository/tree`, {
                params: { recursive: true, per_page: 1 },
                // ヘッダーから total を取得するため
            });
            totalCount += parseInt(treeResponse.headers['x-total'] || '0', 10);
        } catch { /* ignore */ }
    }

    // MR数
    if (includeTargets.includes('mr')) {
        try {
            const mrResponse = await axiosWithAuth.get(`/api/v4/projects/${config.projectId}/merge_requests`, {
                params: { state: 'all', per_page: 1 }
            });
            totalCount += parseInt(mrResponse.headers['x-total'] || '0', 10);
        } catch { /* ignore */ }
    }

    // Issue数
    if (includeTargets.includes('issues')) {
        try {
            const issueResponse = await axiosWithAuth.get(`/api/v4/projects/${config.projectId}/issues`, {
                params: { state: 'all', per_page: 1 }
            });
            totalCount += parseInt(issueResponse.headers['x-total'] || '0', 10);
        } catch { /* ignore */ }
    }

    return { itemCount: totalCount };
}

// --- Gitea ---
async function syncGiteaResource(resource: ContextResourceEntity, req: UserRequest): Promise<SyncMetadata> {
    const config = resource.config as { owner?: string; repo?: string; includeTargets?: string[] } | undefined;
    if (!config?.owner || !config?.repo) {
        return { itemCount: 0 };
    }

    const provider = `gitea-${resource.providerName}`;
    const e = await getExtApiClient(req.info.user.orgKey, provider);
    const axiosWithAuth = await (await e.axiosWithAuth)(req.info.user.id);

    let totalCount = 0;
    const includeTargets = config.includeTargets || ['source'];

    // リポジトリ情報
    if (includeTargets.includes('source')) {
        try {
            const repoResponse = await axiosWithAuth.get(`/api/v1/repos/${config.owner}/${config.repo}`);
            // Giteaはファイル数を直接返さないので、とりあえず1としてカウント
            totalCount += 1;
        } catch { /* ignore */ }
    }

    // PR数
    if (includeTargets.includes('pr')) {
        try {
            const prResponse = await axiosWithAuth.get(`/api/v1/repos/${config.owner}/${config.repo}/pulls`, {
                params: { state: 'all', page: 1, limit: 1 }
            });
            totalCount += parseInt(prResponse.headers['x-total-count'] || '0', 10);
        } catch { /* ignore */ }
    }

    // Issue数
    if (includeTargets.includes('issues')) {
        try {
            const issueResponse = await axiosWithAuth.get(`/api/v1/repos/${config.owner}/${config.repo}/issues`, {
                params: { state: 'all', page: 1, limit: 1 }
            });
            totalCount += parseInt(issueResponse.headers['x-total-count'] || '0', 10);
        } catch { /* ignore */ }
    }

    return { itemCount: totalCount };
}

// --- Mattermost ---
async function syncMattermostResource(resource: ContextResourceEntity, req: UserRequest): Promise<SyncMetadata> {
    const config = resource.config as {
        sourceType?: 'channel' | 'timeline';
        channelIds?: string[];
        teamId?: string;
    } | undefined;

    if (!config) {
        return { itemCount: 0 };
    }

    const provider = `mattermost-${resource.providerName}`;
    const e = await getExtApiClient(req.info.user.orgKey, provider);
    const axiosWithAuth = await (await e.axiosWithAuth)(req.info.user.id);

    let totalCount = 0;

    if (config.sourceType === 'channel' && config.channelIds && config.channelIds.length > 0) {
        // チャンネルごとの投稿数を取得
        for (const channelId of config.channelIds) {
            try {
                const statsResponse = await axiosWithAuth.get(`/api/v4/channels/${channelId}/stats`);
                totalCount += statsResponse.data?.message_count ?? 0;
            } catch { /* ignore */ }
        }
    }

    return { itemCount: totalCount };
}

// --- Confluence ---
async function syncConfluenceResource(resource: ContextResourceEntity, req: UserRequest): Promise<SyncMetadata> {
    const config = resource.config as {
        spaceKey?: string;
        pageId?: string;
    } | undefined;

    if (!config?.spaceKey) {
        return { itemCount: 0 };
    }

    const provider = `confluence-${resource.providerName}`;
    const e = await getExtApiClient(req.info.user.orgKey, provider);
    const axiosWithAuth = await (await e.axiosWithAuth)(req.info.user.id);

    let totalCount = 0;

    try {
        if (config.pageId) {
            // 特定ページの子ページ数を取得
            const childResponse = await axiosWithAuth.get(`/wiki/rest/api/content/${config.pageId}/child/page`, {
                params: { limit: 1 }
            });
            totalCount = childResponse.data?.size ?? 1;
        } else {
            // スペース内のページ数を取得
            const contentResponse = await axiosWithAuth.get(`/wiki/rest/api/content`, {
                params: { spaceKey: config.spaceKey, limit: 1 }
            });
            totalCount = contentResponse.data?.size ?? 0;
        }
    } catch (error) {
        console.error('Confluence sync error:', error);
    }

    return { itemCount: totalCount };
}

// --- Jira ---
async function syncJiraResource(resource: ContextResourceEntity, req: UserRequest): Promise<SyncMetadata> {
    const config = resource.config as {
        queryType?: 'project' | 'jql';
        projectKey?: string;
        jql?: string;
    } | undefined;

    if (!config) {
        return { itemCount: 0 };
    }

    const provider = `jira-${resource.providerName}`;
    const e = await getExtApiClient(req.info.user.orgKey, provider);
    const axiosWithAuth = await (await e.axiosWithAuth)(req.info.user.id);

    let totalCount = 0;

    try {
        let jql = '';
        if (config.queryType === 'project' && config.projectKey) {
            jql = `project = ${config.projectKey}`;
        } else if (config.queryType === 'jql' && config.jql) {
            jql = config.jql;
        }

        if (jql) {
            const searchResponse = await axiosWithAuth.get(`/rest/api/3/search`, {
                params: { jql, maxResults: 0 }
            });
            totalCount = searchResponse.data?.total ?? 0;
        }
    } catch (error) {
        console.error('Jira sync error:', error);
    }

    return { itemCount: totalCount };
}

// --- Web ---
async function syncWebResource(resource: ContextResourceEntity, req: UserRequest): Promise<SyncMetadata> {
    const config = resource.config as {
        sourceType?: 'url' | 'sitelist';
        urls?: string[];
        sitelistContent?: string;
    } | undefined;

    if (!config) {
        return { itemCount: 0 };
    }

    let urlCount = 0;

    if (config.sourceType === 'url' && config.urls) {
        urlCount = config.urls.length;
    } else if (config.sourceType === 'sitelist' && config.sitelistContent) {
        // サイトリストの行数をカウント
        urlCount = config.sitelistContent.split('\n').filter(line => line.trim()).length;
    }

    return { itemCount: urlCount };
}

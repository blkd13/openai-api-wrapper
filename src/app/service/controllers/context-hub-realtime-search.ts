import { Request } from 'express';
import { getAxios } from '../../common/http-client.js';
import { ds } from '../db.js';
import { ContextResourceEntity, ContextResourceProviderType, ContextSearchMode } from '../entity/context-hub.entity.js';
import { UserRequest } from '../models/info.js';
import { getExtApiClient } from './auth.js';

// ============================================
// Types
// ============================================

export interface RealtimeSearchResult {
    resourceId: string;
    resourceLabel: string;
    title: string;
    content: string;
    url?: string;
    score?: number;
    metadata?: {
        path?: string;
        author?: string;
        lastModified?: Date;
        sourceType?: string;
    };
}

export interface RealtimeSearchRequest {
    query: string;
    resourceIds?: string[];
    limit?: number;
}

export interface RealtimeSearchResponse {
    results: RealtimeSearchResult[];
    query: string;
    searchMode: 'realtime';
}

// ============================================
// Main Entry Point
// ============================================

/**
 * 複数リソースに対してリアルタイム検索を実行
 */
export async function searchRealtimeMultiple(
    hubId: string,
    request: RealtimeSearchRequest,
    _req: Request
): Promise<RealtimeSearchResponse> {
    const req = _req as UserRequest;
    const { query, resourceIds, limit = 10 } = request;

    // 対象リソースを取得
    let resources = await ds.getRepository(ContextResourceEntity).find({
        where: {
            orgKey: req.info.user.orgKey,
            contextHubId: hubId,
            isActive: true,
        },
    });

    // resourceIds が指定されている場合はフィルタ
    if (resourceIds && resourceIds.length > 0) {
        resources = resources.filter(r => resourceIds.includes(r.id));
    }

    // realtime モードのリソースのみ対象（vectorモード固定のものは除外）
    resources = resources.filter(r => {
        // Gitea/Local は vector のみなので除外
        if (r.providerType === ContextResourceProviderType.Gitea ||
            r.providerType === ContextResourceProviderType.Local) {
            return false;
        }
        // searchMode が vector の場合も除外
        if (r.searchMode === ContextSearchMode.Vector) {
            return false;
        }
        return true;
    });

    // 各リソースに対して並列で検索実行
    const searchPromises = resources.map(async resource => {
        try {
            return await searchRealtime(resource, query, req, limit);
        } catch (error) {
            console.error(`Realtime search error for resource ${resource.id}:`, error);
            return [];
        }
    });

    const resultsArrays = await Promise.all(searchPromises);
    const allResults = resultsArrays.flat();

    // スコアでソート（スコアがあれば）
    allResults.sort((a, b) => (b.score || 0) - (a.score || 0));

    // limit で切り詰め
    const limitedResults = allResults.slice(0, limit);

    return {
        results: limitedResults,
        query,
        searchMode: 'realtime',
    };
}

/**
 * 単一リソースに対するリアルタイム検索
 */
export async function searchRealtime(
    resource: ContextResourceEntity,
    query: string,
    req: UserRequest,
    limit: number = 10
): Promise<RealtimeSearchResult[]> {
    switch (resource.providerType) {
        case ContextResourceProviderType.Box:
            return searchBox(resource, query, req, limit);
        case ContextResourceProviderType.GitLab:
            return searchGitLab(resource, query, req, limit);
        case ContextResourceProviderType.Mattermost:
            return searchMattermost(resource, query, req, limit);
        case ContextResourceProviderType.Confluence:
            return searchConfluence(resource, query, req, limit);
        case ContextResourceProviderType.Jira:
            return searchJira(resource, query, req, limit);
        case ContextResourceProviderType.Web:
            return searchWeb(resource, query, req, limit);
        case ContextResourceProviderType.Gitea:
        case ContextResourceProviderType.Local:
            // これらは realtime 検索非対応
            return [];
        default:
            console.warn(`Unknown provider type for realtime search: ${resource.providerType}`);
            return [];
    }
}

// ============================================
// Provider-specific Search Implementations
// ============================================

// --- Box ---
async function searchBox(
    resource: ContextResourceEntity,
    query: string,
    req: UserRequest,
    limit: number
): Promise<RealtimeSearchResult[]> {
    const config = resource.config as { folderId?: string } | undefined;
    if (!config?.folderId) {
        return [];
    }

    const provider = `box-${resource.providerName}`;
    const e = await getExtApiClient(req.info.user.orgKey, provider);
    const axiosWithAuth = await (await e.axiosWithAuth)(req.info.user.id);
    const baseUrl = e.uriBase || 'https://api.box.com';

    try {
        const response = await axiosWithAuth.get(`${baseUrl}/2.0/search`, {
            params: {
                query,
                ancestor_folder_ids: config.folderId,
                content_types: 'name,description,file_content',
                limit,
            }
        });

        const entries = response.data?.entries || [];
        return entries.map((item: any) => ({
            resourceId: resource.id,
            resourceLabel: resource.label,
            title: item.name || 'Untitled',
            content: item.description || '',
            url: item.shared_link?.url || `https://app.box.com/file/${item.id}`,
            metadata: {
                path: item.path_collection?.entries?.map((e: any) => e.name).join('/'),
                author: item.modified_by?.name,
                lastModified: item.modified_at ? new Date(item.modified_at) : undefined,
                sourceType: item.type,
            },
        }));
    } catch (error) {
        console.error('Box search error:', error);
        return [];
    }
}

// --- GitLab ---
async function searchGitLab(
    resource: ContextResourceEntity,
    query: string,
    req: UserRequest,
    limit: number
): Promise<RealtimeSearchResult[]> {
    const config = resource.config as { projectId?: number; includeTargets?: string[] } | undefined;
    if (!config?.projectId) {
        return [];
    }

    const provider = `gitlab-${resource.providerName}`;
    const e = await getExtApiClient(req.info.user.orgKey, provider);
    const axiosWithAuth = await (await e.axiosWithAuth)(req.info.user.id);
    const baseUrl = e.uriBase || '';

    const allResults: RealtimeSearchResult[] = [];
    const includeTargets = config.includeTargets || ['issues', 'merge_requests'];

    // GitLab search scopes mapping
    const scopeMap: Record<string, string> = {
        'source': 'blobs',
        'issues': 'issues',
        'mr': 'merge_requests',
    };

    const searchScopes = includeTargets
        .map(t => scopeMap[t])
        .filter(Boolean);

    try {
        const searchPromises = searchScopes.map(async scope => {
            const response = await axiosWithAuth.get(
                `${baseUrl}/api/v4/projects/${config.projectId}/search`,
                { params: { scope, search: query, per_page: limit } }
            );
            return { scope, items: response.data || [] };
        });

        const scopeResults = await Promise.all(searchPromises);

        for (const { scope, items } of scopeResults) {
            for (const item of items) {
                let result: RealtimeSearchResult;

                if (scope === 'blobs') {
                    result = {
                        resourceId: resource.id,
                        resourceLabel: resource.label,
                        title: item.filename || item.path || 'Code',
                        content: item.data || '',
                        url: item.web_url || `${baseUrl}/${item.project_id}/-/blob/${item.ref}/${item.path}`,
                        metadata: {
                            path: item.path,
                            sourceType: 'code',
                        },
                    };
                } else if (scope === 'issues') {
                    result = {
                        resourceId: resource.id,
                        resourceLabel: resource.label,
                        title: `#${item.iid}: ${item.title}`,
                        content: item.description || '',
                        url: item.web_url,
                        metadata: {
                            author: item.author?.name,
                            lastModified: item.updated_at ? new Date(item.updated_at) : undefined,
                            sourceType: 'issue',
                        },
                    };
                } else if (scope === 'merge_requests') {
                    result = {
                        resourceId: resource.id,
                        resourceLabel: resource.label,
                        title: `!${item.iid}: ${item.title}`,
                        content: item.description || '',
                        url: item.web_url,
                        metadata: {
                            author: item.author?.name,
                            lastModified: item.updated_at ? new Date(item.updated_at) : undefined,
                            sourceType: 'mr',
                        },
                    };
                } else {
                    continue;
                }

                allResults.push(result);
            }
        }
    } catch (error) {
        console.error('GitLab search error:', error);
    }

    return allResults.slice(0, limit);
}

// --- Mattermost ---
async function searchMattermost(
    resource: ContextResourceEntity,
    query: string,
    req: UserRequest,
    limit: number
): Promise<RealtimeSearchResult[]> {
    const config = resource.config as {
        teamId?: string;
        channelIds?: string[];
    } | undefined;

    if (!config?.teamId) {
        return [];
    }

    const provider = `mattermost-${resource.providerName}`;
    const e = await getExtApiClient(req.info.user.orgKey, provider);
    const axiosWithAuth = await (await e.axiosWithAuth)(req.info.user.id);
    const baseUrl = e.uriBase || '';

    try {
        // Mattermost search uses POST
        let searchTerms = query;

        // チャンネル制限がある場合
        if (config.channelIds && config.channelIds.length > 0) {
            const channelFilter = config.channelIds.map(id => `in:${id}`).join(' ');
            searchTerms = `${channelFilter} ${query}`;
        }

        const response = await axiosWithAuth.post(`${baseUrl}/api/v4/teams/${config.teamId}/posts/search`, {
            terms: searchTerms,
            is_or_search: true,
        });

        const posts = response.data?.posts || {};
        const order = response.data?.order || [];

        return order.slice(0, limit).map((postId: string) => {
            const post = posts[postId];
            return {
                resourceId: resource.id,
                resourceLabel: resource.label,
                title: `Message by ${post.user_id}`,
                content: post.message || '',
                url: `${baseUrl}/${config.teamId}/pl/${postId}`,
                metadata: {
                    author: post.user_id,
                    lastModified: post.update_at ? new Date(post.update_at) : undefined,
                    sourceType: 'post',
                },
            };
        });
    } catch (error) {
        console.error('Mattermost search error:', error);
        return [];
    }
}

// --- Confluence ---
async function searchConfluence(
    resource: ContextResourceEntity,
    query: string,
    req: UserRequest,
    limit: number
): Promise<RealtimeSearchResult[]> {
    const config = resource.config as {
        spaceKey?: string;
        pageId?: string;
    } | undefined;

    if (!config?.spaceKey) {
        return [];
    }

    const provider = `confluence-${resource.providerName}`;
    const e = await getExtApiClient(req.info.user.orgKey, provider);
    const axiosWithAuth = await (await e.axiosWithAuth)(req.info.user.id);
    const baseUrl = e.uriBase || '';

    try {
        // CQLクエリ構築
        // クエリ内の特殊文字をエスケープ
        const escapedQuery = query.replace(/"/g, '\\"');
        let cql = `space = "${config.spaceKey}" AND (title ~ "${escapedQuery}" OR text ~ "${escapedQuery}")`;

        if (config.pageId) {
            cql += ` AND ancestor = ${config.pageId}`;
        }

        const response = await axiosWithAuth.get(`${baseUrl}/wiki/rest/api/search`, {
            params: {
                cql,
                limit,
                expand: 'content.body.view',
            }
        });

        const results = response.data?.results || [];
        return results.map((item: any) => ({
            resourceId: resource.id,
            resourceLabel: resource.label,
            title: item.content?.title || item.title || 'Untitled',
            content: item.excerpt || item.content?.body?.view?.value || '',
            url: item.content?._links?.webui
                ? `${baseUrl}/wiki${item.content._links.webui}`
                : undefined,
            metadata: {
                path: item.content?.space?.name,
                author: item.content?.history?.createdBy?.displayName,
                lastModified: item.content?.history?.lastUpdated?.when
                    ? new Date(item.content.history.lastUpdated.when)
                    : undefined,
                sourceType: 'page',
            },
        }));
    } catch (error) {
        console.error('Confluence search error:', error);
        return [];
    }
}

// --- Jira ---
async function searchJira(
    resource: ContextResourceEntity,
    query: string,
    req: UserRequest,
    limit: number
): Promise<RealtimeSearchResult[]> {
    const config = resource.config as {
        queryType?: 'project' | 'jql';
        projectKey?: string;
        jql?: string;
    } | undefined;

    if (!config) {
        return [];
    }

    const provider = `jira-${resource.providerName}`;
    const e = await getExtApiClient(req.info.user.orgKey, provider);
    const axiosWithAuth = await (await e.axiosWithAuth)(req.info.user.id);
    const baseUrl = e.uriBase || '';

    try {
        // JQLクエリ構築
        // クエリ内の特殊文字をエスケープ
        const escapedQuery = query.replace(/"/g, '\\"');
        let jql = '';

        if (config.queryType === 'jql' && config.jql) {
            jql = `(${config.jql}) AND text ~ "${escapedQuery}"`;
        } else if (config.projectKey) {
            jql = `project = "${config.projectKey}" AND text ~ "${escapedQuery}"`;
        } else {
            jql = `text ~ "${escapedQuery}"`;
        }

        const response = await axiosWithAuth.get(`${baseUrl}/rest/api/3/search`, {
            params: {
                jql,
                maxResults: limit,
                fields: 'summary,description,assignee,reporter,updated',
            }
        });

        const issues = response.data?.issues || [];
        return issues.map((issue: any) => ({
            resourceId: resource.id,
            resourceLabel: resource.label,
            title: `${issue.key}: ${issue.fields?.summary || 'Untitled'}`,
            content: issue.fields?.description?.content
                ?.map((c: any) => c.content?.map((t: any) => t.text).join('')).join('\n') || '',
            url: `${baseUrl}/browse/${issue.key}`,
            metadata: {
                author: issue.fields?.reporter?.displayName,
                lastModified: issue.fields?.updated ? new Date(issue.fields.updated) : undefined,
                sourceType: 'issue',
            },
        }));
    } catch (error) {
        console.error('Jira search error:', error);
        return [];
    }
}

// --- Web (Google Custom Search) ---
async function searchWeb(
    resource: ContextResourceEntity,
    query: string,
    req: UserRequest,
    limit: number
): Promise<RealtimeSearchResult[]> {
    const config = resource.config as {
        sourceType?: 'url' | 'sitelist';
        urls?: string[];
        sitelistContent?: string;
    } | undefined;

    if (!config) {
        return [];
    }

    const GOOGLE_CUSTOM_SEARCH_API_KEY = process.env.GOOGLE_CUSTOM_SEARCH_API_KEY;
    const GOOGLE_CSE_ID = process.env.GOOGLE_CSE_ID;

    if (!GOOGLE_CUSTOM_SEARCH_API_KEY || !GOOGLE_CSE_ID) {
        console.warn('Google Custom Search API credentials not configured');
        return [];
    }

    try {
        // URL一覧からドメインを抽出
        let urls: string[] = [];
        if (config.sourceType === 'url' && config.urls) {
            urls = config.urls;
        } else if (config.sourceType === 'sitelist' && config.sitelistContent) {
            urls = config.sitelistContent.split('\n').filter(line => line.trim());
        }

        if (urls.length === 0) {
            return [];
        }

        // ドメインを抽出
        const domains = extractDomains(urls);

        // site: パラメータを構築
        const siteQuery = domains.map(d => `site:${d}`).join(' OR ');
        const fullQuery = `(${siteQuery}) ${query}`;

        const axios = await getAxios('https://www.googleapis.com');
        const response = await axios.get('/customsearch/v1', {
            params: {
                key: GOOGLE_CUSTOM_SEARCH_API_KEY,
                cx: GOOGLE_CSE_ID,
                q: fullQuery,
                num: Math.min(limit, 10), // Google API max is 10
            }
        });

        const items = response.data?.items || [];
        return items.map((item: any) => ({
            resourceId: resource.id,
            resourceLabel: resource.label,
            title: item.title || 'Untitled',
            content: item.snippet || '',
            url: item.link,
            metadata: {
                sourceType: 'web',
            },
        }));
    } catch (error) {
        console.error('Web (Google) search error:', error);
        return [];
    }
}

// ============================================
// Helper Functions
// ============================================

function extractDomains(urls: string[]): string[] {
    const domains = new Set<string>();

    for (const urlStr of urls) {
        try {
            const url = new URL(urlStr.trim());
            domains.add(url.hostname);
        } catch {
            // Invalid URL, skip
        }
    }

    return Array.from(domains);
}

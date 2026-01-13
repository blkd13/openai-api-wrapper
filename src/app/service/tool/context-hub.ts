import { MyToolType } from '../../common/openai-api-wrapper.js';
import { Utils } from '../../common/utils.js';
import { AIClientLike } from '../common/ai-client.js';
import { MessageArgsSet } from '../controllers/chat-by-project-model.js';
import { ds } from '../db.js';
import {
    ContextHubEntity,
    ContextResourceEntity,
    ContextResourceProviderType,
    ContextSearchMode,
} from '../entity/context-hub.entity.js';
import { ContentPartEntity, MessageEntity, MessageGroupEntity } from '../entity/project-models.entity.js';
import { UserRequest } from '../models/info.js';
import { getExtApiClient } from '../controllers/auth.js';
import { boxFunctionDefinitions } from './box.js';
import { mattermostFunctionDefinitions } from './mattermost.js';
import { gitlabFunctionDefinitions } from './gitlab.js';
import { confluenceFunctionDefinitions } from './confluence.js';
import { jiraFunctionDefinitions } from './jira.js';

// プロバイダー別の関数定義取得マッピング
type ProviderFunctionGetter = (
    name: string,
    obj: { inDto: MessageArgsSet; messageSet: { messageGroup: MessageGroupEntity; message: MessageEntity; contentParts: ContentPartEntity[]; }; },
    req: UserRequest,
    aiApi: AIClientLike,
    connectionId: string,
    streamId: string,
    message: MessageEntity,
    label: string,
) => Promise<MyToolType[]>;

const providerFunctionMap: Partial<Record<ContextResourceProviderType, ProviderFunctionGetter>> = {
    [ContextResourceProviderType.Box]: boxFunctionDefinitions,
    [ContextResourceProviderType.Mattermost]: mattermostFunctionDefinitions,
    [ContextResourceProviderType.GitLab]: gitlabFunctionDefinitions,
    [ContextResourceProviderType.Confluence]: confluenceFunctionDefinitions,
    [ContextResourceProviderType.Jira]: jiraFunctionDefinitions,
};

// プロバイダータイプの日本語ラベル
const providerTypeLabels: Record<ContextResourceProviderType, string> = {
    [ContextResourceProviderType.Box]: 'Box',
    [ContextResourceProviderType.GitLab]: 'GitLab',
    [ContextResourceProviderType.Gitea]: 'Gitea',
    [ContextResourceProviderType.Mattermost]: 'Mattermost',
    [ContextResourceProviderType.Confluence]: 'Confluence',
    [ContextResourceProviderType.Jira]: 'Jira',
    [ContextResourceProviderType.Web]: 'Web',
    [ContextResourceProviderType.Local]: 'Local',
};

/**
 * Context Hub リソースからtool定義を動的生成
 */
export async function contextHubFunctionDefinitions(
    projectId: string,
    obj: { inDto: MessageArgsSet; messageSet: { messageGroup: MessageGroupEntity; message: MessageEntity; contentParts: ContentPartEntity[]; }; },
    req: UserRequest,
    aiApi: AIClientLike,
    connectionId: string,
    streamId: string,
    message: MessageEntity,
    label: string,
): Promise<MyToolType[]> {
    // プロジェクトに紐づくContext Hubを取得
    const contextHub = await ds.getRepository(ContextHubEntity).findOne({
        where: {
            orgKey: req.info.user.orgKey,
            projectId,
            isActive: true,
        },
    });

    if (!contextHub) {
        return [];
    }

    // リアルタイム検索モードのリソースを取得
    const resources = await ds.getRepository(ContextResourceEntity).find({
        where: {
            orgKey: req.info.user.orgKey,
            contextHubId: contextHub.id,
            isActive: true,
            searchMode: ContextSearchMode.Realtime,
        },
        order: { sortOrder: 'ASC' },
    });

    // Gitea/Local は realtime 非対応なので除外
    const realtimeResources = resources.filter(r =>
        r.providerType !== ContextResourceProviderType.Gitea &&
        r.providerType !== ContextResourceProviderType.Local
    );

    // 各リソースに対してtool定義を生成
    const tools: MyToolType[] = [];

    for (const resource of realtimeResources) {
        const resourceIdShort = resource.id.replace(/-/g, '');
        const customResourceGroup = `ctx-${resource.providerType}-${resourceIdShort}`;

        // 1. 検索ツールを生成
        const searchTool = await createSearchToolForResource(resource, req);
        if (searchTool) {
            tools.push(searchTool);
        }

        // 2. 対応プロバイダーの他のツールを取得してグループ名を変更
        const providerFunctionGetter = providerFunctionMap[resource.providerType];
        if (providerFunctionGetter) {
            const providerTools = await providerFunctionGetter(
                resource.providerName, obj, req, aiApi, connectionId, streamId, message, label
            );

            // 検索ツール（xxx_search）以外のツールをカスタムリソースのグループに追加
            for (const tool of providerTools) {
                const originalToolName = (tool.definition as any)?.function?.name || '';
                // 検索ツールはカスタムリソース専用のものを使うので除外
                if (originalToolName.includes('_search')) {
                    continue;
                }
                // ツール名をカスタムリソース用にユニークにする
                // 例: box_public_ai_content → ctx_{resourceIdShort}_ai_content
                const toolNameSuffix = originalToolName.replace(/^[^_]+_[^_]+_/, ''); // box_public_ai_content → ai_content
                const newToolName = `ctx_${resourceIdShort}_${toolNameSuffix}`;

                // グループ名とツール名をカスタムリソース用に変更
                const newDefinition = JSON.parse(JSON.stringify(tool.definition));
                newDefinition.function.name = newToolName;

                tools.push({
                    ...tool,
                    definition: newDefinition,
                    info: {
                        ...tool.info,
                        group: customResourceGroup,
                        name: newToolName,
                    },
                });
            }
        }
    }

    return tools;
}

/**
 * 単一リソースに対する検索tool定義を生成
 */
async function createSearchToolForResource(
    resource: ContextResourceEntity,
    req: UserRequest,
): Promise<MyToolType | null> {
    const providerTypeLabel = providerTypeLabels[resource.providerType] || resource.providerType;
    // 1リソース = 1グループになるよう、リソースIDを含める
    const resourceIdShort = resource.id.replace(/-/g, '');
    const group = `ctx-${resource.providerType}-${resourceIdShort}`;
    const toolName = `ctx_${resourceIdShort}_search`;

    // 検索ハンドラーを取得
    const handler = getSearchHandler(resource, req);
    if (!handler) {
        return null;
    }

    return {
        info: {
            group,
            isActive: true,
            isInteractive: false,
            label: `${resource.label}を検索`,
            responseType: 'text',
        },
        definition: {
            type: 'function',
            function: {
                name: toolName,
                description: Utils.trimLines(`
                    「${resource.label}」内を検索します。（${providerTypeLabel}）
                    事前に設定された範囲内のみを検索対象とします。
                `),
                parameters: {
                    type: 'object',
                    properties: {
                        query: {
                            type: 'string',
                            description: '検索クエリ',
                        },
                        limit: {
                            type: 'integer',
                            minimum: 1,
                            maximum: 50,
                            default: 10,
                            description: '最大結果数',
                        },
                    },
                    required: ['query'],
                },
            },
        },
        handler,
    };
}

/**
 * プロバイダータイプに応じた検索ハンドラーを取得
 */
function getSearchHandler(
    resource: ContextResourceEntity,
    req: UserRequest,
): ((args: { query: string; limit?: number }) => Promise<string>) | null {
    switch (resource.providerType) {
        case ContextResourceProviderType.Box:
            return createBoxSearchHandler(resource, req);
        case ContextResourceProviderType.GitLab:
            return createGitLabSearchHandler(resource, req);
        case ContextResourceProviderType.Mattermost:
            return createMattermostSearchHandler(resource, req);
        case ContextResourceProviderType.Confluence:
            return createConfluenceSearchHandler(resource, req);
        case ContextResourceProviderType.Jira:
            return createJiraSearchHandler(resource, req);
        case ContextResourceProviderType.Web:
            return createWebSearchHandler(resource, req);
        default:
            return null;
    }
}

// ============================================
// Provider-specific Search Handlers
// ============================================

function createBoxSearchHandler(
    resource: ContextResourceEntity,
    req: UserRequest,
): (args: { query: string; limit?: number }) => Promise<string> {
    return async (args) => {
        const config = resource.config as { folderId?: string } | undefined;
        if (!config?.folderId) {
            return 'エラー: フォルダが設定されていません';
        }

        const provider = `box-${resource.providerName}`;
        const e = await getExtApiClient(req.info.user.orgKey, provider);
        const axiosWithAuth = await (await e.axiosWithAuth)(req.info.user.id);
        const baseUrl = e.uriBase || 'https://api.box.com';

        try {
            const response = await axiosWithAuth.get(`${baseUrl}/2.0/search`, {
                params: {
                    query: args.query,
                    ancestor_folder_ids: config.folderId,
                    content_types: 'name,description,file_content',
                    limit: args.limit || 10,
                },
            });

            const entries = response.data?.entries || [];
            if (entries.length === 0) {
                return '検索結果がありませんでした。';
            }

            const results = entries.map((item: any) => {
                const path = item.path_collection?.entries?.map((e: any) => e.name).join('/') || '';
                return `${item.type === 'folder' ? 'd' : '-'}\t${item.id}\t${item.size || 0}\t${path}/${item.name}`;
            }).join('\n');

            return `リソース: ${resource.label}\nuriBase=${baseUrl}\n\n${results}`;
        } catch (error: any) {
            console.error('Box search error:', error);
            return `検索エラー: ${error.message || 'Unknown error'}`;
        }
    };
}

function createGitLabSearchHandler(
    resource: ContextResourceEntity,
    req: UserRequest,
): (args: { query: string; limit?: number }) => Promise<string> {
    return async (args) => {
        const config = resource.config as { projectId?: number; includeTargets?: string[] } | undefined;
        if (!config?.projectId) {
            return 'エラー: プロジェクトが設定されていません';
        }

        const provider = `gitlab-${resource.providerName}`;
        const e = await getExtApiClient(req.info.user.orgKey, provider);
        const axiosWithAuth = await (await e.axiosWithAuth)(req.info.user.id);
        const baseUrl = e.uriBase || '';
        const limit = args.limit || 10;

        const includeTargets = config.includeTargets || ['issues', 'mr'];
        const scopeMap: Record<string, string> = {
            'source': 'blobs',
            'issues': 'issues',
            'mr': 'merge_requests',
        };

        const searchScopes = includeTargets
            .map(t => scopeMap[t])
            .filter(Boolean);

        try {
            const results: string[] = [];

            for (const scope of searchScopes) {
                const response = await axiosWithAuth.get(
                    `${baseUrl}/api/v4/projects/${config.projectId}/search`,
                    { params: { scope, search: args.query, per_page: limit } }
                );

                const items = response.data || [];
                for (const item of items) {
                    if (scope === 'blobs') {
                        results.push(`[code] ${item.path}: ${item.data?.substring(0, 100) || ''}`);
                    } else if (scope === 'issues') {
                        results.push(`[issue] #${item.iid}: ${item.title}`);
                    } else if (scope === 'merge_requests') {
                        results.push(`[mr] !${item.iid}: ${item.title}`);
                    }
                }
            }

            if (results.length === 0) {
                return '検索結果がありませんでした。';
            }

            return `リソース: ${resource.label}\n\n${results.join('\n')}`;
        } catch (error: any) {
            console.error('GitLab search error:', error);
            return `検索エラー: ${error.message || 'Unknown error'}`;
        }
    };
}

function createMattermostSearchHandler(
    resource: ContextResourceEntity,
    req: UserRequest,
): (args: { query: string; limit?: number }) => Promise<string> {
    return async (args) => {
        const config = resource.config as {
            teamId?: string;
            channelIds?: string[];
        } | undefined;

        if (!config?.teamId) {
            return 'エラー: チームが設定されていません';
        }

        const provider = `mattermost-${resource.providerName}`;
        const e = await getExtApiClient(req.info.user.orgKey, provider);
        const axiosWithAuth = await (await e.axiosWithAuth)(req.info.user.id);
        const baseUrl = e.uriBase || '';
        const limit = args.limit || 10;

        try {
            let searchTerms = args.query;

            // チャンネル制限がある場合
            if (config.channelIds && config.channelIds.length > 0) {
                const channelFilter = config.channelIds.map(id => `in:${id}`).join(' ');
                searchTerms = `${channelFilter} ${args.query}`;
            }

            const response = await axiosWithAuth.post(`${baseUrl}/api/v4/teams/${config.teamId}/posts/search`, {
                terms: searchTerms,
                is_or_search: true,
            });

            const posts = response.data?.posts || {};
            const order = response.data?.order || [];

            if (order.length === 0) {
                return '検索結果がありませんでした。';
            }

            const results = order.slice(0, limit).map((postId: string) => {
                const post = posts[postId];
                const message = post.message?.substring(0, 200) || '';
                return `[post] ${postId}: ${message}`;
            }).join('\n');

            return `リソース: ${resource.label}\n\n${results}`;
        } catch (error: any) {
            console.error('Mattermost search error:', error);
            return `検索エラー: ${error.message || 'Unknown error'}`;
        }
    };
}

function createConfluenceSearchHandler(
    resource: ContextResourceEntity,
    req: UserRequest,
): (args: { query: string; limit?: number }) => Promise<string> {
    return async (args) => {
        const config = resource.config as {
            spaceKey?: string;
            pageId?: string;
        } | undefined;

        if (!config?.spaceKey) {
            return 'エラー: スペースが設定されていません';
        }

        const provider = `confluence-${resource.providerName}`;
        const e = await getExtApiClient(req.info.user.orgKey, provider);
        const axiosWithAuth = await (await e.axiosWithAuth)(req.info.user.id);
        const baseUrl = e.uriBase || '';
        const limit = args.limit || 10;

        try {
            const escapedQuery = args.query.replace(/"/g, '\\"');
            let cql = `space = "${config.spaceKey}" AND (title ~ "${escapedQuery}" OR text ~ "${escapedQuery}")`;

            if (config.pageId) {
                cql += ` AND ancestor = ${config.pageId}`;
            }

            const response = await axiosWithAuth.get(`${baseUrl}/wiki/rest/api/search`, {
                params: {
                    cql,
                    limit,
                },
            });

            const items = response.data?.results || [];
            if (items.length === 0) {
                return '検索結果がありませんでした。';
            }

            const results = items.map((item: any) => {
                const title = item.content?.title || item.title || 'Untitled';
                const excerpt = item.excerpt?.substring(0, 100) || '';
                return `[page] ${title}: ${excerpt}`;
            }).join('\n');

            return `リソース: ${resource.label}\n\n${results}`;
        } catch (error: any) {
            console.error('Confluence search error:', error);
            return `検索エラー: ${error.message || 'Unknown error'}`;
        }
    };
}

function createJiraSearchHandler(
    resource: ContextResourceEntity,
    req: UserRequest,
): (args: { query: string; limit?: number }) => Promise<string> {
    return async (args) => {
        const config = resource.config as {
            queryType?: 'project' | 'jql';
            projectKey?: string;
            jql?: string;
        } | undefined;

        if (!config) {
            return 'エラー: 設定がありません';
        }

        const provider = `jira-${resource.providerName}`;
        const e = await getExtApiClient(req.info.user.orgKey, provider);
        const axiosWithAuth = await (await e.axiosWithAuth)(req.info.user.id);
        const baseUrl = e.uriBase || '';
        const limit = args.limit || 10;

        try {
            const escapedQuery = args.query.replace(/"/g, '\\"');
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
                    fields: 'summary,description',
                },
            });

            const issues = response.data?.issues || [];
            if (issues.length === 0) {
                return '検索結果がありませんでした。';
            }

            const results = issues.map((issue: any) => {
                const summary = issue.fields?.summary || 'Untitled';
                return `[issue] ${issue.key}: ${summary}`;
            }).join('\n');

            return `リソース: ${resource.label}\n\n${results}`;
        } catch (error: any) {
            console.error('Jira search error:', error);
            return `検索エラー: ${error.message || 'Unknown error'}`;
        }
    };
}

function createWebSearchHandler(
    resource: ContextResourceEntity,
    req: UserRequest,
): (args: { query: string; limit?: number }) => Promise<string> {
    return async (args) => {
        const config = resource.config as {
            sourceType?: 'url' | 'sitelist';
            urls?: string[];
            sitelistContent?: string;
        } | undefined;

        if (!config) {
            return 'エラー: 設定がありません';
        }

        const GOOGLE_CUSTOM_SEARCH_API_KEY = process.env.GOOGLE_CUSTOM_SEARCH_API_KEY;
        const GOOGLE_CSE_ID = process.env.GOOGLE_CSE_ID;

        if (!GOOGLE_CUSTOM_SEARCH_API_KEY || !GOOGLE_CSE_ID) {
            return 'エラー: Google Custom Search APIが設定されていません';
        }

        try {
            let urls: string[] = [];
            if (config.sourceType === 'url' && config.urls) {
                urls = config.urls;
            } else if (config.sourceType === 'sitelist' && config.sitelistContent) {
                urls = config.sitelistContent.split('\n').filter(line => line.trim());
            }

            if (urls.length === 0) {
                return 'エラー: URLが設定されていません';
            }

            // ドメインを抽出
            const domains = new Set<string>();
            for (const urlStr of urls) {
                try {
                    const url = new URL(urlStr.trim());
                    domains.add(url.hostname);
                } catch {
                    // Invalid URL, skip
                }
            }

            if (domains.size === 0) {
                return 'エラー: 有効なURLがありません';
            }

            const siteQuery = Array.from(domains).map(d => `site:${d}`).join(' OR ');
            const fullQuery = `(${siteQuery}) ${args.query}`;
            const limit = Math.min(args.limit || 10, 10); // Google API max is 10

            const { getAxios } = await import('../../common/http-client.js');
            const axios = await getAxios('https://www.googleapis.com');
            const response = await axios.get('/customsearch/v1', {
                params: {
                    key: GOOGLE_CUSTOM_SEARCH_API_KEY,
                    cx: GOOGLE_CSE_ID,
                    q: fullQuery,
                    num: limit,
                },
            });

            const items = response.data?.items || [];
            if (items.length === 0) {
                return '検索結果がありませんでした。';
            }

            const results = items.map((item: any) => {
                const title = item.title || 'Untitled';
                const snippet = item.snippet?.substring(0, 100) || '';
                return `[web] ${title}: ${snippet}`;
            }).join('\n');

            return `リソース: ${resource.label}\n\n${results}`;
        } catch (error: any) {
            console.error('Web search error:', error);
            return `検索エラー: ${error.message || 'Unknown error'}`;
        }
    };
}

import { Request, Response } from "express";
import { EntityManager } from "typeorm";
import { map, toArray } from "rxjs";

import { MyToolType, OpenAIApiWrapper, providerPrediction } from "../../common/openai-api-wrapper.js";
import { UserRequest } from "../models/info.js";
import { ContentPartEntity, MessageEntity, MessageGroupEntity, PredictHistoryWrapperEntity } from "../entity/project-models.entity.js";
import { readOAuth2Env } from "../controllers/auth.js";
import { MessageArgsSet } from "../controllers/chat-by-project-model.js";
import { Utils } from "../../common/utils.js";
import { ds } from "../db.js";
import { OAuthAccountEntity } from "../entity/auth.entity.js";
import { decrypt } from "../controllers/tool-call.js";
import { getOAuthAccount, reform } from "./common.js";

// 1. 関数マッピングの作成
export function gitlabFunctionDefinitions(providerSubName: string,
    obj: { inDto: MessageArgsSet; messageSet: { messageGroup: MessageGroupEntity; message: MessageEntity; contentParts: ContentPartEntity[]; }; },
    req: UserRequest, aiApi: OpenAIApiWrapper, connectionId: string, streamId: string, message: MessageEntity, label: string,
): MyToolType[] {
    return [
        {
            info: { group: `gitlab-${providerSubName}`, isActive: true, isInteractive: false, label: `汎用検索`, },
            definition: {
                type: 'function', function: {
                    name: `gitlab_${providerSubName}_search`,
                    description: `GitLabでの汎用的な検索`,
                    parameters: {
                        type: 'object',
                        properties: {
                            scope: {
                                type: 'string',
                                description: '検索対象のスコープ（projects, issues, merge_requests, milestones, users, snippets）',
                                enum: ['projects', 'issues', 'merge_requests', 'milestones', 'users', 'snippets'],
                                default: 'projects'
                            },
                            search: {
                                type: 'string',
                                description: '検索キーワード'
                            },
                            per_page: {
                                type: 'number',
                                description: '1ページあたりの結果数（最大100）',
                                default: 20,
                                minimum: 1,
                                maximum: 100
                            },
                            page: {
                                type: 'number',
                                description: 'ページ番号',
                                default: 1,
                                minimum: 1
                            }
                        },
                        required: ['search']
                    }
                }
            },
            handler: async (args: { scope: string, search: string, per_page: number, page: number }): Promise<any> => {
                let { per_page, page, scope } = args;
                per_page = Math.max(Math.min(per_page || 20, 100), 1); // 1以上100以下
                page = Math.max(page || 1, 1); // 1以上
                scope = scope || 'projects';

                const { e, oAuthAccount } = await getOAuthAccount(req, `gitlab-${providerSubName}`);

                const url = `${e.uriBase}/api/v4/search?scope=${scope}&search=${encodeURIComponent(args.search)}&per_page=${per_page}&page=${page}`;
                const result = (await e.axiosWithAuth.then(g => g(req.info.user.id)).then(g => g.get(url))).data;

                reform(result);
                // result.me = reform(JSON.parse(oAuthAccount.userInfo));
                result.uriBase = e.uriBase;
                return result;
            }
        },
        {
            info: { group: `gitlab-${providerSubName}`, isActive: true, isInteractive: false, label: `プロジェクト一覧取得`, },
            definition: {
                type: 'function', function: {
                    name: `gitlab_${providerSubName}_projects`,
                    description: `GitLabのプロジェクト一覧を取得`,
                    parameters: {
                        type: 'object',
                        properties: {
                            membership: {
                                type: 'boolean',
                                description: 'trueの場合、ユーザーがメンバーであるプロジェクトのみを返す',
                                default: true
                            },
                            per_page: {
                                type: 'number',
                                description: '1ページあたりの結果数（最大100）',
                                default: 20,
                                minimum: 1,
                                maximum: 100
                            },
                            page: {
                                type: 'number',
                                description: 'ページ番号',
                                default: 1,
                                minimum: 1
                            },
                            order_by: {
                                type: 'string',
                                description: 'ソート順の基準',
                                enum: ['id', 'name', 'path', 'created_at', 'updated_at', 'last_activity_at'],
                                default: 'created_at'
                            },
                            sort: {
                                type: 'string',
                                description: 'ソート方向',
                                enum: ['asc', 'desc'],
                                default: 'desc'
                            }
                        }
                    }
                }
            },
            handler: async (args: { membership: boolean, per_page: number, page: number, order_by: string, sort: string }): Promise<any> => {
                let { per_page, page, membership, order_by, sort } = args;
                per_page = Math.max(Math.min(per_page || 20, 100), 1); // 1以上100以下
                page = Math.max(page || 1, 1); // 1以上
                membership = membership !== false; // デフォルトはtrue
                order_by = order_by || 'created_at';
                sort = sort || 'desc';

                const { e, oAuthAccount } = await getOAuthAccount(req, `gitlab-${providerSubName}`);

                const url = `${e.uriBase}/api/v4/projects?membership=${membership}&per_page=${per_page}&page=${page}&order_by=${order_by}&sort=${sort}`;
                const result = (await e.axiosWithAuth.then(g => g(req.info.user.id)).then(g => g.get(url))).data;

                reform(result);
                // result.me = reform(JSON.parse(oAuthAccount.userInfo));
                result.uriBase = e.uriBase;
                return result;
            }
        },

        // {
        //     info: { group: `gitlab-${providerSubName}`, isActive: true, isInteractive: false, label: `リポジトリ全ファイル一覧を取得`, },
        //     definition: {
        //         type: 'function', function: {
        //             name: `gitlab_${providerSubName}_repository_all_files`,
        //             description: `指定したリポジトリの全ファイルの一覧を取得`,
        //             parameters: {
        //                 type: 'object',
        //                 properties: {
        //                     owner: {
        //                         type: 'string',
        //                         description: 'リポジトリのオーナー（ユーザー名）'
        //                     },
        //                     repo: {
        //                         type: 'string',
        //                         description: 'リポジトリ名'
        //                     },
        //                     ref: {
        //                         type: 'string',
        //                         description: 'ブランチ名、タグ名、またはコミットSHA',
        //                         default: 'main'
        //                     }
        //                 },
        //                 required: ['owner', 'repo']
        //             }
        //         }
        //     },
        //     handler: async (args: { owner: string, repo: string, ref?: string }): Promise<any> => {
        //         const { owner, repo } = args;
        //         const ref = args.ref || 'main';
        //         const { e, oAuthAccount } = await getOAuthAccount(req, `gitlab-${providerSubName}`);

        //         // GitLabではプロジェクトIDは "owner/repo" をURLエンコードしたものを利用
        //         const projectId = encodeURIComponent(`${owner}/${repo}`);

        //         // リポジトリのツリー情報を再帰的に取得（最大件数はper_page=100、必要に応じてページングの実装が必要）
        //         const treeUrl = `${e.uriBase}/api/v4/projects/${projectId}/repository/tree?recursive=true&ref=${encodeURIComponent(ref)}&per_page=1000`;
        //         const treeResponse = await e.axiosWithAuth.then(g => g(req.info.user.id)).then(g => g.get(treeUrl));
        //         const treeData = treeResponse.data;

        //         if (!Array.isArray(treeData)) {
        //             return { error: "リポジトリのツリー情報が取得できませんでした" };
        //         }

        //         return { treeData, uriBase: e.uriBase };

        //         // blob（ファイル）のみ抽出
        //         const fileItems = treeData.filter((item: any) => item.type === 'blob');

        //         // 各ファイルの内容と情報を並列で取得
        //         const filePromises = fileItems.map(async (item: any) => {
        //             const filePath = item.path;
        //             try {
        //                 // ファイル内容の取得
        //                 const rawUrl = `${e.uriBase}/api/v4/projects/${projectId}/repository/files/${encodeURIComponent(filePath)}/raw?ref=${encodeURIComponent(ref)}`;
        //                 const contentResponse = await e.axiosWithAuth.then(g => g(req.info.user.id)).then(g => g.get(rawUrl, { responseType: 'text' }));
        //                 const content = contentResponse.data;

        //                 // ファイル情報の取得
        //                 const infoUrl = `${e.uriBase}/api/v4/projects/${projectId}/repository/files/${encodeURIComponent(filePath)}?ref=${encodeURIComponent(ref)}`;
        //                 const infoResponse = await e.axiosWithAuth.then(g => g(req.info.user.id)).then(g => g.get(infoUrl));
        //                 const fileInfo = infoResponse.data;

        //                 return { path: filePath, content, file_info: fileInfo };
        //             } catch (error) {
        //                 return { path: filePath, error: "取得に失敗しました", details: Utils.errorFormattedObject(error) };
        //             }
        //         });

        //         const files = await Promise.all(filePromises);
        //         return { files, uriBase: e.uriBase };
        //     }
        // },
        {
            info: { group: `gitlab-${providerSubName}`, isActive: true, isInteractive: false, label: `プロジェクトの課題一覧`, },
            definition: {
                type: 'function', function: {
                    name: `gitlab_${providerSubName}_project_issues`,
                    description: `指定したプロジェクトの課題（Issue）一覧を取得`,
                    parameters: {
                        type: 'object',
                        properties: {
                            project_id: {
                                type: 'number',
                                description: 'プロジェクトID'
                            },
                            state: {
                                type: 'string',
                                description: '課題の状態',
                                enum: ['opened', 'closed', 'all'],
                                default: 'opened'
                            },
                            per_page: {
                                type: 'number',
                                description: '1ページあたりの結果数（最大100）',
                                default: 20,
                                minimum: 1,
                                maximum: 100
                            },
                            page: {
                                type: 'number',
                                description: 'ページ番号',
                                default: 1,
                                minimum: 1
                            }
                        },
                        required: ['project_id']
                    }
                }
            },
            handler: async (args: { project_id: number, state: string, per_page: number, page: number }): Promise<any> => {
                let { project_id, state, per_page, page } = args;
                per_page = Math.max(Math.min(per_page || 20, 100), 1); // 1以上100以下
                page = Math.max(page || 1, 1); // 1以上
                state = state || 'opened';

                const { e, oAuthAccount } = await getOAuthAccount(req, `gitlab-${providerSubName}`);

                const url = `${e.uriBase}/api/v4/projects/${project_id}/issues?state=${state}&per_page=${per_page}&page=${page}`;
                const result = (await e.axiosWithAuth.then(g => g(req.info.user.id)).then(g => g.get(url))).data;

                reform(result);
                // result.me = reform(JSON.parse(oAuthAccount.userInfo));
                result.uriBase = e.uriBase;
                return result;
            }
        },
        {
            info: { group: `gitlab-${providerSubName}`, isActive: true, isInteractive: false, label: `プロジェクトのマージリクエスト一覧`, },
            definition: {
                type: 'function', function: {
                    name: `gitlab_${providerSubName}_project_merge_requests`,
                    description: `指定したプロジェクトのマージリクエスト一覧を取得`,
                    parameters: {
                        type: 'object',
                        properties: {
                            project_id: {
                                type: 'number',
                                description: 'プロジェクトID'
                            },
                            state: {
                                type: 'string',
                                description: 'マージリクエストの状態',
                                enum: ['opened', 'closed', 'locked', 'merged', 'all'],
                                default: 'opened'
                            },
                            per_page: {
                                type: 'number',
                                description: '1ページあたりの結果数（最大100）',
                                default: 20,
                                minimum: 1,
                                maximum: 100
                            },
                            page: {
                                type: 'number',
                                description: 'ページ番号',
                                default: 1,
                                minimum: 1
                            }
                        },
                        required: ['project_id']
                    }
                }
            },
            handler: async (args: { project_id: number, state: string, per_page: number, page: number }): Promise<any> => {
                let { project_id, state, per_page, page } = args;
                per_page = Math.max(Math.min(per_page || 20, 100), 1); // 1以上100以下
                page = Math.max(page || 1, 1); // 1以上
                state = state || 'opened';

                const { e, oAuthAccount } = await getOAuthAccount(req, `gitlab-${providerSubName}`);

                const url = `${e.uriBase}/api/v4/projects/${project_id}/merge_requests?state=${state}&per_page=${per_page}&page=${page}`;
                const result = (await e.axiosWithAuth.then(g => g(req.info.user.id)).then(g => g.get(url))).data;

                reform(result);
                // result.me = reform(JSON.parse(oAuthAccount.userInfo));
                result.uriBase = e.uriBase;
                return result;
            }
        },
        {
            info: { group: `gitlab-${providerSubName}`, isActive: true, isInteractive: false, label: `gitlab-${providerSubName}：自分のユーザー情報`, },
            definition: {
                type: 'function', function: {
                    name: `gitlab_${providerSubName}_user_info`,
                    description: `gitlab-${providerSubName}：自分のユーザー情報`,
                    parameters: { type: 'object', properties: {}, }
                }
            },
            handler: async (args: {}): Promise<any> => {
                const { e, oAuthAccount } = await getOAuthAccount(req, `gitlab-${providerSubName}`);

                const url = `${e.uriBase}/api/v4/user`;
                const result = (await e.axiosWithAuth.then(g => g(req.info.user.id)).then(g => g.get(url))).data;

                reform(result);
                result.me = reform(JSON.parse(oAuthAccount.userInfo));
                result.uriBase = e.uriBase;
                return result;
            }
        },
        {
            info: { group: `gitlab-${providerSubName}`, isActive: true, isInteractive: false, label: `リポジトリファイル内容取得`, responseType: 'markdown' },
            definition: {
                type: 'function', function: {
                    name: `gitlab_${providerSubName}_file_content`,
                    description: `指定したプロジェクトのリポジトリからファイル内容を取得`,
                    parameters: {
                        type: 'object',
                        properties: {
                            project_id: {
                                type: 'number',
                                description: 'プロジェクトID'
                            },
                            file_path: {
                                type: 'string',
                                description: 'ファイルのパス（例: src/main.js, docs/README.md）'
                            },
                            ref: {
                                type: 'string',
                                description: 'ブランチ名、タグ名、またはコミットSHA',
                                default: 'main'
                            }
                        },
                        required: ['project_id', 'file_path']
                    }
                }
            },
            handler: async (args: { project_id: number, file_path: string, ref: string }): Promise<any> => {
                let { project_id, file_path, ref } = args;
                ref = ref || 'main';

                const { e, oAuthAccount } = await getOAuthAccount(req, `gitlab-${providerSubName}`);

                const url = `${e.uriBase}/api/v4/projects/${project_id}/repository/files/${encodeURIComponent(file_path)}?ref=${encodeURIComponent(ref)}`;
                const result = (await e.axiosWithAuth.then(g => g(req.info.user.id)).then(g => g.get(url))).data;

                // Base64デコードしてファイル内容を取得
                if (result && result.content) {
                    result.decoded_content = Buffer.from(result.content, 'base64').toString('utf-8');
                } else { }

                // reform(result);
                // // result.me = reform(JSON.parse(oAuthAccount.userInfo));
                // result.uriBase = e.uriBase;
                // return result;

                // ファイル情報も取得
                let trg = file_path.split('\.').at(-1) || '';
                trg = { cob: 'cobol', cbl: 'cobol', pco: 'cobol', htm: 'html' }[trg] || trg;

                return `\`\`\`${trg} ${file_path}\n\n${result.decoded_content}\`\`\`\n`;
            }
        },
        {
            info: { group: `gitlab-${providerSubName}`, isActive: true, isInteractive: false, label: `リポジトリファイル一覧取得（ls風）`, responseType: 'text' },
            definition: {
                type: 'function', function: {
                    name: `gitlab_${providerSubName}_repository_tree`,
                    description: `指定したプロジェクトのリポジトリ内のファイルとディレクトリ一覧をls形式で取得`,
                    parameters: {
                        type: 'object',
                        properties: {
                            project_id: {
                                type: 'number',
                                description: 'プロジェクトID'
                            },
                            path: {
                                type: 'string',
                                description: 'ディレクトリパス（例: src/, docs/）、ルートの場合は空文字または省略',
                                default: ''
                            },
                            ref: {
                                type: 'string',
                                description: 'ブランチ名、タグ名、またはコミットSHA',
                                default: 'main'
                            },
                            recursive: {
                                type: 'boolean',
                                description: '再帰的に取得するかどうか (trueの場合、サブディレクトリも含めて全取得)',
                                default: true
                            },
                            show_directories: {
                                type: 'boolean',
                                description: 'ディレクトリも表示するかどうか',
                                default: false
                            }
                        },
                        required: ['project_id']
                    }
                }
            },
            handler: async (args: { project_id: number, path: string, ref: string, recursive: boolean, show_directories: boolean }): Promise<any> => {
                let { project_id, path, ref, recursive, show_directories } = args;
                path = path || '';
                ref = ref || 'main';
                recursive = recursive !== false; // 明示的にfalseの場合のみfalse
                show_directories = show_directories === true; // 明示的にtrueの場合のみtrue

                const { e, oAuthAccount } = await getOAuthAccount(req, `gitlab-${providerSubName}`);

                // GitLabのAPIでは最大100件しか一度に取得できないので、100に設定
                const per_page = 100;
                let allItems: any[] = [];
                let currentPage = 1;
                let hasMorePages = true;

                // 全ページ取得
                while (hasMorePages) {
                    const url = `${e.uriBase}/api/v4/projects/${project_id}/repository/tree?path=${encodeURIComponent(path)}&ref=${encodeURIComponent(ref)}&recursive=${recursive}&per_page=${per_page}&page=${currentPage}`;

                    try {
                        const response = await e.axiosWithAuth.then(g => g(req.info.user.id)).then(g => g.get(url));
                        const result = response.data;

                        if (result.length > 0) {
                            allItems = allItems.concat(result);
                            currentPage++;
                        } else {
                            hasMorePages = false;
                        }
                    } catch (error) {
                        return {
                            error: "ファイル一覧の取得に失敗しました",
                            details: Utils.errorFormattedObject(error),
                        };
                    }
                }

                // 結果をソート
                allItems.sort((a, b) => {
                    // 1. タイプでソート (ディレクトリが先)
                    if (a.type !== b.type) {
                        return a.type === 'tree' ? -1 : 1;
                    }
                    // 2. パス名でソート
                    return a.path.localeCompare(b.path);
                });

                // 表示用にフィルタリング
                if (!show_directories) {
                    allItems = allItems.filter(item => item.type !== 'tree');
                }

                // 出力形式
                let output = `# Repository files for project ${project_id}, path: ${path || '/'}, recursive: ${recursive}\n`;
                output += `# uriBase=${e.uriBase}\n\n`;

                // ls風の表示
                const formattedItems = allItems.map(item => {
                    const type = item.type === 'tree' ? 'd' : '-';
                    const mode = item.mode || '100644'; // デフォルトパーミッション
                    const formattedMode = formatMode(mode);
                    const name = item.path.split('/').pop(); // パスの最後の部分を取得
                    const fullPath = item.path;
                    return `${type}${formattedMode} ${item.id} ${fullPath}${item.type === 'tree' ? '/' : ''}`;
                });

                output += formattedItems.join('\n');
                return output;
            }
            }
    ];
};


// Git modeをls -l風の権限表記に変換する補助関数
function formatMode(mode: string): string {
    // Gitのモード (例: 100644) をls風の表記 (例: rwxr-xr-x) に変換
    const m = parseInt(mode, 8); // 8進数として解釈

    let result = '';
    // オーナー権限
    result += (m & 0o400) ? 'r' : '-';
    result += (m & 0o200) ? 'w' : '-';
    result += (m & 0o100) ? 'x' : '-';
    // グループ権限
    result += (m & 0o40) ? 'r' : '-';
    result += (m & 0o20) ? 'w' : '-';
    result += (m & 0o10) ? 'x' : '-';
    // その他の権限
    result += (m & 0o4) ? 'r' : '-';
    result += (m & 0o2) ? 'w' : '-';
    result += (m & 0o1) ? 'x' : '-';

    return result;
}

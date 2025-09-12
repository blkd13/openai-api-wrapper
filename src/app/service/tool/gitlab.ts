import { map, toArray } from "rxjs";

import { genClientByProvider, MyToolType, OpenAIApiWrapper, providerPrediction } from "../../common/openai-api-wrapper.js";
import { UserRequest } from "../models/info.js";
import { ContentPartEntity, MessageEntity, MessageGroupEntity, PredictHistoryWrapperEntity } from "../entity/project-models.entity.js";
import { getAIProvider, MessageArgsSet } from "../controllers/chat-by-project-model.js";
import { ds } from "../db.js";
import { getOAuthAccountForTool, reform } from "./common.js";
import { Utils } from "../../common/utils.js";

// 1. 関数マッピングの作成
export async function gitlabFunctionDefinitions(providerName: string,
    obj: { inDto: MessageArgsSet; messageSet: { messageGroup: MessageGroupEntity; message: MessageEntity; contentParts: ContentPartEntity[]; }; },
    req: UserRequest, aiApi: OpenAIApiWrapper, connectionId: string, streamId: string, message: MessageEntity, label: string,
): Promise<MyToolType[]> {
    const provider = `gitlab-${providerName}`;
    return [
        {
            info: { group: provider, isActive: true, isInteractive: false, label: `汎用検索`, },
            definition: {
                type: 'function', function: {
                    name: `gitlab_${providerName}_search`,
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
                const { e, oAuthAccount, axiosWithAuth } = await getOAuthAccountForTool(req, provider);
                let { per_page, page, scope } = args;
                per_page = Math.max(Math.min(per_page || 20, 100), 1); // 1以上100以下
                page = Math.max(page || 1, 1); // 1以上
                scope = scope || 'projects';

                const url = `${e.uriBase}/api/v4/search?scope=${scope}&search=${encodeURIComponent(args.search)}&per_page=${per_page}&page=${page}`;
                const result = (await axiosWithAuth.get(url)).data;

                reform(result);
                // result.me = reform(oAuthAccount.userInfo);
                result.uriBase = e.uriBase;
                return result;
            }
        },
        {
            info: { group: provider, isActive: true, isInteractive: false, label: `プロジェクト一覧取得`, },
            definition: {
                type: 'function', function: {
                    name: `gitlab_${providerName}_projects`,
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
                const { e, axiosWithAuth } = await getOAuthAccountForTool(req, provider);
                let { per_page, page, membership, order_by, sort } = args;
                per_page = Math.max(Math.min(per_page || 20, 100), 1); // 1以上100以下
                page = Math.max(page || 1, 1); // 1以上
                membership = membership !== false; // デフォルトはtrue
                order_by = order_by || 'created_at';
                sort = sort || 'desc';

                const url = `${e.uriBase}/api/v4/projects?membership=${membership}&per_page=${per_page}&page=${page}&order_by=${order_by}&sort=${sort}`;
                const result = (await axiosWithAuth.get(url)).data;

                reform(result);
                // result.me = reform(oAuthAccount.userInfo);
                result.uriBase = e.uriBase;
                return result;
            }
        },
        {   // For retrieving commit logs
            info: { group: provider, isActive: true, isInteractive: false, label: `リポジトリのコミット履歴`, responseType: 'markdown' },
            definition: {
                type: 'function', function: {
                    name: `gitlab_${providerName}_repository_commits`,
                    description: `指定したプロジェクトのコミット履歴を取得`,
                    parameters: {
                        type: 'object',
                        properties: {
                            project_id: {
                                type: 'number',
                                description: 'プロジェクトID'
                            },
                            ref_name: {
                                type: 'string',
                                description: 'ブランチ名、タグ名、またはコミットSHA',
                            },
                            path: {
                                type: 'string',
                                description: '特定のファイルパスに限定する場合、そのパス',
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
            handler: async (args: { project_id: number, ref_name?: string, path?: string, per_page?: number, page?: number }): Promise<any> => {
                const { e, axiosWithAuth } = await getOAuthAccountForTool(req, provider);
                const { project_id, ref_name, path = '', per_page = 20, page = 1 } = args;
                const queryMap = {} as { [key: string]: string };
                if (path) queryMap.path = path;
                if (per_page) queryMap.per_page = per_page + '';
                if (page) queryMap.page = page + '';
                if (ref_name) queryMap.ref_name = ref_name;
                const url = `${e.uriBase}/api/v4/projects/${project_id}/repository/commits?${new URLSearchParams(queryMap)}`;
                // console.log(url);
                const result = (await axiosWithAuth.get(url)).data;

                // reform(result);
                // result.uriBase = e.uriBase;

                // JSONをMarkdownテーブルに変換
                let markdownTable = '## GitLabコミット履歴\n\n';
                markdownTable += `- uriBase: ${e.uriBase}`;
                // markdownTable += `- プロジェクトID: ${project_id}`;
                // markdownTable += `- ブランチ/タグ: ${ref_name || '全て'}`;
                // markdownTable += `- ファイルパス: ${path || '全て'}`;
                // markdownTable += `- ページ: ${page}`;
                // markdownTable += `- 1ページあたりの結果数: ${per_page}\n\n`;
                markdownTable += `\n\n`;
                markdownTable += '| ID | Short ID | 作成日 | 親コミットID | タイトル | メッセージ | 作成者名 | 作成者メール | 作成日時 | コミッター名 | コミッターメール | コミット日時 | Web URL |\n';
                markdownTable += '|---|----------|--------|-------------|---------|-----------|----------|--------------|---------|------------|-----------------|-----------|--------|\n';

                // 各コミットをテーブル行に変換
                for (const commit of result) {
                    // 日付部分のみ抽出 (YYYY-MM-DD形式)
                    const createdDate = commit.created_at;
                    const authoredDate = commit.authored_date;
                    const committedDate = commit.committed_date;

                    // 親コミットIDを文字列に変換
                    const parentIds = commit.parent_ids.join(', ');

                    // Markdownテーブル行を作成
                    markdownTable += `| ${commit.id} | ${commit.short_id} | ${createdDate} | ${parentIds} | ${commit.title.replaceAll(/\|/g, '\\|')} | ${commit.message.trim().replaceAll(/\|/g, '\\|')} | ${commit.author_name} | ${commit.author_email} | ${authoredDate} | ${commit.committer_name} | ${commit.committer_email} | ${committedDate} | [リンク](${commit.web_url}) |\n`;
                }

                // 元のJSONデータとMarkdownデータの両方を返す
                // フロントエンドでMarkdownを使いたい場合はmarkdownTable、
                // 既存の処理との互換性のためにresultも残す
                return markdownTable;
            }
        },
        {   // ブランチとタグ一覧を統合した関数
            info: { group: provider, isActive: true, isInteractive: false, label: `リポジトリのブランチ/タグ一覧`, },
            definition: {
                type: 'function', function: {
                    name: `gitlab_${providerName}_repository_refs`,
                    description: `指定したプロジェクトのブランチまたはタグ一覧を取得`,
                    parameters: {
                        type: 'object',
                        properties: {
                            project_id: {
                                type: 'number',
                                description: 'プロジェクトID'
                            },
                            ref_type: {
                                type: 'string',
                                description: '取得する参照タイプ',
                                enum: ['branches', 'tags'],
                                default: 'branches'
                            },
                            search: {
                                type: 'string',
                                description: 'Return list of branches containing the search string. Use ^term to find branches that begin with term, and term$ to find branches that end with term.',
                            },
                            regex: {
                                type: 'string',
                                description: 'Return list of branches with names matching a re2 regular expression.',
                            },
                        },
                        required: ['project_id']
                    }
                }
            },
            handler: async (args: { project_id: number, ref_type: string, search?: string, regex?: string }): Promise<any> => {
                const { e, axiosWithAuth } = await getOAuthAccountForTool(req, provider);
                const { project_id, ref_type = 'branches', search, regex, } = args;

                const queryMap = {} as { [key: string]: string };
                if (search) queryMap.search = search;
                if (regex) queryMap.regex = regex;

                // ref_typeに基づいてURLを構築
                const url = `${e.uriBase}/api/v4/projects/${project_id}/repository/${ref_type}?${new URLSearchParams(queryMap)}`;
                const result = (await axiosWithAuth.get(url)).data;

                reform(result);
                result.uriBase = e.uriBase;
                result.ref_type = ref_type; // どちらのタイプを取得したかを結果に含める
                return result;
            }
        },
        {   // For viewing commit differences (diff)
            info: { group: provider, isActive: true, isInteractive: false, label: `コミット間の差分を取得`, responseType: 'markdown' },
            definition: {
                type: 'function', function: {
                    name: `gitlab_${providerName}_repository_compare`,
                    description: `指定したプロジェクトの2つのコミット（ブランチやタグ）間の差分を取得`,
                    parameters: {
                        type: 'object',
                        properties: {
                            project_id: {
                                type: 'number',
                                description: 'プロジェクトID'
                            },
                            from: {
                                type: 'string',
                                description: '比較元のブランチ名、タグ名、またはコミットSHA'
                            },
                            to: {
                                type: 'string',
                                description: '比較先のブランチ名、タグ名、またはコミットSHA'
                            },
                            straight: {
                                type: 'boolean',
                                description: '比較方法（trueの場合は直接比較、falseの場合はマージベース比較）',
                                default: true
                            }
                        },
                        required: ['project_id', 'from', 'to']
                    }
                }
            },
            handler: async (args: { project_id: number, from: string, to: string, straight: boolean }): Promise<any> => {
                const { e, axiosWithAuth } = await getOAuthAccountForTool(req, provider);
                const { project_id, from, to, straight = true } = args;

                const url = `${e.uriBase}/api/v4/projects/${project_id}/repository/compare?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&straight=${straight}`;
                const result = (await axiosWithAuth.get(url)).data;

                // Format the output as markdown
                let markdown = `# 比較結果: ${from} → ${to}\n\n`;

                if (result.commits && result.commits.length > 0) {
                    markdown += `## コミット (${result.commits.length}件)\n\n`;
                    result.commits.forEach((commit: any) => {
                        markdown += `- **${commit.id.substring(0, 8)}** ${commit.title} (${commit.author_name}, ${new Date(commit.created_at).toLocaleString()})\n`;
                    });
                    markdown += '\n';
                }

                if (result.diffs && result.diffs.length > 0) {
                    markdown += `## 変更されたファイル (${result.diffs.length}件)\n\n`;
                    result.diffs.forEach((diff: any) => {
                        markdown += `### ${diff.new_path}\n`;
                        markdown += '```diff\n' + diff.diff + '\n```\n\n';
                    });
                }

                return markdown;
            }
        },
        {   // For viewing a specific commit
            info: { group: provider, isActive: true, isInteractive: false, label: `特定コミットの詳細`, },
            definition: {
                type: 'function', function: {
                    name: `gitlab_${providerName}_repository_commit`,
                    description: `指定したプロジェクトの特定のコミット詳細と変更内容を取得`,
                    parameters: {
                        type: 'object',
                        properties: {
                            project_id: {
                                type: 'number',
                                description: 'プロジェクトID'
                            },
                            commit_id: {
                                type: 'string',
                                description: 'コミットSHA'
                            },
                            stats: {
                                type: 'boolean',
                                description: '統計情報を含めるかどうか',
                                default: true
                            }
                        },
                        required: ['project_id', 'commit_id']
                    }
                }
            },
            handler: async (args: { project_id: number, commit_id: string, stats: boolean }): Promise<any> => {
                const { e, axiosWithAuth } = await getOAuthAccountForTool(req, provider);
                const { project_id, commit_id, stats = true } = args;

                // Get commit details
                const commitUrl = `${e.uriBase}/api/v4/projects/${project_id}/repository/commits/${encodeURIComponent(commit_id)}?stats=${stats}`;
                // console.log(commitUrl);
                const commitResult = (await axiosWithAuth.get(commitUrl)).data;
                // console.dir(commitResult);

                // Get commit diff
                const diffUrl = `${e.uriBase}/api/v4/projects/${project_id}/repository/commits/${encodeURIComponent(commit_id)}/diff`;
                // console.log(diffUrl);
                const diffResult = (await axiosWithAuth.get(diffUrl)).data;
                // console.dir(diffResult);

                const result = {
                    ...commitResult,
                    diffs: diffResult,
                    uriBase: e.uriBase
                };

                try {
                    reform(result);
                } catch (e) {
                    console.log('Error in reforming result');
                    console.error(e);
                }
                return result;
            }
        },
        // {
        //     info: { group: provider, isActive: true, isInteractive: false, label: `リポジトリ全ファイル一覧を取得`, },
        //     definition: {
        //         type: 'function', function: {
        //             name: `gitlab_${providerName}_repository_all_files`,
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
        //         const { e } = await getOAuthAccount(req, provider);

        //         // GitLabではプロジェクトIDは "owner/repo" をURLエンコードしたものを利用
        //         const projectId = encodeURIComponent(`${owner}/${repo}`);

        //         // リポジトリのツリー情報を再帰的に取得（最大件数はper_page=100、必要に応じてページングの実装が必要）
        //         const treeUrl = `${e.uriBase}/api/v4/projects/${projectId}/repository/tree?recursive=true&ref=${encodeURIComponent(ref)}&per_page=1000`;
        //         const treeResponse = await axiosWithAuth.get(treeUrl));
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
        //                 const contentResponse = await axiosWithAuth.get(rawUrl, { responseType: 'text' }));
        //                 const content = contentResponse.data;

        //                 // ファイル情報の取得
        //                 const infoUrl = `${e.uriBase}/api/v4/projects/${projectId}/repository/files/${encodeURIComponent(filePath)}?ref=${encodeURIComponent(ref)}`;
        //                 const infoResponse = await axiosWithAuth.get(infoUrl));
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
            info: { group: provider, isActive: true, isInteractive: false, label: `プロジェクトの課題一覧`, },
            definition: {
                type: 'function', function: {
                    name: `gitlab_${providerName}_project_issues`,
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
                const { e, axiosWithAuth } = await getOAuthAccountForTool(req, provider);
                let { project_id, state, per_page, page } = args;
                per_page = Math.max(Math.min(per_page || 20, 100), 1); // 1以上100以下
                page = Math.max(page || 1, 1); // 1以上
                state = state || 'opened';

                const url = `${e.uriBase}/api/v4/projects/${project_id}/issues?state=${state}&per_page=${per_page}&page=${page}`;
                const result = (await axiosWithAuth.get(url)).data;

                reform(result);
                // result.me = reform(oAuthAccount.userInfo);
                result.uriBase = e.uriBase;
                return result;
            }
        },
        {
            info: { group: provider, isActive: true, isInteractive: false, label: `プロジェクトのマージリクエスト一覧`, },
            definition: {
                type: 'function', function: {
                    name: `gitlab_${providerName}_project_merge_requests`,
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
                const { e, axiosWithAuth } = await getOAuthAccountForTool(req, provider);
                let { project_id, state, per_page, page } = args;
                per_page = Math.max(Math.min(per_page || 20, 100), 1); // 1以上100以下
                page = Math.max(page || 1, 1); // 1以上
                state = state || 'opened';

                const url = `${e.uriBase}/api/v4/projects/${project_id}/merge_requests?state=${state}&per_page=${per_page}&page=${page}`;
                const result = (await axiosWithAuth.get(url)).data;

                reform(result);
                // result.me = reform(oAuthAccount.userInfo);
                result.uriBase = e.uriBase;
                return result;
            }
        },
        {
            info: { group: provider, isActive: true, isInteractive: false, label: `gitlab-${providerName}：自分のユーザー情報`, },
            definition: {
                type: 'function', function: {
                    name: `gitlab_${providerName}_user_info`,
                    description: `gitlab-${providerName}：自分のユーザー情報`,
                    parameters: { type: 'object', properties: {}, }
                }
            },
            handler: async (args: {}): Promise<any> => {
                const { e, oAuthAccount, axiosWithAuth } = await getOAuthAccountForTool(req, provider);
                const url = `${e.uriBase}/api/v4/user`;
                const result = (await axiosWithAuth.get(url)).data;

                reform(result);
                result.me = reform(oAuthAccount.userInfo);
                result.uriBase = e.uriBase;
                return result;
            }
        },
        {
            info: { group: provider, isActive: true, isInteractive: false, label: `リポジトリファイル内容取得`, responseType: 'markdown' },
            definition: {
                type: 'function', function: {
                    name: `gitlab_${providerName}_file_content`,
                    description: `指定したプロジェクトのリポジトリからファイル内容を取得`,
                    parameters: {
                        type: 'object',
                        properties: {
                            project_id: {
                                type: 'number',
                                description: 'プロジェクトID'
                            },
                            file_path_list: {
                                type: 'array',
                                items: {
                                    type: 'string'
                                },
                                description: 'ファイルパスのリスト（例: src/main.js, docs/README.md）',
                                example: ['src/index.js', 'README.md']
                            },
                            ref: {
                                type: 'string',
                                description: 'ブランチ名、タグ名、またはコミットSHA',
                                default: 'main'
                            }
                        },
                        required: ['project_id', 'file_path_list']
                    }
                }
            },
            handler: async (args: { project_id: number, file_path_list: string[], ref: string }): Promise<any> => {
                const { e, oAuthAccount, axiosWithAuth } = await getOAuthAccountForTool(req, provider);
                let { project_id, file_path_list, ref } = args;

                if (ref) {
                    // ブランチ名、タグ名、SHAのいずれかが指定されている場合
                } else {
                    // デフォルトのブランチを取得
                    const defaultBranchUrl = `${e.uriBase}/api/v4/projects/${project_id}`;
                    const defaultBranchResult = (await axiosWithAuth.get(defaultBranchUrl)).data;
                    ref = defaultBranchResult.default_branch || 'main';
                }

                return await Promise.all(file_path_list.map(async (file_path) => {
                    const url = `${e.uriBase}/api/v4/projects/${project_id}/repository/files/${encodeURIComponent(file_path)}?ref=${encodeURIComponent(ref)}`;
                    const result = (await axiosWithAuth.get(url)).data;

                    // Base64デコードしてファイル内容を取得
                    if (result && result.content) {
                        result.decoded_content = Buffer.from(result.content, 'base64').toString('utf-8');
                    } else { }

                    // reform(result);
                    // // result.me = reform(oAuthAccount.userInfo);
                    // result.uriBase = e.uriBase;
                    // return result;

                    let trg = file_path.split('\.').at(-1) || '';
                    trg = { cob: 'cobol', cbl: 'cobol', pco: 'cobol', htm: 'html' }[trg] || trg;

                    return `\`\`\`${trg} ${file_path}\n\n${result.decoded_content}\n\`\`\`\n`;
                })).then((results) => results.join('\n'));
            }
        },
        {
            info: { group: provider, isActive: true, isInteractive: false, label: `リポジトリファイル内容取得（AI）`, responseType: 'markdown' },
            definition: {
                type: 'function', function: {
                    name: `gitlab_${providerName}_file_content_by_ai`,
                    description: `指定したプロジェクトのリポジトリからAI経由で情報を取得する`,
                    parameters: {
                        type: 'object',
                        properties: {
                            userPrompt: {
                                type: 'string',
                                description: 'AI要約に置けるプロンプト（例: "関数一覧のみを抽出してください"）',
                                default: '要約してください'
                            },
                            project_id: {
                                type: 'number',
                                description: 'プロジェクトID'
                            },
                            file_path_list: {
                                type: 'array',
                                items: {
                                    type: 'string'
                                },
                                description: 'ファイルパスのリスト（例: src/main.js, docs/README.md）',
                                example: ['src/index.js', 'README.md']
                            },
                            ref: {
                                type: 'string',
                                description: 'ブランチ名、タグ名、またはコミットSHA',
                                default: 'main'
                            }
                        },
                        required: ['project_id', 'file_path_list']
                    }
                }
            },
            handler: async (args: { userPrompt?: string, project_id: number, file_path_list: string[], ref: string }): Promise<any> => {
                const { e, oAuthAccount, axiosWithAuth } = await getOAuthAccountForTool(req, provider);
                let { userPrompt = '要約してください', project_id, file_path_list, ref } = args;
                const aiProvider = await getAIProvider(req.info.user, obj.inDto.args.model);

                if (ref) {
                    // ブランチ名、タグ名、SHAのいずれかが指定されている場合
                } else {
                    // デフォルトのブランチを取得
                    const defaultBranchUrl = `${e.uriBase}/api/v4/projects/${project_id}`;
                    const defaultBranchResult = (await axiosWithAuth.get(defaultBranchUrl)).data;
                    ref = defaultBranchResult.default_branch || 'main';
                }

                return await Promise.all(file_path_list.map(async (file_path) => {
                    const url = `${e.uriBase}/api/v4/projects/${project_id}/repository/files/${encodeURIComponent(file_path)}?ref=${encodeURIComponent(ref)}`;
                    const result = (await axiosWithAuth.get(url)).data;

                    // Base64デコードしてファイル内容を取得
                    if (result && result.content) {
                        result.decoded_content = Buffer.from(result.content, 'base64').toString('utf-8');
                    } else { }


                    let trg = file_path.split('\.').at(-1) || '';
                    trg = { cob: 'cobol', cbl: 'cobol', pco: 'cobol', htm: 'html' }[trg] || trg;
                    const codeBlock = `\`\`\`${trg} ${file_path}\n\n${result.decoded_content}\n\`\`\`\n`;
                    // const codeInfoBlock = `\`\`\`json\n${JSON.stringify(contentInfo, null, 2)}\n\`\`\`\n`; // ファイル情報

                    const systemPrompt = 'アシスタントAI';
                    const inDto = Utils.deepCopyOmitting(obj.inDto, 'aiProviderClient');
                    // inDto.args.model = 'gemini-1.5-pro';
                    inDto.args.messages = [
                        { role: 'system', content: [{ type: 'text', text: systemPrompt }] },
                        {
                            role: 'user', content: [
                                { type: 'text', text: userPrompt },
                                // { type: 'text', text: codeInfoBlock },
                                { type: 'text', text: codeBlock },
                            ],
                        },
                    ];
                    // toolは使わないので空にしておく
                    delete inDto.args.tool_choice;
                    delete inDto.args.tools;

                    const newLabel = `${label}-call_ai-${inDto.args.model}`;
                    // レスポンス返した後にゆるりとヒストリーを更新しておく。
                    const history = new PredictHistoryWrapperEntity();
                    history.orgKey = req.info.user.orgKey;
                    history.connectionId = connectionId;
                    history.streamId = streamId;
                    history.messageId = message.id;
                    history.label = newLabel;
                    history.model = inDto.args.model;
                    history.provider = aiProvider.type;
                    history.createdBy = req.info.user.id;
                    history.updatedBy = req.info.user.id;
                    history.createdIp = req.info.ip;
                    history.updatedIp = req.info.ip;
                    await ds.getRepository(PredictHistoryWrapperEntity).save(history);

                    return new Promise((resolve, reject) => {
                        let text = '';
                        // console.log(`call_ai: model=${model}, userPrompt=${userPrompt}`);
                        aiApi.chatCompletionObservableStream(
                            inDto.args, { label: newLabel }, aiProvider,
                        ).pipe(
                            map(res => res.choices.map(choice => choice.delta.content).join('')),
                            toArray(),
                            map(res => res.join('')),
                        ).subscribe({
                            next: next => {
                                text += next;
                            },
                            error: error => {
                                reject(error);
                            },
                            complete: () => {
                                resolve(text);
                            },
                        });;
                    });
                })).then((results) => results.join('\n'));
            }
        },
        {
            info: { group: provider, isActive: true, isInteractive: false, label: `リポジトリファイル一覧取得（ls風）`, responseType: 'markdown' },
            definition: {
                type: 'function', function: {
                    name: `gitlab_${providerName}_repository_tree`,
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
                            // show_directories: {
                            //     type: 'boolean',
                            //     description: 'ディレクトリも表示するかどうか',
                            //     default: false
                            // }
                        },
                        required: ['project_id']
                    }
                }
            },
            handler: async (args: { project_id: number, path: string, ref: string, recursive: boolean, show_directories: boolean }): Promise<any> => {
                const { e, oAuthAccount, axiosWithAuth } = await getOAuthAccountForTool(req, provider);
                let { project_id, path, ref, recursive, show_directories } = args;
                path = path || '';
                recursive = recursive !== false; // 明示的にfalseの場合のみfalse
                show_directories = show_directories === true; // 明示的にtrueの場合のみtrue

                if (ref) {
                    // ブランチ名、タグ名、SHAのいずれかが指定されている場合
                } else {
                    // デフォルトのブランチを取得
                    const defaultBranchUrl = `${e.uriBase}/api/v4/projects/${project_id}`;
                    const defaultBranchResult = (await axiosWithAuth.get(defaultBranchUrl)).data;
                    ref = defaultBranchResult.default_branch || 'main';
                }


                let allItems: any[] = [];
                let currentPage = 1;
                let hasMorePages = true;

                const queryMap = {} as { [key: string]: string };
                queryMap.per_page = 100 + '';// GitLabのAPIでは最大100件しか一度に取得できないので、100に設定
                if (path) queryMap.path = path;
                if (ref) queryMap.ref = ref;
                if (recursive) queryMap.recursive = recursive + '';

                const query = new URLSearchParams(queryMap);

                // 全ページ取得
                while (hasMorePages) {
                    // TODO pagination=keyset
                    const url = `${e.uriBase}/api/v4/projects/${project_id}/repository/tree?${query.toString()}&page=${currentPage}`;
                    const response = await axiosWithAuth.get(url);
                    const result = response.data;

                    if (result.length > 0) {
                        allItems = allItems.concat(result);
                        currentPage++;
                    } else {
                        hasMorePages = false;
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
                output += `## uriBase=${e.uriBase}\n\n`;

                // ls風の表示
                // const formattedItems = allItems.map(item => {
                //     const type = item.type === 'tree' ? 'd' : '-';
                //     const mode = item.mode || '100644'; // デフォルトパーミッション
                //     const formattedMode = formatMode(mode);
                //     const name = item.path.split('/').pop(); // パスの最後の部分を取得
                //     const fullPath = item.path;
                //     return `${type}${formattedMode} ${item.id} ${fullPath}${item.type === 'tree' ? '/' : ''}`;
                // });

                // フィルタしたアイテムの配列を取得
                const filteredItems = allItems.filter(item => item.type !== 'tree');
                const batchSize = 20; // バッチサイズ
                const results = [];
                for (let i = 0; i < filteredItems.length; i += batchSize) {
                    const batch = filteredItems.slice(i, i + batchSize);
                    const batchResults = await Promise.all(
                        batch.map(async item => {
                            const url = `${e.uriBase}/api/v4/projects/${project_id}/repository/files/${encodeURIComponent(item.path)}?ref=${ref}`;
                            const response = await axiosWithAuth.head(url);
                            return { ...item, size: response.headers['x-gitlab-size'] };
                        })
                    );
                    results.push(...batchResults);
                }
                const maxSizeLen = Math.max(...results.map(item => (item.size + '').length));
                const formattedItems = results.map(item => {
                    const type = item.type === 'tree' ? 'd' : '-';
                    const mode = item.mode || '100644'; // デフォルトパーミッション
                    const formattedMode = formatMode(mode);
                    const fullPath = item.path;
                    console.log(item.size, item.path);
                    return `${type}${formattedMode} ${String(item.size).padStart(maxSizeLen, ' ')} ${fullPath}${item.type === 'tree' ? '/' : ''}`;
                });

                output += `\`\`\`text\n${formattedItems.join('\n')}\n\`\`\``;
                return output;
            }
        },
        {
            info: { group: provider, isActive: true, isInteractive: false, label: `プロジェクト内ファイル内容検索`, },
            definition: {
                type: 'function', function: {
                    name: `gitlab_${providerName}_project_file_search`,
                    description: `指定したプロジェクト内でファイル内容を検索します。ファイル名とファイル内容の両方を対象に検索を行い、コードやドキュメント内の特定のキーワードを見つけることができます。`,
                    parameters: {
                        type: 'object',
                        properties: {
                            project_id: {
                                type: 'number',
                                description: 'プロジェクトID'
                            },
                            search: {
                                type: 'string',
                                description: '検索キーワード。ファイル名とファイル内容の両方が検索対象になります。'
                            },
                            filename_filter: {
                                type: 'string',
                                description: 'ファイルパターンによる絞り込み（例: "*.py", "*.js", "README*"）。ワイルドカード（*）が使用可能です。',
                                example: '*.py'
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
                            ref: {
                                type: 'string',
                                description: '検索対象のブランチ名、タグ名、またはコミットSHA',
                                default: 'main'
        }
                        },
                        required: ['project_id', 'search']
                    }
                }
            },
            handler: async (args: { project_id: number, search: string, filename_filter?: string, per_page?: number, page?: number, ref?: string }): Promise<any> => {
                const { e, axiosWithAuth } = await getOAuthAccountForTool(req, provider);
                let { project_id, search, filename_filter, per_page, page, ref } = args;

                per_page = Math.max(Math.min(per_page || 20, 100), 1);
                page = Math.max(page || 1, 1);

                // 検索クエリの構築
                let searchQuery = encodeURIComponent(search);
                if (filename_filter) {
                    searchQuery += `+filename:${encodeURIComponent(filename_filter)}`;
                }

                const url = `${e.uriBase}/api/v4/projects/${project_id}/search?scope=blobs&search=${searchQuery}&per_page=${per_page}&page=${page}${ref ? `&ref=${encodeURIComponent(ref)}` : ''}`;
                const result = (await axiosWithAuth.get(url)).data;

                reform(result);
                result.uriBase = e.uriBase;
                result.search_info = {
                    project_id,
                    search_query: search,
                    filename_filter: filename_filter || 'なし',
                    total_results: result.length,
                    ref: ref || 'デフォルトブランチ'
                };
                return result;
            }
        },
        // グローバルファイル内容検索（Elasticsearch必須）
        {
            info: { group: provider, isActive: false, isInteractive: false, label: `グローバルファイル内容検索`, },
            definition: {
                type: 'function', function: {
                    name: `gitlab_${providerName}_global_file_search`,
                    description: `GitLab インスタンス全体でファイル内容を検索します。アクセス権限のあるすべてのプロジェクトを対象に、ファイル名とファイル内容の両方から特定のキーワードを検索できます。`,
                    parameters: {
                        type: 'object',
                        properties: {
                            search: {
                                type: 'string',
                                description: '検索キーワード。ファイル名とファイル内容の両方が検索対象になります。'
                            },
                            filename_filter: {
                                type: 'string',
                                description: 'ファイルパターンによる絞り込み（例: "*.py", "*.js", "README*"）。ワイルドカード（*）が使用可能です。',
                                example: '*.py'
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
            handler: async (args: { search: string, filename_filter?: string, per_page?: number, page?: number }): Promise<any> => {
                const { e, axiosWithAuth } = await getOAuthAccountForTool(req, provider);
                let { search, filename_filter, per_page, page } = args;

                per_page = Math.max(Math.min(per_page || 20, 100), 1);
                page = Math.max(page || 1, 1);

                // 検索クエリの構築
                let searchQuery = encodeURIComponent(search);
                if (filename_filter) {
                    searchQuery += `+filename:${encodeURIComponent(filename_filter)}`;
                }

                const url = `${e.uriBase}/api/v4/search?scope=blobs&search=${searchQuery}&per_page=${per_page}&page=${page}`;
                const result = (await axiosWithAuth.get(url)).data;

                reform(result);
                result.uriBase = e.uriBase;
                result.search_info = {
                    scope: 'グローバル',
                    search_query: search,
                    filename_filter: filename_filter || 'なし',
                    total_results: result.length
                };
                return result;
            }
        },
        // グループ内ファイル内容検索（Elasticsearch必須）
        {
            info: { group: provider, isActive: false, isInteractive: false, label: `グループ内ファイル内容検索`, },
            definition: {
                type: 'function', function: {
                    name: `gitlab_${providerName}_group_file_search`,
                    description: `指定したグループ内の全プロジェクトでファイル内容を検索します。グループに属するすべてのプロジェクトを対象に、ファイル名とファイル内容の両方から特定のキーワードを検索できます。`,
                    parameters: {
                        type: 'object',
                        properties: {
                            group_id: {
                                type: 'number',
                                description: 'グループID'
                            },
                            search: {
                                type: 'string',
                                description: '検索キーワード。ファイル名とファイル内容の両方が検索対象になります。'
                            },
                            filename_filter: {
                                type: 'string',
                                description: 'ファイルパターンによる絞り込み（例: "*.py", "*.js", "README*"）。ワイルドカード（*）が使用可能です。',
                                example: '*.py'
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
                        required: ['group_id', 'search']
                    }
                }
            },
            handler: async (args: { group_id: number, search: string, filename_filter?: string, per_page?: number, page?: number }): Promise<any> => {
                const { e, axiosWithAuth } = await getOAuthAccountForTool(req, provider);
                let { group_id, search, filename_filter, per_page, page } = args;

                per_page = Math.max(Math.min(per_page || 20, 100), 1);
                page = Math.max(page || 1, 1);

                // 検索クエリの構築
                let searchQuery = encodeURIComponent(search);
                if (filename_filter) {
                    searchQuery += `+filename:${encodeURIComponent(filename_filter)}`;
                }

                const url = `${e.uriBase}/api/v4/groups/${group_id}/search?scope=blobs&search=${searchQuery}&per_page=${per_page}&page=${page}`;
                const result = (await axiosWithAuth.get(url)).data;

                reform(result);
                result.uriBase = e.uriBase;
                result.search_info = {
                    group_id,
                    search_query: search,
                    filename_filter: filename_filter || 'なし',
                    total_results: result.length
                };
                return result;
            }
        },
        {
            info: { group: provider, isActive: true, isInteractive: true, label: `Issue作成`, },
            definition: {
                type: 'function', function: {
                    name: `gitlab_${providerName}_create_issue`,
                    description: `GitLabで新しいIssueを作成`,
                    parameters: {
                        type: 'object',
                        properties: {
                            project_id: { type: 'number', description: 'プロジェクトID' },
                            title: { type: 'string', description: 'Issueのタイトル' },
                            description: { type: 'string', description: 'Issueの説明', default: '' },
                            assignee_ids: { type: 'array', items: { type: 'number' }, description: '担当者のユーザーIDの配列', default: [] },
                            labels: { type: 'string', description: 'カンマ区切りのラベル', default: '' },
                            milestone_id: { type: 'number', description: 'マイルストーンID' },
                            confidential: { type: 'boolean', description: '機密Issue', default: false }
                        },
                        required: ['project_id', 'title']
                    }
                }
            },
            handler: async (args: { project_id: number, title: string, description?: string, assignee_ids?: number[], labels?: string, milestone_id?: number, confidential?: boolean }): Promise<any> => {
                const { e, axiosWithAuth } = await getOAuthAccountForTool(req, provider);
                const { project_id, title, description = '', assignee_ids = [], labels = '', milestone_id, confidential = false } = args;

                const issueData: any = {
                    title: title,
                    description: description,
                    assignee_ids: assignee_ids,
                    labels: labels,
                    confidential: confidential
                };

                if (milestone_id) issueData.milestone_id = milestone_id;

                const url = `${e.uriBase}/api/v4/projects/${project_id}/issues`;
                const result = (await axiosWithAuth.post(url, issueData)).data;

                reform(result);
                result.uriBase = e.uriBase;
                return result;
            }
        },
        {
            info: { group: provider, isActive: true, isInteractive: true, label: `Issue更新`, },
            definition: {
                type: 'function', function: {
                    name: `gitlab_${providerName}_update_issue`,
                    description: `GitLabの既存Issueを更新`,
                    parameters: {
                        type: 'object',
                        properties: {
                            project_id: { type: 'number', description: 'プロジェクトID' },
                            issue_iid: { type: 'number', description: 'Issue IID' },
                            title: { type: 'string', description: '新しいタイトル' },
                            description: { type: 'string', description: '新しい説明' },
                            assignee_ids: { type: 'array', items: { type: 'number' }, description: '担当者のユーザーIDの配列' },
                            labels: { type: 'string', description: 'カンマ区切りのラベル' },
                            state_event: { type: 'string', description: 'ステート変更', enum: ['close', 'reopen'] }
                        },
                        required: ['project_id', 'issue_iid']
                    }
                }
            },
            handler: async (args: { project_id: number, issue_iid: number, title?: string, description?: string, assignee_ids?: number[], labels?: string, state_event?: string }): Promise<any> => {
                const { e, axiosWithAuth } = await getOAuthAccountForTool(req, provider);
                const { project_id, issue_iid, title, description, assignee_ids, labels, state_event } = args;

                const updateData: any = {};
                if (title) updateData.title = title;
                if (description) updateData.description = description;
                if (assignee_ids) updateData.assignee_ids = assignee_ids;
                if (labels) updateData.labels = labels;
                if (state_event) updateData.state_event = state_event;

                const url = `${e.uriBase}/api/v4/projects/${project_id}/issues/${issue_iid}`;
                const result = (await axiosWithAuth.put(url, updateData)).data;

                reform(result);
                result.uriBase = e.uriBase;
                return result;
            }
        },
        {
            info: { group: provider, isActive: true, isInteractive: true, label: `Issue削除`, },
            definition: {
                type: 'function', function: {
                    name: `gitlab_${providerName}_delete_issue`,
                    description: `GitLabのIssueを削除`,
                    parameters: {
                        type: 'object',
                        properties: {
                            project_id: { type: 'number', description: 'プロジェクトID' },
                            issue_iid: { type: 'number', description: 'Issue IID' }
                        },
                        required: ['project_id', 'issue_iid']
                    }
                }
            },
            handler: async (args: { project_id: number, issue_iid: number }): Promise<any> => {
                const { e, axiosWithAuth } = await getOAuthAccountForTool(req, provider);
                const { project_id, issue_iid } = args;

                const url = `${e.uriBase}/api/v4/projects/${project_id}/issues/${issue_iid}`;
                const result = (await axiosWithAuth.delete(url)).data;

                reform(result);
                result.uriBase = e.uriBase;
                return result;
            }
        },
        {
            info: { group: provider, isActive: true, isInteractive: true, label: `マージリクエスト作成`, },
            definition: {
                type: 'function', function: {
                    name: `gitlab_${providerName}_create_merge_request`,
                    description: `GitLabで新しいマージリクエストを作成`,
                    parameters: {
                        type: 'object',
                        properties: {
                            project_id: { type: 'number', description: 'プロジェクトID' },
                            source_branch: { type: 'string', description: 'ソースブランチ名' },
                            target_branch: { type: 'string', description: 'ターゲットブランチ名' },
                            title: { type: 'string', description: 'マージリクエストのタイトル' },
                            description: { type: 'string', description: 'マージリクエストの説明', default: '' },
                            assignee_id: { type: 'number', description: '担当者のユーザーID' },
                            target_project_id: { type: 'number', description: 'ターゲットプロジェクトID（フォーク間のMRの場合）' }
                        },
                        required: ['project_id', 'source_branch', 'target_branch', 'title']
                    }
                }
            },
            handler: async (args: { project_id: number, source_branch: string, target_branch: string, title: string, description?: string, assignee_id?: number, target_project_id?: number }): Promise<any> => {
                const { e, axiosWithAuth } = await getOAuthAccountForTool(req, provider);
                const { project_id, source_branch, target_branch, title, description = '', assignee_id, target_project_id } = args;

                const mrData: any = {
                    source_branch: source_branch,
                    target_branch: target_branch,
                    title: title,
                    description: description
                };

                if (assignee_id) mrData.assignee_id = assignee_id;
                if (target_project_id) mrData.target_project_id = target_project_id;

                const url = `${e.uriBase}/api/v4/projects/${project_id}/merge_requests`;
                const result = (await axiosWithAuth.post(url, mrData)).data;

                reform(result);
                result.uriBase = e.uriBase;
                return result;
            }
        },
        {
            info: { group: provider, isActive: true, isInteractive: true, label: `ファイル作成・更新`, },
            definition: {
                type: 'function', function: {
                    name: `gitlab_${providerName}_create_or_update_file`,
                    description: `GitLabリポジトリでファイルを作成または更新`,
                    parameters: {
                        type: 'object',
                        properties: {
                            project_id: { type: 'number', description: 'プロジェクトID' },
                            file_path: { type: 'string', description: 'ファイルパス' },
                            content: { type: 'string', description: 'ファイル内容' },
                            commit_message: { type: 'string', description: 'コミットメッセージ' },
                            branch: { type: 'string', description: 'ブランチ名', default: 'main' },
                            author_email: { type: 'string', description: '作成者のメールアドレス' },
                            author_name: { type: 'string', description: '作成者の名前' },
                            encoding: { type: 'string', description: 'エンコーディング', enum: ['text', 'base64'], default: 'text' }
                        },
                        required: ['project_id', 'file_path', 'content', 'commit_message']
                    }
                }
            },
            handler: async (args: { project_id: number, file_path: string, content: string, commit_message: string, branch?: string, author_email?: string, author_name?: string, encoding?: string }): Promise<any> => {
                const { e, axiosWithAuth } = await getOAuthAccountForTool(req, provider);
                const { project_id, file_path, content, commit_message, branch = 'main', author_email, author_name, encoding = 'text' } = args;

                const fileData: any = {
                    content: content,
                    commit_message: commit_message,
                    branch: branch,
                    encoding: encoding
                };

                if (author_email) fileData.author_email = author_email;
                if (author_name) fileData.author_name = author_name;

                const url = `${e.uriBase}/api/v4/projects/${project_id}/repository/files/${encodeURIComponent(file_path)}`;
                const result = (await axiosWithAuth.post(url, fileData)).data;

                reform(result);
                result.uriBase = e.uriBase;
                return result;
            }
        },
        {
            info: { group: provider, isActive: true, isInteractive: true, label: `ファイル削除`, },
            definition: {
                type: 'function', function: {
                    name: `gitlab_${providerName}_delete_file`,
                    description: `GitLabリポジトリからファイルを削除`,
                    parameters: {
                        type: 'object',
                        properties: {
                            project_id: { type: 'number', description: 'プロジェクトID' },
                            file_path: { type: 'string', description: 'ファイルパス' },
                            commit_message: { type: 'string', description: 'コミットメッセージ' },
                            branch: { type: 'string', description: 'ブランチ名', default: 'main' },
                            author_email: { type: 'string', description: '作成者のメールアドレス' },
                            author_name: { type: 'string', description: '作成者の名前' }
                        },
                        required: ['project_id', 'file_path', 'commit_message']
                    }
                }
            },
            handler: async (args: { project_id: number, file_path: string, commit_message: string, branch?: string, author_email?: string, author_name?: string }): Promise<any> => {
                const { e, axiosWithAuth } = await getOAuthAccountForTool(req, provider);
                const { project_id, file_path, commit_message, branch = 'main', author_email, author_name } = args;

                const deleteData: any = {
                    commit_message: commit_message,
                    branch: branch
                };

                if (author_email) deleteData.author_email = author_email;
                if (author_name) deleteData.author_name = author_name;

                const url = `${e.uriBase}/api/v4/projects/${project_id}/repository/files/${encodeURIComponent(file_path)}`;
                const result = (await axiosWithAuth.delete(url, { data: deleteData })).data;

                reform(result);
                result.uriBase = e.uriBase;
                return result;
            }
        },
        {
            info: { group: provider, isActive: true, isInteractive: true, label: `ブランチ作成`, },
            definition: {
                type: 'function', function: {
                    name: `gitlab_${providerName}_create_branch`,
                    description: `GitLabリポジトリで新しいブランチを作成`,
                    parameters: {
                        type: 'object',
                        properties: {
                            project_id: { type: 'number', description: 'プロジェクトID' },
                            branch_name: { type: 'string', description: '新しいブランチ名' },
                            ref: { type: 'string', description: 'ベースとなるブランチ名、タグ名、またはコミットSHA', default: 'main' }
                        },
                        required: ['project_id', 'branch_name']
                    }
                }
            },
            handler: async (args: { project_id: number, branch_name: string, ref?: string }): Promise<any> => {
                const { e, axiosWithAuth } = await getOAuthAccountForTool(req, provider);
                const { project_id, branch_name, ref = 'main' } = args;

                const branchData = {
                    branch: branch_name,
                    ref: ref
                };

                const url = `${e.uriBase}/api/v4/projects/${project_id}/repository/branches`;
                const result = (await axiosWithAuth.post(url, branchData)).data;

                reform(result);
                result.uriBase = e.uriBase;
                return result;
            }
        },
        {
            info: { group: provider, isActive: true, isInteractive: true, label: `ブランチ削除`, },
            definition: {
                type: 'function', function: {
                    name: `gitlab_${providerName}_delete_branch`,
                    description: `GitLabリポジトリのブランチを削除`,
                    parameters: {
                        type: 'object',
                        properties: {
                            project_id: { type: 'number', description: 'プロジェクトID' },
                            branch_name: { type: 'string', description: '削除するブランチ名' }
                        },
                        required: ['project_id', 'branch_name']
                    }
                }
            },
            handler: async (args: { project_id: number, branch_name: string }): Promise<any> => {
                const { e, axiosWithAuth } = await getOAuthAccountForTool(req, provider);
                const { project_id, branch_name } = args;

                const url = `${e.uriBase}/api/v4/projects/${project_id}/repository/branches/${encodeURIComponent(branch_name)}`;
                const result = (await axiosWithAuth.delete(url)).data;

                reform(result);
                result.uriBase = e.uriBase;
                return result;
            }
        },
        {
            info: { group: provider, isActive: true, isInteractive: true, label: `プロジェクト作成`, },
            definition: {
                type: 'function', function: {
                    name: `gitlab_${providerName}_create_project`,
                    description: `GitLabで新しいプロジェクト（リポジトリ）を作成`,
                    parameters: {
                        type: 'object',
                        properties: {
                            name: { type: 'string', description: 'プロジェクト名' },
                            description: { type: 'string', description: 'プロジェクトの説明', default: '' },
                            visibility: { type: 'string', description: '可視性', enum: ['private', 'internal', 'public'], default: 'private' },
                            initialize_with_readme: { type: 'boolean', description: 'README.mdを自動作成', default: true },
                            default_branch: { type: 'string', description: 'デフォルトブランチ名', default: 'main' },
                            namespace_id: { type: 'number', description: '名前空間ID（グループに作成する場合）' },
                            issues_enabled: { type: 'boolean', description: 'Issueを有効にするか', default: true },
                            merge_requests_enabled: { type: 'boolean', description: 'マージリクエストを有効にするか', default: true },
                            wiki_enabled: { type: 'boolean', description: 'Wikiを有効にするか', default: true },
                            snippets_enabled: { type: 'boolean', description: 'スニペットを有効にするか', default: true },
                            container_registry_enabled: { type: 'boolean', description: 'コンテナレジストリを有効にするか', default: true }
                        },
                        required: ['name']
                    }
                }
            },
            handler: async (args: { name: string, description?: string, visibility?: string, initialize_with_readme?: boolean, default_branch?: string, namespace_id?: number, issues_enabled?: boolean, merge_requests_enabled?: boolean, wiki_enabled?: boolean, snippets_enabled?: boolean, container_registry_enabled?: boolean }): Promise<any> => {
                const { e, axiosWithAuth } = await getOAuthAccountForTool(req, provider);
                const {
                    name,
                    description = '',
                    visibility = 'private',
                    initialize_with_readme = true,
                    default_branch = 'main',
                    namespace_id,
                    issues_enabled = true,
                    merge_requests_enabled = true,
                    wiki_enabled = true,
                    snippets_enabled = true,
                    container_registry_enabled = true
                } = args;

                const projectData: any = {
                    name: name,
                    description: description,
                    visibility: visibility,
                    initialize_with_readme: initialize_with_readme,
                    default_branch: default_branch,
                    issues_enabled: issues_enabled,
                    merge_requests_enabled: merge_requests_enabled,
                    wiki_enabled: wiki_enabled,
                    snippets_enabled: snippets_enabled,
                    container_registry_enabled: container_registry_enabled
                };

                if (namespace_id) projectData.namespace_id = namespace_id;

                const url = `${e.uriBase}/api/v4/projects`;
                const result = (await axiosWithAuth.post(url, projectData)).data;

                reform(result);
                result.uriBase = e.uriBase;
                return result;
            }
        },
        {
            info: { group: provider, isActive: true, isInteractive: false, label: `プロジェクトフォーク`, },
            definition: {
                type: 'function', function: {
                    name: `gitlab_${providerName}_fork_project`,
                    description: `GitLabプロジェクトをフォーク`,
                    parameters: {
                        type: 'object',
                        properties: {
                            project_id: { type: 'number', description: 'フォーク元のプロジェクトID' },
                            namespace: { type: 'string', description: 'フォーク先の名前空間（ユーザー名またはグループ名）' },
                            name: { type: 'string', description: 'フォーク先のプロジェクト名（指定しない場合は元の名前を使用）' },
                            path: { type: 'string', description: 'フォーク先のプロジェクトパス（指定しない場合は元のパスを使用）' }
                        },
                        required: ['project_id']
                    }
                }
            },
            handler: async (args: { project_id: number, namespace?: string, name?: string, path?: string }): Promise<any> => {
                const { e, axiosWithAuth } = await getOAuthAccountForTool(req, provider);
                const { project_id, namespace, name, path } = args;

                const forkData: any = {};
                if (namespace) forkData.namespace = namespace;
                if (name) forkData.name = name;
                if (path) forkData.path = path;

                const url = `${e.uriBase}/api/v4/projects/${project_id}/fork`;
                const result = (await axiosWithAuth.post(url, forkData)).data;

                reform(result);
                result.uriBase = e.uriBase;
                return result;
            }
        },
        {
            info: { group: provider, isActive: true, isInteractive: false, label: `パイプライン一覧取得`, },
            definition: {
                type: 'function', function: {
                    name: `gitlab_${providerName}_project_pipelines`,
                    description: `GitLabプロジェクトのパイプライン一覧を取得`,
                    parameters: {
                        type: 'object',
                        properties: {
                            project_id: { type: 'number', description: 'プロジェクトID' },
                            status: { type: 'string', description: 'パイプラインのステータス', enum: ['created', 'waiting_for_resource', 'preparing', 'pending', 'running', 'success', 'failed', 'canceled', 'skipped', 'manual', 'scheduled'] },
                            ref: { type: 'string', description: 'ブランチまたはタグ名' },
                            per_page: { type: 'number', description: '1ページあたりの結果数（最大100）', default: 20, minimum: 1, maximum: 100 },
                            page: { type: 'number', description: 'ページ番号', default: 1, minimum: 1 }
                        },
                        required: ['project_id']
                    }
                }
            },
            handler: async (args: { project_id: number, status?: string, ref?: string, per_page?: number, page?: number }): Promise<any> => {
                const { e, axiosWithAuth } = await getOAuthAccountForTool(req, provider);
                let { project_id, status, ref, per_page = 20, page = 1 } = args;
                per_page = Math.max(Math.min(per_page, 100), 1);
                page = Math.max(page, 1);

                const queryParams = new URLSearchParams();
                queryParams.append('per_page', per_page.toString());
                queryParams.append('page', page.toString());
                if (status) queryParams.append('status', status);
                if (ref) queryParams.append('ref', ref);

                const url = `${e.uriBase}/api/v4/projects/${project_id}/pipelines?${queryParams.toString()}`;
                const result = (await axiosWithAuth.get(url)).data;

                reform(result);
                result.uriBase = e.uriBase;
                return result;
            }
        },
        {
            info: { group: provider, isActive: true, isInteractive: false, label: `パイプライン詳細取得`, },
            definition: {
                type: 'function', function: {
                    name: `gitlab_${providerName}_pipeline_detail`,
                    description: `GitLabパイプラインの詳細情報を取得`,
                    parameters: {
                        type: 'object',
                        properties: {
                            project_id: { type: 'number', description: 'プロジェクトID' },
                            pipeline_id: { type: 'number', description: 'パイプラインID' }
                        },
                        required: ['project_id', 'pipeline_id']
                    }
                }
            },
            handler: async (args: { project_id: number, pipeline_id: number }): Promise<any> => {
                const { e, axiosWithAuth } = await getOAuthAccountForTool(req, provider);
                const { project_id, pipeline_id } = args;

                const url = `${e.uriBase}/api/v4/projects/${project_id}/pipelines/${pipeline_id}`;
                const result = (await axiosWithAuth.get(url)).data;

                reform(result);
                result.uriBase = e.uriBase;
                return result;
            }
        },
        {
            info: { group: provider, isActive: true, isInteractive: false, label: `パイプラインジョブ一覧`, },
            definition: {
                type: 'function', function: {
                    name: `gitlab_${providerName}_pipeline_jobs`,
                    description: `GitLabパイプラインのジョブ一覧を取得`,
                    parameters: {
                        type: 'object',
                        properties: {
                            project_id: { type: 'number', description: 'プロジェクトID' },
                            pipeline_id: { type: 'number', description: 'パイプラインID' },
                            scope: { type: 'array', items: { type: 'string' }, description: 'ジョブのスコープ配列', example: ['success', 'failed', 'canceled'] }
                        },
                        required: ['project_id', 'pipeline_id']
                    }
                }
            },
            handler: async (args: { project_id: number, pipeline_id: number, scope?: string[] }): Promise<any> => {
                const { e, axiosWithAuth } = await getOAuthAccountForTool(req, provider);
                const { project_id, pipeline_id, scope } = args;

                const queryParams = new URLSearchParams();
                if (scope && scope.length > 0) {
                    scope.forEach(s => queryParams.append('scope[]', s));
                }

                const url = `${e.uriBase}/api/v4/projects/${project_id}/pipelines/${pipeline_id}/jobs?${queryParams.toString()}`;
                const result = (await axiosWithAuth.get(url)).data;

                reform(result);
                result.uriBase = e.uriBase;
                return result;
            }
        },
        {
            info: { group: provider, isActive: true, isInteractive: false, label: `パイプライン実行`, },
            definition: {
                type: 'function', function: {
                    name: `gitlab_${providerName}_trigger_pipeline`,
                    description: `GitLabパイプラインを実行`,
                    parameters: {
                        type: 'object',
                        properties: {
                            project_id: { type: 'number', description: 'プロジェクトID' },
                            ref: { type: 'string', description: 'ブランチ名、タグ名、またはコミットSHA' },
                            variables: { type: 'object', description: 'パイプライン変数（キー:値のオブジェクト）', additionalProperties: { type: 'string' } }
                        },
                        required: ['project_id', 'ref']
                    }
                }
            },
            handler: async (args: { project_id: number, ref: string, variables?: Record<string, string> }): Promise<any> => {
                const { e, axiosWithAuth } = await getOAuthAccountForTool(req, provider);
                const { project_id, ref, variables } = args;

                const pipelineData: any = { ref };
                if (variables) {
                    pipelineData.variables = Object.entries(variables).map(([key, value]) => ({ key, value }));
                }

                const url = `${e.uriBase}/api/v4/projects/${project_id}/pipeline`;
                const result = (await axiosWithAuth.post(url, pipelineData)).data;

                reform(result);
                result.uriBase = e.uriBase;
                return result;
            }
        },
        {
            info: { group: provider, isActive: true, isInteractive: false, label: `パイプラインキャンセル`, },
            definition: {
                type: 'function', function: {
                    name: `gitlab_${providerName}_cancel_pipeline`,
                    description: `GitLabパイプラインをキャンセル`,
                    parameters: {
                        type: 'object',
                        properties: {
                            project_id: { type: 'number', description: 'プロジェクトID' },
                            pipeline_id: { type: 'number', description: 'パイプラインID' }
                        },
                        required: ['project_id', 'pipeline_id']
                    }
                }
            },
            handler: async (args: { project_id: number, pipeline_id: number }): Promise<any> => {
                const { e, axiosWithAuth } = await getOAuthAccountForTool(req, provider);
                const { project_id, pipeline_id } = args;

                const url = `${e.uriBase}/api/v4/projects/${project_id}/pipelines/${pipeline_id}/cancel`;
                const result = (await axiosWithAuth.post(url, {})).data;

                reform(result);
                result.uriBase = e.uriBase;
                return result;
            }
        },
        {
            info: { group: provider, isActive: true, isInteractive: false, label: `パイプライン再実行`, },
            definition: {
                type: 'function', function: {
                    name: `gitlab_${providerName}_retry_pipeline`,
                    description: `GitLabパイプラインを再実行`,
                    parameters: {
                        type: 'object',
                        properties: {
                            project_id: { type: 'number', description: 'プロジェクトID' },
                            pipeline_id: { type: 'number', description: 'パイプラインID' }
                        },
                        required: ['project_id', 'pipeline_id']
                    }
                }
            },
            handler: async (args: { project_id: number, pipeline_id: number }): Promise<any> => {
                const { e, axiosWithAuth } = await getOAuthAccountForTool(req, provider);
                const { project_id, pipeline_id } = args;

                const url = `${e.uriBase}/api/v4/projects/${project_id}/pipelines/${pipeline_id}/retry`;
                const result = (await axiosWithAuth.post(url, {})).data;

                reform(result);
                result.uriBase = e.uriBase;
                return result;
            }
        },
        {
            info: { group: provider, isActive: true, isInteractive: false, label: `ジョブログ取得`, responseType: 'text' },
            definition: {
                type: 'function', function: {
                    name: `gitlab_${providerName}_job_log`,
                    description: `GitLabジョブのログを取得`,
                    parameters: {
                        type: 'object',
                        properties: {
                            project_id: { type: 'number', description: 'プロジェクトID' },
                            job_id: { type: 'number', description: 'ジョブID' }
                        },
                        required: ['project_id', 'job_id']
                    }
                }
            },
            handler: async (args: { project_id: number, job_id: number }): Promise<any> => {
                const { e, axiosWithAuth } = await getOAuthAccountForTool(req, provider);
                const { project_id, job_id } = args;

                const url = `${e.uriBase}/api/v4/projects/${project_id}/jobs/${job_id}/trace`;
                const result = (await axiosWithAuth.get(url, { responseType: 'text' })).data;

                return `\`\`\`text\n${result}\n\`\`\``;
            }
        },
        {
            info: { group: provider, isActive: true, isInteractive: false, label: `マージリクエスト承認`, },
            definition: {
                type: 'function', function: {
                    name: `gitlab_${providerName}_approve_merge_request`,
                    description: `GitLabマージリクエストを承認`,
                    parameters: {
                        type: 'object',
                        properties: {
                            project_id: { type: 'number', description: 'プロジェクトID' },
                            merge_request_iid: { type: 'number', description: 'マージリクエストIID' },
                            sha: { type: 'string', description: '承認するコミットSHA（オプション）' }
                        },
                        required: ['project_id', 'merge_request_iid']
                    }
                }
            },
            handler: async (args: { project_id: number, merge_request_iid: number, sha?: string }): Promise<any> => {
                const { e, axiosWithAuth } = await getOAuthAccountForTool(req, provider);
                const { project_id, merge_request_iid, sha } = args;

                const approvalData: any = {};
                if (sha) approvalData.sha = sha;

                const url = `${e.uriBase}/api/v4/projects/${project_id}/merge_requests/${merge_request_iid}/approve`;
                const result = (await axiosWithAuth.post(url, approvalData)).data;

                reform(result);
                result.uriBase = e.uriBase;
                return result;
            }
        },
        {
            info: { group: provider, isActive: true, isInteractive: false, label: `マージリクエスト承認取消`, },
            definition: {
                type: 'function', function: {
                    name: `gitlab_${providerName}_unapprove_merge_request`,
                    description: `GitLabマージリクエストの承認を取り消し`,
                    parameters: {
                        type: 'object',
                        properties: {
                            project_id: { type: 'number', description: 'プロジェクトID' },
                            merge_request_iid: { type: 'number', description: 'マージリクエストIID' }
                        },
                        required: ['project_id', 'merge_request_iid']
                    }
                }
            },
            handler: async (args: { project_id: number, merge_request_iid: number }): Promise<any> => {
                const { e, axiosWithAuth } = await getOAuthAccountForTool(req, provider);
                const { project_id, merge_request_iid } = args;

                const url = `${e.uriBase}/api/v4/projects/${project_id}/merge_requests/${merge_request_iid}/unapprove`;
                const result = (await axiosWithAuth.post(url, {})).data;

                reform(result);
                result.uriBase = e.uriBase;
                return result;
            }
        },
        {
            info: { group: provider, isActive: true, isInteractive: false, label: `マージリクエストノート追加`, },
            definition: {
                type: 'function', function: {
                    name: `gitlab_${providerName}_add_merge_request_note`,
                    description: `GitLabマージリクエストにノート（コメント）を追加`,
                    parameters: {
                        type: 'object',
                        properties: {
                            project_id: { type: 'number', description: 'プロジェクトID' },
                            merge_request_iid: { type: 'number', description: 'マージリクエストIID' },
                            body: { type: 'string', description: 'ノートの内容' },
                            confidential: { type: 'boolean', description: '機密ノート', default: false }
                        },
                        required: ['project_id', 'merge_request_iid', 'body']
                    }
                }
            },
            handler: async (args: { project_id: number, merge_request_iid: number, body: string, confidential?: boolean }): Promise<any> => {
                const { e, axiosWithAuth } = await getOAuthAccountForTool(req, provider);
                const { project_id, merge_request_iid, body, confidential = false } = args;

                const noteData = {
                    body: body,
                    confidential: confidential
                };

                const url = `${e.uriBase}/api/v4/projects/${project_id}/merge_requests/${merge_request_iid}/notes`;
                const result = (await axiosWithAuth.post(url, noteData)).data;

                reform(result);
                result.uriBase = e.uriBase;
                return result;
            }
        },
        {
            info: { group: provider, isActive: true, isInteractive: false, label: `マージリクエストノート一覧`, },
            definition: {
                type: 'function', function: {
                    name: `gitlab_${providerName}_merge_request_notes`,
                    description: `GitLabマージリクエストのノート一覧を取得`,
                    parameters: {
                        type: 'object',
                        properties: {
                            project_id: { type: 'number', description: 'プロジェクトID' },
                            merge_request_iid: { type: 'number', description: 'マージリクエストIID' },
                            sort: { type: 'string', description: 'ソート順', enum: ['asc', 'desc'], default: 'asc' },
                            order_by: { type: 'string', description: 'ソート基準', enum: ['created_at', 'updated_at'], default: 'created_at' }
                        },
                        required: ['project_id', 'merge_request_iid']
                    }
                }
            },
            handler: async (args: { project_id: number, merge_request_iid: number, sort?: string, order_by?: string }): Promise<any> => {
                const { e, axiosWithAuth } = await getOAuthAccountForTool(req, provider);
                const { project_id, merge_request_iid, sort = 'asc', order_by = 'created_at' } = args;

                const queryParams = new URLSearchParams();
                queryParams.append('sort', sort);
                queryParams.append('order_by', order_by);

                const url = `${e.uriBase}/api/v4/projects/${project_id}/merge_requests/${merge_request_iid}/notes?${queryParams.toString()}`;
                const result = (await axiosWithAuth.get(url)).data;

                reform(result);
                result.uriBase = e.uriBase;
                return result;
            }
        },
        {
            info: { group: provider, isActive: true, isInteractive: false, label: `マージリクエスト変更一覧`, },
            definition: {
                type: 'function', function: {
                    name: `gitlab_${providerName}_merge_request_changes`,
                    description: `GitLabマージリクエストの変更内容を取得`,
                    parameters: {
                        type: 'object',
                        properties: {
                            project_id: { type: 'number', description: 'プロジェクトID' },
                            merge_request_iid: { type: 'number', description: 'マージリクエストIID' },
                            access_raw_diffs: { type: 'boolean', description: '生のdiffを取得するか', default: false }
                        },
                        required: ['project_id', 'merge_request_iid']
                    }
                }
            },
            handler: async (args: { project_id: number, merge_request_iid: number, access_raw_diffs?: boolean }): Promise<any> => {
                const { e, axiosWithAuth } = await getOAuthAccountForTool(req, provider);
                const { project_id, merge_request_iid, access_raw_diffs = false } = args;

                const queryParams = new URLSearchParams();
                if (access_raw_diffs) queryParams.append('access_raw_diffs', 'true');

                const url = `${e.uriBase}/api/v4/projects/${project_id}/merge_requests/${merge_request_iid}/changes?${queryParams.toString()}`;
                const result = (await axiosWithAuth.get(url)).data;

                reform(result);
                result.uriBase = e.uriBase;
                return result;
            }
        },
        {
            info: { group: provider, isActive: true, isInteractive: false, label: `マージリクエスト承認者一覧`, },
            definition: {
                type: 'function', function: {
                    name: `gitlab_${providerName}_merge_request_approvals`,
                    description: `GitLabマージリクエストの承認状況を取得`,
                    parameters: {
                        type: 'object',
                        properties: {
                            project_id: { type: 'number', description: 'プロジェクトID' },
                            merge_request_iid: { type: 'number', description: 'マージリクエストIID' }
                        },
                        required: ['project_id', 'merge_request_iid']
                    }
                }
            },
            handler: async (args: { project_id: number, merge_request_iid: number }): Promise<any> => {
                const { e, axiosWithAuth } = await getOAuthAccountForTool(req, provider);
                const { project_id, merge_request_iid } = args;

                const url = `${e.uriBase}/api/v4/projects/${project_id}/merge_requests/${merge_request_iid}/approvals`;
                const result = (await axiosWithAuth.get(url)).data;

                reform(result);
                result.uriBase = e.uriBase;
                return result;
            }
        },
        {
            info: { group: provider, isActive: true, isInteractive: false, label: `マージリクエストマージ`, },
            definition: {
                type: 'function', function: {
                    name: `gitlab_${providerName}_merge_merge_request`,
                    description: `GitLabマージリクエストをマージ`,
                    parameters: {
                        type: 'object',
                        properties: {
                            project_id: { type: 'number', description: 'プロジェクトID' },
                            merge_request_iid: { type: 'number', description: 'マージリクエストIID' },
                            merge_commit_message: { type: 'string', description: 'マージコミットメッセージ' },
                            should_remove_source_branch: { type: 'boolean', description: 'ソースブランチを削除するか', default: false },
                            merge_when_pipeline_succeeds: { type: 'boolean', description: 'パイプライン成功時にマージするか', default: false },
                            sha: { type: 'string', description: 'マージするコミットSHA' }
                        },
                        required: ['project_id', 'merge_request_iid']
                    }
                }
            },
            handler: async (args: { project_id: number, merge_request_iid: number, merge_commit_message?: string, should_remove_source_branch?: boolean, merge_when_pipeline_succeeds?: boolean, sha?: string }): Promise<any> => {
                const { e, axiosWithAuth } = await getOAuthAccountForTool(req, provider);
                const { project_id, merge_request_iid, merge_commit_message, should_remove_source_branch = false, merge_when_pipeline_succeeds = false, sha } = args;

                const mergeData: any = {
                    should_remove_source_branch: should_remove_source_branch,
                    merge_when_pipeline_succeeds: merge_when_pipeline_succeeds
                };

                if (merge_commit_message) mergeData.merge_commit_message = merge_commit_message;
                if (sha) mergeData.sha = sha;

                const url = `${e.uriBase}/api/v4/projects/${project_id}/merge_requests/${merge_request_iid}/merge`;
                const result = (await axiosWithAuth.put(url, mergeData)).data;

                reform(result);
                result.uriBase = e.uriBase;
                return result;
            }
        },
        {
            info: { group: provider, isActive: true, isInteractive: false, label: `Issueコメント追加`, },
            definition: {
                type: 'function', function: {
                    name: `gitlab_${providerName}_add_issue_note`,
                    description: `GitLabIssueにノート（コメント）を追加`,
                    parameters: {
                        type: 'object',
                        properties: {
                            project_id: { type: 'number', description: 'プロジェクトID' },
                            issue_iid: { type: 'number', description: 'Issue IID' },
                            body: { type: 'string', description: 'ノートの内容' },
                            confidential: { type: 'boolean', description: '機密ノート', default: false }
                        },
                        required: ['project_id', 'issue_iid', 'body']
                    }
                }
            },
            handler: async (args: { project_id: number, issue_iid: number, body: string, confidential?: boolean }): Promise<any> => {
                const { e, axiosWithAuth } = await getOAuthAccountForTool(req, provider);
                const { project_id, issue_iid, body, confidential = false } = args;

                const noteData = {
                    body: body,
                    confidential: confidential
                };

                const url = `${e.uriBase}/api/v4/projects/${project_id}/issues/${issue_iid}/notes`;
                const result = (await axiosWithAuth.post(url, noteData)).data;

                reform(result);
                result.uriBase = e.uriBase;
                return result;
            }
        },
        {
            info: { group: provider, isActive: true, isInteractive: false, label: `Issueノート一覧`, },
            definition: {
                type: 'function', function: {
                    name: `gitlab_${providerName}_issue_notes`,
                    description: `GitLabIssueのノート一覧を取得`,
                    parameters: {
                        type: 'object',
                        properties: {
                            project_id: { type: 'number', description: 'プロジェクトID' },
                            issue_iid: { type: 'number', description: 'Issue IID' },
                            sort: { type: 'string', description: 'ソート順', enum: ['asc', 'desc'], default: 'asc' },
                            order_by: { type: 'string', description: 'ソート基準', enum: ['created_at', 'updated_at'], default: 'created_at' }
                        },
                        required: ['project_id', 'issue_iid']
                    }
                }
            },
            handler: async (args: { project_id: number, issue_iid: number, sort?: string, order_by?: string }): Promise<any> => {
                const { e, axiosWithAuth } = await getOAuthAccountForTool(req, provider);
                const { project_id, issue_iid, sort = 'asc', order_by = 'created_at' } = args;

                const queryParams = new URLSearchParams();
                queryParams.append('sort', sort);
                queryParams.append('order_by', order_by);

                const url = `${e.uriBase}/api/v4/projects/${project_id}/issues/${issue_iid}/notes?${queryParams.toString()}`;
                const result = (await axiosWithAuth.get(url)).data;

                reform(result);
                result.uriBase = e.uriBase;
                return result;
            }
        },
        {
            info: { group: provider, isActive: true, isInteractive: false, label: `Issue担当者設定`, },
            definition: {
                type: 'function', function: {
                    name: `gitlab_${providerName}_assign_issue`,
                    description: `GitLabIssueに担当者を設定`,
                    parameters: {
                        type: 'object',
                        properties: {
                            project_id: { type: 'number', description: 'プロジェクトID' },
                            issue_iid: { type: 'number', description: 'Issue IID' },
                            assignee_ids: { type: 'array', items: { type: 'number' }, description: '担当者のユーザーIDの配列' }
                        },
                        required: ['project_id', 'issue_iid', 'assignee_ids']
                    }
                }
            },
            handler: async (args: { project_id: number, issue_iid: number, assignee_ids: number[] }): Promise<any> => {
                const { e, axiosWithAuth } = await getOAuthAccountForTool(req, provider);
                const { project_id, issue_iid, assignee_ids } = args;

                const updateData = { assignee_ids: assignee_ids };

                const url = `${e.uriBase}/api/v4/projects/${project_id}/issues/${issue_iid}`;
                const result = (await axiosWithAuth.put(url, updateData)).data;

                reform(result);
                result.uriBase = e.uriBase;
                return result;
            }
        },
        {
            info: { group: provider, isActive: true, isInteractive: false, label: `Issueラベル設定`, },
            definition: {
                type: 'function', function: {
                    name: `gitlab_${providerName}_set_issue_labels`,
                    description: `GitLabIssueにラベルを設定`,
                    parameters: {
                        type: 'object',
                        properties: {
                            project_id: { type: 'number', description: 'プロジェクトID' },
                            issue_iid: { type: 'number', description: 'Issue IID' },
                            labels: { type: 'string', description: 'カンマ区切りのラベル' },
                            add_labels: { type: 'string', description: '追加するラベル（カンマ区切り）' },
                            remove_labels: { type: 'string', description: '削除するラベル（カンマ区切り）' }
                        },
                        required: ['project_id', 'issue_iid']
                    }
                }
            },
            handler: async (args: { project_id: number, issue_iid: number, labels?: string, add_labels?: string, remove_labels?: string }): Promise<any> => {
                const { e, axiosWithAuth } = await getOAuthAccountForTool(req, provider);
                const { project_id, issue_iid, labels, add_labels, remove_labels } = args;

                const updateData: any = {};
                if (labels) updateData.labels = labels;
                if (add_labels) updateData.add_labels = add_labels;
                if (remove_labels) updateData.remove_labels = remove_labels;

                const url = `${e.uriBase}/api/v4/projects/${project_id}/issues/${issue_iid}`;
                const result = (await axiosWithAuth.put(url, updateData)).data;

                reform(result);
                result.uriBase = e.uriBase;
                return result;
            }
        },
        {
            info: { group: provider, isActive: true, isInteractive: false, label: `Issueマイルストーン設定`, },
            definition: {
                type: 'function', function: {
                    name: `gitlab_${providerName}_set_issue_milestone`,
                    description: `GitLabIssueにマイルストーンを設定`,
                    parameters: {
                        type: 'object',
                        properties: {
                            project_id: { type: 'number', description: 'プロジェクトID' },
                            issue_iid: { type: 'number', description: 'Issue IID' },
                            milestone_id: { type: 'number', description: 'マイルストーンID（nullで削除）' }
                        },
                        required: ['project_id', 'issue_iid']
                    }
                }
            },
            handler: async (args: { project_id: number, issue_iid: number, milestone_id?: number }): Promise<any> => {
                const { e, axiosWithAuth } = await getOAuthAccountForTool(req, provider);
                const { project_id, issue_iid, milestone_id } = args;

                const updateData = { milestone_id: milestone_id || null };

                const url = `${e.uriBase}/api/v4/projects/${project_id}/issues/${issue_iid}`;
                const result = (await axiosWithAuth.put(url, updateData)).data;

                reform(result);
                result.uriBase = e.uriBase;
                return result;
            }
        },
        {
            info: { group: provider, isActive: true, isInteractive: false, label: `プロジェクトラベル一覧`, },
            definition: {
                type: 'function', function: {
                    name: `gitlab_${providerName}_project_labels`,
                    description: `GitLabプロジェクトのラベル一覧を取得`,
                    parameters: {
                        type: 'object',
                        properties: {
                            project_id: { type: 'number', description: 'プロジェクトID' },
                            with_counts: { type: 'boolean', description: 'カウント情報を含めるか', default: false },
                            include_ancestor_groups: { type: 'boolean', description: '親グループのラベルも含めるか', default: false }
                        },
                        required: ['project_id']
                    }
                }
            },
            handler: async (args: { project_id: number, with_counts?: boolean, include_ancestor_groups?: boolean }): Promise<any> => {
                const { e, axiosWithAuth } = await getOAuthAccountForTool(req, provider);
                const { project_id, with_counts = false, include_ancestor_groups = false } = args;

                const queryParams = new URLSearchParams();
                if (with_counts) queryParams.append('with_counts', 'true');
                if (include_ancestor_groups) queryParams.append('include_ancestor_groups', 'true');

                const url = `${e.uriBase}/api/v4/projects/${project_id}/labels?${queryParams.toString()}`;
                const result = (await axiosWithAuth.get(url)).data;

                reform(result);
                result.uriBase = e.uriBase;
                return result;
            }
        },
        {
            info: { group: provider, isActive: true, isInteractive: false, label: `プロジェクトマイルストーン一覧`, },
            definition: {
                type: 'function', function: {
                    name: `gitlab_${providerName}_project_milestones`,
                    description: `GitLabプロジェクトのマイルストーン一覧を取得`,
                    parameters: {
                        type: 'object',
                        properties: {
                            project_id: { type: 'number', description: 'プロジェクトID' },
                            state: { type: 'string', description: 'マイルストーンの状態', enum: ['active', 'closed'], default: 'active' },
                            search: { type: 'string', description: '検索キーワード' }
                        },
                        required: ['project_id']
                    }
                }
            },
            handler: async (args: { project_id: number, state?: string, search?: string }): Promise<any> => {
                const { e, axiosWithAuth } = await getOAuthAccountForTool(req, provider);
                const { project_id, state = 'active', search } = args;

                const queryParams = new URLSearchParams();
                queryParams.append('state', state);
                if (search) queryParams.append('search', search);

                const url = `${e.uriBase}/api/v4/projects/${project_id}/milestones?${queryParams.toString()}`;
                const result = (await axiosWithAuth.get(url)).data;

                reform(result);
                result.uriBase = e.uriBase;
                return result;
            }
        },
        {
            info: { group: provider, isActive: true, isInteractive: false, label: `Webhook作成`, },
            definition: {
                type: 'function', function: {
                    name: `gitlab_${providerName}_create_webhook`,
                    description: `GitLabプロジェクトにWebhookを作成`,
                    parameters: {
                        type: 'object',
                        properties: {
                            project_id: { type: 'number', description: 'プロジェクトID' },
                            url: { type: 'string', description: 'WebhookのURL' },
                            push_events: { type: 'boolean', description: 'プッシュイベント', default: true },
                            issues_events: { type: 'boolean', description: 'Issueイベント', default: false },
                            merge_requests_events: { type: 'boolean', description: 'マージリクエストイベント', default: false },
                            tag_push_events: { type: 'boolean', description: 'タグプッシュイベント', default: false },
                            pipeline_events: { type: 'boolean', description: 'パイプラインイベント', default: false },
                            wiki_page_events: { type: 'boolean', description: 'Wikiページイベント', default: false },
                            deployment_events: { type: 'boolean', description: 'デプロイメントイベント', default: false },
                            job_events: { type: 'boolean', description: 'ジョブイベント', default: false },
                            releases_events: { type: 'boolean', description: 'リリースイベント', default: false },
                            token: { type: 'string', description: 'シークレットトークン' },
                            enable_ssl_verification: { type: 'boolean', description: 'SSL検証を有効にするか', default: true }
                        },
                        required: ['project_id', 'url']
                    }
                }
            },
            handler: async (args: { project_id: number, url: string, push_events?: boolean, issues_events?: boolean, merge_requests_events?: boolean, tag_push_events?: boolean, pipeline_events?: boolean, wiki_page_events?: boolean, deployment_events?: boolean, job_events?: boolean, releases_events?: boolean, token?: string, enable_ssl_verification?: boolean }): Promise<any> => {
                const { e, axiosWithAuth } = await getOAuthAccountForTool(req, provider);
                const {
                    project_id,
                    url,
                    push_events = true,
                    issues_events = false,
                    merge_requests_events = false,
                    tag_push_events = false,
                    pipeline_events = false,
                    wiki_page_events = false,
                    deployment_events = false,
                    job_events = false,
                    releases_events = false,
                    token,
                    enable_ssl_verification = true
                } = args;

                const webhookData: any = {
                    url: url,
                    push_events: push_events,
                    issues_events: issues_events,
                    merge_requests_events: merge_requests_events,
                    tag_push_events: tag_push_events,
                    pipeline_events: pipeline_events,
                    wiki_page_events: wiki_page_events,
                    deployment_events: deployment_events,
                    job_events: job_events,
                    releases_events: releases_events,
                    enable_ssl_verification: enable_ssl_verification
                };

                if (token) webhookData.token = token;

                const hookUrl = `${e.uriBase}/api/v4/projects/${project_id}/hooks`;
                const result = (await axiosWithAuth.post(hookUrl, webhookData)).data;

                reform(result);
                result.uriBase = e.uriBase;
                return result;
            }
        },
        {
            info: { group: provider, isActive: true, isInteractive: false, label: `Webhook一覧取得`, },
            definition: {
                type: 'function', function: {
                    name: `gitlab_${providerName}_list_webhooks`,
                    description: `GitLabプロジェクトのWebhook一覧を取得`,
                    parameters: {
                        type: 'object',
                        properties: {
                            project_id: { type: 'number', description: 'プロジェクトID' }
                        },
                        required: ['project_id']
                    }
                }
            },
            handler: async (args: { project_id: number }): Promise<any> => {
                const { e, axiosWithAuth } = await getOAuthAccountForTool(req, provider);
                const { project_id } = args;

                const url = `${e.uriBase}/api/v4/projects/${project_id}/hooks`;
                const result = (await axiosWithAuth.get(url)).data;

                reform(result);
                result.uriBase = e.uriBase;
                return result;
            }
        },
        {
            info: { group: provider, isActive: true, isInteractive: false, label: `Webhook削除`, },
            definition: {
                type: 'function', function: {
                    name: `gitlab_${providerName}_delete_webhook`,
                    description: `GitLabプロジェクトのWebhookを削除`,
                    parameters: {
                        type: 'object',
                        properties: {
                            project_id: { type: 'number', description: 'プロジェクトID' },
                            hook_id: { type: 'number', description: 'WebhookのID' }
                        },
                        required: ['project_id', 'hook_id']
                    }
                }
            },
            handler: async (args: { project_id: number, hook_id: number }): Promise<any> => {
                const { e, axiosWithAuth } = await getOAuthAccountForTool(req, provider);
                const { project_id, hook_id } = args;

                const url = `${e.uriBase}/api/v4/projects/${project_id}/hooks/${hook_id}`;
                const result = (await axiosWithAuth.delete(url)).data;

                reform(result);
                result.uriBase = e.uriBase;
                return result;
            }
        },
        {
            info: { group: provider, isActive: true, isInteractive: false, label: `保護ブランチ設定`, },
            definition: {
                type: 'function', function: {
                    name: `gitlab_${providerName}_protect_branch`,
                    description: `GitLabブランチを保護設定`,
                    parameters: {
                        type: 'object',
                        properties: {
                            project_id: { type: 'number', description: 'プロジェクトID' },
                            name: { type: 'string', description: 'ブランチ名またはワイルドカード' },
                            push_access_level: { type: 'number', description: 'プッシュアクセスレベル（0=No access, 30=Developer, 40=Maintainer）', default: 40 },
                            merge_access_level: { type: 'number', description: 'マージアクセスレベル（0=No access, 30=Developer, 40=Maintainer）', default: 40 },
                            unprotect_access_level: { type: 'number', description: '保護解除アクセスレベル（40=Maintainer, 60=Admin）', default: 40 },
                            allow_force_push: { type: 'boolean', description: 'フォースプッシュを許可するか', default: false },
                            allowed_to_push: { type: 'array', items: { type: 'object', properties: { user_id: { type: 'number' }, group_id: { type: 'number' }, access_level: { type: 'number' } } }, description: 'プッシュを許可するユーザー・グループ' },
                            allowed_to_merge: { type: 'array', items: { type: 'object', properties: { user_id: { type: 'number' }, group_id: { type: 'number' }, access_level: { type: 'number' } } }, description: 'マージを許可するユーザー・グループ' }
                        },
                        required: ['project_id', 'name']
                    }
                }
            },
            handler: async (args: { project_id: number, name: string, push_access_level?: number, merge_access_level?: number, unprotect_access_level?: number, allow_force_push?: boolean, allowed_to_push?: Array<{ user_id?: number, group_id?: number, access_level?: number }>, allowed_to_merge?: Array<{ user_id?: number, group_id?: number, access_level?: number }> }): Promise<any> => {
                const { e, axiosWithAuth } = await getOAuthAccountForTool(req, provider);
                const {
                    project_id,
                    name,
                    push_access_level = 40,
                    merge_access_level = 40,
                    unprotect_access_level = 40,
                    allow_force_push = false,
                    allowed_to_push,
                    allowed_to_merge
                } = args;

                const protectionData: any = {
                    name: name,
                    push_access_level: push_access_level,
                    merge_access_level: merge_access_level,
                    unprotect_access_level: unprotect_access_level,
                    allow_force_push: allow_force_push
                };

                if (allowed_to_push) protectionData.allowed_to_push = allowed_to_push;
                if (allowed_to_merge) protectionData.allowed_to_merge = allowed_to_merge;

                const url = `${e.uriBase}/api/v4/projects/${project_id}/protected_branches`;
                const result = (await axiosWithAuth.post(url, protectionData)).data;

                reform(result);
                result.uriBase = e.uriBase;
                return result;
            }
        },
        {
            info: { group: provider, isActive: true, isInteractive: false, label: `保護ブランチ一覧`, },
            definition: {
                type: 'function', function: {
                    name: `gitlab_${providerName}_list_protected_branches`,
                    description: `GitLabプロジェクトの保護ブランチ一覧を取得`,
                    parameters: {
                        type: 'object',
                        properties: {
                            project_id: { type: 'number', description: 'プロジェクトID' },
                            search: { type: 'string', description: '検索キーワード' }
                        },
                        required: ['project_id']
                    }
                }
            },
            handler: async (args: { project_id: number, search?: string }): Promise<any> => {
                const { e, axiosWithAuth } = await getOAuthAccountForTool(req, provider);
                const { project_id, search } = args;

                const queryParams = new URLSearchParams();
                if (search) queryParams.append('search', search);

                const url = `${e.uriBase}/api/v4/projects/${project_id}/protected_branches?${queryParams.toString()}`;
                const result = (await axiosWithAuth.get(url)).data;

                reform(result);
                result.uriBase = e.uriBase;
                return result;
            }
        },
        {
            info: { group: provider, isActive: true, isInteractive: false, label: `保護ブランチ解除`, },
            definition: {
                type: 'function', function: {
                    name: `gitlab_${providerName}_unprotect_branch`,
                    description: `GitLabブランチの保護を解除`,
                    parameters: {
                        type: 'object',
                        properties: {
                            project_id: { type: 'number', description: 'プロジェクトID' },
                            name: { type: 'string', description: 'ブランチ名' }
                        },
                        required: ['project_id', 'name']
                    }
                }
            },
            handler: async (args: { project_id: number, name: string }): Promise<any> => {
                const { e, axiosWithAuth } = await getOAuthAccountForTool(req, provider);
                const { project_id, name } = args;

                const url = `${e.uriBase}/api/v4/projects/${project_id}/protected_branches/${encodeURIComponent(name)}`;
                const result = (await axiosWithAuth.delete(url)).data;

                reform(result);
                result.uriBase = e.uriBase;
                return result;
            }
        },
        {
            info: { group: provider, isActive: true, isInteractive: false, label: `プロジェクト設定更新`, },
            definition: {
                type: 'function', function: {
                    name: `gitlab_${providerName}_update_project_settings`,
                    description: `GitLabプロジェクトの設定を更新`,
                    parameters: {
                        type: 'object',
                        properties: {
                            project_id: { type: 'number', description: 'プロジェクトID' },
                            name: { type: 'string', description: 'プロジェクト名' },
                            description: { type: 'string', description: 'プロジェクトの説明' },
                            default_branch: { type: 'string', description: 'デフォルトブランチ' },
                            visibility: { type: 'string', description: '可視性', enum: ['private', 'internal', 'public'] },
                            issues_enabled: { type: 'boolean', description: 'Issueを有効にするか' },
                            merge_requests_enabled: { type: 'boolean', description: 'マージリクエストを有効にするか' },
                            wiki_enabled: { type: 'boolean', description: 'Wikiを有効にするか' },
                            snippets_enabled: { type: 'boolean', description: 'スニペットを有効にするか' },
                            container_registry_enabled: { type: 'boolean', description: 'コンテナレジストリを有効にするか' },
                            merge_method: { type: 'string', description: 'マージ方法', enum: ['merge', 'rebase_merge', 'ff'] },
                            squash_option: { type: 'string', description: 'スカッシュオプション', enum: ['never', 'always', 'default_on', 'default_off'] },
                            only_allow_merge_if_pipeline_succeeds: { type: 'boolean', description: 'パイプライン成功時のみマージ許可' },
                            only_allow_merge_if_all_discussions_are_resolved: { type: 'boolean', description: '全ディスカッション解決時のみマージ許可' }
                        },
                        required: ['project_id']
                    }
                }
            },
            handler: async (args: { project_id: number, name?: string, description?: string, default_branch?: string, visibility?: string, issues_enabled?: boolean, merge_requests_enabled?: boolean, wiki_enabled?: boolean, snippets_enabled?: boolean, container_registry_enabled?: boolean, merge_method?: string, squash_option?: string, only_allow_merge_if_pipeline_succeeds?: boolean, only_allow_merge_if_all_discussions_are_resolved?: boolean }): Promise<any> => {
                const { e, axiosWithAuth } = await getOAuthAccountForTool(req, provider);
                const { project_id, ...updateData } = args;

                // undefined値を除去
                const cleanUpdateData = Object.fromEntries(
                    Object.entries(updateData).filter(([_, value]) => value !== undefined)
                );

                const url = `${e.uriBase}/api/v4/projects/${project_id}`;
                const result = (await axiosWithAuth.put(url, cleanUpdateData)).data;

                reform(result);
                result.uriBase = e.uriBase;
                return result;
            }
        },
        {
            info: { group: provider, isActive: true, isInteractive: false, label: `タグ作成`, },
            definition: {
                type: 'function', function: {
                    name: `gitlab_${providerName}_create_tag`,
                    description: `GitLabでタグを作成`,
                    parameters: {
                        type: 'object',
                        properties: {
                            project_id: { type: 'number', description: 'プロジェクトID' },
                            tag_name: { type: 'string', description: 'タグ名' },
                            ref: { type: 'string', description: 'タグを作成するブランチ名、タグ名、またはコミットSHA' },
                            message: { type: 'string', description: 'タグメッセージ（注釈付きタグの場合）' },
                            release_description: { type: 'string', description: 'リリース説明' }
                        },
                        required: ['project_id', 'tag_name', 'ref']
                    }
                }
            },
            handler: async (args: { project_id: number, tag_name: string, ref: string, message?: string, release_description?: string }): Promise<any> => {
                const { e, axiosWithAuth } = await getOAuthAccountForTool(req, provider);
                const { project_id, tag_name, ref, message, release_description } = args;

                const tagData: any = {
                    tag_name: tag_name,
                    ref: ref
                };

                if (message) tagData.message = message;
                if (release_description) tagData.release_description = release_description;

                const url = `${e.uriBase}/api/v4/projects/${project_id}/repository/tags`;
                const result = (await axiosWithAuth.post(url, tagData)).data;

                reform(result);
                result.uriBase = e.uriBase;
                return result;
            }
        },
        {
            info: { group: provider, isActive: true, isInteractive: false, label: `タグ削除`, },
            definition: {
                type: 'function', function: {
                    name: `gitlab_${providerName}_delete_tag`,
                    description: `GitLabのタグを削除`,
                    parameters: {
                        type: 'object',
                        properties: {
                            project_id: { type: 'number', description: 'プロジェクトID' },
                            tag_name: { type: 'string', description: '削除するタグ名' }
                        },
                        required: ['project_id', 'tag_name']
                    }
                }
            },
            handler: async (args: { project_id: number, tag_name: string }): Promise<any> => {
                const { e, axiosWithAuth } = await getOAuthAccountForTool(req, provider);
                const { project_id, tag_name } = args;

                const url = `${e.uriBase}/api/v4/projects/${project_id}/repository/tags/${encodeURIComponent(tag_name)}`;
                const result = (await axiosWithAuth.delete(url)).data;

                reform(result);
                result.uriBase = e.uriBase;
                return result;
            }
        },
        {
            info: { group: provider, isActive: true, isInteractive: false, label: `リリース一覧取得`, },
            definition: {
                type: 'function', function: {
                    name: `gitlab_${providerName}_project_releases`,
                    description: `GitLabプロジェクトのリリース一覧を取得`,
                    parameters: {
                        type: 'object',
                        properties: {
                            project_id: { type: 'number', description: 'プロジェクトID' },
                            order_by: { type: 'string', description: 'ソート基準', enum: ['created_at', 'released_at'], default: 'created_at' },
                            sort: { type: 'string', description: 'ソート順', enum: ['asc', 'desc'], default: 'desc' },
                            include_html_description: { type: 'boolean', description: 'HTML説明を含めるか', default: false }
                        },
                        required: ['project_id']
                    }
                }
            },
            handler: async (args: { project_id: number, order_by?: string, sort?: string, include_html_description?: boolean }): Promise<any> => {
                const { e, axiosWithAuth } = await getOAuthAccountForTool(req, provider);
                const { project_id, order_by = 'created_at', sort = 'desc', include_html_description = false } = args;

                const queryParams = new URLSearchParams();
                queryParams.append('order_by', order_by);
                queryParams.append('sort', sort);
                if (include_html_description) queryParams.append('include_html_description', 'true');

                const url = `${e.uriBase}/api/v4/projects/${project_id}/releases?${queryParams.toString()}`;
                const result = (await axiosWithAuth.get(url)).data;

                reform(result);
                result.uriBase = e.uriBase;
                return result;
            }
        },
        {
            info: { group: provider, isActive: true, isInteractive: false, label: `リリース詳細取得`, },
            definition: {
                type: 'function', function: {
                    name: `gitlab_${providerName}_release_detail`,
                    description: `GitLabリリースの詳細情報を取得`,
                    parameters: {
                        type: 'object',
                        properties: {
                            project_id: { type: 'number', description: 'プロジェクトID' },
                            tag_name: { type: 'string', description: 'タグ名' },
                            include_html_description: { type: 'boolean', description: 'HTML説明を含めるか', default: false }
                        },
                        required: ['project_id', 'tag_name']
                    }
                }
            },
            handler: async (args: { project_id: number, tag_name: string, include_html_description?: boolean }): Promise<any> => {
                const { e, axiosWithAuth } = await getOAuthAccountForTool(req, provider);
                const { project_id, tag_name, include_html_description = false } = args;

                const queryParams = new URLSearchParams();
                if (include_html_description) queryParams.append('include_html_description', 'true');

                const url = `${e.uriBase}/api/v4/projects/${project_id}/releases/${encodeURIComponent(tag_name)}?${queryParams.toString()}`;
                const result = (await axiosWithAuth.get(url)).data;

                reform(result);
                result.uriBase = e.uriBase;
                return result;
            }
        },
        {
            info: { group: provider, isActive: true, isInteractive: false, label: `リリース作成`, },
            definition: {
                type: 'function', function: {
                    name: `gitlab_${providerName}_create_release`,
                    description: `GitLabでリリースを作成`,
                    parameters: {
                        type: 'object',
                        properties: {
                            project_id: { type: 'number', description: 'プロジェクトID' },
                            name: { type: 'string', description: 'リリース名' },
                            tag_name: { type: 'string', description: 'タグ名' },
                            description: { type: 'string', description: 'リリース説明', default: '' },
                            ref: { type: 'string', description: 'タグを作成するブランチ名、タグ名、またはコミットSHA（新規タグの場合）' },
                            milestones: { type: 'array', items: { type: 'string' }, description: 'マイルストーン名の配列' },
                            assets: {
                                type: 'object',
                                properties: {
                                    links: {
                                        type: 'array',
                                        items: {
                                            type: 'object',
                                            properties: {
                                                name: { type: 'string', description: 'リンク名' },
                                                url: { type: 'string', description: 'リンクURL' },
                                                link_type: { type: 'string', description: 'リンクタイプ', enum: ['other', 'runbook', 'image', 'package'], default: 'other' }
                                            },
                                            required: ['name', 'url']
                                        },
                                        description: 'アセットリンク配列'
                                    }
                                },
                                description: 'リリースアセット'
                            },
                            released_at: { type: 'string', description: 'リリース日時（ISO 8601形式）' }
                        },
                        required: ['project_id', 'name', 'tag_name']
                    }
                }
            },
            handler: async (args: { project_id: number, name: string, tag_name: string, description?: string, ref?: string, milestones?: string[], assets?: { links?: Array<{ name: string, url: string, link_type?: string }> }, released_at?: string }): Promise<any> => {
                const { e, axiosWithAuth } = await getOAuthAccountForTool(req, provider);
                const { project_id, name, tag_name, description = '', ref, milestones, assets, released_at } = args;

                const releaseData: any = {
                    name: name,
                    tag_name: tag_name,
                    description: description
                };

                if (ref) releaseData.ref = ref;
                if (milestones) releaseData.milestones = milestones;
                if (assets) releaseData.assets = assets;
                if (released_at) releaseData.released_at = released_at;

                const url = `${e.uriBase}/api/v4/projects/${project_id}/releases`;
                const result = (await axiosWithAuth.post(url, releaseData)).data;

                reform(result);
                result.uriBase = e.uriBase;
                return result;
            }
        },
        {
            info: { group: provider, isActive: true, isInteractive: false, label: `リリース更新`, },
            definition: {
                type: 'function', function: {
                    name: `gitlab_${providerName}_update_release`,
                    description: `GitLabリリースを更新`,
                    parameters: {
                        type: 'object',
                        properties: {
                            project_id: { type: 'number', description: 'プロジェクトID' },
                            tag_name: { type: 'string', description: 'タグ名' },
                            name: { type: 'string', description: 'リリース名' },
                            description: { type: 'string', description: 'リリース説明' },
                            milestones: { type: 'array', items: { type: 'string' }, description: 'マイルストーン名の配列' },
                            released_at: { type: 'string', description: 'リリース日時（ISO 8601形式）' }
                        },
                        required: ['project_id', 'tag_name']
                    }
                }
            },
            handler: async (args: { project_id: number, tag_name: string, name?: string, description?: string, milestones?: string[], released_at?: string }): Promise<any> => {
                const { e, axiosWithAuth } = await getOAuthAccountForTool(req, provider);
                const { project_id, tag_name, name, description, milestones, released_at } = args;

                const updateData: any = {};
                if (name) updateData.name = name;
                if (description) updateData.description = description;
                if (milestones) updateData.milestones = milestones;
                if (released_at) updateData.released_at = released_at;

                const url = `${e.uriBase}/api/v4/projects/${project_id}/releases/${encodeURIComponent(tag_name)}`;
                const result = (await axiosWithAuth.put(url, updateData)).data;

                reform(result);
                result.uriBase = e.uriBase;
                return result;
            }
        },
        {
            info: { group: provider, isActive: true, isInteractive: false, label: `リリース削除`, },
            definition: {
                type: 'function', function: {
                    name: `gitlab_${providerName}_delete_release`,
                    description: `GitLabリリースを削除`,
                    parameters: {
                        type: 'object',
                        properties: {
                            project_id: { type: 'number', description: 'プロジェクトID' },
                            tag_name: { type: 'string', description: 'タグ名' }
                        },
                        required: ['project_id', 'tag_name']
                    }
                }
            },
            handler: async (args: { project_id: number, tag_name: string }): Promise<any> => {
                const { e, axiosWithAuth } = await getOAuthAccountForTool(req, provider);
                const { project_id, tag_name } = args;

                const url = `${e.uriBase}/api/v4/projects/${project_id}/releases/${encodeURIComponent(tag_name)}`;
                const result = (await axiosWithAuth.delete(url)).data;

                reform(result);
                result.uriBase = e.uriBase;
                return result;
            }
        },
        {
            info: { group: provider, isActive: true, isInteractive: false, label: `リリースリンク作成`, },
            definition: {
                type: 'function', function: {
                    name: `gitlab_${providerName}_create_release_link`,
                    description: `GitLabリリースにリンクを追加`,
                    parameters: {
                        type: 'object',
                        properties: {
                            project_id: { type: 'number', description: 'プロジェクトID' },
                            tag_name: { type: 'string', description: 'タグ名' },
                            name: { type: 'string', description: 'リンク名' },
                            url: { type: 'string', description: 'リンクURL' },
                            filepath: { type: 'string', description: 'ファイルパス（オプション）' },
                            link_type: { type: 'string', description: 'リンクタイプ', enum: ['other', 'runbook', 'image', 'package'], default: 'other' }
                        },
                        required: ['project_id', 'tag_name', 'name', 'url']
                    }
                }
            },
            handler: async (args: { project_id: number, tag_name: string, name: string, url: string, filepath?: string, link_type?: string }): Promise<any> => {
                const { e, axiosWithAuth } = await getOAuthAccountForTool(req, provider);
                const { project_id, tag_name, name, url, filepath, link_type = 'other' } = args;

                const linkData: any = {
                    name: name,
                    url: url,
                    link_type: link_type
                };

                if (filepath) linkData.filepath = filepath;

                const linkUrl = `${e.uriBase}/api/v4/projects/${project_id}/releases/${encodeURIComponent(tag_name)}/assets/links`;
                const result = (await axiosWithAuth.post(linkUrl, linkData)).data;

                reform(result);
                result.uriBase = e.uriBase;
                return result;
            }
        },
        {
            info: { group: provider, isActive: true, isInteractive: false, label: `リリースリンク削除`, },
            definition: {
                type: 'function', function: {
                    name: `gitlab_${providerName}_delete_release_link`,
                    description: `GitLabリリースのリンクを削除`,
                    parameters: {
                        type: 'object',
                        properties: {
                            project_id: { type: 'number', description: 'プロジェクトID' },
                            tag_name: { type: 'string', description: 'タグ名' },
                            link_id: { type: 'number', description: 'リンクID' }
                        },
                        required: ['project_id', 'tag_name', 'link_id']
                    }
                }
            },
            handler: async (args: { project_id: number, tag_name: string, link_id: number }): Promise<any> => {
                const { e, axiosWithAuth } = await getOAuthAccountForTool(req, provider);
                const { project_id, tag_name, link_id } = args;

                const url = `${e.uriBase}/api/v4/projects/${project_id}/releases/${encodeURIComponent(tag_name)}/assets/links/${link_id}`;
                const result = (await axiosWithAuth.delete(url)).data;

                reform(result);
                result.uriBase = e.uriBase;
                return result;
            }
        },
        {
            info: { group: provider, isActive: true, isInteractive: false, label: `プロジェクトメンバー一覧`, },
            definition: {
                type: 'function', function: {
                    name: `gitlab_${providerName}_project_members`,
                    description: `GitLabプロジェクトのメンバー一覧を取得`,
                    parameters: {
                        type: 'object',
                        properties: {
                            project_id: { type: 'number', description: 'プロジェクトID' },
                            query: { type: 'string', description: '検索クエリ' },
                            user_ids: { type: 'array', items: { type: 'number' }, description: '特定のユーザーIDで絞り込み' }
                        },
                        required: ['project_id']
                    }
                }
            },
            handler: async (args: { project_id: number, query?: string, user_ids?: number[] }): Promise<any> => {
                const { e, axiosWithAuth } = await getOAuthAccountForTool(req, provider);
                const { project_id, query, user_ids } = args;

                const queryParams = new URLSearchParams();
                if (query) queryParams.append('query', query);
                if (user_ids && user_ids.length > 0) {
                    user_ids.forEach(id => queryParams.append('user_ids[]', id.toString()));
                }

                const url = `${e.uriBase}/api/v4/projects/${project_id}/members?${queryParams.toString()}`;
                const result = (await axiosWithAuth.get(url)).data;

                reform(result);
                result.uriBase = e.uriBase;
                return result;
            }
        },
        {
            info: { group: provider, isActive: true, isInteractive: true, label: `プロジェクトメンバー追加`, },
            definition: {
                type: 'function', function: {
                    name: `gitlab_${providerName}_add_project_member`,
                    description: `GitLabプロジェクトにメンバーを追加`,
                    parameters: {
                        type: 'object',
                        properties: {
                            project_id: { type: 'number', description: 'プロジェクトID' },
                            user_id: { type: 'number', description: 'ユーザーID' },
                            access_level: { type: 'number', description: 'アクセスレベル（10=Guest, 20=Reporter, 30=Developer, 40=Maintainer, 50=Owner）', enum: ['10', '20', '30', '40', '50'] },
                            expires_at: { type: 'string', description: '有効期限（YYYY-MM-DD形式）' }
                        },
                        required: ['project_id', 'user_id', 'access_level']
                    }
                }
            },
            handler: async (args: { project_id: number, user_id: number, access_level: number, expires_at?: string }): Promise<any> => {
                const { e, axiosWithAuth } = await getOAuthAccountForTool(req, provider);
                const { project_id, user_id, access_level, expires_at } = args;

                const memberData: any = {
                    user_id: user_id,
                    access_level: Number(access_level)
                };

                if (expires_at) memberData.expires_at = expires_at;

                const url = `${e.uriBase}/api/v4/projects/${project_id}/members`;
                const result = (await axiosWithAuth.post(url, memberData)).data;

                reform(result);
                result.uriBase = e.uriBase;
                return result;
            }
        },
        {
            info: { group: provider, isActive: true, isInteractive: true, label: `プロジェクトメンバー更新`, },
            definition: {
                type: 'function', function: {
                    name: `gitlab_${providerName}_update_project_member`,
                    description: `GitLabプロジェクトメンバーの権限を更新`,
                    parameters: {
                        type: 'object',
                        properties: {
                            project_id: { type: 'number', description: 'プロジェクトID' },
                            user_id: { type: 'number', description: 'ユーザーID' },
                            access_level: { type: 'number', description: 'アクセスレベル（10=Guest, 20=Reporter, 30=Developer, 40=Maintainer, 50=Owner）', enum: ['10', '20', '30', '40', '50'] },
                            expires_at: { type: 'string', description: '有効期限（YYYY-MM-DD形式）' }
                        },
                        required: ['project_id', 'user_id', 'access_level']
                    }
                }
            },
            handler: async (args: { project_id: number, user_id: number, access_level: number, expires_at?: string }): Promise<any> => {
                const { e, axiosWithAuth } = await getOAuthAccountForTool(req, provider);
                const { project_id, user_id, access_level, expires_at } = args;

                const updateData: any = {
                    access_level: Number(access_level)
                };

                if (expires_at) updateData.expires_at = expires_at;

                const url = `${e.uriBase}/api/v4/projects/${project_id}/members/${user_id}`;
                const result = (await axiosWithAuth.put(url, updateData)).data;

                reform(result);
                result.uriBase = e.uriBase;
                return result;
            }
        },
        {
            info: { group: provider, isActive: true, isInteractive: true, label: `プロジェクトメンバー削除`, },
            definition: {
                type: 'function', function: {
                    name: `gitlab_${providerName}_remove_project_member`,
                    description: `GitLabプロジェクトからメンバーを削除`,
                    parameters: {
                        type: 'object',
                        properties: {
                            project_id: { type: 'number', description: 'プロジェクトID' },
                            user_id: { type: 'number', description: 'ユーザーID' }
                        },
                        required: ['project_id', 'user_id']
                    }
                }
            },
            handler: async (args: { project_id: number, user_id: number }): Promise<any> => {
                const { e, axiosWithAuth } = await getOAuthAccountForTool(req, provider);
                const { project_id, user_id } = args;

                const url = `${e.uriBase}/api/v4/projects/${project_id}/members/${user_id}`;
                const result = (await axiosWithAuth.delete(url)).data;

                reform(result);
                result.uriBase = e.uriBase;
                return result;
            }
        },
        {
            info: { group: provider, isActive: true, isInteractive: false, label: `グループ一覧取得`, },
            definition: {
                type: 'function', function: {
                    name: `gitlab_${providerName}_groups`,
                    description: `GitLabのグループ一覧を取得`,
                    parameters: {
                        type: 'object',
                        properties: {
                            owned: { type: 'boolean', description: '所有するグループのみ', default: false },
                            min_access_level: { type: 'number', description: '最小アクセスレベル（10=Guest, 20=Reporter, 30=Developer, 40=Maintainer, 50=Owner）' },
                            order_by: { type: 'string', description: 'ソート基準', enum: ['name', 'path', 'id'], default: 'name' },
                            sort: { type: 'string', description: 'ソート順', enum: ['asc', 'desc'], default: 'asc' },
                            search: { type: 'string', description: '検索キーワード' },
                            per_page: { type: 'number', description: '1ページあたりの結果数（最大100）', default: 20, minimum: 1, maximum: 100 },
                            page: { type: 'number', description: 'ページ番号', default: 1, minimum: 1 }
                        }
                    }
                }
            },
            handler: async (args: { owned?: boolean, min_access_level?: number, order_by?: string, sort?: string, search?: string, per_page?: number, page?: number }): Promise<any> => {
                const { e, axiosWithAuth } = await getOAuthAccountForTool(req, provider);
                let { owned = false, min_access_level, order_by = 'name', sort = 'asc', search, per_page = 20, page = 1 } = args;
                per_page = Math.max(Math.min(per_page, 100), 1);
                page = Math.max(page, 1);

                const queryParams = new URLSearchParams();
                queryParams.append('owned', owned.toString());
                queryParams.append('order_by', order_by);
                queryParams.append('sort', sort);
                queryParams.append('per_page', per_page.toString());
                queryParams.append('page', page.toString());
                if (min_access_level) queryParams.append('min_access_level', min_access_level.toString());
                if (search) queryParams.append('search', search);

                const url = `${e.uriBase}/api/v4/groups?${queryParams.toString()}`;
                const result = (await axiosWithAuth.get(url)).data;

                reform(result);
                result.uriBase = e.uriBase;
                return result;
            }
        },
        {
            info: { group: provider, isActive: true, isInteractive: false, label: `グループメンバー一覧`, },
            definition: {
                type: 'function', function: {
                    name: `gitlab_${providerName}_group_members`,
                    description: `GitLabグループのメンバー一覧を取得`,
                    parameters: {
                        type: 'object',
                        properties: {
                            group_id: { type: 'number', description: 'グループID' },
                            query: { type: 'string', description: '検索クエリ' },
                            user_ids: { type: 'array', items: { type: 'number' }, description: '特定のユーザーIDで絞り込み' }
                        },
                        required: ['group_id']
                    }
                }
            },
            handler: async (args: { group_id: number, query?: string, user_ids?: number[] }): Promise<any> => {
                const { e, axiosWithAuth } = await getOAuthAccountForTool(req, provider);
                const { group_id, query, user_ids } = args;

                const queryParams = new URLSearchParams();
                if (query) queryParams.append('query', query);
                if (user_ids && user_ids.length > 0) {
                    user_ids.forEach(id => queryParams.append('user_ids[]', id.toString()));
                }

                const url = `${e.uriBase}/api/v4/groups/${group_id}/members?${queryParams.toString()}`;
                const result = (await axiosWithAuth.get(url)).data;

                reform(result);
                result.uriBase = e.uriBase;
                return result;
            }
        },
        {
            info: { group: provider, isActive: true, isInteractive: true, label: `グループメンバー追加`, },
            definition: {
                type: 'function', function: {
                    name: `gitlab_${providerName}_add_group_member`,
                    description: `GitLabグループにメンバーを追加`,
                    parameters: {
                        type: 'object',
                        properties: {
                            group_id: { type: 'number', description: 'グループID' },
                            user_id: { type: 'number', description: 'ユーザーID' },
                            access_level: { type: 'number', description: 'アクセスレベル（10=Guest, 20=Reporter, 30=Developer, 40=Maintainer, 50=Owner）', enum: ['10', '20', '30', '40', '50'] },
                            expires_at: { type: 'string', description: '有効期限（YYYY-MM-DD形式）' }
                        },
                        required: ['group_id', 'user_id', 'access_level']
                    }
                }
            },
            handler: async (args: { group_id: number, user_id: number, access_level: number, expires_at?: string }): Promise<any> => {
                const { e, axiosWithAuth } = await getOAuthAccountForTool(req, provider);
                const { group_id, user_id, access_level, expires_at } = args;

                const memberData: any = {
                    user_id: user_id,
                    access_level: Number(access_level)
                };

                if (expires_at) memberData.expires_at = expires_at;

                const url = `${e.uriBase}/api/v4/groups/${group_id}/members`;
                const result = (await axiosWithAuth.post(url, memberData)).data;

                reform(result);
                result.uriBase = e.uriBase;
                return result;
            }
        },
        {
            info: { group: provider, isActive: true, isInteractive: true, label: `グループメンバー更新`, },
            definition: {
                type: 'function', function: {
                    name: `gitlab_${providerName}_update_group_member`,
                    description: `GitLabグループメンバーの権限を更新`,
                    parameters: {
                        type: 'object',
                        properties: {
                            group_id: { type: 'number', description: 'グループID' },
                            user_id: { type: 'number', description: 'ユーザーID' },
                            access_level: { type: 'number', description: 'アクセスレベル（10=Guest, 20=Reporter, 30=Developer, 40=Maintainer, 50=Owner）', enum: ['10', '20', '30', '40', '50'] },
                            expires_at: { type: 'string', description: '有効期限（YYYY-MM-DD形式）' }
                        },
                        required: ['group_id', 'user_id', 'access_level']
                    }
                }
            },
            handler: async (args: { group_id: number, user_id: number, access_level: number, expires_at?: string }): Promise<any> => {
                const { e, axiosWithAuth } = await getOAuthAccountForTool(req, provider);
                const { group_id, user_id, access_level, expires_at } = args;

                const updateData: any = {
                    access_level: Number(access_level)
                };

                if (expires_at) updateData.expires_at = expires_at;

                const url = `${e.uriBase}/api/v4/groups/${group_id}/members/${user_id}`;
                const result = (await axiosWithAuth.put(url, updateData)).data;

                reform(result);
                result.uriBase = e.uriBase;
                return result;
            }
        },
        {
            info: { group: provider, isActive: true, isInteractive: true, label: `グループメンバー削除`, },
            definition: {
                type: 'function', function: {
                    name: `gitlab_${providerName}_remove_group_member`,
                    description: `GitLabグループからメンバーを削除`,
                    parameters: {
                        type: 'object',
                        properties: {
                            group_id: { type: 'number', description: 'グループID' },
                            user_id: { type: 'number', description: 'ユーザーID' }
                        },
                        required: ['group_id', 'user_id']
                    }
                }
            },
            handler: async (args: { group_id: number, user_id: number }): Promise<any> => {
                const { e, axiosWithAuth } = await getOAuthAccountForTool(req, provider);
                const { group_id, user_id } = args;

                const url = `${e.uriBase}/api/v4/groups/${group_id}/members/${user_id}`;
                const result = (await axiosWithAuth.delete(url)).data;

                reform(result);
                result.uriBase = e.uriBase;
                return result;
            }
        },
        {
            info: { group: provider, isActive: true, isInteractive: false, label: `ユーザー検索`, },
            definition: {
                type: 'function', function: {
                    name: `gitlab_${providerName}_search_users`,
                    description: `GitLabのユーザーを検索`,
                    parameters: {
                        type: 'object',
                        properties: {
                            search: { type: 'string', description: '検索キーワード（ユーザー名、名前、メールアドレス）' },
                            username: { type: 'string', description: 'ユーザー名で検索' },
                            extern_uid: { type: 'string', description: '外部UID' },
                            provider: { type: 'string', description: 'プロバイダー' },
                            created_after: { type: 'string', description: '作成日以降（ISO 8601形式）' },
                            created_before: { type: 'string', description: '作成日以前（ISO 8601形式）' },
                            active: { type: 'boolean', description: 'アクティブユーザーのみ', default: true },
                            blocked: { type: 'boolean', description: 'ブロック済みユーザーのみ', default: false },
                            per_page: { type: 'number', description: '1ページあたりの結果数（最大100）', default: 20, minimum: 1, maximum: 100 },
                            page: { type: 'number', description: 'ページ番号', default: 1, minimum: 1 }
                        }
                    }
                }
            },
            handler: async (args: { search?: string, username?: string, extern_uid?: string, provider?: string, created_after?: string, created_before?: string, active?: boolean, blocked?: boolean, per_page?: number, page?: number }): Promise<any> => {
                const { e, axiosWithAuth } = await getOAuthAccountForTool(req, provider);
                let { search, username, extern_uid, provider: authProvider, created_after, created_before, active = true, blocked = false, per_page = 20, page = 1 } = args;
                per_page = Math.max(Math.min(per_page, 100), 1);
                page = Math.max(page, 1);

                const queryParams = new URLSearchParams();
                queryParams.append('active', active.toString());
                queryParams.append('blocked', blocked.toString());
                queryParams.append('per_page', per_page.toString());
                queryParams.append('page', page.toString());
                if (search) queryParams.append('search', search);
                if (username) queryParams.append('username', username);
                if (extern_uid) queryParams.append('extern_uid', extern_uid);
                if (authProvider) queryParams.append('provider', authProvider);
                if (created_after) queryParams.append('created_after', created_after);
                if (created_before) queryParams.append('created_before', created_before);

                const url = `${e.uriBase}/api/v4/users?${queryParams.toString()}`;
                const result = (await axiosWithAuth.get(url)).data;

                reform(result);
                result.uriBase = e.uriBase;
                return result;
            }
        },
        {
            info: { group: provider, isActive: true, isInteractive: false, label: `通知一覧取得`, },
            definition: {
                type: 'function', function: {
                    name: `gitlab_${providerName}_notifications`,
                    description: `GitLabの通知一覧を取得`,
                    parameters: {
                        type: 'object',
                        properties: {
                            all: { type: 'boolean', description: '全ての通知を取得（既読含む）', default: false },
                            participating: { type: 'boolean', description: '参加している通知のみ', default: false },
                            per_page: { type: 'number', description: '1ページあたりの結果数（最大100）', default: 20, minimum: 1, maximum: 100 },
                            page: { type: 'number', description: 'ページ番号', default: 1, minimum: 1 }
                        }
                    }
                }
            },
            handler: async (args: { all?: boolean, participating?: boolean, per_page?: number, page?: number }): Promise<any> => {
                const { e, axiosWithAuth } = await getOAuthAccountForTool(req, provider);
                let { all = false, participating = false, per_page = 20, page = 1 } = args;
                per_page = Math.max(Math.min(per_page, 100), 1);
                page = Math.max(page, 1);

                const queryParams = new URLSearchParams();
                queryParams.append('all', all.toString());
                queryParams.append('participating', participating.toString());
                queryParams.append('per_page', per_page.toString());
                queryParams.append('page', page.toString());

                const url = `${e.uriBase}/api/v4/notification_settings?${queryParams.toString()}`;
                const result = (await axiosWithAuth.get(url)).data;

                reform(result);
                result.uriBase = e.uriBase;
                return result;
            }
        },
        {
            info: { group: provider, isActive: true, isInteractive: true, label: `通知設定更新`, },
            definition: {
                type: 'function', function: {
                    name: `gitlab_${providerName}_update_notification_settings`,
                    description: `GitLabの通知設定を更新`,
                    parameters: {
                        type: 'object',
                        properties: {
                            level: { type: 'string', description: '通知レベル', enum: ['disabled', 'participating', 'watch', 'global', 'mention', 'custom'] },
                            notification_email: { type: 'string', description: '通知先メールアドレス' },
                            new_note: { type: 'boolean', description: '新しいコメント通知' },
                            new_issue: { type: 'boolean', description: '新しいIssue通知' },
                            reopen_issue: { type: 'boolean', description: 'Issue再オープン通知' },
                            close_issue: { type: 'boolean', description: 'Issue終了通知' },
                            reassign_issue: { type: 'boolean', description: 'Issue再割り当て通知' },
                            new_merge_request: { type: 'boolean', description: '新しいマージリクエスト通知' },
                            reopen_merge_request: { type: 'boolean', description: 'マージリクエスト再オープン通知' },
                            close_merge_request: { type: 'boolean', description: 'マージリクエスト終了通知' },
                            reassign_merge_request: { type: 'boolean', description: 'マージリクエスト再割り当て通知' },
                            merge_merge_request: { type: 'boolean', description: 'マージリクエストマージ通知' },
                            failed_pipeline: { type: 'boolean', description: 'パイプライン失敗通知' },
                            success_pipeline: { type: 'boolean', description: 'パイプライン成功通知' }
                        }
                    }
                }
            },
            handler: async (args: { level?: string, notification_email?: string, new_note?: boolean, new_issue?: boolean, reopen_issue?: boolean, close_issue?: boolean, reassign_issue?: boolean, new_merge_request?: boolean, reopen_merge_request?: boolean, close_merge_request?: boolean, reassign_merge_request?: boolean, merge_merge_request?: boolean, failed_pipeline?: boolean, success_pipeline?: boolean }): Promise<any> => {
                const { e, axiosWithAuth } = await getOAuthAccountForTool(req, provider);

                // undefined値を除去
                const cleanUpdateData = Object.fromEntries(
                    Object.entries(args).filter(([_, value]) => value !== undefined)
                );

                const url = `${e.uriBase}/api/v4/notification_settings`;
                const result = (await axiosWithAuth.put(url, cleanUpdateData)).data;

                reform(result);
                result.uriBase = e.uriBase;
                return result;
            }
        },
        {
            info: { group: provider, isActive: true, isInteractive: false, label: `システム統計取得`, },
            definition: {
                type: 'function', function: {
                    name: `gitlab_${providerName}_statistics`,
                    description: `GitLabのシステム統計情報を取得`,
                    parameters: {
                        type: 'object',
                        properties: {}
                    }
                }
            },
            handler: async (args: {}): Promise<any> => {
                const { e, axiosWithAuth } = await getOAuthAccountForTool(req, provider);

                const url = `${e.uriBase}/api/v4/application/statistics`;
                const result = (await axiosWithAuth.get(url)).data;

                reform(result);
                result.uriBase = e.uriBase;
                return result;
            }
        },
        {
            info: { group: provider, isActive: true, isInteractive: false, label: `システム情報取得`, },
            definition: {
                type: 'function', function: {
                    name: `gitlab_${providerName}_version`,
                    description: `GitLabのバージョン情報を取得`,
                    parameters: {
                        type: 'object',
                        properties: {}
                    }
                }
            },
            handler: async (args: {}): Promise<any> => {
                const { e, axiosWithAuth } = await getOAuthAccountForTool(req, provider);

                const url = `${e.uriBase}/api/v4/version`;
                const result = (await axiosWithAuth.get(url)).data;

                reform(result);
                result.uriBase = e.uriBase;
                return result;
            }
        },
        {
            info: { group: provider, isActive: true, isInteractive: false, label: `イベント一覧取得`, },
            definition: {
                type: 'function', function: {
                    name: `gitlab_${providerName}_events`,
                    description: `GitLabのイベント一覧を取得`,
                    parameters: {
                        type: 'object',
                        properties: {
                            action: { type: 'string', description: 'アクションフィルター', enum: ['created', 'updated', 'closed', 'reopened', 'pushed', 'commented', 'merged', 'joined', 'left', 'destroyed', 'expired'] },
                            target_type: { type: 'string', description: 'ターゲットタイプ', enum: ['Issue', 'Milestone', 'MergeRequest', 'Note', 'Project', 'Snippet', 'User'] },
                            before: { type: 'string', description: '指定日以前（YYYY-MM-DD形式）' },
                            after: { type: 'string', description: '指定日以降（YYYY-MM-DD形式）' },
                            sort: { type: 'string', description: 'ソート順', enum: ['asc', 'desc'], default: 'desc' },
                            per_page: { type: 'number', description: '1ページあたりの結果数（最大100）', default: 20, minimum: 1, maximum: 100 },
                            page: { type: 'number', description: 'ページ番号', default: 1, minimum: 1 }
                        }
                    }
                }
            },
            handler: async (args: { action?: string, target_type?: string, before?: string, after?: string, sort?: string, per_page?: number, page?: number }): Promise<any> => {
                const { e, axiosWithAuth } = await getOAuthAccountForTool(req, provider);
                let { action, target_type, before, after, sort = 'desc', per_page = 20, page = 1 } = args;
                per_page = Math.max(Math.min(per_page, 100), 1);
                page = Math.max(page, 1);

                const queryParams = new URLSearchParams();
                queryParams.append('sort', sort);
                queryParams.append('per_page', per_page.toString());
                queryParams.append('page', page.toString());
                if (action) queryParams.append('action', action);
                if (target_type) queryParams.append('target_type', target_type);
                if (before) queryParams.append('before', before);
                if (after) queryParams.append('after', after);

                const url = `${e.uriBase}/api/v4/events?${queryParams.toString()}`;
                const result = (await axiosWithAuth.get(url)).data;

                reform(result);
                result.uriBase = e.uriBase;
                return result;
            }
        },
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

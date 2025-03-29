import { map, toArray } from "rxjs";

import { MyToolType, OpenAIApiWrapper, providerPrediction } from "../../common/openai-api-wrapper.js";
import { UserRequest } from "../models/info.js";
import { ContentPartEntity, MessageEntity, MessageGroupEntity, PredictHistoryWrapperEntity } from "../entity/project-models.entity.js";
import { MessageArgsSet } from "../controllers/chat-by-project-model.js";
import { ds } from "../db.js";
import { getOAuthAccountForTool, reform } from "./common.js";

// 1. 関数マッピングの作成
export async function gitlabFunctionDefinitions(providerSubName: string,
    obj: { inDto: MessageArgsSet; messageSet: { messageGroup: MessageGroupEntity; message: MessageEntity; contentParts: ContentPartEntity[]; }; },
    req: UserRequest, aiApi: OpenAIApiWrapper, connectionId: string, streamId: string, message: MessageEntity, label: string,
): Promise<MyToolType[]> {
    const provider = `gitlab-${providerSubName}`;
    return [
        {
            info: { group: provider, isActive: true, isInteractive: false, label: `汎用検索`, },
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
                const { e, oAuthAccount, axiosWithAuth } = await getOAuthAccountForTool(req, provider);
                let { per_page, page, scope } = args;
                per_page = Math.max(Math.min(per_page || 20, 100), 1); // 1以上100以下
                page = Math.max(page || 1, 1); // 1以上
                scope = scope || 'projects';

                const url = `${e.uriBase}/api/v4/search?scope=${scope}&search=${encodeURIComponent(args.search)}&per_page=${per_page}&page=${page}`;
                const result = (await axiosWithAuth.get(url)).data;

                reform(result);
                // result.me = reform(JSON.parse(oAuthAccount.userInfo));
                result.uriBase = e.uriBase;
                return result;
            }
        },
        {
            info: { group: provider, isActive: true, isInteractive: false, label: `プロジェクト一覧取得`, },
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
                const { e, oAuthAccount, axiosWithAuth } = await getOAuthAccountForTool(req, provider);
                let { per_page, page, membership, order_by, sort } = args;
                per_page = Math.max(Math.min(per_page || 20, 100), 1); // 1以上100以下
                page = Math.max(page || 1, 1); // 1以上
                membership = membership !== false; // デフォルトはtrue
                order_by = order_by || 'created_at';
                sort = sort || 'desc';

                const url = `${e.uriBase}/api/v4/projects?membership=${membership}&per_page=${per_page}&page=${page}&order_by=${order_by}&sort=${sort}`;
                const result = (await axiosWithAuth.get(url)).data;

                reform(result);
                // result.me = reform(JSON.parse(oAuthAccount.userInfo));
                result.uriBase = e.uriBase;
                return result;
            }
        },
        {   // For retrieving commit logs
            info: { group: provider, isActive: true, isInteractive: false, label: `リポジトリのコミット履歴`, responseType: 'markdown' },
            definition: {
                type: 'function', function: {
                    name: `gitlab_${providerSubName}_repository_commits`,
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
                const { e, oAuthAccount, axiosWithAuth } = await getOAuthAccountForTool(req, provider);
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
                    name: `gitlab_${providerSubName}_repository_refs`,
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
                const { e, oAuthAccount, axiosWithAuth } = await getOAuthAccountForTool(req, provider);
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
                    name: `gitlab_${providerSubName}_repository_compare`,
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
                const { e, oAuthAccount, axiosWithAuth } = await getOAuthAccountForTool(req, provider);
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
                    name: `gitlab_${providerSubName}_repository_commit`,
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
                const { e, oAuthAccount, axiosWithAuth } = await getOAuthAccountForTool(req, provider);
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
                const { e, oAuthAccount, axiosWithAuth } = await getOAuthAccountForTool(req, provider);
                let { project_id, state, per_page, page } = args;
                per_page = Math.max(Math.min(per_page || 20, 100), 1); // 1以上100以下
                page = Math.max(page || 1, 1); // 1以上
                state = state || 'opened';

                const url = `${e.uriBase}/api/v4/projects/${project_id}/issues?state=${state}&per_page=${per_page}&page=${page}`;
                const result = (await axiosWithAuth.get(url)).data;

                reform(result);
                // result.me = reform(JSON.parse(oAuthAccount.userInfo));
                result.uriBase = e.uriBase;
                return result;
            }
        },
        {
            info: { group: provider, isActive: true, isInteractive: false, label: `プロジェクトのマージリクエスト一覧`, },
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
                const { e, oAuthAccount, axiosWithAuth } = await getOAuthAccountForTool(req, provider);
                let { project_id, state, per_page, page } = args;
                per_page = Math.max(Math.min(per_page || 20, 100), 1); // 1以上100以下
                page = Math.max(page || 1, 1); // 1以上
                state = state || 'opened';

                const url = `${e.uriBase}/api/v4/projects/${project_id}/merge_requests?state=${state}&per_page=${per_page}&page=${page}`;
                const result = (await axiosWithAuth.get(url)).data;

                reform(result);
                // result.me = reform(JSON.parse(oAuthAccount.userInfo));
                result.uriBase = e.uriBase;
                return result;
            }
        },
        {
            info: { group: provider, isActive: true, isInteractive: false, label: `gitlab-${providerSubName}：自分のユーザー情報`, },
            definition: {
                type: 'function', function: {
                    name: `gitlab_${providerSubName}_user_info`,
                    description: `gitlab-${providerSubName}：自分のユーザー情報`,
                    parameters: { type: 'object', properties: {}, }
                }
            },
            handler: async (args: {}): Promise<any> => {
                const { e, oAuthAccount, axiosWithAuth } = await getOAuthAccountForTool(req, provider);
                const url = `${e.uriBase}/api/v4/user`;
                const result = (await axiosWithAuth.get(url)).data;

                reform(result);
                result.me = reform(JSON.parse(oAuthAccount.userInfo));
                result.uriBase = e.uriBase;
                return result;
            }
        },
        {
            info: { group: provider, isActive: true, isInteractive: false, label: `リポジトリファイル内容取得`, responseType: 'markdown' },
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
                    // // result.me = reform(JSON.parse(oAuthAccount.userInfo));
                    // result.uriBase = e.uriBase;
                    // return result;

                    let trg = file_path.split('\.').at(-1) || '';
                    trg = { cob: 'cobol', cbl: 'cobol', pco: 'cobol', htm: 'html' }[trg] || trg;

                    return `\`\`\`${trg} ${file_path}\n\n${result.decoded_content}\n\`\`\`\n`;
                })).then((results) => results.join('\n'));
            }
        },
        {
            info: { group: provider, isActive: true, isInteractive: false, label: `リポジトリファイル内容取得`, responseType: 'markdown' },
            definition: {
                type: 'function', function: {
                    name: `gitlab_${providerSubName}_file_content`,
                    description: `指定したプロジェクトのリポジトリからファイル内容を取得`,
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
                    const inDto = JSON.parse(JSON.stringify(obj.inDto)); // deep copy
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

                    const aiProvider = providerPrediction(inDto.args.model);

                    const newLabel = `${label}-call_ai-${inDto.args.model}`;
                    // レスポンス返した後にゆるりとヒストリーを更新しておく。
                    const history = new PredictHistoryWrapperEntity();
                    history.connectionId = connectionId;
                    history.streamId = streamId;
                    history.messageId = message.id;
                    history.label = newLabel;
                    history.model = inDto.args.model;
                    history.provider = provider;
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

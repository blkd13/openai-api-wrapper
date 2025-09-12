import { map, toArray } from "rxjs";

const { GITEA_CONFIDENCIAL_OWNERS = '' } = process.env as { GITEA_CONFIDENCIAL_OWNERS: string };

import { genClientByProvider, MyToolType, OpenAIApiWrapper, providerPrediction } from "../../common/openai-api-wrapper.js";
import { UserRequest } from "../models/info.js";
import { ContentPartEntity, MessageEntity, MessageGroupEntity, PredictHistoryWrapperEntity } from "../entity/project-models.entity.js";
import { getAIProvider, MessageArgsSet } from "../controllers/chat-by-project-model.js";
import { Utils } from "../../common/utils.js";
import { ds } from "../db.js";
import { getOAuthAccountForTool, reform } from "./common.js";
import { GiteaRepository } from "../api/api-gitea.js";

// 1. 関数マッピングの作成
export async function giteaFunctionDefinitions(providerName: string,
    obj: { inDto: MessageArgsSet; messageSet: { messageGroup: MessageGroupEntity; message: MessageEntity; contentParts: ContentPartEntity[]; }; },
    req: UserRequest, aiApi: OpenAIApiWrapper, connectionId: string, streamId: string, message: MessageEntity, label: string,
): Promise<MyToolType[]> {
    const provider = `gitea-${providerName}`;
    return [
        {
            info: { group: provider, isActive: true, isInteractive: false, label: `リポジトリ検索`, },
            definition: {
                type: 'function', function: {
                    name: `gitea_${providerName}_search_repos`,
                    description: `Giteaでリポジトリを検索`,
                    parameters: {
                        type: 'object',
                        properties: {
                            keyword: {
                                type: 'string',
                                description: '検索キーワード'
                            },
                            uid: {
                                type: 'number',
                                description: '特定のユーザーのリポジトリのみを検索する場合のユーザーID'
                            },
                            limit: {
                                type: 'number',
                                description: '取得する最大数。1以上50以下',
                                default: 10,
                                minimum: 1,
                                maximum: 50
                            },
                            page: {
                                type: 'number',
                                description: 'ページ番号',
                                default: 1,
                                minimum: 1
                            },
                            private: {
                                type: 'boolean',
                                description: 'プライベートリポジトリを含めるか',
                                default: true
                            }
                        },
                        required: ['keyword']
                    }
                }
            },
            handler: async (args: { keyword: string, uid?: number, limit: number, page: number, private: boolean }): Promise<any> => {
                const { e, axiosWithAuth } = await getOAuthAccountForTool(req, provider);
                let { limit, page, keyword, uid } = args;
                limit = Math.max(Math.min(limit || 10, 50), 1); // 1以上50以下
                page = Math.max(page || 1, 1); // 1以上

                let url = `${e.uriBase}/api/v1/repos/search?q=${encodeURIComponent(keyword)}&limit=${limit}&page=${page}`;

                if (uid) {
                    url += `&uid=${uid}`;
                }

                if (args.private !== undefined) {
                    url += `&private=${args.private}`;
                }

                const result = (await axiosWithAuth.get(url)).data;

                reform(result);
                // result.me = reform(oAuthAccount.userInfo);
                result.uriBase = e.uriBase;
                return result;
            }
        },
        {   // コミット履歴取得
            info: { group: provider, isActive: true, isInteractive: false, label: `リポジトリのコミット履歴`, responseType: 'markdown' },
            definition: {
                type: 'function', function: {
                    name: `gitea_${providerName}_repository_commits`,
                    description: `指定したプロジェクトのコミット履歴を取得`,
                    parameters: {
                        type: 'object',
                        properties: {
                            project_id: {
                                type: 'number',
                                description: 'プロジェクトID'
                            },
                            sha: {
                                type: 'string',
                                description: 'ブランチ名、タグ名、またはコミットSHA',
                            },
                            path: {
                                type: 'string',
                                description: '特定のファイルパスに限定する場合、そのパス',
                            },
                            limit: {
                                type: 'number',
                                description: '取得する最大コミット数',
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
            handler: async (args: { project_id: number, sha?: string, path?: string, limit: number, page: number }): Promise<any> => {
                const { e, axiosWithAuth } = await getOAuthAccountForTool(req, provider);
                const { project_id, sha, path, limit = 20, page = 1 } = args;

                const queryMap = {} as { [key: string]: string };
                if (sha) queryMap.sha = sha;
                if (path) queryMap.path = path;
                queryMap.limit = limit.toString();
                queryMap.page = page.toString();
                // Giteaでは/api/v1/repos/{owner}/{repo}/commitsの形式
                // project_idからリポジトリ情報を取得するためのリクエスト
                const repoUrl = `${e.uriBase}/api/v1/repositories/${project_id}`;
                const repoInfo = (await axiosWithAuth.get(repoUrl)).data;
                const owner = repoInfo.owner.username;
                const repo = repoInfo.name;

                const url = `${e.uriBase}/api/v1/repos/${owner}/${repo}/commits?${Object.entries(queryMap).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&')}`;
                console.log(url);
                const result = (await axiosWithAuth.get(url)).data;

                // JSONをMarkdownテーブルに変換
                let markdownTable = '## Giteaコミット履歴\n\n';
                markdownTable += `- uriBase: ${e.uriBase}\n\n`;
                markdownTable += '| SHA | 作成日 | メッセージ | 作成者 | コミッター | 統計情報 | URL |\n';
                markdownTable += '|-----|--------|----------|---------|-----------|------------|-----|\n';

                // 各コミットをテーブル行に変換
                for (const commit of result) {
                    // 日付のフォーマット (YYYY-MM-DD形式)
                    const createdDate = commit.created;

                    // 統計情報
                    const stats = commit.stats ?
                        `追加: ${commit.stats.additions}, 削除: ${commit.stats.deletions}, 合計: ${commit.stats.total}` : '';

                    // コミットメッセージの改行を取り除く
                    const message = commit.commit?.message?.trim().replace(/\n/g, ' ') || '';

                    // 作成者とコミッターのユーザー名
                    const authorName = commit.author?.username || '';
                    const committerName = commit.committer?.username || '';

                    // Markdownテーブル行を作成
                    markdownTable += `| ${commit.sha.substring(0, 7)} | ${createdDate} | ${message.replaceAll(/\|/g, '\\|')} | ${authorName} | ${committerName} | ${stats} | [リンク](${commit.html_url}) |\n`;
                }

                // Markdownテーブルを返す
                return markdownTable;
            }
        },
        {   // ブランチとタグ一覧の統合関数
            info: { group: provider, isActive: true, isInteractive: false, label: `リポジトリのブランチ/タグ一覧`, },
            definition: {
                type: 'function', function: {
                    name: `gitea_${providerName}_repository_refs`,
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
                            query: {
                                type: 'string',
                                description: '検索キーワード（名前でフィルタリング）',
                                default: ''
                            },
                            limit: {
                                type: 'number',
                                description: '取得する最大件数',
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
            handler: async (args: { project_id: number, ref_type: string, query: string, limit: number, page: number }): Promise<any> => {
                const { e, axiosWithAuth } = await getOAuthAccountForTool(req, provider);
                const { project_id, ref_type = 'branches', query = '', limit = 20, page = 1 } = args;

                // project_idからリポジトリ情報を取得するためのリクエスト
                const repoUrl = `${e.uriBase}/api/v1/repositories/${project_id}`;
                const repoInfo = (await axiosWithAuth.get(repoUrl)).data;
                const owner = repoInfo.owner.username;
                const repo = repoInfo.name;

                // ref_typeに基づいてURLを構築
                const url = `${e.uriBase}/api/v1/repos/${owner}/${repo}/${ref_type}?q=${encodeURIComponent(query)}&limit=${limit}&page=${page}`;
                const result = (await axiosWithAuth.get(url)).data;

                reform(result);
                result.uriBase = e.uriBase;
                result.ref_type = ref_type; // どちらのタイプを取得したかを結果に含める
                return result;
            }
        },
        {   // コミット間の差分を取得
            info: { group: provider, isActive: true, isInteractive: false, label: `コミット間の差分を取得`, responseType: 'markdown' },
            definition: {
                type: 'function', function: {
                    name: `gitea_${providerName}_repository_compare`,
                    description: `指定したプロジェクトの2つのコミット（ブランチやタグ）間の差分を取得`,
                    parameters: {
                        type: 'object',
                        properties: {
                            project_id: {
                                type: 'number',
                                description: 'プロジェクトID'
                            },
                            base: {
                                type: 'string',
                                description: '比較元のブランチ名、タグ名、またはコミットSHA'
                            },
                            head: {
                                type: 'string',
                                description: '比較先のブランチ名、タグ名、またはコミットSHA'
                            }
                        },
                        required: ['project_id', 'base', 'head']
                    }
                }
            },
            handler: async (args: { project_id: number, base: string, head: string }): Promise<any> => {
                const { e, axiosWithAuth } = await getOAuthAccountForTool(req, provider);
                const { project_id, base, head } = args;

                // project_idからリポジトリ情報を取得するためのリクエスト
                const repoUrl = `${e.uriBase}/api/v1/repositories/${project_id}`;
                const repoInfo = (await axiosWithAuth.get(repoUrl)).data;
                const owner = repoInfo.owner.username;
                const repo = repoInfo.name;

                const url = `${e.uriBase}/api/v1/repos/${owner}/${repo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`;
                const result = (await axiosWithAuth.get(url)).data;

                // Format the output as markdown
                let markdown = `# 比較結果: ${base} → ${head}\n\n`;

                if (result.commits && result.commits.length > 0) {
                    markdown += `## コミット (${result.commits.length}件)\n\n`;
                    result.commits.forEach((commit: any) => {
                        markdown += `- **${commit.sha.substring(0, 8)}** ${commit.commit.message.split('\n')[0]} (${commit.author?.login || commit.commit.author.name}, ${new Date(commit.commit.author.date).toLocaleString()})\n`;
                    });
                    markdown += '\n';
                }

                if (result.files && result.files.length > 0) {
                    markdown += `## 変更されたファイル (${result.files.length}件)\n\n`;
                    result.files.forEach((file: any) => {
                        markdown += `### ${file.filename}\n`;
                        if (file.patch) {
                            markdown += '```diff\n' + file.patch + '\n```\n\n';
                        } else {
                            markdown += `*ファイルタイプ: ${file.status}*\n\n`;
                        }
                    });
                }

                return markdown;
            }
        },
        {   // 特定コミットの詳細
            info: { group: provider, isActive: true, isInteractive: false, label: `特定コミットの詳細`, },
            definition: {
                type: 'function', function: {
                    name: `gitea_${providerName}_repository_commit`,
                    description: `指定したプロジェクトの特定のコミット詳細と変更内容を取得`,
                    parameters: {
                        type: 'object',
                        properties: {
                            project_id: {
                                type: 'number',
                                description: 'プロジェクトID'
                            },
                            sha: {
                                type: 'string',
                                description: 'コミットSHA'
                            }
                        },
                        required: ['project_id', 'sha']
                    }
                }
            },
            handler: async (args: { project_id: number, sha: string }): Promise<any> => {
                const { e, axiosWithAuth } = await getOAuthAccountForTool(req, provider);
                const { project_id, sha } = args;

                // project_idからリポジトリ情報を取得するためのリクエスト
                const repoUrl = `${e.uriBase}/api/v1/repositories/${project_id}`;
                const repoInfo = (await axiosWithAuth.get(repoUrl)).data;
                const owner = repoInfo.owner.username;
                const repo = repoInfo.name;

                // Get commit details
                const commitUrl = `${e.uriBase}/api/v1/repos/${owner}/${repo}/git/commits/${encodeURIComponent(sha)}`;
                const commitResult = (await axiosWithAuth.get(commitUrl)).data;

                // Get commit files
                const filesUrl = `${e.uriBase}/api/v1/repos/${owner}/${repo}/commits/${encodeURIComponent(sha)}`;
                const filesResult = (await axiosWithAuth.get(filesUrl)).data;

                const result = {
                    commit: commitResult,
                    files: filesResult.files,
                    uriBase: e.uriBase
                };

                reform(result);
                return result;
            }
        },
        // {
        //     info: { group: provider, isActive: true, isInteractive: false, label: `リポジトリ全ファイル一覧を取得`, },
        //     definition: {
        //         type: 'function', function: {
        //             name: `gitea_${providerName}_repository_all_file_list`,
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
        //         let { owner, repo } = args;
        //         const ref = args.ref || 'main';
        //         const { e } = await getOAuthAccount(req, provider);

        //         // リポジトリのツリー情報を再帰的に取得
        //         const treeUrl = `${e.uriBase}/api/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees/${encodeURIComponent(ref)}?recursive=true`;
        //         const treeResponse = await axiosWithAuth.get(treeUrl);
        //         const treeData = treeResponse.data;
        //         console.dir(treeData);

        //         if (!treeData.tree) {
        //             return { error: "リポジトリのツリー情報が取得できませんでした" };
        //         }
        //         return { treeData, uriBase: e.uriBase };

        //         // blob(ファイル)のみを抽出
        //         const fileItems = treeData.tree.filter((item: any) => item.type === 'blob');

        //         // 各ファイルの内容と情報を並列で取得
        //         const filePromises = fileItems.map(async (item: any) => {
        //             const filePath = item.path;
        //             try {
        //                 const rawUrl = `${e.uriBase}/api/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/raw/${encodeURIComponent(ref)}/${encodeURIComponent(filePath)}`;
        //                 const contentResponse = await axiosWithAuth.get(rawUrl, { responseType: 'text' });
        //                 const content = contentResponse.data;

        //                 const infoUrl = `${e.uriBase}/api/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodeURIComponent(filePath)}?ref=${encodeURIComponent(ref)}`;
        //                 const infoResponse = await axiosWithAuth.get(infoUrl);
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
        // /**
        //  * リポジトリの全ファイルを一度に取得する関数
        //  */
        // {
        //     info: { group: provider, isActive: true, isInteractive: false, label: `リポジトリ全ファイル取得`, },
        //     definition: {
        //         type: 'function', function: {
        //             name: `gitea_${providerName}_get_all_repository_files`,
        //             description: `指定したリポジトリの全ファイル内容を一度に取得`,
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
        //                     },
        //                     exclude_patterns: {
        //                         type: 'array',
        //                         items: {
        //                             type: 'string'
        //                         },
        //                         description: '除外するファイルパターン（正規表現）の配列',
        //                         default: []
        //                     },
        //                     include_binary: {
        //                         type: 'boolean',
        //                         description: 'バイナリファイルを含めるかどうか',
        //                         default: false
        //                     },
        //                     max_size_mb: {
        //                         type: 'number',
        //                         description: '取得する最大ファイルサイズ（MB）',
        //                         default: 5
        //                     }
        //                 },
        //                 required: ['owner', 'repo']
        //             }
        //         }
        //     },
        //     handler: async (args: {
        //         owner: string,
        //         repo: string,
        //         ref: string,
        //         exclude_patterns?: string[],
        //         include_binary?: boolean,
        //         max_size_mb?: number
        //     }): Promise<any> => {
        //         let { owner, repo, ref, exclude_patterns, include_binary, max_size_mb } = args;
        //         ref = ref || 'main';
        //         exclude_patterns = exclude_patterns || [];
        //         include_binary = include_binary !== undefined ? include_binary : false;
        //         max_size_mb = max_size_mb || 5;
        //         const max_size_bytes = max_size_mb * 1024 * 1024;

        //         const { e } = await getOAuthAccount(req, provider);

        //         // 正規表現パターンを準備
        //         const regexPatterns = exclude_patterns.map(pattern => new RegExp(pattern));

        //         // ファイルをフィルタリングする関数
        //         const shouldIncludeFile = (path: string, size: number, isTextFile: boolean): boolean => {
        //             // サイズチェック
        //             if (size > max_size_bytes) return false;

        //             // バイナリファイルのチェック
        //             if (!isTextFile && !include_binary) return false;

        //             // パターンマッチングによる除外チェック
        //             return !regexPatterns.some(regex => regex.test(path));
        //         };

        //         // テキストファイルかどうかを判断する簡易関数
        //         const isLikelyTextFile = (path: string): boolean => {
        //             const textExtensions = [
        //                 '.txt', '.md', '.js', '.ts', '.jsx', '.tsx', '.html', '.css', '.scss', '.less',
        //                 '.json', '.xml', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf',
        //                 '.c', '.cpp', '.h', '.hpp', '.java', '.py', '.rb', '.php', '.go', '.rs', '.swift',
        //                 '.sh', '.bash', '.zsh', '.bat', '.ps1', '.sql', '.graphql', '.prisma',
        //                 '.vue', '.svelte', '.astro', '.mdx', '.njk', '.liquid', '.hbs', '.ejs'
        //             ];

        //             return textExtensions.some(ext => path.toLowerCase().endsWith(ext)) ||
        //                 !path.includes('.'); // 拡張子がない場合も一応テキストとして扱う
        //         };

        //         try {
        //             // 1. まずリポジトリの全ファイル一覧を再帰的に取得
        //             const treeUrl = `${e.uriBase}/api/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees/${encodeURIComponent(ref)}?recursive=true`;
        //             const treeResponse = await axiosWithAuth.get(treeUrl);
        //             const tree = treeResponse.data;

        //             // 2. ファイルのみをフィルタリング
        //             const fileEntries = Array.isArray(tree.tree)
        //                 ? tree.tree.filter((item: any) => item.type === 'blob')
        //                 : [];

        //             // 3. 各ファイルの内容を並行取得
        //             const fileContents = await Promise.all(
        //                 fileEntries.map(async (file: any) => {
        //                     // パスとサイズによるフィルタリング
        //                     const isTextFile = isLikelyTextFile(file.path);
        //                     if (!shouldIncludeFile(file.path, file.size || 0, isTextFile)) {
        //                         return {
        //                             path: file.path,
        //                             content: null,
        //                             excluded: true,
        //                             reason: file.size > max_size_bytes
        //                                 ? 'サイズ超過'
        //                                 : (!isTextFile && !include_binary)
        //                                     ? 'バイナリファイル'
        //                                     : 'パターン除外'
        //                         };
        //                     }

        //                     try {
        //                         const contentUrl = `${e.uriBase}/api/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/raw/${encodeURIComponent(ref)}/${encodeURIComponent(file.path)}`;
        //                         const contentResponse = await axiosWithAuth.get(contentUrl, { responseType: 'text' });
        //                         return {
        //                             path: file.path,
        //                             content: contentResponse.data,
        //                             size: file.size,
        //                             sha: file.sha
        //                         };
        //                     } catch (err) {
        //                         return {
        //                             path: file.path,
        //                             content: null,
        //                             error: "取得失敗",
        //                             details: Utils.errorFormattedObject(err)
        //                         };
        //                     }
        //                 })
        //             );

        //             // 4. 結果をまとめる
        //             const result = {
        //                 repository: {
        //                     owner,
        //                     repo,
        //                     ref
        //                 },
        //                 stats: {
        //                     total_files: fileEntries.length,
        //                     included_files: fileContents.filter(f => !f.excluded && !f.error).length,
        //                     excluded_files: fileContents.filter(f => f.excluded).length,
        //                     error_files: fileContents.filter(f => f.error).length,
        //                     total_size: fileContents.reduce((sum, f) => sum + (f.size || 0), 0)
        //                 },
        //                 files: fileContents
        //             };

        //             reform(result);
        //             (result as any).uriBase = e.uriBase;
        //             return result;
        //         } catch (error) {
        //             return {
        //                 error: "リポジトリファイルの取得に失敗しました",
        //                 details: Utils.errorFormattedObject(error),
        //             };
        //         }
        //     }
        // },
        {
            info: { group: provider, isActive: true, isInteractive: false, label: `課題検索`, },
            definition: {
                type: 'function', function: {
                    name: `gitea_${providerName}_search_issues`,
                    description: `Giteaで課題（Issue）を検索`,
                    parameters: {
                        type: 'object',
                        properties: {
                            keyword: {
                                type: 'string',
                                description: '検索キーワード'
                            },
                            owner: {
                                type: 'string',
                                description: 'リポジトリのオーナー（ユーザー名）'
                            },
                            repo: {
                                type: 'string',
                                description: 'リポジトリ名'
                            },
                            state: {
                                type: 'string',
                                description: '課題の状態',
                                enum: ['open', 'closed', 'all'],
                                default: 'open'
                            },
                            labels: {
                                type: 'string',
                                description: 'カンマ区切りのラベルリスト（例: "bug,enhancement"）'
                            },
                            limit: {
                                type: 'number',
                                description: '取得する最大数。1以上50以下',
                                default: 10,
                                minimum: 1,
                                maximum: 50
                            },
                            page: {
                                type: 'number',
                                description: 'ページ番号',
                                default: 1,
                                minimum: 1
                            }
                        }
                    }
                }
            },
            handler: async (args: { keyword?: string, owner?: string, repo?: string, state?: string, labels?: string, limit: number, page: number }): Promise<any> => {
                const { e, axiosWithAuth } = await getOAuthAccountForTool(req, provider);
                let { limit, page, state } = args;
                limit = Math.max(Math.min(limit || 10, 50), 1); // 1以上50以下
                page = Math.max(page || 1, 1); // 1以上
                state = state || 'open';

                let url = `${e.uriBase}/api/v1/repos/issues/search?limit=${limit}&page=${page}&state=${state}`;

                if (args.keyword) {
                    url += `&q=${encodeURIComponent(args.keyword)}`;
                }

                if (args.owner) {
                    url += `&owner=${encodeURIComponent(args.owner)}`;
                }

                if (args.repo) {
                    url += `&repo=${encodeURIComponent(args.repo)}`;
                }

                if (args.labels) {
                    url += `&labels=${encodeURIComponent(args.labels)}`;
                }

                const result = (await axiosWithAuth.get(url)).data;

                reform(result);
                // result.me = reform(AuthAccount.userInfo);
                result.uriBase = e.uriBase;
                return result;
            }
        },
        {
            info: { group: provider, isActive: true, isInteractive: false, label: `自分のリポジトリ一覧`, },
            definition: {
                type: 'function', function: {
                    name: `gitea_${providerName}_my_repos`,
                    description: `自分のリポジトリ一覧を取得`,
                    parameters: {
                        type: 'object',
                        properties: {
                            limit: {
                                type: 'number',
                                description: '取得する最大数。1以上50以下',
                                default: 10,
                                minimum: 1,
                                maximum: 50
                            },
                            page: {
                                type: 'number',
                                description: 'ページ番号',
                                default: 1,
                                minimum: 1
                            }
                        }
                    }
                }
            },
            handler: async (args: { limit: number, page: number }): Promise<any> => {
                const { e, axiosWithAuth } = await getOAuthAccountForTool(req, provider);
                let { limit, page } = args;
                limit = Math.max(Math.min(limit || 10, 50), 1); // 1以上50以下
                page = Math.max(page || 1, 1); // 1以上

                const url = `${e.uriBase}/api/v1/user/repos?limit=${limit}&page=${page}`;
                const result = (await axiosWithAuth.get(url)).data;

                reform(result);
                // result.me = reform(oAuthAccount.userInfo);
                result.uriBase = e.uriBase;
                return result;
            }
        },
        {
            info: { group: provider, isActive: true, isInteractive: false, label: `リポジトリの課題一覧`, },
            definition: {
                type: 'function', function: {
                    name: `gitea_${providerName}_repo_issues`,
                    description: `指定したリポジトリの課題（Issue）一覧を取得`,
                    parameters: {
                        type: 'object',
                        properties: {
                            owner: {
                                type: 'string',
                                description: 'リポジトリのオーナー（ユーザー名）'
                            },
                            repo: {
                                type: 'string',
                                description: 'リポジトリ名'
                            },
                            state: {
                                type: 'string',
                                description: '課題の状態',
                                enum: ['open', 'closed', 'all'],
                                default: 'open'
                            },
                            labels: {
                                type: 'string',
                                description: 'カンマ区切りのラベルリスト（例: "bug,enhancement"）'
                            },
                            limit: {
                                type: 'number',
                                description: '取得する最大数。1以上50以下',
                                default: 10,
                                minimum: 1,
                                maximum: 50
                            },
                            page: {
                                type: 'number',
                                description: 'ページ番号',
                                default: 1,
                                minimum: 1
                            }
                        },
                        required: ['owner', 'repo']
                    }
                }
            },
            handler: async (args: { owner: string, repo: string, state?: string, labels?: string, limit: number, page: number }): Promise<any> => {
                const { e, axiosWithAuth } = await getOAuthAccountForTool(req, provider);
                let { limit, page, state, owner, repo } = args;
                limit = Math.max(Math.min(limit || 10, 50), 1); // 1以上50以下
                page = Math.max(page || 1, 1); // 1以上
                state = state || 'open';

                let url = `${e.uriBase}/api/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues?limit=${limit}&page=${page}&state=${state}`;

                if (args.labels) {
                    url += `&labels=${encodeURIComponent(args.labels)}`;
                }

                const result = (await axiosWithAuth.get(url)).data;

                reform(result);
                // result.me = reform(oAuthAccount.userInfo);
                result.uriBase = e.uriBase;
                return result;
            }
        },
        {
            info: { group: provider, isActive: true, isInteractive: false, label: `リポジトリのプルリクエスト一覧`, },
            definition: {
                type: 'function', function: {
                    name: `gitea_${providerName}_repo_pulls`,
                    description: `指定したリポジトリのプルリクエスト一覧を取得`,
                    parameters: {
                        type: 'object',
                        properties: {
                            owner: {
                                type: 'string',
                                description: 'リポジトリのオーナー（ユーザー名）'
                            },
                            repo: {
                                type: 'string',
                                description: 'リポジトリ名'
                            },
                            state: {
                                type: 'string',
                                description: 'プルリクエストの状態',
                                enum: ['open', 'closed', 'all'],
                                default: 'open'
                            },
                            limit: {
                                type: 'number',
                                description: '取得する最大数。1以上50以下',
                                default: 10,
                                minimum: 1,
                                maximum: 50
                            },
                            page: {
                                type: 'number',
                                description: 'ページ番号',
                                default: 1,
                                minimum: 1
                            }
                        },
                        required: ['owner', 'repo']
                    }
                }
            },
            handler: async (args: { owner: string, repo: string, state?: string, limit: number, page: number }): Promise<any> => {
                const { e, axiosWithAuth } = await getOAuthAccountForTool(req, provider);
                let { limit, page, state, owner, repo } = args;
                limit = Math.max(Math.min(limit || 10, 50), 1); // 1以上50以下
                page = Math.max(page || 1, 1); // 1以上
                state = state || 'open';

                const url = `${e.uriBase}/api/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls?limit=${limit}&page=${page}&state=${state}`;
                const result = (await axiosWithAuth.get(url)).data;

                reform(result);
                // result.me = reform(oAuthAccount.userInfo);
                result.uriBase = e.uriBase;
                return result;
            }
        },
        {
            info: { group: provider, isActive: true, isInteractive: false, label: `gitea-${providerName}：自分のユーザー情報`, },
            definition: {
                type: 'function', function: {
                    name: `gitea_${providerName}_user_info`,
                    description: `gitea-${providerName}：自分のユーザー情報`,
                    parameters: { type: 'object', properties: {}, }
                }
            },
            handler: async (args: {}): Promise<any> => {
                const { e, oAuthAccount, axiosWithAuth } = await getOAuthAccountForTool(req, provider);
                const url = `${e.uriBase}/api/v1/user`;
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
                    name: `gitea_${providerName}_file_content`,
                    description: `指定したリポジトリからファイル内容を取得`,
                    parameters: {
                        type: 'object',
                        properties: {
                            owner: {
                                type: 'string',
                                description: 'リポジトリのオーナー（ユーザー名）'
                            },
                            repo: {
                                type: 'string',
                                description: 'リポジトリ名'
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
                        required: ['owner', 'repo', 'file_path_list']
                    }
                }
            },
            handler: async (args: { owner: string, repo: string, file_path_list: string[], ref: string }): Promise<string> => {
                const { e, oAuthAccount, axiosWithAuth } = await getOAuthAccountForTool(req, provider);
                let { owner, repo, file_path_list, ref } = args;
                if (GITEA_CONFIDENCIAL_OWNERS.split(',').includes(owner)) {
                    return Promise.resolve(`\`\`\`json\n{ "error": "このリポジトリは機密情報を含むため、表示できません", "details": "機密情報を含むリポジトリの場合、表示を制限しています。" }\n\`\`\``);
                } else { }

                if (ref) {
                    // ブランチ名、タグ名、またはコミットSHAが指定されている場合はそのまま
                } else {
                    const defaultBranchUrl = `${e.uriBase}/api/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
                    const defaultBranchResult = (await axiosWithAuth.get<GiteaRepository>(defaultBranchUrl)).data;
                    ref = ref || defaultBranchResult.default_branch || 'main';
                }

                // ファイルの内容を取得
                return await Promise.all(file_path_list.map(async (file_path) => {
                    const url = `${e.uriBase}/api/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/raw/${encodeURIComponent(ref)}/${encodeURIComponent(file_path)}`;
                    try {
                        // raw contentを取得
                        const contentResponse = await axiosWithAuth.get(url, { responseType: 'text' });
                        const content = contentResponse.data;

                        // ファイル情報も取得
                        const contentUrl = `${e.uriBase}/api/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodeURIComponent(file_path)}?ref=${encodeURIComponent(ref)}`;
                        const contentInfo = (await axiosWithAuth.get(contentUrl)).data;
                        // console.log('contentInfo:START');
                        // console.dir(contentInfo);
                        // console.log('contentInfo:END');
                        // // 結合したレスポンス
                        // const result = {
                        //     content: content,
                        //     file_info: contentInfo
                        // } as any;
                        // reform(result);
                        // // result.me = reform(oAuthAccount.userInfo);
                        // result.uriBase = e.uriBase;
                        // return result;
                        let trg = file_path.split('\.').at(-1) || '';
                        trg = { cob: 'cobol', cbl: 'cobol', pco: 'cobol', htm: 'html' }[trg] || trg;
                        return `\`\`\`${trg} ${file_path}\n\n${content}\n\`\`\`\n`;
                    } catch (error) {
                        // ファイルが見つからない場合など
                        return `\`\`\`json\n{ "error": "ファイルが見つかりません", "details": ${JSON.stringify(Utils.errorFormattedObject(error))} }\n\`\`\`\n\n`;
                    }
                })).then(results => results.join('\n'));
            }
        },
        {
            info: { group: provider, isActive: true, isInteractive: false, label: `リポジトリファイル内容取得（AI）`, responseType: 'markdown' },
            definition: {
                type: 'function', function: {
                    name: `gitea_${providerName}_file_content_by_ai`,
                    description: `指定したリポジトリからファイル内容のAI要約を取得`,
                    parameters: {
                        type: 'object',
                        properties: {
                            userPrompt: {
                                type: 'string',
                                description: 'AI要約に置けるプロンプト（例: "関数一覧のみを抽出してください"）',
                                default: '要約してください'
                            },
                            owner: {
                                type: 'string',
                                description: 'リポジトリのオーナー（ユーザー名）'
                            },
                            repo: {
                                type: 'string',
                                description: 'リポジトリ名'
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
                        required: ['owner', 'repo', 'file_path_list']
                    }
                }
            },
            handler: async (args: { userPrompt?: string, owner: string, repo: string, file_path_list: string[], ref: string }): Promise<string> => {
                const { e, oAuthAccount, axiosWithAuth } = await getOAuthAccountForTool(req, provider);
                let { userPrompt = '要約してください', owner, repo, file_path_list, ref } = args;
                const aiProvider = await getAIProvider(req.info.user, obj.inDto.args.model);

                if (GITEA_CONFIDENCIAL_OWNERS.split(',').includes(owner)) {
                    return Promise.resolve(`\`\`\`json\n{ "error": "このリポジトリは機密情報を含むため、表示できません", "details": "機密情報を含むリポジトリの場合、表示を制限しています。" }\n\`\`\``);
                } else { }

                if (ref) {
                    // ブランチ名、タグ名、またはコミットSHAが指定されている場合はそのまま
                } else {
                    const defaultBranchUrl = `${e.uriBase}/api/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
                    const defaultBranchResult = (await axiosWithAuth.get<GiteaRepository>(defaultBranchUrl)).data;
                    ref = ref || defaultBranchResult.default_branch || 'main';
                }

                // ファイルの内容を取得
                return await Promise.all(file_path_list.map(async (file_path) => {
                    const url = `${e.uriBase}/api/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/raw/${encodeURIComponent(ref)}/${encodeURIComponent(file_path)}`;
                    try {
                        // raw contentを取得
                        const contentResponse = await axiosWithAuth.get(url, { responseType: 'text' });
                        const content = contentResponse.data;

                        // ファイル情報も取得
                        const contentUrl = `${e.uriBase}/api/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodeURIComponent(file_path)}?ref=${encodeURIComponent(ref)}`;
                        const contentInfo = (await axiosWithAuth.get(contentUrl)).data;

                        let trg = file_path.split('\.').at(-1) || '';
                        trg = { cob: 'cobol', cbl: 'cobol', pco: 'cobol', htm: 'html' }[trg] || trg;
                        const codeBlock = `\`\`\`${trg} ${file_path}\n\n${content}\n\`\`\`\n`;
                        const codeInfoBlock = `\`\`\`json\n${JSON.stringify(contentInfo, null, 2)}\n\`\`\`\n`; // ファイル情報

                        const systemPrompt = 'アシスタントAI';

                        const inDto = Utils.deepCopyOmitting(obj.inDto, 'aiProviderClient');
                        // inDto.args.model = 'gemini-1.5-pro';
                        inDto.args.messages = [
                            { role: 'system', content: [{ type: 'text', text: systemPrompt }] },
                            {
                                role: 'user', content: [
                                    { type: 'text', text: userPrompt },
                                    { type: 'text', text: codeInfoBlock },
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
                    } catch (error) {
                        // ファイルが見つからない場合など
                        return `\`\`\`json\n{ "error": "ファイルが見つかりません", "details": ${JSON.stringify(Utils.errorFormattedObject(error))} }\n\`\`\`\n\n`;
                    }
                })).then(results => results.join('\n'));
            }
        },
        {
            info: { group: provider, isActive: true, isInteractive: false, label: `リポジトリファイル一覧取得（ls風）`, responseType: 'text' },
            definition: {
                type: 'function', function: {
                    name: `gitea_${providerName}_repository_tree`,
                    description: `指定したリポジトリ内のファイルとディレクトリ一覧をls形式で取得`,
                    parameters: {
                        type: 'object',
                        properties: {
                            owner: {
                                type: 'string',
                                description: 'リポジトリのオーナー（ユーザー名）'
                            },
                            repo: {
                                type: 'string',
                                description: 'リポジトリ名'
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
                        required: ['owner', 'repo']
                    }
                }
            },
            handler: async (args: { owner: string, repo: string, path: string, ref: string, recursive: boolean, show_directories: boolean }): Promise<any> => {
                const { e, oAuthAccount, axiosWithAuth } = await getOAuthAccountForTool(req, provider);
                let { owner, repo, path, ref, recursive, show_directories } = args;
                path = path || '';
                recursive = recursive !== false; // 明示的にfalseの場合のみfalse
                show_directories = show_directories === true; // 明示的にtrueの場合のみtrue

                if (ref) {
                    // ブランチ名、タグ名、またはコミットSHAが指定されている場合はそのまま
                } else {
                    const defaultBranchUrl = `${e.uriBase}/api/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
                    const defaultBranchResult = (await axiosWithAuth.get<GiteaRepository>(defaultBranchUrl)).data;
                    ref = ref || defaultBranchResult.default_branch || 'main';
                }

                // GitEAの再帰的な取得とパス解決のためのロジック
                let allItems: any[] = [];

                if (recursive) {
                    // 再帰的な場合は git trees API を使用
                    let treeUrl = `${e.uriBase}/api/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees/${encodeURIComponent(ref)}?recursive=true`;

                    if (path) {
                        // パスが指定されている場合、そのパスのSHAを取得する必要がある
                        const pathUrl = `${e.uriBase}/api/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(ref)}`;
                        try {
                            const pathResponse = await axiosWithAuth.get(pathUrl);
                            if (Array.isArray(pathResponse.data) && pathResponse.data.length > 0) {
                                // これはディレクトリ
                                const dirSha = pathResponse.data[0].sha;
                                treeUrl = `${e.uriBase}/api/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees/${dirSha}?recursive=true`;
                            } else if (pathResponse.data && pathResponse.data.type === 'dir') {
                                // 単一のディレクトリオブジェクト
                                const dirSha = pathResponse.data.sha;
                                treeUrl = `${e.uriBase}/api/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees/${dirSha}?recursive=true`;
                            }
                        } catch (err) {
                            // パス解決に失敗した場合、ルートから再帰的に取得
                            console.error("Path resolution failed:", err);
                        }
                    }

                    const treeResponse = await axiosWithAuth.get(treeUrl);
                    if (treeResponse.data && treeResponse.data.tree) {
                        // GitEAのツリー構造をフラット化
                        allItems = treeResponse.data.tree.map((item: any) => {
                            return {
                                name: item.path.split('/').pop(),
                                path: item.path,
                                type: item.type === 'tree' ? 'tree' : 'blob',
                                mode: item.mode || '100644',
                                sha: item.sha,
                                size: item.size || 0
                            };
                        });

                        // パスでフィルタリング（指定されたパスのサブディレクトリのみを表示）
                        if (path) {
                            const normalizedPath = path.endsWith('/') ? path : path + '/';
                            allItems = allItems.filter(item =>
                                item.path.startsWith(normalizedPath) &&
                                item.path !== normalizedPath
                            );
                        }
                    }
                } else {
                    // 非再帰的な場合は contents API を使用
                    const contentsUrl = `${e.uriBase}/api/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(ref)}`;
                    const contentsResponse = await axiosWithAuth.get(contentsUrl);

                    if (Array.isArray(contentsResponse.data)) {
                        allItems = contentsResponse.data.map((item: any) => {
                            return {
                                name: item.name,
                                path: item.path,
                                type: item.type === 'dir' ? 'tree' : 'blob',
                                mode: item.type === 'dir' ? '040000' : '100644',
                                sha: item.sha,
                                size: item.size || 0
                            };
                        });
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
                let output = `# Repository files for ${owner}/${repo}, path: ${path || '/'}, recursive: ${recursive}\n`;
                output += `# uriBase=${e.uriBase}\n\n`;

                // ls風の表示
                const maxSizeLen = Math.max(...allItems.filter(item => item.type !== 'tree').map(item => (item.size + '').length));
                const formattedItems = allItems.filter(item => item.type !== 'tree').map(item => {
                    const type = item.type === 'tree' ? 'd' : '-';
                    const mode = item.mode || '100644'; // デフォルトパーミッション
                    const formattedMode = formatMode(mode);
                    const fullPath = item.path;
                    return `${type}${formattedMode} ${String(item.size).padStart(maxSizeLen, ' ')} ${fullPath}${item.type === 'tree' ? '/' : ''}`;
                });
                // const formattedItems = allItems.filter(item => item.type !== 'tree').map(item => item.path);

                output += formattedItems.join('\n');
                return output;
            }
        },
        {
            info: { group: provider, isActive: true, isInteractive: true, label: `Issue作成`, },
            definition: {
                type: 'function', function: {
                    name: `gitea_${providerName}_create_issue`,
                    description: `Giteaで新しいIssueを作成`,
                    parameters: {
                        type: 'object',
                        properties: {
                            owner: { type: 'string', description: 'リポジトリのオーナー（ユーザー名）' },
                            repo: { type: 'string', description: 'リポジトリ名' },
                            title: { type: 'string', description: 'Issueのタイトル' },
                            body: { type: 'string', description: 'Issueの説明', default: '' },
                            assignee: { type: 'string', description: '担当者のユーザー名' },
                            labels: { type: 'array', items: { type: 'number' }, description: 'ラベルIDの配列', default: [] },
                            milestone: { type: 'number', description: 'マイルストーンID' }
                        },
                        required: ['owner', 'repo', 'title']
                    }
                }
            },
            handler: async (args: { owner: string, repo: string, title: string, body?: string, assignee?: string, labels?: number[], milestone?: number }): Promise<any> => {
                const { e, axiosWithAuth } = await getOAuthAccountForTool(req, provider);
                const { owner, repo, title, body = '', assignee, labels = [], milestone } = args;

                const issueData: any = {
                    title: title,
                    body: body,
                    labels: labels
                };

                if (assignee) issueData.assignee = assignee;
                if (milestone) issueData.milestone = milestone;

                const url = `${e.uriBase}/api/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues`;
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
                    name: `gitea_${providerName}_update_issue`,
                    description: `Giteaの既存Issueを更新`,
                    parameters: {
                        type: 'object',
                        properties: {
                            owner: { type: 'string', description: 'リポジトリのオーナー（ユーザー名）' },
                            repo: { type: 'string', description: 'リポジトリ名' },
                            index: { type: 'number', description: 'Issue番号' },
                            title: { type: 'string', description: '新しいタイトル' },
                            body: { type: 'string', description: '新しい説明' },
                            assignee: { type: 'string', description: '担当者のユーザー名' },
                            state: { type: 'string', description: 'ステート', enum: ['open', 'closed'] }
                        },
                        required: ['owner', 'repo', 'index']
                    }
                }
            },
            handler: async (args: { owner: string, repo: string, index: number, title?: string, body?: string, assignee?: string, state?: string }): Promise<any> => {
                const { e, axiosWithAuth } = await getOAuthAccountForTool(req, provider);
                const { owner, repo, index, title, body, assignee, state } = args;

                const updateData: any = {};
                if (title) updateData.title = title;
                if (body) updateData.body = body;
                if (assignee) updateData.assignee = assignee;
                if (state) updateData.state = state;

                const url = `${e.uriBase}/api/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${index}`;
                const result = (await axiosWithAuth.patch(url, updateData)).data;

                reform(result);
                result.uriBase = e.uriBase;
                return result;
            }
        },
        {
            info: { group: provider, isActive: true, isInteractive: true, label: `プルリクエスト作成`, },
            definition: {
                type: 'function', function: {
                    name: `gitea_${providerName}_create_pull_request`,
                    description: `Giteaで新しいプルリクエストを作成`,
                    parameters: {
                        type: 'object',
                        properties: {
                            owner: { type: 'string', description: 'リポジトリのオーナー（ユーザー名）' },
                            repo: { type: 'string', description: 'リポジトリ名' },
                            head: { type: 'string', description: 'ソースブランチ名' },
                            base: { type: 'string', description: 'ターゲットブランチ名' },
                            title: { type: 'string', description: 'プルリクエストのタイトル' },
                            body: { type: 'string', description: 'プルリクエストの説明', default: '' },
                            assignee: { type: 'string', description: '担当者のユーザー名' }
                        },
                        required: ['owner', 'repo', 'head', 'base', 'title']
                    }
                }
            },
            handler: async (args: { owner: string, repo: string, head: string, base: string, title: string, body?: string, assignee?: string }): Promise<any> => {
                const { e, axiosWithAuth } = await getOAuthAccountForTool(req, provider);
                const { owner, repo, head, base, title, body = '', assignee } = args;

                const prData: any = {
                    head: head,
                    base: base,
                    title: title,
                    body: body
                };

                if (assignee) prData.assignee = assignee;

                const url = `${e.uriBase}/api/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls`;
                const result = (await axiosWithAuth.post(url, prData)).data;

                reform(result);
                result.uriBase = e.uriBase;
                return result;
            }
        },
        {
            info: { group: provider, isActive: true, isInteractive: true, label: `ファイル作成・更新`, },
            definition: {
                type: 'function', function: {
                    name: `gitea_${providerName}_create_or_update_file`,
                    description: `Giteaリポジトリでファイルを作成または更新`,
                    parameters: {
                        type: 'object',
                        properties: {
                            owner: { type: 'string', description: 'リポジトリのオーナー（ユーザー名）' },
                            repo: { type: 'string', description: 'リポジトリ名' },
                            filepath: { type: 'string', description: 'ファイルパス' },
                            content: { type: 'string', description: 'ファイル内容（Base64エンコード）' },
                            message: { type: 'string', description: 'コミットメッセージ' },
                            branch: { type: 'string', description: 'ブランチ名', default: 'main' },
                            author_email: { type: 'string', description: '作成者のメールアドレス' },
                            author_name: { type: 'string', description: '作成者の名前' },
                            sha: { type: 'string', description: '既存ファイルのSHA（更新時に必要）' }
                        },
                        required: ['owner', 'repo', 'filepath', 'content', 'message']
                    }
                }
            },
            handler: async (args: { owner: string, repo: string, filepath: string, content: string, message: string, branch?: string, author_email?: string, author_name?: string, sha?: string }): Promise<any> => {
                const { e, axiosWithAuth } = await getOAuthAccountForTool(req, provider);
                const { owner, repo, filepath, content, message, branch = 'main', author_email, author_name, sha } = args;

                const fileData: any = {
                    content: Buffer.from(content).toString('base64'),
                    message: message,
                    branch: branch
                };

                if (author_email) fileData.author = { email: author_email };
                if (author_name) {
                    if (!fileData.author) fileData.author = {};
                    fileData.author.name = author_name;
                }
                if (sha) fileData.sha = sha;

                const url = `${e.uriBase}/api/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodeURIComponent(filepath)}`;
                const method = sha ? 'put' : 'post';
                const result = (await axiosWithAuth[method](url, fileData)).data;

                reform(result);
                result.uriBase = e.uriBase;
                return result;
            }
        },
        {
            info: { group: provider, isActive: true, isInteractive: true, label: `ファイル削除`, },
            definition: {
                type: 'function', function: {
                    name: `gitea_${providerName}_delete_file`,
                    description: `Giteaリポジトリからファイルを削除`,
                    parameters: {
                        type: 'object',
                        properties: {
                            owner: { type: 'string', description: 'リポジトリのオーナー（ユーザー名）' },
                            repo: { type: 'string', description: 'リポジトリ名' },
                            filepath: { type: 'string', description: 'ファイルパス' },
                            message: { type: 'string', description: 'コミットメッセージ' },
                            sha: { type: 'string', description: '削除するファイルのSHA' },
                            branch: { type: 'string', description: 'ブランチ名', default: 'main' },
                            author_email: { type: 'string', description: '作成者のメールアドレス' },
                            author_name: { type: 'string', description: '作成者の名前' }
                        },
                        required: ['owner', 'repo', 'filepath', 'message', 'sha']
                    }
                }
            },
            handler: async (args: { owner: string, repo: string, filepath: string, message: string, sha: string, branch?: string, author_email?: string, author_name?: string }): Promise<any> => {
                const { e, axiosWithAuth } = await getOAuthAccountForTool(req, provider);
                const { owner, repo, filepath, message, sha, branch = 'main', author_email, author_name } = args;

                const deleteData: any = {
                    message: message,
                    sha: sha,
                    branch: branch
                };

                if (author_email) deleteData.author = { email: author_email };
                if (author_name) {
                    if (!deleteData.author) deleteData.author = {};
                    deleteData.author.name = author_name;
                }

                const url = `${e.uriBase}/api/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodeURIComponent(filepath)}`;
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
                    name: `gitea_${providerName}_create_branch`,
                    description: `Giteaリポジトリで新しいブランチを作成`,
                    parameters: {
                        type: 'object',
                        properties: {
                            owner: { type: 'string', description: 'リポジトリのオーナー（ユーザー名）' },
                            repo: { type: 'string', description: 'リポジトリ名' },
                            new_branch_name: { type: 'string', description: '新しいブランチ名' },
                            old_branch_name: { type: 'string', description: 'ベースとなるブランチ名', default: 'main' }
                        },
                        required: ['owner', 'repo', 'new_branch_name']
                    }
                }
            },
            handler: async (args: { owner: string, repo: string, new_branch_name: string, old_branch_name?: string }): Promise<any> => {
                const { e, axiosWithAuth } = await getOAuthAccountForTool(req, provider);
                const { owner, repo, new_branch_name, old_branch_name = 'main' } = args;

                const branchData = {
                    new_branch_name: new_branch_name,
                    old_branch_name: old_branch_name
                };

                const url = `${e.uriBase}/api/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/branches`;
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
                    name: `gitea_${providerName}_delete_branch`,
                    description: `Giteaリポジトリのブランチを削除`,
                    parameters: {
                        type: 'object',
                        properties: {
                            owner: { type: 'string', description: 'リポジトリのオーナー（ユーザー名）' },
                            repo: { type: 'string', description: 'リポジトリ名' },
                            branch: { type: 'string', description: '削除するブランチ名' }
                        },
                        required: ['owner', 'repo', 'branch']
                    }
                }
            },
            handler: async (args: { owner: string, repo: string, branch: string }): Promise<any> => {
                const { e, axiosWithAuth } = await getOAuthAccountForTool(req, provider);
                const { owner, repo, branch } = args;

                const url = `${e.uriBase}/api/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/branches/${encodeURIComponent(branch)}`;
                const result = (await axiosWithAuth.delete(url)).data;

                reform(result);
                result.uriBase = e.uriBase;
                return result;
            }
        },
        {
            info: { group: provider, isActive: true, isInteractive: true, label: `リポジトリ作成`, },
            definition: {
                type: 'function', function: {
                    name: `gitea_${providerName}_create_repo`,
                    description: `Giteaで新しいリポジトリを作成`,
                    parameters: {
                        type: 'object',
                        properties: {
                            name: { type: 'string', description: 'リポジトリ名' },
                            description: { type: 'string', description: 'リポジトリの説明', default: '' },
                            private: { type: 'boolean', description: 'プライベートリポジトリ', default: false },
                            auto_init: { type: 'boolean', description: 'README.mdを自動作成', default: true },
                            gitignores: { type: 'string', description: '.gitignoreテンプレート', default: '' },
                            license: { type: 'string', description: 'ライセンステンプレート', default: '' }
                        },
                        required: ['name']
                    }
                }
            },
            handler: async (args: { name: string, description?: string, private?: boolean, auto_init?: boolean, gitignores?: string, license?: string }): Promise<any> => {
                const { e, axiosWithAuth } = await getOAuthAccountForTool(req, provider);
                const { name, description = '', private: isPrivate = false, auto_init = true, gitignores = '', license = '' } = args;

                const repoData: any = {
                    name: name,
                    description: description,
                    private: isPrivate,
                    auto_init: auto_init
                };

                if (gitignores) repoData.gitignores = gitignores;
                if (license) repoData.license = license;

                const url = `${e.uriBase}/api/v1/user/repos`;
                const result = (await axiosWithAuth.post(url, repoData)).data;

                reform(result);
                result.uriBase = e.uriBase;
                return result;
            }
        },
        {
            info: { group: provider, isActive: true, isInteractive: false, label: `リポジトリフォーク`, },
            definition: {
                type: 'function', function: {
                    name: `gitea_${providerName}_fork_repo`,
                    description: `Giteaリポジトリをフォーク`,
                    parameters: {
                        type: 'object',
                        properties: {
                            owner: { type: 'string', description: 'フォーク元のリポジトリオーナー（ユーザー名）' },
                            repo: { type: 'string', description: 'フォーク元のリポジトリ名' },
                            organization: { type: 'string', description: 'フォーク先の組織名（指定しない場合は自分のアカウントにフォーク）' }
                        },
                        required: ['owner', 'repo']
                    }
                }
            },
            handler: async (args: { owner: string, repo: string, organization?: string }): Promise<any> => {
                const { e, axiosWithAuth } = await getOAuthAccountForTool(req, provider);
                const { owner, repo, organization } = args;

                const forkData: any = {};
                if (organization) forkData.organization = organization;

                const url = `${e.uriBase}/api/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/forks`;
                const result = (await axiosWithAuth.post(url, forkData)).data;

                reform(result);
                result.uriBase = e.uriBase;
                return result;
            }
        },
        {
            info: { group: provider, isActive: true, isInteractive: false, label: `アクション一覧取得`, },
            definition: {
                type: 'function', function: {
                    name: `gitea_${providerName}_repository_actions`,
                    description: `Giteaリポジトリのアクション（ワークフロー）実行一覧を取得`,
                    parameters: {
                        type: 'object',
                        properties: {
                            owner: { type: 'string', description: 'リポジトリのオーナー（ユーザー名）' },
                            repo: { type: 'string', description: 'リポジトリ名' },
                            status: { type: 'string', description: 'アクションのステータス', enum: ['waiting', 'running', 'success', 'failure', 'cancelled', 'skipped'] },
                            limit: { type: 'number', description: '取得する最大数。1以上50以下', default: 10, minimum: 1, maximum: 50 },
                            page: { type: 'number', description: 'ページ番号', default: 1, minimum: 1 }
                        },
                        required: ['owner', 'repo']
                    }
                }
            },
            handler: async (args: { owner: string, repo: string, status?: string, limit?: number, page?: number }): Promise<any> => {
                const { e, axiosWithAuth } = await getOAuthAccountForTool(req, provider);
                let { owner, repo, status, limit = 10, page = 1 } = args;
                limit = Math.max(Math.min(limit, 50), 1);
                page = Math.max(page, 1);

                const queryParams = new URLSearchParams();
                queryParams.append('limit', limit.toString());
                queryParams.append('page', page.toString());
                if (status) queryParams.append('status', status);

                const url = `${e.uriBase}/api/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/runs?${queryParams.toString()}`;
                const result = (await axiosWithAuth.get(url)).data;

                reform(result);
                result.uriBase = e.uriBase;
                return result;
            }
        },
        {
            info: { group: provider, isActive: true, isInteractive: false, label: `アクション詳細取得`, },
            definition: {
                type: 'function', function: {
                    name: `gitea_${providerName}_action_detail`,
                    description: `Giteaアクションの詳細情報を取得`,
                    parameters: {
                        type: 'object',
                        properties: {
                            owner: { type: 'string', description: 'リポジトリのオーナー（ユーザー名）' },
                            repo: { type: 'string', description: 'リポジトリ名' },
                            run_id: { type: 'number', description: 'アクション実行ID' }
                        },
                        required: ['owner', 'repo', 'run_id']
                    }
                }
            },
            handler: async (args: { owner: string, repo: string, run_id: number }): Promise<any> => {
                const { e, axiosWithAuth } = await getOAuthAccountForTool(req, provider);
                const { owner, repo, run_id } = args;

                const url = `${e.uriBase}/api/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/runs/${run_id}`;
                const result = (await axiosWithAuth.get(url)).data;

                reform(result);
                result.uriBase = e.uriBase;
                return result;
            }
        },
        {
            info: { group: provider, isActive: true, isInteractive: false, label: `アクションジョブ一覧`, },
            definition: {
                type: 'function', function: {
                    name: `gitea_${providerName}_action_jobs`,
                    description: `Giteaアクションのジョブ一覧を取得`,
                    parameters: {
                        type: 'object',
                        properties: {
                            owner: { type: 'string', description: 'リポジトリのオーナー（ユーザー名）' },
                            repo: { type: 'string', description: 'リポジトリ名' },
                            run_id: { type: 'number', description: 'アクション実行ID' }
                        },
                        required: ['owner', 'repo', 'run_id']
                    }
                }
            },
            handler: async (args: { owner: string, repo: string, run_id: number }): Promise<any> => {
                const { e, axiosWithAuth } = await getOAuthAccountForTool(req, provider);
                const { owner, repo, run_id } = args;

                const url = `${e.uriBase}/api/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/runs/${run_id}/jobs`;
                const result = (await axiosWithAuth.get(url)).data;

                reform(result);
                result.uriBase = e.uriBase;
                return result;
            }
        },
        {
            info: { group: provider, isActive: true, isInteractive: false, label: `アクション再実行`, },
            definition: {
                type: 'function', function: {
                    name: `gitea_${providerName}_rerun_action`,
                    description: `Giteaアクションを再実行`,
                    parameters: {
                        type: 'object',
                        properties: {
                            owner: { type: 'string', description: 'リポジトリのオーナー（ユーザー名）' },
                            repo: { type: 'string', description: 'リポジトリ名' },
                            run_id: { type: 'number', description: 'アクション実行ID' }
                        },
                        required: ['owner', 'repo', 'run_id']
                    }
                }
            },
            handler: async (args: { owner: string, repo: string, run_id: number }): Promise<any> => {
                const { e, axiosWithAuth } = await getOAuthAccountForTool(req, provider);
                const { owner, repo, run_id } = args;

                const url = `${e.uriBase}/api/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/runs/${run_id}/rerun`;
                const result = (await axiosWithAuth.post(url, {})).data;

                reform(result);
                result.uriBase = e.uriBase;
                return result;
            }
        },
        {
            info: { group: provider, isActive: true, isInteractive: false, label: `アクションキャンセル`, },
            definition: {
                type: 'function', function: {
                    name: `gitea_${providerName}_cancel_action`,
                    description: `Giteaアクションをキャンセル`,
                    parameters: {
                        type: 'object',
                        properties: {
                            owner: { type: 'string', description: 'リポジトリのオーナー（ユーザー名）' },
                            repo: { type: 'string', description: 'リポジトリ名' },
                            run_id: { type: 'number', description: 'アクション実行ID' }
                        },
                        required: ['owner', 'repo', 'run_id']
                    }
                }
            },
            handler: async (args: { owner: string, repo: string, run_id: number }): Promise<any> => {
                const { e, axiosWithAuth } = await getOAuthAccountForTool(req, provider);
                const { owner, repo, run_id } = args;

                const url = `${e.uriBase}/api/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/runs/${run_id}/cancel`;
                const result = (await axiosWithAuth.post(url, {})).data;

                reform(result);
                result.uriBase = e.uriBase;
                return result;
            }
        },
        {
            info: { group: provider, isActive: true, isInteractive: false, label: `ワークフロー一覧`, },
            definition: {
                type: 'function', function: {
                    name: `gitea_${providerName}_workflows`,
                    description: `Giteaリポジトリのワークフロー一覧を取得`,
                    parameters: {
                        type: 'object',
                        properties: {
                            owner: { type: 'string', description: 'リポジトリのオーナー（ユーザー名）' },
                            repo: { type: 'string', description: 'リポジトリ名' }
                        },
                        required: ['owner', 'repo']
                    }
                }
            },
            handler: async (args: { owner: string, repo: string }): Promise<any> => {
                const { e, axiosWithAuth } = await getOAuthAccountForTool(req, provider);
                const { owner, repo } = args;

                const url = `${e.uriBase}/api/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/workflows`;
                const result = (await axiosWithAuth.get(url)).data;

                reform(result);
                result.uriBase = e.uriBase;
                return result;
            }
        },
        {
            info: { group: provider, isActive: true, isInteractive: false, label: `ワークフロー実行`, },
            definition: {
                type: 'function', function: {
                    name: `gitea_${providerName}_trigger_workflow`,
                    description: `Giteaワークフローを手動実行`,
                    parameters: {
                        type: 'object',
                        properties: {
                            owner: { type: 'string', description: 'リポジトリのオーナー（ユーザー名）' },
                            repo: { type: 'string', description: 'リポジトリ名' },
                            workflow_id: { type: 'string', description: 'ワークフローIDまたはファイル名' },
                            ref: { type: 'string', description: 'ブランチ名、タグ名、またはコミットSHA', default: 'main' },
                            inputs: { type: 'object', description: 'ワークフロー入力変数（キー:値のオブジェクト）', additionalProperties: { type: 'string' } }
                        },
                        required: ['owner', 'repo', 'workflow_id']
                    }
                }
            },
            handler: async (args: { owner: string, repo: string, workflow_id: string, ref?: string, inputs?: Record<string, string> }): Promise<any> => {
                const { e, axiosWithAuth } = await getOAuthAccountForTool(req, provider);
                const { owner, repo, workflow_id, ref = 'main', inputs } = args;

                const workflowData: any = { ref };
                if (inputs) workflowData.inputs = inputs;

                const url = `${e.uriBase}/api/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/workflows/${encodeURIComponent(workflow_id)}/dispatches`;
                const result = (await axiosWithAuth.post(url, workflowData)).data;

                reform(result);
                result.uriBase = e.uriBase;
                return result;
            }
        },
        {
            info: { group: provider, isActive: true, isInteractive: false, label: `プルリクエストレビュー追加`, },
            definition: {
                type: 'function', function: {
                    name: `gitea_${providerName}_add_pull_review`,
                    description: `Giteaプルリクエストにレビューを追加`,
                    parameters: {
                        type: 'object',
                        properties: {
                            owner: { type: 'string', description: 'リポジトリのオーナー（ユーザー名）' },
                            repo: { type: 'string', description: 'リポジトリ名' },
                            index: { type: 'number', description: 'プルリクエスト番号' },
                            body: { type: 'string', description: 'レビューコメント', default: '' },
                            event: { type: 'string', description: 'レビューイベント', enum: ['APPROVE', 'REQUEST_CHANGES', 'COMMENT'], default: 'COMMENT' },
                            comments: {
                                type: 'array',
                                items: {
                                    type: 'object',
                                    properties: {
                                        path: { type: 'string', description: 'ファイルパス' },
                                        line: { type: 'number', description: '行番号' },
                                        body: { type: 'string', description: 'コメント内容' }
                                    },
                                    required: ['path', 'line', 'body']
                                },
                                description: 'ライン別コメント配列',
                                default: []
                            }
                        },
                        required: ['owner', 'repo', 'index']
                    }
                }
            },
            handler: async (args: { owner: string, repo: string, index: number, body?: string, event?: string, comments?: Array<{ path: string, line: number, body: string }> }): Promise<any> => {
                const { e, axiosWithAuth } = await getOAuthAccountForTool(req, provider);
                const { owner, repo, index, body = '', event = 'COMMENT', comments = [] } = args;

                const reviewData: any = {
                    body: body,
                    event: event
                };

                if (comments && comments.length > 0) {
                    reviewData.comments = comments;
                }

                const url = `${e.uriBase}/api/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${index}/reviews`;
                const result = (await axiosWithAuth.post(url, reviewData)).data;

                reform(result);
                result.uriBase = e.uriBase;
                return result;
            }
        },
        {
            info: { group: provider, isActive: true, isInteractive: false, label: `プルリクエストレビュー一覧`, },
            definition: {
                type: 'function', function: {
                    name: `gitea_${providerName}_pull_reviews`,
                    description: `Giteaプルリクエストのレビュー一覧を取得`,
                    parameters: {
                        type: 'object',
                        properties: {
                            owner: { type: 'string', description: 'リポジトリのオーナー（ユーザー名）' },
                            repo: { type: 'string', description: 'リポジトリ名' },
                            index: { type: 'number', description: 'プルリクエスト番号' }
                        },
                        required: ['owner', 'repo', 'index']
                    }
                }
            },
            handler: async (args: { owner: string, repo: string, index: number }): Promise<any> => {
                const { e, axiosWithAuth } = await getOAuthAccountForTool(req, provider);
                const { owner, repo, index } = args;

                const url = `${e.uriBase}/api/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${index}/reviews`;
                const result = (await axiosWithAuth.get(url)).data;

                reform(result);
                result.uriBase = e.uriBase;
                return result;
            }
        },
        {
            info: { group: provider, isActive: true, isInteractive: false, label: `プルリクエストコメント追加`, },
            definition: {
                type: 'function', function: {
                    name: `gitea_${providerName}_add_pull_comment`,
                    description: `Giteaプルリクエストにコメントを追加`,
                    parameters: {
                        type: 'object',
                        properties: {
                            owner: { type: 'string', description: 'リポジトリのオーナー（ユーザー名）' },
                            repo: { type: 'string', description: 'リポジトリ名' },
                            index: { type: 'number', description: 'プルリクエスト番号' },
                            body: { type: 'string', description: 'コメント内容' }
                        },
                        required: ['owner', 'repo', 'index', 'body']
                    }
                }
            },
            handler: async (args: { owner: string, repo: string, index: number, body: string }): Promise<any> => {
                const { e, axiosWithAuth } = await getOAuthAccountForTool(req, provider);
                const { owner, repo, index, body } = args;

                const commentData = { body };

                const url = `${e.uriBase}/api/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${index}/comments`;
                const result = (await axiosWithAuth.post(url, commentData)).data;

                reform(result);
                result.uriBase = e.uriBase;
                return result;
            }
        },
        {
            info: { group: provider, isActive: true, isInteractive: false, label: `プルリクエストコメント一覧`, },
            definition: {
                type: 'function', function: {
                    name: `gitea_${providerName}_pull_comments`,
                    description: `Giteaプルリクエストのコメント一覧を取得`,
                    parameters: {
                        type: 'object',
                        properties: {
                            owner: { type: 'string', description: 'リポジトリのオーナー（ユーザー名）' },
                            repo: { type: 'string', description: 'リポジトリ名' },
                            index: { type: 'number', description: 'プルリクエスト番号' },
                            since: { type: 'string', description: '指定日時以降のコメントのみ取得（RFC3339形式）' },
                            before: { type: 'string', description: '指定日時以前のコメントのみ取得（RFC3339形式）' }
                        },
                        required: ['owner', 'repo', 'index']
                    }
                }
            },
            handler: async (args: { owner: string, repo: string, index: number, since?: string, before?: string }): Promise<any> => {
                const { e, axiosWithAuth } = await getOAuthAccountForTool(req, provider);
                const { owner, repo, index, since, before } = args;

                const queryParams = new URLSearchParams();
                if (since) queryParams.append('since', since);
                if (before) queryParams.append('before', before);

                const url = `${e.uriBase}/api/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${index}/comments?${queryParams.toString()}`;
                const result = (await axiosWithAuth.get(url)).data;

                reform(result);
                result.uriBase = e.uriBase;
                return result;
            }
        },
        {
            info: { group: provider, isActive: true, isInteractive: false, label: `プルリクエストマージ`, },
            definition: {
                type: 'function', function: {
                    name: `gitea_${providerName}_merge_pull_request`,
                    description: `Giteaプルリクエストをマージ`,
                    parameters: {
                        type: 'object',
                        properties: {
                            owner: { type: 'string', description: 'リポジトリのオーナー（ユーザー名）' },
                            repo: { type: 'string', description: 'リポジトリ名' },
                            index: { type: 'number', description: 'プルリクエスト番号' },
                            Do: { type: 'string', description: 'マージ方法', enum: ['merge', 'rebase', 'rebase-merge', 'squash'], default: 'merge' },
                            MergeTitleField: { type: 'string', description: 'マージコミットのタイトル' },
                            MergeMessageField: { type: 'string', description: 'マージコミットのメッセージ' },
                            delete_branch_after_merge: { type: 'boolean', description: 'マージ後にブランチを削除するか', default: false }
                        },
                        required: ['owner', 'repo', 'index']
                    }
                }
            },
            handler: async (args: { owner: string, repo: string, index: number, Do?: string, MergeTitleField?: string, MergeMessageField?: string, delete_branch_after_merge?: boolean }): Promise<any> => {
                const { e, axiosWithAuth } = await getOAuthAccountForTool(req, provider);
                const { owner, repo, index, Do = 'merge', MergeTitleField, MergeMessageField, delete_branch_after_merge = false } = args;

                const mergeData: any = {
                    Do: Do,
                    delete_branch_after_merge: delete_branch_after_merge
                };

                if (MergeTitleField) mergeData.MergeTitleField = MergeTitleField;
                if (MergeMessageField) mergeData.MergeMessageField = MergeMessageField;

                const url = `${e.uriBase}/api/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${index}/merge`;
                const result = (await axiosWithAuth.post(url, mergeData)).data;

                reform(result);
                result.uriBase = e.uriBase;
                return result;
            }
        },
        {
            info: { group: provider, isActive: true, isInteractive: false, label: `プルリクエスト変更内容取得`, },
            definition: {
                type: 'function', function: {
                    name: `gitea_${providerName}_pull_request_diff`,
                    description: `Giteaプルリクエストの変更内容（diff）を取得`,
                    parameters: {
                        type: 'object',
                        properties: {
                            owner: { type: 'string', description: 'リポジトリのオーナー（ユーザー名）' },
                            repo: { type: 'string', description: 'リポジトリ名' },
                            index: { type: 'number', description: 'プルリクエスト番号' },
                            diffType: { type: 'string', description: 'diffの形式', enum: ['diff', 'patch'], default: 'diff' }
                        },
                        required: ['owner', 'repo', 'index']
                    }
                }
            },
            handler: async (args: { owner: string, repo: string, index: number, diffType?: string }): Promise<any> => {
                const { e, axiosWithAuth } = await getOAuthAccountForTool(req, provider);
                const { owner, repo, index, diffType = 'diff' } = args;

                const url = `${e.uriBase}/api/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${index}.${diffType}`;
                const result = (await axiosWithAuth.get(url, { responseType: 'text' })).data;

                return `\`\`\`diff\n${result}\n\`\`\``;
            }
        },
        {
            info: { group: provider, isActive: true, isInteractive: false, label: `Issueコメント追加`, },
            definition: {
                type: 'function', function: {
                    name: `gitea_${providerName}_add_issue_comment`,
                    description: `GiteaIssueにコメントを追加`,
                    parameters: {
                        type: 'object',
                        properties: {
                            owner: { type: 'string', description: 'リポジトリのオーナー（ユーザー名）' },
                            repo: { type: 'string', description: 'リポジトリ名' },
                            index: { type: 'number', description: 'Issue番号' },
                            body: { type: 'string', description: 'コメント内容' }
                        },
                        required: ['owner', 'repo', 'index', 'body']
                    }
                }
            },
            handler: async (args: { owner: string, repo: string, index: number, body: string }): Promise<any> => {
                const { e, axiosWithAuth } = await getOAuthAccountForTool(req, provider);
                const { owner, repo, index, body } = args;

                const commentData = { body };

                const url = `${e.uriBase}/api/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${index}/comments`;
                const result = (await axiosWithAuth.post(url, commentData)).data;

                reform(result);
                result.uriBase = e.uriBase;
                return result;
            }
        },
        {
            info: { group: provider, isActive: true, isInteractive: false, label: `Issueコメント一覧`, },
            definition: {
                type: 'function', function: {
                    name: `gitea_${providerName}_issue_comments`,
                    description: `GiteaIssueのコメント一覧を取得`,
                    parameters: {
                        type: 'object',
                        properties: {
                            owner: { type: 'string', description: 'リポジトリのオーナー（ユーザー名）' },
                            repo: { type: 'string', description: 'リポジトリ名' },
                            index: { type: 'number', description: 'Issue番号' },
                            since: { type: 'string', description: '指定日時以降のコメントのみ取得（RFC3339形式）' },
                            before: { type: 'string', description: '指定日時以前のコメントのみ取得（RFC3339形式）' }
                        },
                        required: ['owner', 'repo', 'index']
                    }
                }
            },
            handler: async (args: { owner: string, repo: string, index: number, since?: string, before?: string }): Promise<any> => {
                const { e, axiosWithAuth } = await getOAuthAccountForTool(req, provider);
                const { owner, repo, index, since, before } = args;

                const queryParams = new URLSearchParams();
                if (since) queryParams.append('since', since);
                if (before) queryParams.append('before', before);

                const url = `${e.uriBase}/api/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${index}/comments?${queryParams.toString()}`;
                const result = (await axiosWithAuth.get(url)).data;

                reform(result);
                result.uriBase = e.uriBase;
                return result;
            }
        },
        {
            info: { group: provider, isActive: true, isInteractive: false, label: `Issue担当者追加`, },
            definition: {
                type: 'function', function: {
                    name: `gitea_${providerName}_add_issue_assignee`,
                    description: `GiteaIssueに担当者を追加`,
                    parameters: {
                        type: 'object',
                        properties: {
                            owner: { type: 'string', description: 'リポジトリのオーナー（ユーザー名）' },
                            repo: { type: 'string', description: 'リポジトリ名' },
                            index: { type: 'number', description: 'Issue番号' },
                            assignees: { type: 'array', items: { type: 'string' }, description: '担当者のユーザー名配列' }
                        },
                        required: ['owner', 'repo', 'index', 'assignees']
                    }
                }
            },
            handler: async (args: { owner: string, repo: string, index: number, assignees: string[] }): Promise<any> => {
                const { e, axiosWithAuth } = await getOAuthAccountForTool(req, provider);
                const { owner, repo, index, assignees } = args;

                const assigneeData = { assignees };

                const url = `${e.uriBase}/api/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${index}/assignees`;
                const result = (await axiosWithAuth.post(url, assigneeData)).data;

                reform(result);
                result.uriBase = e.uriBase;
                return result;
            }
        },
        {
            info: { group: provider, isActive: true, isInteractive: false, label: `Issue担当者削除`, },
            definition: {
                type: 'function', function: {
                    name: `gitea_${providerName}_remove_issue_assignee`,
                    description: `GiteaIssueから担当者を削除`,
                    parameters: {
                        type: 'object',
                        properties: {
                            owner: { type: 'string', description: 'リポジトリのオーナー（ユーザー名）' },
                            repo: { type: 'string', description: 'リポジトリ名' },
                            index: { type: 'number', description: 'Issue番号' },
                            assignees: { type: 'array', items: { type: 'string' }, description: '削除する担当者のユーザー名配列' }
                        },
                        required: ['owner', 'repo', 'index', 'assignees']
                    }
                }
            },
            handler: async (args: { owner: string, repo: string, index: number, assignees: string[] }): Promise<any> => {
                const { e, axiosWithAuth } = await getOAuthAccountForTool(req, provider);
                const { owner, repo, index, assignees } = args;

                const assigneeData = { assignees };

                const url = `${e.uriBase}/api/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${index}/assignees`;
                const result = (await axiosWithAuth.delete(url, { data: assigneeData })).data;

                reform(result);
                result.uriBase = e.uriBase;
                return result;
            }
        },
        {
            info: { group: provider, isActive: true, isInteractive: false, label: `Issueラベル追加`, },
            definition: {
                type: 'function', function: {
                    name: `gitea_${providerName}_add_issue_labels`,
                    description: `GiteaIssueにラベルを追加`,
                    parameters: {
                        type: 'object',
                        properties: {
                            owner: { type: 'string', description: 'リポジトリのオーナー（ユーザー名）' },
                            repo: { type: 'string', description: 'リポジトリ名' },
                            index: { type: 'number', description: 'Issue番号' },
                            labels: { type: 'array', items: { type: 'number' }, description: 'ラベルIDの配列' }
                        },
                        required: ['owner', 'repo', 'index', 'labels']
                    }
                }
            },
            handler: async (args: { owner: string, repo: string, index: number, labels: number[] }): Promise<any> => {
                const { e, axiosWithAuth } = await getOAuthAccountForTool(req, provider);
                const { owner, repo, index, labels } = args;

                const labelData = { labels };

                const url = `${e.uriBase}/api/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${index}/labels`;
                const result = (await axiosWithAuth.post(url, labelData)).data;

                reform(result);
                result.uriBase = e.uriBase;
                return result;
            }
        },
        {
            info: { group: provider, isActive: true, isInteractive: false, label: `Issueラベル削除`, },
            definition: {
                type: 'function', function: {
                    name: `gitea_${providerName}_remove_issue_labels`,
                    description: `GiteaIssueからラベルを削除`,
                    parameters: {
                        type: 'object',
                        properties: {
                            owner: { type: 'string', description: 'リポジトリのオーナー（ユーザー名）' },
                            repo: { type: 'string', description: 'リポジトリ名' },
                            index: { type: 'number', description: 'Issue番号' },
                            labels: { type: 'array', items: { type: 'number' }, description: '削除するラベルIDの配列' }
                        },
                        required: ['owner', 'repo', 'index', 'labels']
                    }
                }
            },
            handler: async (args: { owner: string, repo: string, index: number, labels: number[] }): Promise<any> => {
                const { e, axiosWithAuth } = await getOAuthAccountForTool(req, provider);
                const { owner, repo, index, labels } = args;

                const labelData = { labels };

                const url = `${e.uriBase}/api/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${index}/labels`;
                const result = (await axiosWithAuth.delete(url, { data: labelData })).data;

                reform(result);
                result.uriBase = e.uriBase;
                return result;
            }
        },
        {
            info: { group: provider, isActive: true, isInteractive: false, label: `リポジトリラベル一覧`, },
            definition: {
                type: 'function', function: {
                    name: `gitea_${providerName}_repository_labels`,
                    description: `Giteaリポジトリのラベル一覧を取得`,
                    parameters: {
                        type: 'object',
                        properties: {
                            owner: { type: 'string', description: 'リポジトリのオーナー（ユーザー名）' },
                            repo: { type: 'string', description: 'リポジトリ名' },
                            page: { type: 'number', description: 'ページ番号', default: 1, minimum: 1 },
                            limit: { type: 'number', description: '取得する最大数。1以上50以下', default: 10, minimum: 1, maximum: 50 }
                        },
                        required: ['owner', 'repo']
                    }
                }
            },
            handler: async (args: { owner: string, repo: string, page?: number, limit?: number }): Promise<any> => {
                const { e, axiosWithAuth } = await getOAuthAccountForTool(req, provider);
                let { owner, repo, page = 1, limit = 10 } = args;
                page = Math.max(page, 1);
                limit = Math.max(Math.min(limit, 50), 1);

                const queryParams = new URLSearchParams();
                queryParams.append('page', page.toString());
                queryParams.append('limit', limit.toString());

                const url = `${e.uriBase}/api/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/labels?${queryParams.toString()}`;
                const result = (await axiosWithAuth.get(url)).data;

                reform(result);
                result.uriBase = e.uriBase;
                return result;
            }
        },
        {
            info: { group: provider, isActive: true, isInteractive: false, label: `リポジトリマイルストーン一覧`, },
            definition: {
                type: 'function', function: {
                    name: `gitea_${providerName}_repository_milestones`,
                    description: `Giteaリポジトリのマイルストーン一覧を取得`,
                    parameters: {
                        type: 'object',
                        properties: {
                            owner: { type: 'string', description: 'リポジトリのオーナー（ユーザー名）' },
                            repo: { type: 'string', description: 'リポジトリ名' },
                            state: { type: 'string', description: 'マイルストーンの状態', enum: ['open', 'closed', 'all'], default: 'open' },
                            name: { type: 'string', description: '名前での検索' },
                            page: { type: 'number', description: 'ページ番号', default: 1, minimum: 1 },
                            limit: { type: 'number', description: '取得する最大数。1以上50以下', default: 10, minimum: 1, maximum: 50 }
                        },
                        required: ['owner', 'repo']
                    }
                }
            },
            handler: async (args: { owner: string, repo: string, state?: string, name?: string, page?: number, limit?: number }): Promise<any> => {
                const { e, axiosWithAuth } = await getOAuthAccountForTool(req, provider);
                let { owner, repo, state = 'open', name, page = 1, limit = 10 } = args;
                page = Math.max(page, 1);
                limit = Math.max(Math.min(limit, 50), 1);

                const queryParams = new URLSearchParams();
                queryParams.append('state', state);
                queryParams.append('page', page.toString());
                queryParams.append('limit', limit.toString());
                if (name) queryParams.append('name', name);

                const url = `${e.uriBase}/api/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/milestones?${queryParams.toString()}`;
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
                    name: `gitea_${providerName}_create_webhook`,
                    description: `GiteaリポジトリにWebhookを作成`,
                    parameters: {
                        type: 'object',
                        properties: {
                            owner: { type: 'string', description: 'リポジトリのオーナー（ユーザー名）' },
                            repo: { type: 'string', description: 'リポジトリ名' },
                            type: { type: 'string', description: 'Webhookのタイプ', enum: ['gitea', 'gogs', 'slack', 'discord', 'dingtalk', 'telegram', 'msteams', 'feishu', 'wechatwork', 'packagist'], default: 'gitea' },
                            config: {
                                type: 'object',
                                properties: {
                                    url: { type: 'string', description: 'WebhookのURL' },
                                    content_type: { type: 'string', description: 'コンテンツタイプ', enum: ['json', 'form'], default: 'json' },
                                    secret: { type: 'string', description: 'シークレットキー' }
                                },
                                required: ['url'],
                                description: 'Webhook設定'
                            },
                            events: { type: 'array', items: { type: 'string' }, description: 'イベントタイプ配列', default: ['push'] },
                            active: { type: 'boolean', description: 'アクティブ状態', default: true }
                        },
                        required: ['owner', 'repo', 'config']
                    }
                }
            },
            handler: async (args: { owner: string, repo: string, type?: string, config: { url: string, content_type?: string, secret?: string }, events?: string[], active?: boolean }): Promise<any> => {
                const { e, axiosWithAuth } = await getOAuthAccountForTool(req, provider);
                const { owner, repo, type = 'gitea', config, events = ['push'], active = true } = args;

                const webhookData = {
                    type: type,
                    config: {
                        url: config.url,
                        content_type: config.content_type || 'json',
                        ...(config.secret && { secret: config.secret })
                    },
                    events: events,
                    active: active
                };

                const url = `${e.uriBase}/api/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/hooks`;
                const result = (await axiosWithAuth.post(url, webhookData)).data;

                reform(result);
                result.uriBase = e.uriBase;
                return result;
            }
        },
        {
            info: { group: provider, isActive: true, isInteractive: false, label: `Webhook一覧取得`, },
            definition: {
                type: 'function', function: {
                    name: `gitea_${providerName}_list_webhooks`,
                    description: `GiteaリポジトリのWebhook一覧を取得`,
                    parameters: {
                        type: 'object',
                        properties: {
                            owner: { type: 'string', description: 'リポジトリのオーナー（ユーザー名）' },
                            repo: { type: 'string', description: 'リポジトリ名' }
                        },
                        required: ['owner', 'repo']
                    }
                }
            },
            handler: async (args: { owner: string, repo: string }): Promise<any> => {
                const { e, axiosWithAuth } = await getOAuthAccountForTool(req, provider);
                const { owner, repo } = args;

                const url = `${e.uriBase}/api/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/hooks`;
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
                    name: `gitea_${providerName}_delete_webhook`,
                    description: `GiteaリポジトリのWebhookを削除`,
                    parameters: {
                        type: 'object',
                        properties: {
                            owner: { type: 'string', description: 'リポジトリのオーナー（ユーザー名）' },
                            repo: { type: 'string', description: 'リポジトリ名' },
                            id: { type: 'number', description: 'WebhookのID' }
                        },
                        required: ['owner', 'repo', 'id']
                    }
                }
            },
            handler: async (args: { owner: string, repo: string, id: number }): Promise<any> => {
                const { e, axiosWithAuth } = await getOAuthAccountForTool(req, provider);
                const { owner, repo, id } = args;

                const url = `${e.uriBase}/api/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/hooks/${id}`;
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
                    name: `gitea_${providerName}_protect_branch`,
                    description: `Giteaブランチを保護設定`,
                    parameters: {
                        type: 'object',
                        properties: {
                            owner: { type: 'string', description: 'リポジトリのオーナー（ユーザー名）' },
                            repo: { type: 'string', description: 'リポジトリ名' },
                            branch_name: { type: 'string', description: 'ブランチ名' },
                            enable_push: { type: 'boolean', description: 'プッシュを有効にするか', default: true },
                            enable_push_whitelist: { type: 'boolean', description: 'プッシュホワイトリストを有効にするか', default: false },
                            push_whitelist_usernames: { type: 'array', items: { type: 'string' }, description: 'プッシュを許可するユーザー名配列', default: [] },
                            push_whitelist_teams: { type: 'array', items: { type: 'string' }, description: 'プッシュを許可するチーム名配列', default: [] },
                            enable_merge_whitelist: { type: 'boolean', description: 'マージホワイトリストを有効にするか', default: false },
                            merge_whitelist_usernames: { type: 'array', items: { type: 'string' }, description: 'マージを許可するユーザー名配列', default: [] },
                            merge_whitelist_teams: { type: 'array', items: { type: 'string' }, description: 'マージを許可するチーム名配列', default: [] },
                            enable_status_check: { type: 'boolean', description: 'ステータスチェックを有効にするか', default: false },
                            status_check_contexts: { type: 'array', items: { type: 'string' }, description: 'ステータスチェックコンテキスト配列', default: [] },
                            required_approvals: { type: 'number', description: '必要な承認数', default: 0 },
                            enable_approvals_whitelist: { type: 'boolean', description: '承認ホワイトリストを有効にするか', default: false },
                            approvals_whitelist_usernames: { type: 'array', items: { type: 'string' }, description: '承認を許可するユーザー名配列', default: [] },
                            approvals_whitelist_teams: { type: 'array', items: { type: 'string' }, description: '承認を許可するチーム名配列', default: [] },
                            block_on_rejected_reviews: { type: 'boolean', description: '拒否されたレビューでブロックするか', default: false },
                            dismiss_stale_approvals: { type: 'boolean', description: '古い承認を無効にするか', default: false },
                            require_signed_commits: { type: 'boolean', description: '署名済みコミットを要求するか', default: false }
                        },
                        required: ['owner', 'repo', 'branch_name']
                    }
                }
            },
            handler: async (args: { owner: string, repo: string, branch_name: string, enable_push?: boolean, enable_push_whitelist?: boolean, push_whitelist_usernames?: string[], push_whitelist_teams?: string[], enable_merge_whitelist?: boolean, merge_whitelist_usernames?: string[], merge_whitelist_teams?: string[], enable_status_check?: boolean, status_check_contexts?: string[], required_approvals?: number, enable_approvals_whitelist?: boolean, approvals_whitelist_usernames?: string[], approvals_whitelist_teams?: string[], block_on_rejected_reviews?: boolean, dismiss_stale_approvals?: boolean, require_signed_commits?: boolean }): Promise<any> => {
                const { e, axiosWithAuth } = await getOAuthAccountForTool(req, provider);
                const {
                    owner,
                    repo,
                    branch_name,
                    enable_push = true,
                    enable_push_whitelist = false,
                    push_whitelist_usernames = [],
                    push_whitelist_teams = [],
                    enable_merge_whitelist = false,
                    merge_whitelist_usernames = [],
                    merge_whitelist_teams = [],
                    enable_status_check = false,
                    status_check_contexts = [],
                    required_approvals = 0,
                    enable_approvals_whitelist = false,
                    approvals_whitelist_usernames = [],
                    approvals_whitelist_teams = [],
                    block_on_rejected_reviews = false,
                    dismiss_stale_approvals = false,
                    require_signed_commits = false
                } = args;

                const protectionData = {
                    enable_push,
                    enable_push_whitelist,
                    push_whitelist_usernames,
                    push_whitelist_teams,
                    enable_merge_whitelist,
                    merge_whitelist_usernames,
                    merge_whitelist_teams,
                    enable_status_check,
                    status_check_contexts,
                    required_approvals,
                    enable_approvals_whitelist,
                    approvals_whitelist_usernames,
                    approvals_whitelist_teams,
                    block_on_rejected_reviews,
                    dismiss_stale_approvals,
                    require_signed_commits
                };

                const url = `${e.uriBase}/api/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/branch_protections`;
                const result = (await axiosWithAuth.post(url, { branch_name, ...protectionData })).data;

                reform(result);
                result.uriBase = e.uriBase;
                return result;
            }
        },
        {
            info: { group: provider, isActive: true, isInteractive: false, label: `保護ブランチ一覧`, },
            definition: {
                type: 'function', function: {
                    name: `gitea_${providerName}_list_protected_branches`,
                    description: `Giteaリポジトリの保護ブランチ一覧を取得`,
                    parameters: {
                        type: 'object',
                        properties: {
                            owner: { type: 'string', description: 'リポジトリのオーナー（ユーザー名）' },
                            repo: { type: 'string', description: 'リポジトリ名' }
                        },
                        required: ['owner', 'repo']
                    }
                }
            },
            handler: async (args: { owner: string, repo: string }): Promise<any> => {
                const { e, axiosWithAuth } = await getOAuthAccountForTool(req, provider);
                const { owner, repo } = args;

                const url = `${e.uriBase}/api/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/branch_protections`;
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
                    name: `gitea_${providerName}_unprotect_branch`,
                    description: `Giteaブランチの保護を解除`,
                    parameters: {
                        type: 'object',
                        properties: {
                            owner: { type: 'string', description: 'リポジトリのオーナー（ユーザー名）' },
                            repo: { type: 'string', description: 'リポジトリ名' },
                            name: { type: 'string', description: 'ブランチ名' }
                        },
                        required: ['owner', 'repo', 'name']
                    }
                }
            },
            handler: async (args: { owner: string, repo: string, name: string }): Promise<any> => {
                const { e, axiosWithAuth } = await getOAuthAccountForTool(req, provider);
                const { owner, repo, name } = args;

                const url = `${e.uriBase}/api/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/branch_protections/${encodeURIComponent(name)}`;
                const result = (await axiosWithAuth.delete(url)).data;

                reform(result);
                result.uriBase = e.uriBase;
                return result;
            }
        },
        {
            info: { group: provider, isActive: true, isInteractive: false, label: `リポジトリ設定更新`, },
            definition: {
                type: 'function', function: {
                    name: `gitea_${providerName}_update_repository_settings`,
                    description: `Giteaリポジトリの設定を更新`,
                    parameters: {
                        type: 'object',
                        properties: {
                            owner: { type: 'string', description: 'リポジトリのオーナー（ユーザー名）' },
                            repo: { type: 'string', description: 'リポジトリ名' },
                            name: { type: 'string', description: 'リポジトリ名' },
                            description: { type: 'string', description: 'リポジトリの説明' },
                            website: { type: 'string', description: 'ウェブサイトURL' },
                            private: { type: 'boolean', description: 'プライベートリポジトリか' },
                            has_issues: { type: 'boolean', description: 'Issueを有効にするか' },
                            has_wiki: { type: 'boolean', description: 'Wikiを有効にするか' },
                            has_pull_requests: { type: 'boolean', description: 'プルリクエストを有効にするか' },
                            has_projects: { type: 'boolean', description: 'プロジェクトを有効にするか' },
                            ignore_whitespace_conflicts: { type: 'boolean', description: '空白の競合を無視するか' },
                            allow_merge_commits: { type: 'boolean', description: 'マージコミットを許可するか' },
                            allow_rebase: { type: 'boolean', description: 'リベースを許可するか' },
                            allow_rebase_explicit: { type: 'boolean', description: '明示的リベースを許可するか' },
                            allow_squash_merge: { type: 'boolean', description: 'スカッシュマージを許可するか' },
                            archived: { type: 'boolean', description: 'アーカイブ済みか' },
                            default_branch: { type: 'string', description: 'デフォルトブランチ' }
                        },
                        required: ['owner', 'repo']
                    }
                }
            },
            handler: async (args: { owner: string, repo: string, name?: string, description?: string, website?: string, private?: boolean, has_issues?: boolean, has_wiki?: boolean, has_pull_requests?: boolean, has_projects?: boolean, ignore_whitespace_conflicts?: boolean, allow_merge_commits?: boolean, allow_rebase?: boolean, allow_rebase_explicit?: boolean, allow_squash_merge?: boolean, archived?: boolean, default_branch?: string }): Promise<any> => {
                const { e, axiosWithAuth } = await getOAuthAccountForTool(req, provider);
                const { owner, repo, ...updateData } = args;

                // undefined値を除去
                const cleanUpdateData = Object.fromEntries(
                    Object.entries(updateData).filter(([_, value]) => value !== undefined)
                );

                const url = `${e.uriBase}/api/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
                const result = (await axiosWithAuth.patch(url, cleanUpdateData)).data;

                reform(result);
                result.uriBase = e.uriBase;
                return result;
            }
        },
        {
            info: { group: provider, isActive: true, isInteractive: false, label: `タグ作成`, },
            definition: {
                type: 'function', function: {
                    name: `gitea_${providerName}_create_tag`,
                    description: `Giteaでタグを作成`,
                    parameters: {
                        type: 'object',
                        properties: {
                            owner: { type: 'string', description: 'リポジトリのオーナー（ユーザー名）' },
                            repo: { type: 'string', description: 'リポジトリ名' },
                            tag_name: { type: 'string', description: 'タグ名' },
                            target: { type: 'string', description: 'タグを作成するブランチ名、タグ名、またはコミットSHA' },
                            message: { type: 'string', description: 'タグメッセージ（注釈付きタグの場合）' }
                        },
                        required: ['owner', 'repo', 'tag_name', 'target']
                    }
                }
            },
            handler: async (args: { owner: string, repo: string, tag_name: string, target: string, message?: string }): Promise<any> => {
                const { e, axiosWithAuth } = await getOAuthAccountForTool(req, provider);
                const { owner, repo, tag_name, target, message } = args;

                const tagData: any = {
                    tag_name: tag_name,
                    target: target
                };

                if (message) tagData.message = message;

                const url = `${e.uriBase}/api/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/tags`;
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
                    name: `gitea_${providerName}_delete_tag`,
                    description: `Giteaのタグを削除`,
                    parameters: {
                        type: 'object',
                        properties: {
                            owner: { type: 'string', description: 'リポジトリのオーナー（ユーザー名）' },
                            repo: { type: 'string', description: 'リポジトリ名' },
                            tag: { type: 'string', description: '削除するタグ名' }
                        },
                        required: ['owner', 'repo', 'tag']
                    }
                }
            },
            handler: async (args: { owner: string, repo: string, tag: string }): Promise<any> => {
                const { e, axiosWithAuth } = await getOAuthAccountForTool(req, provider);
                const { owner, repo, tag } = args;

                const url = `${e.uriBase}/api/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/tags/${encodeURIComponent(tag)}`;
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
                    name: `gitea_${providerName}_repository_releases`,
                    description: `Giteaリポジトリのリリース一覧を取得`,
                    parameters: {
                        type: 'object',
                        properties: {
                            owner: { type: 'string', description: 'リポジトリのオーナー（ユーザー名）' },
                            repo: { type: 'string', description: 'リポジトリ名' },
                            draft: { type: 'boolean', description: 'ドラフトリリースを含めるか', default: false },
                            pre_release: { type: 'boolean', description: 'プレリリースを含めるか', default: true },
                            per_page: { type: 'number', description: '1ページあたりの結果数（最大50）', default: 10, minimum: 1, maximum: 50 },
                            page: { type: 'number', description: 'ページ番号', default: 1, minimum: 1 }
                        },
                        required: ['owner', 'repo']
                    }
                }
            },
            handler: async (args: { owner: string, repo: string, draft?: boolean, pre_release?: boolean, per_page?: number, page?: number }): Promise<any> => {
                const { e, axiosWithAuth } = await getOAuthAccountForTool(req, provider);
                let { owner, repo, draft = false, pre_release = true, per_page = 10, page = 1 } = args;
                per_page = Math.max(Math.min(per_page, 50), 1);
                page = Math.max(page, 1);

                const queryParams = new URLSearchParams();
                queryParams.append('draft', draft.toString());
                queryParams.append('pre-release', pre_release.toString());
                queryParams.append('per_page', per_page.toString());
                queryParams.append('page', page.toString());

                const url = `${e.uriBase}/api/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/releases?${queryParams.toString()}`;
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
                    name: `gitea_${providerName}_release_detail`,
                    description: `Giteaリリースの詳細情報を取得`,
                    parameters: {
                        type: 'object',
                        properties: {
                            owner: { type: 'string', description: 'リポジトリのオーナー（ユーザー名）' },
                            repo: { type: 'string', description: 'リポジトリ名' },
                            id: { type: 'number', description: 'リリースID' }
                        },
                        required: ['owner', 'repo', 'id']
                    }
                }
            },
            handler: async (args: { owner: string, repo: string, id: number }): Promise<any> => {
                const { e, axiosWithAuth } = await getOAuthAccountForTool(req, provider);
                const { owner, repo, id } = args;

                const url = `${e.uriBase}/api/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/releases/${id}`;
                const result = (await axiosWithAuth.get(url)).data;

                reform(result);
                result.uriBase = e.uriBase;
                return result;
            }
        },
        {
            info: { group: provider, isActive: true, isInteractive: false, label: `タグ別リリース取得`, },
            definition: {
                type: 'function', function: {
                    name: `gitea_${providerName}_release_by_tag`,
                    description: `Giteaでタグ名からリリース情報を取得`,
                    parameters: {
                        type: 'object',
                        properties: {
                            owner: { type: 'string', description: 'リポジトリのオーナー（ユーザー名）' },
                            repo: { type: 'string', description: 'リポジトリ名' },
                            tag: { type: 'string', description: 'タグ名' }
                        },
                        required: ['owner', 'repo', 'tag']
                    }
                }
            },
            handler: async (args: { owner: string, repo: string, tag: string }): Promise<any> => {
                const { e, axiosWithAuth } = await getOAuthAccountForTool(req, provider);
                const { owner, repo, tag } = args;

                const url = `${e.uriBase}/api/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/releases/tags/${encodeURIComponent(tag)}`;
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
                    name: `gitea_${providerName}_create_release`,
                    description: `Giteaでリリースを作成`,
                    parameters: {
                        type: 'object',
                        properties: {
                            owner: { type: 'string', description: 'リポジトリのオーナー（ユーザー名）' },
                            repo: { type: 'string', description: 'リポジトリ名' },
                            name: { type: 'string', description: 'リリース名' },
                            tag_name: { type: 'string', description: 'タグ名' },
                            body: { type: 'string', description: 'リリース説明', default: '' },
                            target_commitish: { type: 'string', description: 'タグを作成するブランチ名またはコミットSHA（新規タグの場合）' },
                            draft: { type: 'boolean', description: 'ドラフトリリース', default: false },
                            prerelease: { type: 'boolean', description: 'プレリリース', default: false }
                        },
                        required: ['owner', 'repo', 'name', 'tag_name']
                    }
                }
            },
            handler: async (args: { owner: string, repo: string, name: string, tag_name: string, body?: string, target_commitish?: string, draft?: boolean, prerelease?: boolean }): Promise<any> => {
                const { e, axiosWithAuth } = await getOAuthAccountForTool(req, provider);
                const { owner, repo, name, tag_name, body = '', target_commitish, draft = false, prerelease = false } = args;

                const releaseData: any = {
                    name: name,
                    tag_name: tag_name,
                    body: body,
                    draft: draft,
                    prerelease: prerelease
                };

                if (target_commitish) releaseData.target_commitish = target_commitish;

                const url = `${e.uriBase}/api/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/releases`;
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
                    name: `gitea_${providerName}_update_release`,
                    description: `Giteaリリースを更新`,
                    parameters: {
                        type: 'object',
                        properties: {
                            owner: { type: 'string', description: 'リポジトリのオーナー（ユーザー名）' },
                            repo: { type: 'string', description: 'リポジトリ名' },
                            id: { type: 'number', description: 'リリースID' },
                            name: { type: 'string', description: 'リリース名' },
                            tag_name: { type: 'string', description: 'タグ名' },
                            body: { type: 'string', description: 'リリース説明' },
                            target_commitish: { type: 'string', description: 'ターゲットコミット' },
                            draft: { type: 'boolean', description: 'ドラフトリリース' },
                            prerelease: { type: 'boolean', description: 'プレリリース' }
                        },
                        required: ['owner', 'repo', 'id']
                    }
                }
            },
            handler: async (args: { owner: string, repo: string, id: number, name?: string, tag_name?: string, body?: string, target_commitish?: string, draft?: boolean, prerelease?: boolean }): Promise<any> => {
                const { e, axiosWithAuth } = await getOAuthAccountForTool(req, provider);
                const { owner, repo, id, name, tag_name, body, target_commitish, draft, prerelease } = args;

                const updateData: any = {};
                if (name) updateData.name = name;
                if (tag_name) updateData.tag_name = tag_name;
                if (body) updateData.body = body;
                if (target_commitish) updateData.target_commitish = target_commitish;
                if (draft !== undefined) updateData.draft = draft;
                if (prerelease !== undefined) updateData.prerelease = prerelease;

                const url = `${e.uriBase}/api/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/releases/${id}`;
                const result = (await axiosWithAuth.patch(url, updateData)).data;

                reform(result);
                result.uriBase = e.uriBase;
                return result;
            }
        },
        {
            info: { group: provider, isActive: true, isInteractive: false, label: `リリース削除`, },
            definition: {
                type: 'function', function: {
                    name: `gitea_${providerName}_delete_release`,
                    description: `Giteaリリースを削除`,
                    parameters: {
                        type: 'object',
                        properties: {
                            owner: { type: 'string', description: 'リポジトリのオーナー（ユーザー名）' },
                            repo: { type: 'string', description: 'リポジトリ名' },
                            id: { type: 'number', description: 'リリースID' }
                        },
                        required: ['owner', 'repo', 'id']
                    }
                }
            },
            handler: async (args: { owner: string, repo: string, id: number }): Promise<any> => {
                const { e, axiosWithAuth } = await getOAuthAccountForTool(req, provider);
                const { owner, repo, id } = args;

                const url = `${e.uriBase}/api/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/releases/${id}`;
                const result = (await axiosWithAuth.delete(url)).data;

                reform(result);
                result.uriBase = e.uriBase;
                return result;
            }
        },
        {
            info: { group: provider, isActive: true, isInteractive: false, label: `リリースアセット一覧`, },
            definition: {
                type: 'function', function: {
                    name: `gitea_${providerName}_release_assets`,
                    description: `Giteaリリースのアセット一覧を取得`,
                    parameters: {
                        type: 'object',
                        properties: {
                            owner: { type: 'string', description: 'リポジトリのオーナー（ユーザー名）' },
                            repo: { type: 'string', description: 'リポジトリ名' },
                            id: { type: 'number', description: 'リリースID' }
                        },
                        required: ['owner', 'repo', 'id']
                    }
                }
            },
            handler: async (args: { owner: string, repo: string, id: number }): Promise<any> => {
                const { e, axiosWithAuth } = await getOAuthAccountForTool(req, provider);
                const { owner, repo, id } = args;

                const url = `${e.uriBase}/api/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/releases/${id}/assets`;
                const result = (await axiosWithAuth.get(url)).data;

                reform(result);
                result.uriBase = e.uriBase;
                return result;
            }
        },
        {
            info: { group: provider, isActive: true, isInteractive: false, label: `リリースアセット作成`, },
            definition: {
                type: 'function', function: {
                    name: `gitea_${providerName}_create_release_asset`,
                    description: `Giteaリリースにアセットを追加（ファイルアップロード）`,
                    parameters: {
                        type: 'object',
                        properties: {
                            owner: { type: 'string', description: 'リポジトリのオーナー（ユーザー名）' },
                            repo: { type: 'string', description: 'リポジトリ名' },
                            id: { type: 'number', description: 'リリースID' },
                            name: { type: 'string', description: 'アセット名' },
                            attachment: { type: 'string', description: 'ファイル内容（Base64エンコード）' }
                        },
                        required: ['owner', 'repo', 'id', 'name', 'attachment']
                    }
                }
            },
            handler: async (args: { owner: string, repo: string, id: number, name: string, attachment: string }): Promise<any> => {
                const { e, axiosWithAuth } = await getOAuthAccountForTool(req, provider);
                const { owner, repo, id, name, attachment } = args;

                const formData = new FormData();
                formData.append('attachment', Buffer.from(attachment, 'base64') as any, name);

                const url = `${e.uriBase}/api/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/releases/${id}/assets`;
                const result = (await axiosWithAuth.post(url, formData, {
                    headers: {
                        'Content-Type': 'multipart/form-data'
                    }
                })).data;

                reform(result);
                result.uriBase = e.uriBase;
                return result;
            }
        },
        {
            info: { group: provider, isActive: true, isInteractive: false, label: `リリースアセット削除`, },
            definition: {
                type: 'function', function: {
                    name: `gitea_${providerName}_delete_release_asset`,
                    description: `Giteaリリースのアセットを削除`,
                    parameters: {
                        type: 'object',
                        properties: {
                            owner: { type: 'string', description: 'リポジトリのオーナー（ユーザー名）' },
                            repo: { type: 'string', description: 'リポジトリ名' },
                            id: { type: 'number', description: 'リリースID' },
                            asset_id: { type: 'number', description: 'アセットID' }
                        },
                        required: ['owner', 'repo', 'id', 'asset_id']
                    }
                }
            },
            handler: async (args: { owner: string, repo: string, id: number, asset_id: number }): Promise<any> => {
                const { e, axiosWithAuth } = await getOAuthAccountForTool(req, provider);
                const { owner, repo, id, asset_id } = args;

                const url = `${e.uriBase}/api/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/releases/${id}/assets/${asset_id}`;
                const result = (await axiosWithAuth.delete(url)).data;

                reform(result);
                result.uriBase = e.uriBase;
                return result;
            }
        },
        {
            info: { group: provider, isActive: true, isInteractive: false, label: `リポジトリコラボレーター一覧`, },
            definition: {
                type: 'function', function: {
                    name: `gitea_${providerName}_repository_collaborators`,
                    description: `Giteaリポジトリのコラボレーター一覧を取得`,
                    parameters: {
                        type: 'object',
                        properties: {
                            owner: { type: 'string', description: 'リポジトリのオーナー（ユーザー名）' },
                            repo: { type: 'string', description: 'リポジトリ名' }
                        },
                        required: ['owner', 'repo']
                    }
                }
            },
            handler: async (args: { owner: string, repo: string }): Promise<any> => {
                const { e, axiosWithAuth } = await getOAuthAccountForTool(req, provider);
                const { owner, repo } = args;

                const url = `${e.uriBase}/api/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/collaborators`;
                const result = (await axiosWithAuth.get(url)).data;

                reform(result);
                result.uriBase = e.uriBase;
                return result;
            }
        },
        {
            info: { group: provider, isActive: true, isInteractive: true, label: `リポジトリコラボレーター追加`, },
            definition: {
                type: 'function', function: {
                    name: `gitea_${providerName}_add_repository_collaborator`,
                    description: `Giteaリポジトリにコラボレーターを追加`,
                    parameters: {
                        type: 'object',
                        properties: {
                            owner: { type: 'string', description: 'リポジトリのオーナー（ユーザー名）' },
                            repo: { type: 'string', description: 'リポジトリ名' },
                            username: { type: 'string', description: '追加するユーザー名' },
                            permission: { type: 'string', description: '権限レベル', enum: ['read', 'write', 'admin'], default: 'read' }
                        },
                        required: ['owner', 'repo', 'username']
                    }
                }
            },
            handler: async (args: { owner: string, repo: string, username: string, permission?: string }): Promise<any> => {
                const { e, axiosWithAuth } = await getOAuthAccountForTool(req, provider);
                const { owner, repo, username, permission = 'read' } = args;

                const collaboratorData = { permission: permission };

                const url = `${e.uriBase}/api/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/collaborators/${encodeURIComponent(username)}`;
                const result = (await axiosWithAuth.put(url, collaboratorData)).data;

                reform(result);
                result.uriBase = e.uriBase;
                return result;
            }
        },
        {
            info: { group: provider, isActive: true, isInteractive: true, label: `リポジトリコラボレーター削除`, },
            definition: {
                type: 'function', function: {
                    name: `gitea_${providerName}_remove_repository_collaborator`,
                    description: `Giteaリポジトリからコラボレーターを削除`,
                    parameters: {
                        type: 'object',
                        properties: {
                            owner: { type: 'string', description: 'リポジトリのオーナー（ユーザー名）' },
                            repo: { type: 'string', description: 'リポジトリ名' },
                            username: { type: 'string', description: '削除するユーザー名' }
                        },
                        required: ['owner', 'repo', 'username']
                    }
                }
            },
            handler: async (args: { owner: string, repo: string, username: string }): Promise<any> => {
                const { e, axiosWithAuth } = await getOAuthAccountForTool(req, provider);
                const { owner, repo, username } = args;

                const url = `${e.uriBase}/api/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/collaborators/${encodeURIComponent(username)}`;
                const result = (await axiosWithAuth.delete(url)).data;

                reform(result);
                result.uriBase = e.uriBase;
                return result;
            }
        },
        {
            info: { group: provider, isActive: true, isInteractive: false, label: `組織一覧取得`, },
            definition: {
                type: 'function', function: {
                    name: `gitea_${providerName}_user_organizations`,
                    description: `Giteaの組織一覧を取得`,
                    parameters: {
                        type: 'object',
                        properties: {
                            username: { type: 'string', description: 'ユーザー名（指定しない場合は自分の組織）' },
                            per_page: { type: 'number', description: '1ページあたりの結果数（最大50）', default: 10, minimum: 1, maximum: 50 },
                            page: { type: 'number', description: 'ページ番号', default: 1, minimum: 1 }
                        }
                    }
                }
            },
            handler: async (args: { username?: string, per_page?: number, page?: number }): Promise<any> => {
                const { e, axiosWithAuth } = await getOAuthAccountForTool(req, provider);
                let { username, per_page = 10, page = 1 } = args;
                per_page = Math.max(Math.min(per_page, 50), 1);
                page = Math.max(page, 1);

                const queryParams = new URLSearchParams();
                queryParams.append('per_page', per_page.toString());
                queryParams.append('page', page.toString());

                let url: string;
                if (username) {
                    url = `${e.uriBase}/api/v1/users/${encodeURIComponent(username)}/orgs?${queryParams.toString()}`;
                } else {
                    url = `${e.uriBase}/api/v1/user/orgs?${queryParams.toString()}`;
                }

                const result = (await axiosWithAuth.get(url)).data;

                reform(result);
                result.uriBase = e.uriBase;
                return result;
            }
        },
        {
            info: { group: provider, isActive: true, isInteractive: false, label: `組織メンバー一覧`, },
            definition: {
                type: 'function', function: {
                    name: `gitea_${providerName}_organization_members`,
                    description: `Gitea組織のメンバー一覧を取得`,
                    parameters: {
                        type: 'object',
                        properties: {
                            org: { type: 'string', description: '組織名' },
                            per_page: { type: 'number', description: '1ページあたりの結果数（最大50）', default: 10, minimum: 1, maximum: 50 },
                            page: { type: 'number', description: 'ページ番号', default: 1, minimum: 1 }
                        },
                        required: ['org']
                    }
                }
            },
            handler: async (args: { org: string, per_page?: number, page?: number }): Promise<any> => {
                const { e, axiosWithAuth } = await getOAuthAccountForTool(req, provider);
                let { org, per_page = 10, page = 1 } = args;
                per_page = Math.max(Math.min(per_page, 50), 1);
                page = Math.max(page, 1);

                const queryParams = new URLSearchParams();
                queryParams.append('per_page', per_page.toString());
                queryParams.append('page', page.toString());

                const url = `${e.uriBase}/api/v1/orgs/${encodeURIComponent(org)}/members?${queryParams.toString()}`;
                const result = (await axiosWithAuth.get(url)).data;

                reform(result);
                result.uriBase = e.uriBase;
                return result;
            }
        },
        {
            info: { group: provider, isActive: true, isInteractive: false, label: `組織チーム一覧`, },
            definition: {
                type: 'function', function: {
                    name: `gitea_${providerName}_organization_teams`,
                    description: `Gitea組織のチーム一覧を取得`,
                    parameters: {
                        type: 'object',
                        properties: {
                            org: { type: 'string', description: '組織名' },
                            per_page: { type: 'number', description: '1ページあたりの結果数（最大50）', default: 10, minimum: 1, maximum: 50 },
                            page: { type: 'number', description: 'ページ番号', default: 1, minimum: 1 }
                        },
                        required: ['org']
                    }
                }
            },
            handler: async (args: { org: string, per_page?: number, page?: number }): Promise<any> => {
                const { e, axiosWithAuth } = await getOAuthAccountForTool(req, provider);
                let { org, per_page = 10, page = 1 } = args;
                per_page = Math.max(Math.min(per_page, 50), 1);
                page = Math.max(page, 1);

                const queryParams = new URLSearchParams();
                queryParams.append('per_page', per_page.toString());
                queryParams.append('page', page.toString());

                const url = `${e.uriBase}/api/v1/orgs/${encodeURIComponent(org)}/teams?${queryParams.toString()}`;
                const result = (await axiosWithAuth.get(url)).data;

                reform(result);
                result.uriBase = e.uriBase;
                return result;
            }
        },
        {
            info: { group: provider, isActive: true, isInteractive: false, label: `チームメンバー一覧`, },
            definition: {
                type: 'function', function: {
                    name: `gitea_${providerName}_team_members`,
                    description: `Giteaチームのメンバー一覧を取得`,
                    parameters: {
                        type: 'object',
                        properties: {
                            team_id: { type: 'number', description: 'チームID' },
                            per_page: { type: 'number', description: '1ページあたりの結果数（最大50）', default: 10, minimum: 1, maximum: 50 },
                            page: { type: 'number', description: 'ページ番号', default: 1, minimum: 1 }
                        },
                        required: ['team_id']
                    }
                }
            },
            handler: async (args: { team_id: number, per_page?: number, page?: number }): Promise<any> => {
                const { e, axiosWithAuth } = await getOAuthAccountForTool(req, provider);
                let { team_id, per_page = 10, page = 1 } = args;
                per_page = Math.max(Math.min(per_page, 50), 1);
                page = Math.max(page, 1);

                const queryParams = new URLSearchParams();
                queryParams.append('per_page', per_page.toString());
                queryParams.append('page', page.toString());

                const url = `${e.uriBase}/api/v1/teams/${team_id}/members?${queryParams.toString()}`;
                const result = (await axiosWithAuth.get(url)).data;

                reform(result);
                result.uriBase = e.uriBase;
                return result;
            }
        },
        {
            info: { group: provider, isActive: true, isInteractive: true, label: `チームメンバー追加`, },
            definition: {
                type: 'function', function: {
                    name: `gitea_${providerName}_add_team_member`,
                    description: `Giteaチームにメンバーを追加`,
                    parameters: {
                        type: 'object',
                        properties: {
                            team_id: { type: 'number', description: 'チームID' },
                            username: { type: 'string', description: '追加するユーザー名' }
                        },
                        required: ['team_id', 'username']
                    }
                }
            },
            handler: async (args: { team_id: number, username: string }): Promise<any> => {
                const { e, axiosWithAuth } = await getOAuthAccountForTool(req, provider);
                const { team_id, username } = args;

                const url = `${e.uriBase}/api/v1/teams/${team_id}/members/${encodeURIComponent(username)}`;
                const result = (await axiosWithAuth.put(url, {})).data;

                reform(result);
                result.uriBase = e.uriBase;
                return result;
            }
        },
        {
            info: { group: provider, isActive: true, isInteractive: true, label: `チームメンバー削除`, },
            definition: {
                type: 'function', function: {
                    name: `gitea_${providerName}_remove_team_member`,
                    description: `Giteaチームからメンバーを削除`,
                    parameters: {
                        type: 'object',
                        properties: {
                            team_id: { type: 'number', description: 'チームID' },
                            username: { type: 'string', description: '削除するユーザー名' }
                        },
                        required: ['team_id', 'username']
                    }
                }
            },
            handler: async (args: { team_id: number, username: string }): Promise<any> => {
                const { e, axiosWithAuth } = await getOAuthAccountForTool(req, provider);
                const { team_id, username } = args;

                const url = `${e.uriBase}/api/v1/teams/${team_id}/members/${encodeURIComponent(username)}`;
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
                    name: `gitea_${providerName}_search_users`,
                    description: `Giteaのユーザーを検索`,
                    parameters: {
                        type: 'object',
                        properties: {
                            q: { type: 'string', description: '検索キーワード（ユーザー名）' },
                            uid: { type: 'number', description: 'ユーザーID' },
                            per_page: { type: 'number', description: '1ページあたりの結果数（最大50）', default: 10, minimum: 1, maximum: 50 },
                            page: { type: 'number', description: 'ページ番号', default: 1, minimum: 1 }
                        }
                    }
                }
            },
            handler: async (args: { q?: string, uid?: number, per_page?: number, page?: number }): Promise<any> => {
                const { e, axiosWithAuth } = await getOAuthAccountForTool(req, provider);
                let { q, uid, per_page = 10, page = 1 } = args;
                per_page = Math.max(Math.min(per_page, 50), 1);
                page = Math.max(page, 1);

                const queryParams = new URLSearchParams();
                queryParams.append('per_page', per_page.toString());
                queryParams.append('page', page.toString());
                if (q) queryParams.append('q', q);
                if (uid) queryParams.append('uid', uid.toString());

                const url = `${e.uriBase}/api/v1/users/search?${queryParams.toString()}`;
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
                    name: `gitea_${providerName}_notifications`,
                    description: `Giteaの通知一覧を取得`,
                    parameters: {
                        type: 'object',
                        properties: {
                            all: { type: 'boolean', description: '全ての通知を取得（既読含む）', default: false },
                            status_types: { type: 'array', items: { type: 'string' }, description: 'ステータスタイプで絞り込み', example: ['unread', 'read', 'pinned'] },
                            subject_type: { type: 'array', items: { type: 'string' }, description: 'サブジェクトタイプで絞り込み', example: ['Issue', 'PullRequest', 'Commit', 'Repository'] },
                            since: { type: 'string', description: '指定日以降（RFC3339形式）' },
                            before: { type: 'string', description: '指定日以前（RFC3339形式）' },
                            per_page: { type: 'number', description: '1ページあたりの結果数（最大50）', default: 10, minimum: 1, maximum: 50 },
                            page: { type: 'number', description: 'ページ番号', default: 1, minimum: 1 }
                        }
                    }
                }
            },
            handler: async (args: { all?: boolean, status_types?: string[], subject_type?: string[], since?: string, before?: string, per_page?: number, page?: number }): Promise<any> => {
                const { e, axiosWithAuth } = await getOAuthAccountForTool(req, provider);
                let { all = false, status_types, subject_type, since, before, per_page = 10, page = 1 } = args;
                per_page = Math.max(Math.min(per_page, 50), 1);
                page = Math.max(page, 1);

                const queryParams = new URLSearchParams();
                queryParams.append('all', all.toString());
                queryParams.append('per_page', per_page.toString());
                queryParams.append('page', page.toString());
                if (status_types && status_types.length > 0) {
                    status_types.forEach(status => queryParams.append('status-types', status));
                }
                if (subject_type && subject_type.length > 0) {
                    subject_type.forEach(type => queryParams.append('subject-type', type));
                }
                if (since) queryParams.append('since', since);
                if (before) queryParams.append('before', before);

                const url = `${e.uriBase}/api/v1/notifications?${queryParams.toString()}`;
                const result = (await axiosWithAuth.get(url)).data;

                reform(result);
                result.uriBase = e.uriBase;
                return result;
            }
        },
        {
            info: { group: provider, isActive: true, isInteractive: true, label: `通知既読マーク`, },
            definition: {
                type: 'function', function: {
                    name: `gitea_${providerName}_mark_notifications_read`,
                    description: `Gitea通知を既読にマーク`,
                    parameters: {
                        type: 'object',
                        properties: {
                            last_read_at: { type: 'string', description: '最終既読日時（RFC3339形式）' },
                            all: { type: 'boolean', description: '全ての通知を既読にする', default: false },
                            status_types: { type: 'array', items: { type: 'string' }, description: 'ステータスタイプで絞り込み', example: ['unread'] },
                            to_status: { type: 'string', description: '変更先ステータス', enum: ['read', 'unread', 'pinned'], default: 'read' }
                        }
                    }
                }
            },
            handler: async (args: { last_read_at?: string, all?: boolean, status_types?: string[], to_status?: string }): Promise<any> => {
                const { e, axiosWithAuth } = await getOAuthAccountForTool(req, provider);
                const { last_read_at, all = false, status_types, to_status = 'read' } = args;

                const markData: any = {
                    all: all,
                    'to-status': to_status
                };

                if (last_read_at) markData['last_read_at'] = last_read_at;
                if (status_types && status_types.length > 0) {
                    markData['status-types'] = status_types;
                }

                const url = `${e.uriBase}/api/v1/notifications`;
                const result = (await axiosWithAuth.put(url, markData)).data;

                reform(result);
                result.uriBase = e.uriBase;
                return result;
            }
        },
        {
            info: { group: provider, isActive: true, isInteractive: false, label: `サーバー情報取得`, },
            definition: {
                type: 'function', function: {
                    name: `gitea_${providerName}_server_version`,
                    description: `Giteaのサーバー情報を取得`,
                    parameters: {
                        type: 'object',
                        properties: {}
                    }
                }
            },
            handler: async (args: {}): Promise<any> => {
                const { e, axiosWithAuth } = await getOAuthAccountForTool(req, provider);

                const url = `${e.uriBase}/api/v1/version`;
                const result = (await axiosWithAuth.get(url)).data;

                reform(result);
                result.uriBase = e.uriBase;
                return result;
            }
        },
        {
            info: { group: provider, isActive: true, isInteractive: false, label: `リポジトリアクティビティ取得`, },
            definition: {
                type: 'function', function: {
                    name: `gitea_${providerName}_repository_activity`,
                    description: `Giteaリポジトリのアクティビティを取得`,
                    parameters: {
                        type: 'object',
                        properties: {
                            owner: { type: 'string', description: 'リポジトリのオーナー（ユーザー名）' },
                            repo: { type: 'string', description: 'リポジトリ名' },
                            per_page: { type: 'number', description: '1ページあたりの結果数（最大50）', default: 10, minimum: 1, maximum: 50 },
                            page: { type: 'number', description: 'ページ番号', default: 1, minimum: 1 }
                        },
                        required: ['owner', 'repo']
                    }
                }
            },
            handler: async (args: { owner: string, repo: string, per_page?: number, page?: number }): Promise<any> => {
                const { e, axiosWithAuth } = await getOAuthAccountForTool(req, provider);
                let { owner, repo, per_page = 10, page = 1 } = args;
                per_page = Math.max(Math.min(per_page, 50), 1);
                page = Math.max(page, 1);

                const queryParams = new URLSearchParams();
                queryParams.append('per_page', per_page.toString());
                queryParams.append('page', page.toString());

                const url = `${e.uriBase}/api/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/activities/feeds?${queryParams.toString()}`;
                const result = (await axiosWithAuth.get(url)).data;

                reform(result);
                result.uriBase = e.uriBase;
                return result;
            }
        },
        {
            info: { group: provider, isActive: true, isInteractive: false, label: `サーバー統計取得`, },
            definition: {
                type: 'function', function: {
                    name: `gitea_${providerName}_server_statistics`,
                    description: `Giteaサーバーの統計情報を取得`,
                    parameters: {
                        type: 'object',
                        properties: {}
                    }
                }
            },
            handler: async (args: {}): Promise<any> => {
                const { e, axiosWithAuth } = await getOAuthAccountForTool(req, provider);

                // Giteaは統計APIがないため、利用可能な情報から統計を構築
                try {
                    const [userSearch, orgSearch] = await Promise.all([
                        axiosWithAuth.get(`${e.uriBase}/api/v1/users/search?per_page=1`),
                        axiosWithAuth.get(`${e.uriBase}/api/v1/orgs?per_page=1`)
                    ]);

                    const statistics = {
                        server_version: await axiosWithAuth.get(`${e.uriBase}/api/v1/version`).then(r => r.data),
                        estimated_counts: {
                            users: userSearch.data.total_count || 'unknown',
                            organizations: orgSearch.data.length || 'unknown'
                        },
                        note: 'Gitea does not provide comprehensive server statistics API'
                    };

                    reform(statistics);
                    (statistics as any).uriBase = e.uriBase;
                    return statistics;
                } catch (error) {
                    return {
                        error: 'Unable to retrieve server statistics',
                        details: 'Limited API access or permissions',
                        uriBase: e.uriBase
                    };
                }
            }
        }
    ]
}
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

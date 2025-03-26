import { Request, Response } from "express";
import { EntityManager } from "typeorm";
import { map, toArray } from "rxjs";


const { GITEA_CONFIDENCIAL_OWNERS = '' } = process.env as { GITEA_CONFIDENCIAL_OWNERS: string };

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
import { GiteaRepository } from "../api/api-gitea.js";

// 1. 関数マッピングの作成
export function giteaFunctionDefinitions(providerSubName: string,
    obj: { inDto: MessageArgsSet; messageSet: { messageGroup: MessageGroupEntity; message: MessageEntity; contentParts: ContentPartEntity[]; }; },
    req: UserRequest, aiApi: OpenAIApiWrapper, connectionId: string, streamId: string, message: MessageEntity, label: string,
): MyToolType[] {
    return [
        {
            info: { group: `gitea-${providerSubName}`, isActive: true, isInteractive: false, label: `リポジトリ検索`, },
            definition: {
                type: 'function', function: {
                    name: `gitea_${providerSubName}_search_repos`,
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
                let { limit, page, keyword, uid } = args;
                limit = Math.max(Math.min(limit || 10, 50), 1); // 1以上50以下
                page = Math.max(page || 1, 1); // 1以上

                const { e } = await getOAuthAccount(req, `gitea-${providerSubName}`);

                let url = `${e.uriBase}/api/v1/repos/search?q=${encodeURIComponent(keyword)}&limit=${limit}&page=${page}`;

                if (uid) {
                    url += `&uid=${uid}`;
                }

                if (args.private !== undefined) {
                    url += `&private=${args.private}`;
                }

                const result = (await e.axiosWithAuth.then(g => g(req.info.user.id)).then(g => g.get(url))).data;

                reform(result);
                // result.me = reform(JSON.parse(oAuthAccount.userInfo));
                result.uriBase = e.uriBase;
                return result;
            }
        },
        {   // コミット履歴取得
            info: { group: `gitea-${providerSubName}`, isActive: true, isInteractive: false, label: `リポジトリのコミット履歴`, responseType: 'markdown' },
            definition: {
                type: 'function', function: {
                    name: `gitea_${providerSubName}_repository_commits`,
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
                const { project_id, sha, path, limit = 20, page = 1 } = args;

                const { e } = await getOAuthAccount(req, `gitea-${providerSubName}`);
                const queryMap = {} as { [key: string]: string };
                if (sha) queryMap.sha = sha;
                if (path) queryMap.path = path;
                queryMap.limit = limit.toString();
                queryMap.page = page.toString();
                // Giteaでは/api/v1/repos/{owner}/{repo}/commitsの形式
                // project_idからリポジトリ情報を取得するためのリクエスト
                const repoUrl = `${e.uriBase}/api/v1/repositories/${project_id}`;
                const repoInfo = (await e.axiosWithAuth.then(g => g(req.info.user.id)).then(g => g.get(repoUrl))).data;
                const owner = repoInfo.owner.username;
                const repo = repoInfo.name;

                const url = `${e.uriBase}/api/v1/repos/${owner}/${repo}/commits?${Object.entries(queryMap).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&')}`;
                console.log(url);
                const result = (await e.axiosWithAuth.then(g => g(req.info.user.id)).then(g => g.get(url))).data;

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
            info: { group: `gitea-${providerSubName}`, isActive: true, isInteractive: false, label: `リポジトリのブランチ/タグ一覧`, },
            definition: {
                type: 'function', function: {
                    name: `gitea_${providerSubName}_repository_refs`,
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
                const { project_id, ref_type = 'branches', query = '', limit = 20, page = 1 } = args;

                const { e } = await getOAuthAccount(req, `gitea-${providerSubName}`);

                // project_idからリポジトリ情報を取得するためのリクエスト
                const repoUrl = `${e.uriBase}/api/v1/repositories/${project_id}`;
                const repoInfo = (await e.axiosWithAuth.then(g => g(req.info.user.id)).then(g => g.get(repoUrl))).data;
                const owner = repoInfo.owner.username;
                const repo = repoInfo.name;

                // ref_typeに基づいてURLを構築
                const url = `${e.uriBase}/api/v1/repos/${owner}/${repo}/${ref_type}?q=${encodeURIComponent(query)}&limit=${limit}&page=${page}`;
                const result = (await e.axiosWithAuth.then(g => g(req.info.user.id)).then(g => g.get(url))).data;

                reform(result);
                result.uriBase = e.uriBase;
                result.ref_type = ref_type; // どちらのタイプを取得したかを結果に含める
                return result;
            }
        },
        {   // コミット間の差分を取得
            info: { group: `gitea-${providerSubName}`, isActive: true, isInteractive: false, label: `コミット間の差分を取得`, responseType: 'markdown' },
            definition: {
                type: 'function', function: {
                    name: `gitea_${providerSubName}_repository_compare`,
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
                const { project_id, base, head } = args;

                const { e } = await getOAuthAccount(req, `gitea-${providerSubName}`);

                // project_idからリポジトリ情報を取得するためのリクエスト
                const repoUrl = `${e.uriBase}/api/v1/repositories/${project_id}`;
                const repoInfo = (await e.axiosWithAuth.then(g => g(req.info.user.id)).then(g => g.get(repoUrl))).data;
                const owner = repoInfo.owner.username;
                const repo = repoInfo.name;

                const url = `${e.uriBase}/api/v1/repos/${owner}/${repo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`;
                const result = (await e.axiosWithAuth.then(g => g(req.info.user.id)).then(g => g.get(url))).data;

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
            info: { group: `gitea-${providerSubName}`, isActive: true, isInteractive: false, label: `特定コミットの詳細`, },
            definition: {
                type: 'function', function: {
                    name: `gitea_${providerSubName}_repository_commit`,
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
                const { project_id, sha } = args;

                const { e } = await getOAuthAccount(req, `gitea-${providerSubName}`);

                // project_idからリポジトリ情報を取得するためのリクエスト
                const repoUrl = `${e.uriBase}/api/v1/repositories/${project_id}`;
                const repoInfo = (await e.axiosWithAuth.then(g => g(req.info.user.id)).then(g => g.get(repoUrl))).data;
                const owner = repoInfo.owner.username;
                const repo = repoInfo.name;

                // Get commit details
                const commitUrl = `${e.uriBase}/api/v1/repos/${owner}/${repo}/git/commits/${encodeURIComponent(sha)}`;
                const commitResult = (await e.axiosWithAuth.then(g => g(req.info.user.id)).then(g => g.get(commitUrl))).data;

                // Get commit files
                const filesUrl = `${e.uriBase}/api/v1/repos/${owner}/${repo}/commits/${encodeURIComponent(sha)}`;
                const filesResult = (await e.axiosWithAuth.then(g => g(req.info.user.id)).then(g => g.get(filesUrl))).data;

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
        //     info: { group: `gitea-${providerSubName}`, isActive: true, isInteractive: false, label: `リポジトリ全ファイル一覧を取得`, },
        //     definition: {
        //         type: 'function', function: {
        //             name: `gitea_${providerSubName}_repository_all_file_list`,
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
        //         const { e } = await getOAuthAccount(req, `gitea-${providerSubName}`);

        //         // リポジトリのツリー情報を再帰的に取得
        //         const treeUrl = `${e.uriBase}/api/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees/${encodeURIComponent(ref)}?recursive=true`;
        //         const treeResponse = await e.axiosWithAuth.then(g => g(req.info.user.id)).then(g => g.get(treeUrl));
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
        //                 const contentResponse = await e.axiosWithAuth.then(g => g(req.info.user.id)).then(g => g.get(rawUrl, { responseType: 'text' }));
        //                 const content = contentResponse.data;

        //                 const infoUrl = `${e.uriBase}/api/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodeURIComponent(filePath)}?ref=${encodeURIComponent(ref)}`;
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
        // /**
        //  * リポジトリの全ファイルを一度に取得する関数
        //  */
        // {
        //     info: { group: `gitea-${providerSubName}`, isActive: true, isInteractive: false, label: `リポジトリ全ファイル取得`, },
        //     definition: {
        //         type: 'function', function: {
        //             name: `gitea_${providerSubName}_get_all_repository_files`,
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

        //         const { e } = await getOAuthAccount(req, `gitea-${providerSubName}`);

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
        //             const treeResponse = await e.axiosWithAuth.then(g => g(req.info.user.id)).then(g => g.get(treeUrl));
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
        //                         const contentResponse = await e.axiosWithAuth.then(g => g(req.info.user.id)).then(g => g.get(contentUrl, { responseType: 'text' }));
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
            info: { group: `gitea-${providerSubName}`, isActive: true, isInteractive: false, label: `課題検索`, },
            definition: {
                type: 'function', function: {
                    name: `gitea_${providerSubName}_search_issues`,
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
                let { limit, page, state } = args;
                limit = Math.max(Math.min(limit || 10, 50), 1); // 1以上50以下
                page = Math.max(page || 1, 1); // 1以上
                state = state || 'open';

                const { e } = await getOAuthAccount(req, `gitea-${providerSubName}`);

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

                const result = (await e.axiosWithAuth.then(g => g(req.info.user.id)).then(g => g.get(url))).data;

                reform(result);
                // result.me = reform(JSON.parse(oAuthAccount.userInfo));
                result.uriBase = e.uriBase;
                return result;
            }
        },
        {
            info: { group: `gitea-${providerSubName}`, isActive: true, isInteractive: false, label: `自分のリポジトリ一覧`, },
            definition: {
                type: 'function', function: {
                    name: `gitea_${providerSubName}_my_repos`,
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
                let { limit, page } = args;
                limit = Math.max(Math.min(limit || 10, 50), 1); // 1以上50以下
                page = Math.max(page || 1, 1); // 1以上

                const { e } = await getOAuthAccount(req, `gitea-${providerSubName}`);

                const url = `${e.uriBase}/api/v1/user/repos?limit=${limit}&page=${page}`;
                const result = (await e.axiosWithAuth.then(g => g(req.info.user.id)).then(g => g.get(url))).data;

                reform(result);
                // result.me = reform(JSON.parse(oAuthAccount.userInfo));
                result.uriBase = e.uriBase;
                return result;
            }
        },
        {
            info: { group: `gitea-${providerSubName}`, isActive: true, isInteractive: false, label: `リポジトリの課題一覧`, },
            definition: {
                type: 'function', function: {
                    name: `gitea_${providerSubName}_repo_issues`,
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
                let { limit, page, state, owner, repo } = args;
                limit = Math.max(Math.min(limit || 10, 50), 1); // 1以上50以下
                page = Math.max(page || 1, 1); // 1以上
                state = state || 'open';

                const { e } = await getOAuthAccount(req, `gitea-${providerSubName}`);

                let url = `${e.uriBase}/api/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues?limit=${limit}&page=${page}&state=${state}`;

                if (args.labels) {
                    url += `&labels=${encodeURIComponent(args.labels)}`;
                }

                const result = (await e.axiosWithAuth.then(g => g(req.info.user.id)).then(g => g.get(url))).data;

                reform(result);
                // result.me = reform(JSON.parse(oAuthAccount.userInfo));
                result.uriBase = e.uriBase;
                return result;
            }
        },
        {
            info: { group: `gitea-${providerSubName}`, isActive: true, isInteractive: false, label: `リポジトリのプルリクエスト一覧`, },
            definition: {
                type: 'function', function: {
                    name: `gitea_${providerSubName}_repo_pulls`,
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
                let { limit, page, state, owner, repo } = args;
                limit = Math.max(Math.min(limit || 10, 50), 1); // 1以上50以下
                page = Math.max(page || 1, 1); // 1以上
                state = state || 'open';

                const { e } = await getOAuthAccount(req, `gitea-${providerSubName}`);

                const url = `${e.uriBase}/api/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls?limit=${limit}&page=${page}&state=${state}`;
                const result = (await e.axiosWithAuth.then(g => g(req.info.user.id)).then(g => g.get(url))).data;

                reform(result);
                // result.me = reform(JSON.parse(oAuthAccount.userInfo));
                result.uriBase = e.uriBase;
                return result;
            }
        },
        {
            info: { group: `gitea-${providerSubName}`, isActive: true, isInteractive: false, label: `gitea-${providerSubName}：自分のユーザー情報`, },
            definition: {
                type: 'function', function: {
                    name: `gitea_${providerSubName}_user_info`,
                    description: `gitea-${providerSubName}：自分のユーザー情報`,
                    parameters: { type: 'object', properties: {}, }
                }
            },
            handler: async (args: {}): Promise<any> => {
                const { e, oAuthAccount } = await getOAuthAccount(req, `gitea-${providerSubName}`);

                const url = `${e.uriBase}/api/v1/user`;
                const result = (await e.axiosWithAuth.then(g => g(req.info.user.id)).then(g => g.get(url))).data;

                reform(result);
                result.me = reform(JSON.parse(oAuthAccount.userInfo));
                result.uriBase = e.uriBase;
                return result;
            }
        },
        {
            info: { group: `gitea-${providerSubName}`, isActive: true, isInteractive: false, label: `リポジトリファイル内容取得`, responseType: 'markdown' },
            definition: {
                type: 'function', function: {
                    name: `gitea_${providerSubName}_file_content`,
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
                let { owner, repo, file_path_list, ref } = args;
                ref = ref || 'main';
                const { e } = await getOAuthAccount(req, `gitea-${providerSubName}`);
                if (GITEA_CONFIDENCIAL_OWNERS.split(',').includes(owner)) {
                    return Promise.resolve(`\`\`\`json\n{ "error": "このリポジトリは機密情報を含むため、表示できません", "details": "機密情報を含むリポジトリの場合、表示を制限しています。" }\n\`\`\``);
                } else { }

                if (ref) {
                    // ブランチ名、タグ名、またはコミットSHAが指定されている場合はそのまま
                } else {
                    const defaultBranchUrl = `${e.uriBase}/api/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
                    const defaultBranchResult = (await e.axiosWithAuth.then(g => g(req.info.user.id)).then(g => g.get<GiteaRepository>(defaultBranchUrl))).data;
                    ref = ref || defaultBranchResult.default_branch || 'main';
                }

                // ファイルの内容を取得
                return await Promise.all(file_path_list.map(async (file_path) => {
                    const url = `${e.uriBase}/api/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/raw/${encodeURIComponent(ref)}/${encodeURIComponent(file_path)}`;
                    try {
                        // raw contentを取得
                        const contentResponse = await e.axiosWithAuth.then(g => g(req.info.user.id)).then(g => g.get(url, { responseType: 'text' }));
                        const content = contentResponse.data;

                        // ファイル情報も取得
                        const contentUrl = `${e.uriBase}/api/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodeURIComponent(file_path)}?ref=${encodeURIComponent(ref)}`;
                        const contentInfo = (await e.axiosWithAuth.then(g => g(req.info.user.id)).then(g => g.get(contentUrl))).data;
                        // console.log('contentInfo:START');
                        // console.dir(contentInfo);
                        // console.log('contentInfo:END');
                        // // 結合したレスポンス
                        // const result = {
                        //     content: content,
                        //     file_info: contentInfo
                        // } as any;
                        // reform(result);
                        // // result.me = reform(JSON.parse(oAuthAccount.userInfo));
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
            info: { group: `gitea-${providerSubName}`, isActive: true, isInteractive: false, label: `リポジトリファイル内容取得`, responseType: 'markdown' },
            definition: {
                type: 'function', function: {
                    name: `gitea_${providerSubName}_file_content_ai_summary`,
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
                let { userPrompt = '要約してください', owner, repo, file_path_list, ref } = args;
                const provider = `gitea-${providerSubName}`;
                const { e } = await getOAuthAccount(req, provider);
                if (GITEA_CONFIDENCIAL_OWNERS.split(',').includes(owner)) {
                    return Promise.resolve(`\`\`\`json\n{ "error": "このリポジトリは機密情報を含むため、表示できません", "details": "機密情報を含むリポジトリの場合、表示を制限しています。" }\n\`\`\``);
                } else { }

                if (ref) {
                    // ブランチ名、タグ名、またはコミットSHAが指定されている場合はそのまま
                } else {
                    const defaultBranchUrl = `${e.uriBase}/api/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
                    const defaultBranchResult = (await e.axiosWithAuth.then(g => g(req.info.user.id)).then(g => g.get<GiteaRepository>(defaultBranchUrl))).data;
                    ref = ref || defaultBranchResult.default_branch || 'main';
                }

                // ファイルの内容を取得
                return await Promise.all(file_path_list.map(async (file_path) => {
                    const url = `${e.uriBase}/api/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/raw/${encodeURIComponent(ref)}/${encodeURIComponent(file_path)}`;
                    try {
                        // raw contentを取得
                        const contentResponse = await e.axiosWithAuth.then(g => g(req.info.user.id)).then(g => g.get(url, { responseType: 'text' }));
                        const content = contentResponse.data;

                        // ファイル情報も取得
                        const contentUrl = `${e.uriBase}/api/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodeURIComponent(file_path)}?ref=${encodeURIComponent(ref)}`;
                        const contentInfo = (await e.axiosWithAuth.then(g => g(req.info.user.id)).then(g => g.get(contentUrl))).data;

                        let trg = file_path.split('\.').at(-1) || '';
                        trg = { cob: 'cobol', cbl: 'cobol', pco: 'cobol', htm: 'html' }[trg] || trg;
                        const codeBlock = `\`\`\`${trg} ${file_path}\n\n${content}\n\`\`\`\n`;
                        const codeInfoBlock = `\`\`\`json\n${JSON.stringify(contentInfo, null, 2)}\n\`\`\`\n`; // ファイル情報

                        const systemPrompt = 'アシスタントAI';
                        const inDto = JSON.parse(JSON.stringify(obj.inDto)); // deep copy
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
                    } catch (error) {
                        // ファイルが見つからない場合など
                        return `\`\`\`json\n{ "error": "ファイルが見つかりません", "details": ${JSON.stringify(Utils.errorFormattedObject(error))} }\n\`\`\`\n\n`;
                    }
                })).then(results => results.join('\n'));
            }
        },
        {
            info: { group: `gitea-${providerSubName}`, isActive: true, isInteractive: false, label: `リポジトリファイル一覧取得（ls風）`, responseType: 'text' },
            definition: {
                type: 'function', function: {
                    name: `gitea_${providerSubName}_repository_tree`,
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
                let { owner, repo, path, ref, recursive, show_directories } = args;
                path = path || '';
                recursive = recursive !== false; // 明示的にfalseの場合のみfalse
                show_directories = show_directories === true; // 明示的にtrueの場合のみtrue

                const { e } = await getOAuthAccount(req, `gitea-${providerSubName}`);

                if (ref) {
                    // ブランチ名、タグ名、またはコミットSHAが指定されている場合はそのまま
                } else {
                    const defaultBranchUrl = `${e.uriBase}/api/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
                    const defaultBranchResult = (await e.axiosWithAuth.then(g => g(req.info.user.id)).then(g => g.get<GiteaRepository>(defaultBranchUrl))).data;
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
                            const pathResponse = await e.axiosWithAuth.then(g => g(req.info.user.id)).then(g => g.get(pathUrl));
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

                    const treeResponse = await e.axiosWithAuth.then(g => g(req.info.user.id)).then(g => g.get(treeUrl));
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
                    const contentsResponse = await e.axiosWithAuth.then(g => g(req.info.user.id)).then(g => g.get(contentsUrl));

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

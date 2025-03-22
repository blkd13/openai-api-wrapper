import { Request, Response } from "express";
import { EntityManager } from "typeorm";
import { map, toArray } from "rxjs";


const { GITEA_CONFIDENCIAL_OWNERS } = process.env as { GITEA_CONFIDENCIAL_OWNERS: string };

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

                const { e, oAuthAccount } = await getOAuthAccount(req, `gitea-${providerSubName}`);

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
        //         const { e, oAuthAccount } = await getOAuthAccount(req, `gitea-${providerSubName}`);

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

        //         const { e, oAuthAccount } = await getOAuthAccount(req, `gitea-${providerSubName}`);

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

                const { e, oAuthAccount } = await getOAuthAccount(req, `gitea-${providerSubName}`);

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

                const { e, oAuthAccount } = await getOAuthAccount(req, `gitea-${providerSubName}`);

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

                const { e, oAuthAccount } = await getOAuthAccount(req, `gitea-${providerSubName}`);

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

                const { e, oAuthAccount } = await getOAuthAccount(req, `gitea-${providerSubName}`);

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
                        required: ['owner', 'repo', 'file_path']
                    }
                }
            },
            handler: async (args: { owner: string, repo: string, file_path: string, ref: string }): Promise<string | { error: string, details: unknown | string }> => {
                let { owner, repo, file_path, ref } = args;
                ref = ref || 'main';
                const { e, oAuthAccount } = await getOAuthAccount(req, `gitea-${providerSubName}`);
                if (GITEA_CONFIDENCIAL_OWNERS.split(',').includes(owner)) {
                    return { error: `このリポジトリは共有禁止されています。`, details: owner };
                } else { }
                const url = `${e.uriBase}/api/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/raw/${encodeURIComponent(ref)}/${encodeURIComponent(file_path)}`;
                try {
                    // raw contentを取得
                    const contentResponse = await e.axiosWithAuth.then(g => g(req.info.user.id)).then(g => g.get(url, { responseType: 'text' }));
                    const content = contentResponse.data;

                    // ファイル情報も取得
                    const contentUrl = `${e.uriBase}/api/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodeURIComponent(file_path)}?ref=${encodeURIComponent(ref)}`;
                    const contentInfo = (await e.axiosWithAuth.then(g => g(req.info.user.id)).then(g => g.get(contentUrl))).data;
                    console.log('contentInfo:START');
                    console.dir(contentInfo);
                    console.log('contentInfo:END');
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

                    return `\`\`\`${trg} ${file_path}\n\n${content}\`\`\`\n`;
                } catch (error) {
                    // ファイルが見つからない場合など
                    return {
                        error: "ファイルの取得に失敗しました",
                        details: Utils.errorFormattedObject(error),
                    };
                }
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
                            show_directories: {
                                type: 'boolean',
                                description: 'ディレクトリも表示するかどうか',
                                default: false
                            }
                        },
                        required: ['owner', 'repo']
                    }
                }
            },
            handler: async (args: { owner: string, repo: string, path: string, ref: string, recursive: boolean, show_directories: boolean }): Promise<any> => {
                let { owner, repo, path, ref, recursive, show_directories } = args;
                path = path || '';
                ref = ref || 'main';
                recursive = recursive !== false; // 明示的にfalseの場合のみfalse
                show_directories = show_directories === true; // 明示的にtrueの場合のみtrue

                const { e, oAuthAccount } = await getOAuthAccount(req, `gitea-${providerSubName}`);

                // GitEAの再帰的な取得とパス解決のためのロジック
                let allItems: any[] = [];

                try {
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
                    const formattedItems = allItems.map(item => {
                        const type = item.type === 'tree' ? 'd' : '-';
                        const mode = item.mode || '100644'; // デフォルトパーミッション
                        const formattedMode = formatMode(mode);
                        const fullPath = item.path;
                        return `${type}${formattedMode} ${item.sha} ${fullPath}${item.type === 'tree' ? '/' : ''}`;
                    });

                    output += formattedItems.join('\n');
                    return output;
                } catch (error) {
                    return {
                        error: "ファイル一覧の取得に失敗しました",
                        details: Utils.errorFormattedObject(error),
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

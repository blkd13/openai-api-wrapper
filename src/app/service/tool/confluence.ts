import { MyToolType, OpenAIApiWrapper, providerPrediction } from "../../common/openai-api-wrapper.js";
import { UserRequest } from "../models/info.js";
import { ContentPartEntity, MessageEntity, MessageGroupEntity, PredictHistoryWrapperEntity } from "../entity/project-models.entity.js";
import { MessageArgsSet } from "../controllers/chat-by-project-model.js";
import { getOAuthAccountForTool, reform } from "./common.js";

// 1. 関数マッピングの作成
export async function confluenceFunctionDefinitions(providerSubName: string,
    obj: { inDto: MessageArgsSet; messageSet: { messageGroup: MessageGroupEntity; message: MessageEntity; contentParts: ContentPartEntity[]; }; },
    req: UserRequest, aiApi: OpenAIApiWrapper, connectionId: string, streamId: string, message: MessageEntity, label: string,
): Promise<MyToolType[]> {
    const provider = `confluence-${providerSubName}`;
    return [
        {
            info: { group: provider, isActive: true, isInteractive: false, label: `コンテンツ内容取得`, },
            definition: {
                type: 'function', function: {
                    name: `confluence_${providerSubName}_get_contents`,
                    description: `のConfluence（${providerSubName}）サイトのコンテンツ内容取得`,
                    parameters: {
                        type: 'object',
                        properties: {
                            id: {
                                type: 'number',
                                description: `取得対象コンテンツのID。`,
                            },
                        },
                        required: ['id'],
                    }
                }
            },
            handler: async (args: { id: number }): Promise<any> => {
                const { e, axiosWithAuth } = await getOAuthAccountForTool(req, provider);
                let { id } = args;

                let url, data;
                url = `${e.uriBase}/rest/api/content/${id}?expand=body.storage`;
                const result = (await axiosWithAuth.get(url)).data;
                // result.me = oAuthAccount.userInfo;
                result.uriBase = e.uriBase;
                // console.dir(result, { depth: null });
                return result;
            }
        },
        {
            info: { group: provider, isActive: true, isInteractive: false, label: `汎用検索`, },
            definition: {
                type: 'function', function: {
                    name: `confluence_${providerSubName}_search`,
                    description: `のConfluence（${providerSubName}）サイトでのCQL (Confluence Query Language)を使った汎用的な検索`,
                    parameters: {
                        type: 'object',
                        properties: {
                            limit: { type: 'number', description: '取得する最大数。1以上200以下', default: 50, minimum: 1, maximum: 200 },
                            cql: {
                                type: 'string',
                                description: `CQL (Confluence Query Language)での検索条件指定。\nCQL文法で記載すること。`,
                            },
                        },
                        required: ['cql'],
                    }
                }
            },
            handler: async (args: { limit: number, cql: string }): Promise<any> => {
                const { e, axiosWithAuth } = await getOAuthAccountForTool(req, provider);
                let { limit } = args;
                limit = Math.max(Math.min(limit || 50, 200), 1); // 1以上200以下

                const url = `${e.uriBase}/rest/api/search?cql=${encodeURIComponent(args.cql)}&limit=${limit}`;
                const result = (await axiosWithAuth.get(url)).data;

                reform(result);
                // result.me = reform(oAuthAccount.userInfo);
                result.uriBase = e.uriBase;
                return result;
            }
        },
        {
            info: { group: provider, isActive: true, isInteractive: false, label: `confluence-${providerSubName}：自分のユーザー情報`, },
            definition: {
                type: 'function', function: {
                    name: `confluence_${providerSubName}_user_info`,
                    description: `confluence-${providerSubName}：自分のユーザー情報`,
                    parameters: { type: 'object', properties: {}, }
                }
            },
            handler: async (args: {}): Promise<any> => {
                const { e, oAuthAccount, axiosWithAuth } = await getOAuthAccountForTool(req, provider);
                const url = `${e.uriBase}${e.pathUserInfo}`;
                const result = (await axiosWithAuth.get(url)).data;

                reform(result);
                result.me = reform(oAuthAccount.userInfo);
                result.uriBase = e.uriBase;
                return result;
            }
        },
        {
            info: { group: provider, isActive: true, isInteractive: false, label: `コンテンツ作成`, },
            definition: {
                type: 'function', function: {
                    name: `confluence_${providerSubName}_create_content`,
                    description: `のConfluence（${providerSubName}）サイトで新しいページまたはブログ記事を作成`,
                    parameters: {
                        type: 'object',
                        properties: {
                            spaceKey: { type: 'string', description: 'スペースキー（例: TEST, PROJ）' },
                            title: { type: 'string', description: 'ページのタイトル' },
                            body: { type: 'string', description: 'ページの内容（HTML形式）' },
                            type: { type: 'string', description: 'コンテンツタイプ', enum: ['page', 'blogpost'], default: 'page' },
                            parentId: { type: 'number', description: '親ページのID（ページを子ページとして作成する場合）' },
                            labels: { type: 'array', items: { type: 'string' }, description: 'ラベルの配列', default: [] }
                        },
                        required: ['spaceKey', 'title', 'body']
                    }
                }
            },
            handler: async (args: { spaceKey: string, title: string, body: string, type?: string, parentId?: number, labels?: string[] }): Promise<any> => {
                const { e, axiosWithAuth } = await getOAuthAccountForTool(req, provider);
                const { spaceKey, title, body, type = 'page', parentId, labels = [] } = args;

                const contentData: any = {
                    type: type,
                    title: title,
                    space: { key: spaceKey },
                    body: {
                        storage: {
                            value: body,
                            representation: 'storage'
                        }
                    }
                };

                if (parentId) {
                    contentData.ancestors = [{ id: parentId }];
                }

                if (labels.length > 0) {
                    contentData.metadata = {
                        labels: labels.map(label => ({ name: label }))
                    };
                }

                const url = `${e.uriBase}/rest/api/content`;
                const result = (await axiosWithAuth.post(url, contentData)).data;

                reform(result);
                result.uriBase = e.uriBase;
                return result;
            }
        },
        {
            info: { group: provider, isActive: true, isInteractive: false, label: `コンテンツ更新`, },
            definition: {
                type: 'function', function: {
                    name: `confluence_${providerSubName}_update_content`,
                    description: `のConfluence（${providerSubName}）サイトで既存のページまたはブログ記事を更新（バージョン番号は指定可能、未指定時は自動取得・インクリメント）`,
                    parameters: {
                        type: 'object',
                        properties: {
                            id: { type: 'number', description: '更新するコンテンツのID' },
                            title: { type: 'string', description: '新しいタイトル' },
                            body: { type: 'string', description: '新しい内容（HTML形式）' },
                            version: { type: 'number', description: '期待する現在のバージョン番号（競合回避のため）。未指定時は自動取得してインクリメント' },
                            labels: { type: 'array', items: { type: 'string' }, description: '新しいラベルの配列' }
                        },
                        required: ['id', 'title', 'body']
                    }
                }
            },
            handler: async (args: { id: number, title: string, body: string, version?: number, labels?: string[] }): Promise<any> => {
                const { e, axiosWithAuth } = await getOAuthAccountForTool(req, provider);
                const { id, title, body, version, labels } = args;

                let currentVersion: number;
                let contentType: string;

                if (version !== undefined) {
                    // バージョンが指定されている場合は、競合チェックのため現在のバージョンを確認
                    const getCurrentUrl = `${e.uriBase}/rest/api/content/${id}?expand=version`;
                    const currentContent = (await axiosWithAuth.get(getCurrentUrl)).data;
                    currentVersion = currentContent.version.number;
                    contentType = currentContent.type;

                    if (currentVersion !== version) {
                        throw new Error(`Version conflict: Expected version ${version}, but current version is ${currentVersion}. Please refresh and try again.`);
                    }
                } else {
                    // バージョンが指定されていない場合は自動取得
                    const getCurrentUrl = `${e.uriBase}/rest/api/content/${id}?expand=version`;
                    const currentContent = (await axiosWithAuth.get(getCurrentUrl)).data;
                    currentVersion = currentContent.version.number;
                    contentType = currentContent.type;
                }

                const updateData: any = {
                    id: id,
                    type: contentType,
                    title: title,
                    body: {
                        storage: {
                            value: body,
                            representation: 'storage'
                        }
                    },
                    version: {
                        number: currentVersion + 1
                    }
                };

                if (labels) {
                    updateData.metadata = {
                        labels: labels.map(label => ({ name: label }))
                    };
                }

                const url = `${e.uriBase}/rest/api/content/${id}`;
                const result = (await axiosWithAuth.put(url, updateData)).data;

                reform(result);
                result.uriBase = e.uriBase;
                result.previousVersion = currentVersion;
                result.newVersion = currentVersion + 1;
                result.versionCheckPerformed = version !== undefined;
                return result;
            }
        },
        {
            info: { group: provider, isActive: true, isInteractive: false, label: `コンテンツ削除`, },
            definition: {
                type: 'function', function: {
                    name: `confluence_${providerSubName}_delete_content`,
                    description: `のConfluence（${providerSubName}）サイトでページまたはブログ記事を削除`,
                    parameters: {
                        type: 'object',
                        properties: {
                            id: { type: 'number', description: '削除するコンテンツのID' }
                        },
                        required: ['id']
                    }
                }
            },
            handler: async (args: { id: number }): Promise<any> => {
                const { e, axiosWithAuth } = await getOAuthAccountForTool(req, provider);
                const { id } = args;

                const url = `${e.uriBase}/rest/api/content/${id}`;
                const result = (await axiosWithAuth.delete(url)).data;

                reform(result);
                result.uriBase = e.uriBase;
                return result;
            }
        },
        {
            info: { group: provider, isActive: true, isInteractive: false, label: `コメント追加`, },
            definition: {
                type: 'function', function: {
                    name: `confluence_${providerSubName}_add_comment`,
                    description: `のConfluence（${providerSubName}）サイトでページにコメントを追加`,
                    parameters: {
                        type: 'object',
                        properties: {
                            contentId: { type: 'number', description: 'コメントを追加するコンテンツのID' },
                            body: { type: 'string', description: 'コメント内容（HTML形式）' }
                        },
                        required: ['contentId', 'body']
                    }
                }
            },
            handler: async (args: { contentId: number, body: string }): Promise<any> => {
                const { e, axiosWithAuth } = await getOAuthAccountForTool(req, provider);
                const { contentId, body } = args;

                const commentData = {
                    type: 'comment',
                    container: { id: contentId },
                    body: {
                        storage: {
                            value: body,
                            representation: 'storage'
                        }
                    }
                };

                const url = `${e.uriBase}/rest/api/content`;
                const result = (await axiosWithAuth.post(url, commentData)).data;

                reform(result);
                result.uriBase = e.uriBase;
                return result;
            }
        },
        {
            info: { group: provider, isActive: true, isInteractive: false, label: `ラベル追加`, },
            definition: {
                type: 'function', function: {
                    name: `confluence_${providerSubName}_add_labels`,
                    description: `のConfluence（${providerSubName}）サイトでコンテンツにラベルを追加`,
                    parameters: {
                        type: 'object',
                        properties: {
                            id: { type: 'number', description: 'ラベルを追加するコンテンツのID' },
                            labels: { type: 'array', items: { type: 'string' }, description: '追加するラベルの配列' }
                        },
                        required: ['id', 'labels']
                    }
                }
            },
            handler: async (args: { id: number, labels: string[] }): Promise<any> => {
                const { e, axiosWithAuth } = await getOAuthAccountForTool(req, provider);
                const { id, labels } = args;

                const labelData = labels.map(label => ({ name: label }));

                const url = `${e.uriBase}/rest/api/content/${id}/label`;
                const result = (await axiosWithAuth.post(url, labelData)).data;

                reform(result);
                result.uriBase = e.uriBase;
                return result;
            }
        },
        {
            info: { group: provider, isActive: true, isInteractive: false, label: `ラベル削除`, },
            definition: {
                type: 'function', function: {
                    name: `confluence_${providerSubName}_remove_label`,
                    description: `のConfluence（${providerSubName}）サイトでコンテンツからラベルを削除`,
                    parameters: {
                        type: 'object',
                        properties: {
                            id: { type: 'number', description: 'ラベルを削除するコンテンツのID' },
                            label: { type: 'string', description: '削除するラベル名' }
                        },
                        required: ['id', 'label']
                    }
                }
            },
            handler: async (args: { id: number, label: string }): Promise<any> => {
                const { e, axiosWithAuth } = await getOAuthAccountForTool(req, provider);
                const { id, label } = args;

                const url = `${e.uriBase}/rest/api/content/${id}/label/${encodeURIComponent(label)}`;
                const result = (await axiosWithAuth.delete(url)).data;

                reform(result);
                result.uriBase = e.uriBase;
                return result;
            }
        },
        {
            info: { group: provider, isActive: true, isInteractive: false, label: `スペース作成`, },
            definition: {
                type: 'function', function: {
                    name: `confluence_${providerSubName}_create_space`,
                    description: `のConfluence（${providerSubName}）サイトで新しいスペースを作成`,
                    parameters: {
                        type: 'object',
                        properties: {
                            key: { type: 'string', description: 'スペースキー（一意）' },
                            name: { type: 'string', description: 'スペース名' },
                            description: { type: 'string', description: 'スペースの説明', default: '' },
                            type: { type: 'string', description: 'スペースタイプ', enum: ['global', 'personal'], default: 'global' }
                        },
                        required: ['key', 'name']
                    }
                }
            },
            handler: async (args: { key: string, name: string, description?: string, type?: string }): Promise<any> => {
                const { e, axiosWithAuth } = await getOAuthAccountForTool(req, provider);
                const { key, name, description = '', type = 'global' } = args;

                const spaceData = {
                    key: key,
                    name: name,
                    description: {
                        plain: {
                            value: description,
                            representation: 'plain'
                        }
                    },
                    type: type
                };

                const url = `${e.uriBase}/rest/api/space`;
                const result = (await axiosWithAuth.post(url, spaceData)).data;

                reform(result);
                result.uriBase = e.uriBase;
                return result;
            }
        },
    ];
};

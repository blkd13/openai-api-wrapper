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
                // result.me = JSON.parse(oAuthAccount.userInfo);
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
                // result.me = reform(JSON.parse(oAuthAccount.userInfo));
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
                result.me = reform(JSON.parse(oAuthAccount.userInfo));
                result.uriBase = e.uriBase;
                return result;
            }
        },
    ];
};

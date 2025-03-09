import { Request, Response } from "express";
import { EntityManager } from "typeorm";
import { map, toArray } from "rxjs";

import { MyToolType, OpenAIApiWrapper, providerPrediction } from "../../common/openai-api-wrapper.js";
import { UserRequest } from "../models/info.js";
import { ContentPartEntity, MessageEntity, MessageGroupEntity, PredictHistoryWrapperEntity } from "../entity/project-models.entity.js";
import { axiosWithoutProxy, readOAuth2Env } from "../controllers/auth.js";
import { MessageArgsSet } from "../controllers/chat-by-project-model.js";
import { Utils } from "../../common/utils.js";
import { ds } from "../db.js";
import { OAuthAccountEntity } from "../entity/auth.entity.js";
import { decrypt } from "../controllers/tool-call.js";
import { getOAuthAccount, reform } from "./common.js";
import axios from "axios";


// 1. 関数マッピングの作成
export function confluenceFunctionDefinitions(providerSubName: string,
    obj: { inDto: MessageArgsSet; messageSet: { messageGroup: MessageGroupEntity; message: MessageEntity; contentParts: ContentPartEntity[]; }; },
    req: UserRequest, aiApi: OpenAIApiWrapper, connectionId: string, streamId: string, message: MessageEntity, label: string,
): MyToolType[] {
    return [
        {
            info: { group: `confluence-${providerSubName}`, isActive: true, isInteractive: false, label: `コンテンツ内容取得`, },
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
                let { id } = args;
                const user_id = req.info.user.id;
                if (!user_id) {
                    throw new Error("User ID is required.");
                }
                const provider = `confluence-${providerSubName}`;
                const e = readOAuth2Env(provider);

                const oAuthAccount = await ds.getRepository(OAuthAccountEntity).findOneOrFail({
                    where: { provider: provider, userId: req.info.user.id }
                });

                let url, data;
                url = `${e.uriBase}/rest/api/content/${id}?expand=body.storage`;
                const result = (await e.axios.get(url, {
                    headers: { 'Authorization': `Bearer ${decrypt(oAuthAccount.accessToken)}`, }
                }).catch(error => {
                    if (error && error.response && error.response.status === 400) {
                        return error.response;
                    } else {
                        throw error;
                    }
                })).data;
                // result.me = JSON.parse(oAuthAccount.userInfo);
                result.uriBase = e.uriBase;

                // console.dir(result, { depth: null });
                return result;
            }
        },
        {
            info: { group: `confluence-${providerSubName}`, isActive: true, isInteractive: false, label: `汎用検索`, },
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
                let { limit } = args;
                limit = Math.max(Math.min(limit || 50, 200), 1); // 1以上200以下
                const { e, oAuthAccount } = await getOAuthAccount(req, `confluence-${providerSubName}`);

                const url = `${e.uriBase}/rest/api/search?cql=${encodeURIComponent(args.cql)}&limit=${limit}`;
                const result = (await e.axiosWithAuth.then(g => g(req.info.user.id)).then(g => g.get(url))).data;

                reform(result);
                // result.me = reform(JSON.parse(oAuthAccount.userInfo));
                result.uriBase = e.uriBase;
                return result;
            }
        },
        {
            info: { group: `confluence-${providerSubName}`, isActive: true, isInteractive: false, label: `confluence-${providerSubName}：自分のユーザー情報`, },
            definition: {
                type: 'function', function: {
                    name: `confluence_${providerSubName}_user_info`,
                    description: `confluence-${providerSubName}：自分のユーザー情報`,
                    parameters: { type: 'object', properties: {}, }
                }
            },
            handler: async (args: {}): Promise<any> => {
                const { e, oAuthAccount } = await getOAuthAccount(req, `confluence-${providerSubName}`);

                const url = `${e.uriBase}${e.pathUserInfo}`;
                const result = (await e.axiosWithAuth.then(g => g(req.info.user.id)).then(g => g.get(url))).data;

                reform(result);
                result.me = reform(JSON.parse(oAuthAccount.userInfo));
                result.uriBase = e.uriBase;
                return result;
            }
        },
    ];
};

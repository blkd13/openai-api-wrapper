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
export function jiraFunctionDefinitions(providerSubName: string,
    obj: { inDto: MessageArgsSet; messageSet: { messageGroup: MessageGroupEntity; message: MessageEntity; contentParts: ContentPartEntity[]; }; },
    req: UserRequest, aiApi: OpenAIApiWrapper, connectionId: string, streamId: string, message: MessageEntity, label: string,
): MyToolType[] {
    return [
        {
            info: { group: `jira-${providerSubName}`, isActive: true, isInteractive: false, label: `jira-${providerSubName}：自分のユーザー情報`, },
            definition: {
                type: 'function', function: {
                    name: `jira_${providerSubName}_user_info`,
                    description: `jira-${providerSubName}：自分のユーザー情報と良く使うプロジェクト`,
                    parameters: { type: 'object', properties: {}, }
                }
            },
            handler: async (args: {}): Promise<any> => {
                const { e, oAuthAccount } = await getOAuthAccount(req, `jira-${providerSubName}`);
                const axiosWithAuth = await e.axiosWithAuth.then(g => g(req.info.user.id));

                // ユーザー情報を取得
                const result = (await axiosWithAuth.get(`${e.uriBase}${e.pathUserInfo}`)).data;

                // 参照履歴を取得
                const historyUrl = `${e.uriBase}/rest/api/1.0/menus/browse_link?inAdminMode=false`;
                const resultCurrent = (await axiosWithAuth.get(historyUrl, { headers: { 'Content-Type': 'application/json' } })).data;

                reform(result);
                result.current = resultCurrent;
                result.uriBase = e.uriBase;
                return result;
            }
        },
        {
            info: { group: `jira-${providerSubName}`, isActive: true, isInteractive: false, label: `jira-${providerSubName}：JQL v2での検索`, },
            definition: {
                type: 'function', function: {
                    name: `jira_${providerSubName}_jql_v2_search`,
                    description: `jira-${providerSubName}：JQL v2での検索`,
                    parameters: {
                        type: 'object',
                        properties: {
                            maxResults: { type: 'number', description: '取得する最大数。1以上200以下', default: 10, minimum: 1, maximum: 20 },
                            jql: {
                                type: 'string',
                                description: `JQL (Jira Query Language)の"v2"での検索条件指定。`,
                            },

                        },
                        required: ['jql'],
                    },
                }
            },
            handler: async (args: { jql: string, maxResults: number }): Promise<any> => {
                const { jql, maxResults = 10 } = args;

                const { e, oAuthAccount } = await getOAuthAccount(req, `jira-${providerSubName}`);
                const axiosWithAuth = await e.axiosWithAuth.then(g => g(req.info.user.id));

                // ユーザー情報を取得
                const url = `${e.uriBase}/rest/api/2/search?jql=${encodeURIComponent(jql)}&maxResults=${maxResults}`;
                const result = (await axiosWithAuth.get(url)).data;

                reform(result);
                result.uriBase = e.uriBase;
                return result;
            }
        },
    ];
};

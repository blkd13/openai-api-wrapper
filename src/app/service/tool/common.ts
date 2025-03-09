import { Request, Response } from "express";
import { EntityManager } from "typeorm";
import { map, toArray } from "rxjs";

import { MyToolType, OpenAIApiWrapper, providerPrediction } from "../../common/openai-api-wrapper.js";
import { UserRequest } from "../models/info.js";
import { ContentPartEntity, MessageEntity, MessageGroupEntity, PredictHistoryWrapperEntity } from "../entity/project-models.entity.js";
import { OAuth2Env, readOAuth2Env } from "../controllers/auth.js";
import { MessageArgsSet } from "../controllers/chat-by-project-model.js";
import { Utils } from "../../common/utils.js";
import { boxFunctionDefinitions } from "./box.js";
import { mattermostFunctionDefinitions } from "./mattermost.js";
import { confluenceFunctionDefinitions } from "./confluence.js";
import { jiraFunctionDefinitions } from "./jira.js";
import { ds } from "../db.js";
import { OAuthAccountEntity } from "../entity/auth.entity.js";
import { gitlabFunctionDefinitions } from "./gitlab.js";
import { giteaFunctionDefinitions } from "./gitea.js";

const aiModels = [
    { 'model': 'gemini-2.0-flash-001', 'description': 'gemini-1.5-flashの次世代モデル。前世代を上回る性能。' },
    { 'model': 'gpt-4o', 'description': '高評価。自然な対話、速度とコスト効率の良さが評価されている。', },
    { 'model': 'o1', 'description': '内部推論モデル。超高精度だが遅くて、高コスト。', },
    { 'model': 'o3-mini', 'description': '内部推論モデル。超高精度だが遅くて、高コスト。', },
    // { 'model': 'gemini-1.5-flash', 'description': '高速かつ効率的、Gemini 1.5 Proの軽量版。大量の情報を迅速に処理するニーズに応え、コスト効率も高い。リアルタイム処理が求められる場面での活用が期待されている。', },
    { 'model': 'gemini-1.5-pro', 'description': '長文コンテキスト処理能力に優れる。大量のテキストやコードの解析に強みを発揮。特定のタスクにおいて既存モデルを超える性能を示す。', },
    { 'model': 'gemini-2.0-pro-exp-02-05', 'description': 'gemini-1.5-proの次世代モデル。前世代を上回る性能を持つが、試験運用版のためやや不安定な動作もある。' },
    { 'model': 'claude-3-5-sonnet-20241022', 'description': '推論、コーディング、コンテンツ作成など多様なタスクに対応。安全性と倫理的な配慮が重視されており、企業での利用に適している。バランスの取れた性能も評価されている。', },
    { 'model': 'claude-3-7-sonnet-20250219', 'description': '推論、コーディング、コンテンツ作成など多様なタスクに対応。安全性と倫理的な配慮が重視されており、企業での利用に適している。バランスの取れた性能も評価されている。ツール利用が得意', },
];


// 1. 関数マッピングの作成
export function functionDefinitions(
    obj: { inDto: MessageArgsSet; messageSet: { messageGroup: MessageGroupEntity; message: MessageEntity; contentParts: ContentPartEntity[]; }; },
    req: UserRequest, aiApi: OpenAIApiWrapper, connectionId: string, streamId: string, message: MessageEntity, label: string,
): MyToolType[] {
    const functionDefinitions = [
        ...mattermostFunctionDefinitions(obj, req, aiApi, connectionId, streamId, message, label),
        ...boxFunctionDefinitions(obj, req, aiApi, connectionId, streamId, message, label),
        ...confluenceFunctionDefinitions('', obj, req, aiApi, connectionId, streamId, message, label),
        ...jiraFunctionDefinitions('', obj, req, aiApi, connectionId, streamId, message, label),
        ...giteaFunctionDefinitions('local', obj, req, aiApi, connectionId, streamId, message, label),
        ...gitlabFunctionDefinitions('local', obj, req, aiApi, connectionId, streamId, message, label),
        {
            info: { group: 'ai', isActive: false, isInteractive: true, label: '要約', },
            command: {},
            definition: {
                type: 'function', function: {
                    name: 'summarize_text',
                    description: `文書を要約する。`,
                    parameters: {
                        type: 'object',
                        properties: {
                            text: { type: 'string', description: '要約対象のテキスト' },
                        },
                        required: ['text']
                    }
                }
            },
            handler: async (args: { text: string }): Promise<string> => {
                return Promise.resolve(`summarize_text: ${args.text}`);
            },
        },
        {
            info: { group: 'ai', isActive: false, isInteractive: true },
            definition: {
                type: 'function', function: {
                    name: 'call_ai',
                    label: 'AI呼び出し',
                    description: `AIを呼び出す。AIモデル:\n${JSON.stringify(aiModels)}`,
                    parameters: {
                        type: 'object',
                        properties: {
                            systemPrompt: { type: 'string', description: 'AIに渡すシステムプロンプト', default: 'アシスタントAI' },
                            userPrompt: { type: 'string', description: 'AIに渡すユーザープロンプト' },
                            model: { type: 'string', description: `AIモデル:\n${JSON.stringify(aiModels)}`, enum: aiModels.map(m => m.model), default: aiModels[0].model },
                            // style: { type: 'string', description: '要約のスタイル。箇条書き、短文など', enum: ['short', 'bullet'] }
                        },
                        required: ['userPrompt']
                    }
                }
            },
            handler: async (args: { systemPrompt: string, userPrompt: string, model: string }): Promise<string> => {
                let { systemPrompt, userPrompt, model } = args;
                systemPrompt = systemPrompt || 'アシスタントAI';
                if (!userPrompt) {
                    throw new Error("User prompt is required.");
                } else { }

                const inDto = JSON.parse(JSON.stringify(obj.inDto)); // deep copy
                inDto.args.model = model || inDto.args.model; // modelが指定されていない場合は元のモデルを使う
                inDto.args.messages = [
                    { role: 'system', content: [{ type: 'text', text: systemPrompt }] },
                    { role: 'user', content: [{ type: 'text', text: userPrompt }] },
                ];
                // toolは使わないので空にしておく
                delete inDto.args.tool_choice;
                delete inDto.args.tools;

                const provider = providerPrediction(inDto.args.model);

                const newLabel = `${label}-call_ai-${model}`;
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
                        inDto.args, { label: newLabel }, provider,
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
            },
        },
        {
            info: { group: 'all', isActive: false, isInteractive: true, label: '選択肢を提示', },
            definition: {
                type: 'function', function: {
                    name: 'promptForChoice',
                    description: 'ユーザーに選択肢を提示して選択させる',
                    parameters: {
                        type: 'object',
                        properties: {
                            options: {
                                type: 'array', description: '選択肢の配列',
                                items: {
                                    type: 'object',
                                    properties: {
                                        label: {
                                            type: 'string',
                                            description: '選択肢の表示ラベル'
                                        },
                                        value: {
                                            type: 'string',
                                            description: '選択時に返される値'
                                        }
                                    },
                                    required: ['label', 'value']
                                }
                            },
                        },
                        required: ['options']
                    }
                }
            },
            handler: (args: { options: { label: string, value: string }[] }): Promise<string> => {
                console.log('Prompting for choice with options:+------------------------56', args);
                const { options } = args;
                if (!options) {
                    console.log('Prompting for choice with options:+------------------------------------------------', args);
                    throw new Error("Options are required.");
                }
                console.log("Prompting for choice with options:", options);
                return Promise.resolve('dummy2');
            }
        } as MyToolType,
    ].map(_func => {
        const func = _func as MyToolType;
        // nameの補充（二重定義になると修正時漏れが怖いので、nameは一か所で定義してここで補充する）
        func.info.name = func.definition.function.name;
        func.definition.function.description = `${func.info.group}\n${func.definition.function.description}`;
        return func;
    }).filter((func, index, self) => func.info.isActive && index === self.findIndex(t => t.definition.function.name === func.definition.function.name)) as MyToolType[];
    return functionDefinitions;
}

export interface ElasticsearchResponse {
    took: number;
    timed_out: boolean;
    _shards: {
        total: number;
        successful: number;
        skipped: number;
        failed: number;
    };
    hits: {
        total: {
            value: number;
            relation: string;
        };
        max_score: number;
        hits: Array<{
            _index: string;
            _id: string;
            _score: number;
            _source: {
                "ai.content": string;
                "ai.title": string;
                filetype: string;
                completion: string;
                sitename: string;
                click_count: number;
                label: string[];
                last_modified: string;
                url: string;
                content_length: string;
            };
            highlight: {
                "ai.content": string[];
                "ai.title": string[];
                title_ja: string[];
                content_ja: string[];
            };
        }>;
    };
}


export async function getOAuthAccount(req: UserRequest, provider: string): Promise<{ e: OAuth2Env, oAuthAccount: OAuthAccountEntity }> {
    const user_id = req.info.user.id;
    if (!user_id) {
        throw new Error("User ID is required.");
    }
    const e = readOAuth2Env(provider);
    const oAuthAccount = await ds.getRepository(OAuthAccountEntity).findOneOrFail({
        where: { provider, userId: req.info.user.id },
    });
    return { e, oAuthAccount };
}


export function reform(obj: any, deleteProps: boolean = true): any {
    // null、undefined、0の場合はundefinedを返す
    if (obj === null || obj === undefined || (typeof obj === 'number' && obj === 0)) {
        return undefined;
    }

    // Dateオブジェクトの場合はフォーマット済みの文字列に変換
    if (obj instanceof Date) {
        return Utils.formatDate(obj);
    }

    // オブジェクトの場合
    if (typeof obj === 'object') {
        const keys = Object.keys(obj);

        // 各キーに対して処理
        for (const key of keys) {
            // アンダースコアで始まるキーは削除
            if (key.startsWith('_')) {
                delete obj[key];
                continue;
            }

            // "_at"で終わるキーの特別処理（日付関連）
            if ((key.toLowerCase().endsWith('_at') || key.toLowerCase().endsWith('time')) && typeof obj[key] === 'number') {
                // console.log(`key=${key}, value=${obj[key]}  ${typeof obj[key]}`);
                obj[key] = Utils.formatDate(new Date(obj[key]));
            } else {

                // 通常のプロパティの処理
                if (obj[key] && typeof obj[key] === 'object' && Object.keys(obj[key]).length === 0 && deleteProps) {
                    delete obj[key];
                } else {

                    // 配列の場合
                    if (Array.isArray(obj[key])) {
                        if (obj[key].length > 5) {
                            // キーが全アイテムで一致していたらkeysとdataに分離してデータ圧縮する。
                            // const keys = Object.keys(obj[key][0]);
                            const keySet: Set<string> = new Set<string>();
                            let flag = false;
                            for (let i = 0; i < obj[key].length; i++) {
                                if (Array.isArray(obj[key][i])) {
                                    obj[key] = reform(obj[key]);
                                } else if (typeof obj[key][i] === 'object' && obj[key][i]) {
                                    flag = true;
                                    Object.keys(obj[key][i]).forEach(subKey => {
                                        if (Array.isArray(obj[key][i][subKey]) && obj[key][i][subKey].length === 0) {
                                        } else if (typeof obj[key][i][subKey] === 'object' && Object.keys(obj[key][i][subKey]).length === 0) {
                                        } else if (obj[key][i][subKey] === undefined || obj[key][i][subKey] === null || obj[key][i][subKey] === '') {
                                        } else {
                                            keySet.add(subKey);
                                        }
                                    });
                                }
                            }
                            if (flag) {
                                const keys = Array.from(keySet);
                                const dateIndexes = keys.map((key, index) => ({ index, isDate: key.toLowerCase().endsWith('_at') || key.toLowerCase().endsWith('time') })).filter(m => m.isDate).map(m => m.index);
                                obj[key] = {
                                    keys,
                                    data: obj[key].map((rec: any) => keys.map((key, index) => {
                                        if (dateIndexes.includes(index) && typeof rec[key] === 'number') {
                                            rec[key] = Utils.formatDate(new Date(rec[key]));
                                        } else {
                                            reform(rec[key]);
                                        }
                                        return rec[key];
                                    })),
                                };
                            } else {
                                // console.log(`keysString=${keysString}`);
                            }
                        } else {
                            // 5件以下の場合は圧縮しない
                        }

                        if (obj[key].length === 0) {
                            delete obj[key];
                        }

                        // 各要素に対して再帰的に処理
                        for (let i = 0; i < obj[key].length; i++) {
                            obj[key][i] = reform(obj[key][i], deleteProps);
                        }
                    } else {

                        const processed = reform(obj[key], deleteProps);
                        if (
                            (processed === undefined || processed === null || processed === '' || (typeof processed === 'number' && processed === 0))
                            && deleteProps
                        ) {
                            delete obj[key];
                        } else {
                            if (processed === 'true') {
                                obj[key] = true;
                            } else if (processed === 'false') {
                                obj[key] = false;
                            } else {
                                obj[key] = processed;
                            }
                        }
                    }
                }
            }
        }

        // すべてのキーが削除された場合はundefinedを返す
        if (Object.keys(obj).length === 0 && deleteProps) {
            return undefined;
        }

        return obj;
    }

    // 文字列やその他の型はそのまま返す
    return obj;
}
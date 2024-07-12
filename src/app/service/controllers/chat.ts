import * as http from 'http';
import { Request, Response } from "express";
import { body, query } from "express-validator";
import axios from 'axios';

import { OpenAIApiWrapper, countChars, my_vertexai, normalizeMessage, vertex_ai } from '../../common/openai-api-wrapper.js';
import { validationErrorHandler } from "../middleware/validation.js";
import { UserRequest } from "../models/info.js";
import { ChatCompletionCreateParamsStreaming } from "openai/resources/index.js";
import { ds } from '../db.js';
import { DiscussionEntity, TaskEntity, StatementEntity } from '../entity/project-models.entity.js';
import { enqueueGenerator, qSubject } from './project-models.js';
import { GenerateContentRequest, HarmBlockThreshold, HarmCategory } from '@google-cloud/vertexai';


import * as dotenv from 'dotenv';
import { HttpsProxyAgent } from 'https-proxy-agent';
dotenv.config();
const { GCP_PROJECT_ID, GCP_CONTEXT_CACHE_LOCATION } = process.env;

const proxyObj: { [key: string]: string | undefined } = {
    httpProxy: process.env['http_proxy'] as string || undefined,
    httpsProxy: process.env['https_proxy'] as string || undefined,
};
const httpsAgent = new HttpsProxyAgent(proxyObj.httpsProxy || proxyObj.httpProxy || '');
axios.defaults.httpsAgent = httpsAgent;

import { GenerateContentRequestForCache, mapForGemini } from '../../common/my-vertexai.js';

// Eventクライアントリスト
export const clients: Record<string, { id: string; response: http.ServerResponse; }> = {};

/**
 * [user認証] イベントの初期化
 */
export const initEvent = [
    query('connectionId').trim().notEmpty(),
    validationErrorHandler,
    (_req: Request, res: Response) => {
        const req = _req as UserRequest;

        // クライアントIDを取得
        const clientId = `${req.info.user.id}-${req.query.connectionId}` as string;

        // TODO 再接続の場合もありうる？
        // // クライアントが存在していればID重複なので400エラー
        // if (clients[reqUrl.query['id'] as string]) {
        //     res.writeHead(400);
        //     res.end();
        //     return;
        // } else { /** do nothing */ }

        // クライアントIDを登録
        clients[clientId] = { id: clientId, response: res };

        req.on('close', () => {
            delete clients[clientId]; // クライアントが切断した場合、リストから削除
            console.log(`${req.method} ${req.url} req.on(close)`)
        });

        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders(); // flushHeaders()がないとヘッダーが飛ばない

        // 開始イベントを送信する。本来はflushHeadersだけでも十分のはずだが、
        // プロキシが挟まっていたりするとヘッダーだけだと詰まることもあるので、データ部を送ることで詰まらないようにする。
        clients[clientId]?.response.write('event: chatCompletionStream\n\n');
    }
];

/**
 * [user認証] チャットの送信
 */
export const chatCompletion = [
    // 雑に作ってしまった。。
    // query -> connectionId, threadId
    // body  -> args, options?, taskId?, type?, subType?, topic? ：taskId以降はdiscussionを作成するための情報。discussionを作成しない場合は不要。
    query('connectionId').trim().notEmpty(),
    query('threadId').trim().notEmpty(),
    body('args').notEmpty(),
    validationErrorHandler,
    (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        const clientId = `${req.info.user.id}-${req.query.connectionId}` as string;

        const inDto = req.body as { args: ChatCompletionCreateParamsStreaming, options?: { idempotencyKey?: string }, };

        // inDto.args.model = inDto.args.model || 'gpt-4-1106-preview';

        let text = '';
        const label = req.body.options?.idempotencyKey || `chat-${clientId}-${req.query.threadId}`;
        const aiApi = new OpenAIApiWrapper();
        if (inDto.args.model.startsWith('gemini-')) {
            aiApi.wrapperOptions.provider = 'vertexai';
        } else if (inDto.args.model.startsWith('claude-')) {
            aiApi.wrapperOptions.provider = 'anthropic_vertexai';
        }
        aiApi.chatCompletionObservableStream(
            inDto.args, {
            label: label,
        }).subscribe({
            next: next => {
                text += next;
                const resObj = {
                    data: { threadId: req.query.threadId, content: next },
                    event: 'message',
                };
                clients[clientId]?.response.write(`data: ${JSON.stringify(resObj)}\n\n`);
            },
            error: error => {
                console.log(error);
                clients[clientId]?.response.end(`error: ${req.query.threadId} ${error}\n\n`);
            },
            complete: () => {
                if (req.body.taskId) {

                    // 並列実行
                    const func = enqueueGenerator(['task', 'statement', 'discussion']);
                    const d1 = { body: {} } as any;
                    const d2 = {} as any;
                    func(d1, d2, function () {
                        (function (d1: { body: any }) {
                            // console.log();
                            // console.log(`d1=${JSON.stringify(d1)}`);
                            // console.log();
                            // taskIdが指定されている場合は議事録を作成する
                            const discussion = new DiscussionEntity();
                            discussion.logLabel = label;
                            discussion.type = req.body.type || '';
                            discussion.subType = req.body.subType || '';
                            discussion.topic = req.body.topic || 'chat';
                            discussion.statements = [];

                            const queryRunner = ds.createQueryRunner();
                            queryRunner.connect().then(() => {
                                queryRunner.startTransaction().then(() => {
                                    queryRunner.manager.getRepository(TaskEntity).findOneOrFail({ where: { id: req.body.taskId }, relations: ['discussions'] }).then(task => {
                                        // 並列実行
                                        return Promise.all(inDto.args.messages.map((message, index) => {
                                            const statement = new StatementEntity();
                                            statement.sequence = index;
                                            statement.discussion = discussion;
                                            statement.speaker = message.role === 'user' ? `user-${req.info.user.id}` : message.role;
                                            statement.content = String(message.content);
                                            // statementの更新
                                            return queryRunner.manager.save(StatementEntity, statement);
                                        })).then((statements) => {
                                            // 保存したstatementsをdiscussionに追加
                                            discussion.statements.push(...statements);
                                            // ChatCompletion からの返事を末尾に追加
                                            const statement = new StatementEntity();
                                            statement.sequence = inDto.args.messages.length;
                                            statement.discussion = discussion;
                                            statement.speaker = inDto.args.model;
                                            statement.content = text;
                                            discussion.statements.push(statement);
                                            // statementの更新
                                            return queryRunner.manager.save(StatementEntity, statement);
                                        }).then((statement) => {
                                            // 保存したstatementsをdiscussionに追加
                                            discussion.statements.push(statement);
                                            // discussionの更新
                                            return queryRunner.manager.save(DiscussionEntity, discussion);
                                        }).then((discussion) => {
                                            // 保存したdiscussionをtaskに追加
                                            // taskの更新
                                            task.discussions = task.discussions || [];
                                            task.discussions.push(discussion);
                                            return queryRunner.manager.save(TaskEntity, task);
                                        }).then((task) => {
                                            queryRunner.commitTransaction().then(() => {
                                            }).catch(err => {
                                                queryRunner.rollbackTransaction();
                                                throw err;
                                            }).finally(() => {
                                                queryRunner.release();
                                            });
                                        }).catch(err => {
                                            queryRunner.rollbackTransaction();
                                            throw err;
                                        });
                                        // });
                                    }).catch(err => {
                                        queryRunner.rollbackTransaction();
                                        queryRunner.release();
                                    }).finally(() => {
                                        // DB更新が終わってから終了イベントを送信する
                                        clients[clientId]?.response.write(`data: [DONE] ${req.query.threadId}\n\n`);
                                        qSubject.next(d1.body.myQueue);
                                    });
                                });
                            });
                        })(d1)
                    } as any);

                } else {
                    // 通常モードは素直に終了
                    clients[clientId]?.response.write(`data: [DONE] ${req.query.threadId}\n\n`);
                }
                // console.log(text);
            },
        });


        // clients[clientId]?.response.write(`data: ${JSON.stringify(resObj)}\n\n`);
        res.end(JSON.stringify({ status: 'ok' }));
    }
];

/**
 * [認証不要] トークンカウント
 */
export const geminiCountTokens = [
    body('args').notEmpty(),
    validationErrorHandler,
    (_req: Request, res: Response) => {
        const inDto = _req.body as { args: ChatCompletionCreateParamsStreaming, options?: { idempotencyKey?: string }, };
        const args = inDto.args;
        const generativeModel = vertex_ai.preview.getGenerativeModel({
            // model: args.model,
            model: 'gemini-1.5-flash',
            generationConfig: {
                maxOutputTokens: args.max_tokens || 8192,
                temperature: args.top_p || 0.1,
                topP: args.temperature || 0,
            },
            safetySettings: [
                { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE, },
                { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE, },
                { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE, },
                { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE, }
            ],
        });

        normalizeMessage(args, false).subscribe({
            next: next => {
                const args = next.args;
                const req: GenerateContentRequest = mapForGemini(args);
                const countCharsObj = countChars(args);
                // console.log(countCharsObj);
                // console.dir(req, { depth: null });
                generativeModel.countTokens(req).then(tokenObject => {
                    res.end(JSON.stringify(Object.assign(tokenObject, countCharsObj)));
                });
            },
            // complete: () => {
            //     console.log('complete');
            // },
        });
    }
];

// Eventクライアントリスト
export const global: Record<string, { id: string; response: http.ServerResponse; }> = {};

// const url = `https://${location}-aiplatform.googleapis.com/v1beta1/projects/${projectId}/locations/${location}/cachedContents`;
// projects/458302438887/locations/us-central1/cachedContents/6723733506175795200

// GET https://${location}-aiplatform.googleapis.com/v1beta1/projects/${projectId}/locations/${location}/cachedContents
// PATCH https://${location}-aiplatform.googleapis.com/v1beta1/projects/${projectId}/locations/${location}/cachedContents/CACHE_ID
//         {
//   "seconds":"SECONDS",
//   "nanos":"NANOSECONDS"
//             }
// DELETE https://${location}-aiplatform.googleapis.com/v1beta1/projects/${projectId}/locations/${location}/cachedContents/CACHE_ID

// POST https://LOCATION-aiplatform.googleapis.com/v1beta1/projects/PROJECT_ID/locations/LOCATION/publishers/google/models/gemini-1.5-pro-001:generateContent

const CONTEXT_CACHE_API_ENDPOINT = `https://${GCP_CONTEXT_CACHE_LOCATION}-aiplatform.googleapis.com/v1beta1`;

function errorFormat(error: any): string {
    console.error(error);
    delete error['config'];
    delete error['stack'];
    return JSON.stringify(error);
}

/**
 * [ユーザー認証] コンテキストキャッシュ作成
 */
export const geminiCreateContextCache = [
    body('args').notEmpty(),
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const inDto = _req.body as { args: ChatCompletionCreateParamsStreaming, options?: { idempotencyKey?: string }, };
        const args = inDto.args;
        const projectId: string = GCP_PROJECT_ID || 'dummy';
        const modelId: 'gemini-1.5-flash-001' | 'gemini-1.5-pro-001' = 'gemini-1.5-flash-001';
        const url = `${CONTEXT_CACHE_API_ENDPOINT}/projects/${projectId}/locations/${GCP_CONTEXT_CACHE_LOCATION}/cachedContents`;
        normalizeMessage(args, false).subscribe({
            next: next => {
                const args = next.args;
                const req: GenerateContentRequest = mapForGemini(args);

                // モデルの説明文を書いておく？？
                // req.contents.push({ role: 'model', parts: [{ text: 'これはキャッシュ機能のサンプルです。' }] });

                // // システムプロンプトを先頭に戻しておく
                // if (req.systemInstruction && typeof req.systemInstruction !== 'string') {
                //     req.contents.unshift(req.systemInstruction);
                // } else { }

                // リクエストボディ
                const requestBody = {
                    model: `projects/${projectId}/locations/${location}/publishers/google/models/${modelId}`,
                    contents: req.contents,
                };
                const reqCache: GenerateContentRequestForCache = req as GenerateContentRequestForCache;
                if (reqCache.expire_time || reqCache.ttl) {
                    // 期限設定されていれば何もしない。
                } else {
                    // 期限設定されていなければデフォルト15分を設定する。
                    reqCache.expire_time = new Date(new Date().getTime() + 15 * 60 * 1000).toISOString();
                }
                // fs.writeFileSync('requestBody.json', JSON.stringify(requestBody, null, 2));

                // アクセストークンを取得してリクエスト
                my_vertexai.getAuthorizedHeaders().then(headers =>
                    axios.post(url, requestBody, headers)
                ).then(response => {
                    res.end(JSON.stringify(response.data));
                    // console.log(response.headers);
                    // console.log(response.data);
                }).catch(error => {
                    res.status(503).end(errorFormat(error));
                });
            },
        });
    }
];

/**
 * [ユーザー認証] コンテキストキャッシュ時間変更
 */
export const geminiUpdateContextCache = [
    body('expire_time').notEmpty(),
    body('cache_name').notEmpty(),
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const inDto = _req.body as { expire_time: string, cache_name: string };
        my_vertexai.getAuthorizedHeaders().then(headers =>
            axios.patch(`${CONTEXT_CACHE_API_ENDPOINT}/${inDto.cache_name}`, { expire_time: inDto.expire_time }, headers)
        ).then(response => {
            res.end(JSON.stringify(response.data));
        }).catch(error => {
            res.status(503).end(errorFormat(error));
        });
    }
];


/**
 * [ユーザー認証] コンテキストキャッシュ削除
 */
export const geminiDeleteContextCache = [
    body('cache_name').notEmpty(),
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const inDto = _req.body as { cache_name: string };
        my_vertexai.getAuthorizedHeaders().then(headers =>
            axios.delete(`${CONTEXT_CACHE_API_ENDPOINT}/${inDto.cache_name}`, headers)
        ).then(response => {
            res.end(JSON.stringify(response.data));
        }).catch(error => {
            res.status(503).end(errorFormat(error));
        });
    }
];

/**
 * [ユーザー認証] コンテキストキャッシュ一覧
 */
export const geminiGetContextCache = [
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        my_vertexai.getAuthorizedHeaders().then(headers =>
            axios.get(`${CONTEXT_CACHE_API_ENDPOINT}/projects/${GCP_PROJECT_ID}/locations/${GCP_CONTEXT_CACHE_LOCATION}/cachedContents`, headers)
        ).then(response => {
            res.end(JSON.stringify(response.data));
        }).catch(error => {
            res.status(503).end(errorFormat(error));
        });
    }
];

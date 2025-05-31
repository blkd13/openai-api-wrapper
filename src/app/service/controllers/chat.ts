import * as http from 'http';
import { Request, Response } from "express";
import { body, query } from "express-validator";
import axios from 'axios';

import { OpenAIApiWrapper, aiApi, genClientByProvider, normalizeMessage, providerPrediction } from '../../common/openai-api-wrapper.js';
import { validationErrorHandler } from "../middleware/validation.js";
import { UserRequest } from "../models/info.js";
import { ChatCompletion, ChatCompletionChunk, ChatCompletionCreateParams, ChatCompletionCreateParamsStreaming, ChatCompletionMessage } from "openai/resources/index.js";
import { GenerateContentRequest, HarmBlockThreshold, HarmCategory, VertexAI } from '@google-cloud/vertexai';

import { HttpsProxyAgent } from 'https-proxy-agent';
const { GCP_PROJECT_ID, GCP_CONTEXT_CACHE_LOCATION, GCP_API_BASE_PATH } = process.env;

const proxyObj: { [key: string]: string | undefined } = {
    httpProxy: process.env['http_proxy'] as string || undefined,
    httpsProxy: process.env['https_proxy'] as string || undefined,
};
if (proxyObj.httpsProxy || proxyObj.httpProxy) {
    const httpsAgent = new HttpsProxyAgent(proxyObj.httpsProxy || proxyObj.httpProxy || '');
    // axios.defaults.httpsAgent = httpsAgent;
} else { }

import { countChars, GenerateContentRequestForCache, mapForGemini, MyVertexAiClient } from '../../common/my-vertexai.js';
import { Utils } from '../../common/utils.js';
import { Observer } from 'rxjs/dist/types/index.js';
import { COUNT_TOKEN_MODEL } from './chat-by-project-model.js';

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
 * [user認証] チャットの送信 (chatCompletion)
 */
export const chatCompletionStream = [
    body('model').notEmpty(),
    body('messages').isArray({ min: 1 }), // messages が空でない配列であることを検証
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        // TODO 雑に作ってしまったので後で直したい。
        // ログが取れてないのと、レスポンスを結局textにしてしまった弊害が出てるのでそこを直した版にする。

        const req = _req as UserRequest;
        const inDto = {
            args: {
                model: req.body.model,
                messages: req.body.messages, // ユーザーからのメッセージをそのまま渡す
                stream: true, // ストリーミングを無効にする
                // 他のパラメータも必要に応じて設定
            } as ChatCompletionCreateParamsStreaming,
            options: {
                idempotencyKey: req.body.options?.idempotencyKey,
            },
        };
        if (req.body.temperature !== undefined) {
            inDto.args.temperature = req.body.temperature;
        } else { }
        if (req.body.max_tokens !== undefined) {
            inDto.args.max_tokens = req.body.max_tokens;
        } else { }
        if (req.body.stop !== undefined) {
            inDto.args.stop = req.body.stop;
        } else { }

        const connectionId = Utils.generateUUID();

        // クライアントIDを取得
        const clientId = `${req.info.user.id}-${connectionId}` as string;

        const label = inDto.options?.idempotencyKey || `api-${clientId}`;

        const provider = genClientByProvider(inDto.args.model);

        let subscriber: Partial<Observer<ChatCompletionChunk>> | ((value: ChatCompletionChunk) => void) | undefined;

        if (req.body.stream) {
            // streamモード

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

            // // 開始イベントを送信する。本来はflushHeadersだけでも十分のはずだが、
            // // プロキシが挟まっていたりするとヘッダーだけだと詰まることもあるので、データ部を送ることで詰まらないようにする。
            // clients[clientId]?.response.write('event: chatCompletionStream\n\n');
            subscriber = {
                next: next => {
                    clients[clientId]?.response.write(`data: ${JSON.stringify(next)}\n\n`);
                },
                error: error => {
                    console.log(error);
                    clients[clientId]?.response.end(`error: ${req.query.streamId} ${error}\n\n`);
                },
                complete: () => {
                    // 通常モードは素直に終了
                    const resObj = {
                        choices: [{ content_filter_results: {}, delta: {}, finish_reason: 'stop', index: 0, logprobs: null }],
                        created: Date.now(), id: `chatcmpl-${clientId}`, model: req.body.model, object: 'chat.completion.chunk', system_fingerprint: `fp_${clientId}`,
                    };
                    clients[clientId]?.response.write(`data: ${JSON.stringify(resObj)}\n\n`);
                    clients[clientId]?.response.write(`data: [DONE]\n`);
                    clients[clientId]?.response.end();
                },
            };
        } else {
            // 通常モード
            // aiApiがstreamingモードしか出来ないので、streamを纏める感じにしている。
            let text = '';
            const resObj = {} as ChatCompletion;
            subscriber = {
                next: next => {
                    text += next.choices[0]?.delta?.content || '';
                    Object.assign(resObj, next);
                },
                error: error => {
                    throw error;
                },
                complete: () => {
                    resObj.object = "chat.completion";
                    resObj.choices = [{
                        index: 0,
                        message: { role: "assistant", content: text, refusal: null },
                        logprobs: null,
                        finish_reason: "stop"
                    }]
                    // console.dir(resObj, { depth: null });
                    res.json(resObj);
                    res.end();
                },
            };
        }

        try {
            aiApi.chatCompletionObservableStream(
                inDto.args, { label, userId: req.info.user.id, ip: req.info.ip, authType: 'api' }, provider
            ).subscribe(subscriber);
        } catch (error: any) {
            console.error(`ERROR::${error}`);
            res.status(503).end(Utils.errorFormat(error));
        }
    }
];

/**
 * [user認証] チャットの送信
 */
export const codegenCompletion = [
    // 雑に作ってしまった。。
    body('model').notEmpty(),
    body('prompt'),
    validationErrorHandler,
    (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        const inDto = {
            args: {
                model: req.body.model,
                temperature: req.body.temperature || 0.2,
                max_tokens: req.body.max_tokens || 256,
                stop: req.body.stop || ['\n'],
                messages: [
                    { role: 'system', content: [{ text: `**Code Completion AI System Prompt**\n\nYou are an efficient code completion AI. Follow these guidelines:\n\nUnderstand the user's input code and continue writing it.\nGenerate appropriate code based on the context.\nFollow language best practices and avoid errors.\nAim for concise and readable code.\nFocus on effectively supporting the user's coding process.\n\n**Important Note:**\nOnly return the continuation of the code. There is no need to rewrite the entire provided code. The continuation is the most important part. Exclude any additional explanations or comments.\n` }] },
                    { role: 'user', content: `Write only the continuation of this code\n\n\n\`\`\`\n${req.body.prompt}\`\`\`` },
                ],
            }

        } as { args: ChatCompletionCreateParamsStreaming, options?: { idempotencyKey?: string }, };

        let text = '';
        const label = req.body.options?.idempotencyKey || `chat-${req.info.user.id}`;
        const aiApi = new OpenAIApiWrapper();
        const provider = genClientByProvider(inDto.args.model);

        aiApi.chatCompletionObservableStream(
            inDto.args, { label }, provider
        ).subscribe({
            next: next => {
                const _text = next.choices[0]?.delta?.content || '';
                text += _text;
                // console.log(`${next}`);
            },
            error: error => {
                // console.log(`ERROR::${error}`);
                res.status(503).end(Utils.errorFormat(error));
            },
            complete: () => {
                text = Utils.mdTrim(text, true).trim();
                // console.log(`Complete::${text}`);
                const resObj = {
                    id: label,
                    model: inDto.args.model,
                    object: "text_completion",
                    choices: [
                        {
                            finish_reason: "length",
                            index: 0,
                            logprobs: null,
                            text: text,
                        }
                    ],
                    created: Date.now(),
                    usage: {
                        completion_tokens: 0,
                        prompt_tokens: 0,
                        total_tokens: text.length,
                    }
                };
                res.json(resObj);
                res.end();
            },
        });
    }
];

/**
 * [user認証] チャットの送信
 */
export const chatCompletion = [
    // 雑に作ってしまった。。
    // query -> connectionId, streamId
    // body  -> args, options?, taskId?, type?, subType?, topic? ：taskId以降はdiscussionを作成するための情報。discussionを作成しない場合は不要。
    query('connectionId').trim().notEmpty(),
    query('streamId').trim().notEmpty(),
    body('args').notEmpty(),
    validationErrorHandler,
    (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        const clientId = `${req.info.user.id}-${req.query.connectionId}` as string;

        const inDto = req.body as { args: ChatCompletionCreateParamsStreaming, options?: { idempotencyKey?: string }, };

        const label = req.body.options?.idempotencyKey || `chat-${clientId}-${req.query.streamId}`;
        // const aiApi = new OpenAIApiWrapper();
        const provider = genClientByProvider(inDto.args.model);

        // console.log(aiApi.wrapperOptions.provider);
        aiApi.chatCompletionObservableStream(
            inDto.args, { label }, provider
        ).subscribe({
            next: next => {
                const resObj = {
                    data: { streamId: req.query.streamId, content: next },
                    event: 'message',
                };
                clients[clientId]?.response.write(`data: ${JSON.stringify(resObj)}\n\n`);
            },
            error: error => {
                console.log(error);
                clients[clientId]?.response.end(`error: ${req.query.streamId} ${error}\n\n`);
            },
            complete: () => {
                // 通常モードは素直に終了
                clients[clientId]?.response.write(`data: [DONE] ${req.query.streamId}\n\n`);
                // console.log(text);
            },
        });
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
        const my_vertexai = (genClientByProvider(args.model).client as MyVertexAiClient);
        const client = my_vertexai.client as VertexAI;
        const generativeModel = client.preview.getGenerativeModel({
            model: 'gemini-1.5-flash',
            safetySettings: [
                // { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH,       threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE, },
                // { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE, },
                // { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE, },
                // { category: HarmCategory.HARM_CATEGORY_HARASSMENT,        threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE, }
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

// const CONTEXT_CACHE_API_ENDPOINT = `https://${GCP_CONTEXT_CACHE_LOCATION}-aiplatform.googleapis.com/v1beta1`;
const CONTEXT_CACHE_API_ENDPOINT = `https://${GCP_CONTEXT_CACHE_LOCATION}-${GCP_API_BASE_PATH}/v1beta1`;

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

                const my_vertexai = (genClientByProvider(args.model).client as MyVertexAiClient);
                const client = my_vertexai.client as VertexAI;
                // アクセストークンを取得してリクエスト
                my_vertexai.getAuthorizedHeaders().then(headers =>
                    axios.post(url, requestBody, headers)
                ).then(response => {
                    res.end(JSON.stringify(response.data));
                    // console.log(response.headers);
                    // console.log(response.data);
                }).catch(error => {
                    res.status(503).end(Utils.errorFormat(error));
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
        // myVertex取るために仕方なくCOUNT_TOKEN_MODELを使う
        const my_vertexai = (genClientByProvider(COUNT_TOKEN_MODEL).client as MyVertexAiClient);
        const client = my_vertexai.client as VertexAI;
        my_vertexai.getAuthorizedHeaders().then(headers =>
            axios.patch(`${CONTEXT_CACHE_API_ENDPOINT}/${inDto.cache_name}`, { expire_time: inDto.expire_time }, headers)
        ).then(response => {
            res.end(JSON.stringify(response.data));
        }).catch(error => {
            res.status(503).end(Utils.errorFormat(error));
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
        // myVertex取るために仕方なくCOUNT_TOKEN_MODELを使う
        const my_vertexai = (genClientByProvider(COUNT_TOKEN_MODEL).client as MyVertexAiClient);
        const client = my_vertexai.client as VertexAI;
        my_vertexai.getAuthorizedHeaders().then(headers =>
            axios.delete(`${CONTEXT_CACHE_API_ENDPOINT}/${inDto.cache_name}`, headers)
        ).then(response => {
            res.end(JSON.stringify(response.data));
        }).catch(error => {
            res.status(503).end(Utils.errorFormat(error));
        });
    }
];

/**
 * [ユーザー認証] コンテキストキャッシュ一覧
 */
export const geminiGetContextCache = [
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        // myVertex取るために仕方なくCOUNT_TOKEN_MODELを使う
        const my_vertexai = (genClientByProvider(COUNT_TOKEN_MODEL).client as MyVertexAiClient);
        const client = my_vertexai.client as VertexAI;
        my_vertexai.getAuthorizedHeaders().then(headers =>
            axios.get(`${CONTEXT_CACHE_API_ENDPOINT}/projects/${GCP_PROJECT_ID}/locations/${GCP_CONTEXT_CACHE_LOCATION}/cachedContents`, headers)
        ).then(response => {
            res.end(JSON.stringify(response.data));
        }).catch(error => {
            res.status(503).end(Utils.errorFormat(error));
        });
    }
];

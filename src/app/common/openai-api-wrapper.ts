import { HttpsProxyAgent } from 'https-proxy-agent';
import { Observable, Subscriber } from 'rxjs';
import * as crypto from 'crypto';
import * as fs from 'fs';
import sizeOf from 'image-size';
import { detect } from 'jschardet';

// configureGlobalFetchを読み込むとfetchのproxyが効くようになるので、VertexAI用にただ読み込むだけ。
import * as configureGlobalFetch from './configureGlobalFetch.js'; configureGlobalFetch;

import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { AnthropicVertex } from '@anthropic-ai/vertex-sdk';
import { GenerateContentRequest, HarmBlockThreshold, HarmCategory, Part, VertexAI } from '@google-cloud/vertexai';
// import { GoogleGenerativeAI } from "@google/generative-ai";
// import { GoogleAICacheManager, GoogleAIFileManager } from "@google/generative-ai/server";

import { APIPromise, RequestOptions } from 'openai/core';
import { ChatCompletionChunk, ChatCompletionContentPart, ChatCompletionCreateParamsBase, ChatCompletionCreateParamsStreaming, ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { Stream } from 'openai/streaming';
import { Tiktoken, TiktokenModel, encoding_for_model } from 'tiktoken';

import fss from './fss.js';
import { Utils } from "./utils.js";

const HISTORY_DIRE = `./history`;

// proxy設定判定用オブジェクト
const proxyObj: { [key: string]: any } = {
    httpProxy: process.env['http_proxy'] as string || undefined,
    httpsProxy: process.env['https_proxy'] as string || undefined,
};
const noProxies = process.env['no_proxy']?.split(',') || [];
let host = '';
Object.keys(proxyObj).filter(key => noProxies.includes(host) || !proxyObj[key]).forEach(key => delete proxyObj[key]);
const options = Object.keys(proxyObj).filter(key => proxyObj[key]).length > 0 ? {
    httpAgent: new HttpsProxyAgent(proxyObj.httpsProxy || proxyObj.httpProxy || ''),
} : {};


const openai = new OpenAI({
    apiKey: process.env['OPENAI_API_KEY'] || 'dummy',
    // baseOptions: { timeout: 1200000, Configuration: { timeout: 1200000 } },
});

// llama2-70b-4096
// mixtral-8x7b-32768
const groq = new OpenAI({
    apiKey: process.env['GROQ_API_KEY'] || 'dummy',
    baseURL: 'https://api.groq.com/openai/v1',
});
const mistral = new OpenAI({
    apiKey: process.env['MISTRAL_API_KEY'] || 'dummy',
    baseURL: 'https://api.mistral.ai/v1',
});

const anthropic = new Anthropic({
    apiKey: process.env['ANTHROPIC_API_KEY'] || 'dummy',
    httpAgent: options.httpAgent,
    maxRetries: 0,
});

const deepSeek = new OpenAI({
    apiKey: process.env['DEEPSEEK_API_KEY'] || 'dummy',
    baseURL: 'https://api.deepseek.com/v1',
});

const local = new OpenAI({
    baseURL: 'http://localhost:8913/v1',
});

import { AzureKeyCredential, OpenAIClient } from "@azure/openai";
import { MessageCreateParams } from '@anthropic-ai/sdk/resources/messages.js';

const azureClient = new OpenAIClient(
    process.env['AZURE_OPENAI_ENDPOINT'] as string || 'dummy',
    new AzureKeyCredential(process.env['AZURE_OPENAI_API_KEY'] as string || 'dummy')
);
export const azureDeployNameMap: Record<string, string> = {
    'gpt-3.5-turbo': 'gpt35',
    'gpt-4-vision-preview': 'gpt4',
};
export const azureDeployTpmMap: Record<string, number> = {
    'gpt-3.5-turbo': 60000,
    'gpt-4-vision-preview': 10000,
};

// Initialize Vertex with your Cloud project and location
export const vertex_ai = new VertexAI({ project: process.env['GCP_PROJECT_ID'] || 'gcp-cloud-shosys-ai-002', location: process.env['GCP_REGION'] || 'asia-northeast1' });
export const anthropicVertex = new AnthropicVertex({ projectId: process.env['GCP_PROJECT_ID'] || 'gcp-cloud-shosys-ai-002', region: process.env['GCP_REGION'] || 'asia-northeast1' });

/**
 * tiktokenのEncoderは取得に時間が掛かるので、取得したものはモデル名と紐づけて確保しておく。
 */
const encoderMap: Record<TiktokenModel, Tiktoken> = {} as any;
function getEncoder(model: TiktokenModel): Tiktoken {
    if (encoderMap[model]) {
    } else {
        try {
            encoderMap[model] = encoding_for_model(model);
        } catch (ex) {
            // 登録されていないトークナイザの場合はとりあえずgpt-4のトークナイザを当てておく
            encoderMap[model] = encoding_for_model('gpt-4');
        }
    }
    return encoderMap[model];
}

export interface WrapperOptions {
    allowLocalFiles: boolean;
    provider: 'openai' | 'azure' | 'groq' | 'mistral' | 'anthropic' | 'deepseek' | 'local' | 'vertexai';
}

// Uint8Arrayを文字列に変換
const decoder = new TextDecoder();

interface Ratelimit {
    limitRequests: number;
    limitTokens: number;
    remainingRequests: number;
    remainingTokens: number;
    resetRequests: string;
    resetTokens: string;
}

class RunBit {
    attempts: number = 0;
    constructor(
        public logObject: { output: (stepName: string, error: any) => string },
        public tokenCount: TokenCount,
        public args: ChatCompletionCreateParamsBase,
        public options: RequestOptions,
        public openApiWrapper: OpenAIApiWrapper,
        public observer: Subscriber<string>,
    ) { }

    async executeCall(): Promise<void> {
        const args = this.args;
        const options = this.options;
        const idempotencyKey = this.options.idempotencyKey as string;
        const tokenCount = this.tokenCount;
        const logObject = this.logObject;
        let attempts = this.attempts;
        const maxAttempts = 5;
        const observer = this.observer;

        const ratelimitObj = this.openApiWrapper.currentRatelimit[this.tokenCount.modelShort];
        // 使用例: callAPI関数を最大5回までリトライする
        // console.log(this.logString('call', ''));
        let runPromise = null;

        console.log(logObject.output('start', ''));
        if (this.openApiWrapper.wrapperOptions.provider === 'anthropic') {
            args.max_tokens = args.max_tokens || 4096;
            // console.log('shot');
            // claudeはsystemプロンプトが無い。
            const systemcPrompt = args.messages.find(m => m.role === 'system');
            if (systemcPrompt) {
                (args as any)['system'] = systemcPrompt.content;
            } else { }
            args.messages = args.messages.filter(m => m.role !== 'system');
            // console.log(args);

            //   status: 429,
            //   headers: {
            //     'anthropic-ratelimit-requests-limit': '50',
            //     'anthropic-ratelimit-requests-remaining': '46',
            //     'anthropic-ratelimit-requests-reset': '2024-03-09T08:33:00Z',
            //     'anthropic-ratelimit-tokens-limit': '50000',
            //     'anthropic-ratelimit-tokens-remaining': '28000',
            //     'anthropic-ratelimit-tokens-reset': '2024-03-09T08:33:00Z',
            //     'cf-cache-status': 'DYNAMIC',
            //     'cf-ray': '8619b6f3cb37268a-NRT',
            //     connection: 'keep-alive',
            //     'content-length': '261',
            //     'content-type': 'application/json',
            //     date: 'Sat, 09 Mar 2024 08:32:28 GMT',
            //     'request-id': 'req_01RpaPLbbaKFtR4BSbKa2rzL',
            //     server: 'cloudflare',
            //     via: '1.1 google',
            //     'x-cloud-trace-context': '5b9325b88cf2e68cc39489983301b2db',
            //     'x-should-retry': 'true'
            //   },
            runPromise = new Promise<void>((resolve, reject) => {
                try {
                    // リクエストをファイルに書き出す
                    fss.writeFile(`${HISTORY_DIRE}/${idempotencyKey}-${attempts}.request.json`, JSON.stringify({ args, options }, Utils.genJsonSafer()), {}, (err) => { });
                    const response = (anthropic.messages.stream(args as any).toReadableStream());
                    // console.log('res');
                    // ratelimitObj.limitRequests = 5; // 適当に5にしておく。
                    // ratelimitObj.limitTokens = azureDeployTpmMap[args.model];
                    // ratelimitObj.resetRequests = new Date().toISOString();
                    // ratelimitObj.remainingRequests = 50; // ヘッダーが取得できないときはシングルスレッドで動かす
                    // ratelimitObj.remainingTokens = 100000; // トークン数は適当

                    fss.writeFile(`${HISTORY_DIRE}/${idempotencyKey}-${attempts}.response.json`, JSON.stringify({ args, options, response }, Utils.genJsonSafer()), {}, (err) => { });

                    // ストリームからデータを読み取るためのリーダーを取得
                    const reader = response.getReader();

                    let tokenBuilder: string = '';

                    const _that = this;

                    // ストリームからデータを読み取る非同期関数
                    async function readStream() {
                        while (true) {
                            try {
                                const { value, done } = await reader.read();
                                if (done) {
                                    // ストリームが終了したらループを抜ける
                                    tokenCount.cost = tokenCount.calcCost();
                                    console.log(logObject.output('fine', ''));
                                    observer.complete();

                                    resolve();
                                    // ファイルに書き出す
                                    const trg = args.response_format?.type === 'json_object' ? 'json' : 'md';
                                    fss.writeFile(`${HISTORY_DIRE}/${idempotencyKey}-${attempts}.result.${trg}`, tokenBuilder || '', {}, () => { });
                                    _that.openApiWrapper.fire();
                                    break;
                                }
                                // console.log(JSON.stringify(value));
                                // // 中身を取り出す
                                const content = decoder.decode(value);
                                // console.log(content);

                                // 中身がない場合はスキップ
                                if (!content) { continue; }
                                // ファイルに書き出す
                                fss.appendFile(`${HISTORY_DIRE}/${idempotencyKey}-${attempts}.txt`, content || '', {}, () => { });
                                // console.log(`${tokenCount.completion_tokens}: ${data.toString()}`);
                                const obj = JSON.parse(content);
                                if (obj && obj.delta && obj.delta.text) {
                                    // // トークン数をカウント
                                    // tokenCount.completion_tokens++;
                                    const text = obj.delta.text || '';
                                    tokenBuilder += text;
                                    tokenCount.tokenBuilder = tokenBuilder;

                                    // streamHandlerを呼び出す
                                    observer.next(text);
                                } else {
                                }
                                if (obj.message && obj.message.usage && obj.message.usage.input_tokens) {
                                    // claudeはAPIの中にトークン数が書いてあるのでそれを使う。
                                    tokenCount.prompt_tokens = obj.message.usage.input_tokens;
                                    tokenCount.completion_tokens = obj.message.usage.output_tokens;
                                }
                                if (obj.usage && obj.usage.output_tokens) {
                                    // claudeはAPIの中にトークン数が書いてあるのでそれを使う。
                                    tokenCount.completion_tokens = obj.usage.output_tokens;
                                    // console.log(tokenCount.completion_tokens);
                                }
                            } catch (e) {
                                reject(e);
                            }
                        }
                        // console.log('readStreamFine');
                        return;
                    }
                    // ストリームの読み取りを開始
                    // console.log('readStreamStart');
                    return readStream();
                } catch (e) {
                    reject(e);
                }
                return;
            });
        } else if (this.openApiWrapper.wrapperOptions.provider === 'azure') {
            if (args.max_tokens) {
            } else if (args.model === 'gpt-4-vision-preview') {
                // vision-previの時にmax_tokensを設定しないと20くらいで返ってきてしまう。
                args.max_tokens = 4096;
            }
            // console.log('shot');
            // リクエストをファイルに書き出す
            const reqDto = [azureDeployNameMap[args.model] || args.model, args.messages as any, { ...args as any }];
            fss.writeFile(`${HISTORY_DIRE}/${idempotencyKey}-${attempts}.request.json`, JSON.stringify(reqDto, Utils.genJsonSafer()), {}, (err) => { });
            runPromise = (azureClient.streamChatCompletions(reqDto[0], reqDto[1], reqDto[2])).then((response) => {
                // console.log('res');
                ratelimitObj.limitRequests = 5; // 適当に5にしておく。
                ratelimitObj.limitTokens = azureDeployTpmMap[args.model];
                ratelimitObj.resetRequests = new Date().toISOString();
                ratelimitObj.remainingRequests = 1; // ヘッダーが取得できないときはシングルスレッドで動かす
                ratelimitObj.remainingTokens = 100000; // トークン数は適当

                if ((response as any).headers) {
                    // azureのライブラリを直接改造してないとここは取れない。
                    'x-ratelimit-remaining-requests' in (response as any).headers && (ratelimitObj.remainingRequests = Number((response as any).headers['x-ratelimit-remaining-requests'])) || 1;
                    'x-ratelimit-remaining-tokens' in (response as any).headers && (ratelimitObj.remainingTokens = Number((response as any).headers['x-ratelimit-remaining-tokens'])) || 1;
                    // console.log((response as any).headers);
                } else {
                }

                fss.writeFile(`${HISTORY_DIRE}/${idempotencyKey}-${attempts}.response.json`, JSON.stringify({ args, options, response }, Utils.genJsonSafer()), {}, (err) => { });

                // ストリームからデータを読み取るためのリーダーを取得
                const reader = response.getReader();

                let tokenBuilder: string = '';

                const _that = this;

                // ストリームからデータを読み取る非同期関数
                async function readStream() {
                    while (true) {
                        try {
                            const { value, done } = await reader.read();
                            if (done) {
                                // ストリームが終了したらループを抜ける
                                tokenCount.cost = tokenCount.calcCost();
                                console.log(logObject.output('fine', ''));
                                observer.complete();

                                // ファイルに書き出す
                                const trg = args.response_format?.type === 'json_object' ? 'json' : 'md';
                                fss.writeFile(`${HISTORY_DIRE}/${idempotencyKey}-${attempts}.result.${trg}`, tokenBuilder || '', {}, () => { });
                                _that.openApiWrapper.fire();
                                break;
                            }
                            // console.log(JSON.stringify(value));
                            // // 中身を取り出す
                            // const content = decoder.decode(value.choices);
                            const content = JSON.stringify(value);
                            // console.log(content);

                            // 中身がない場合はスキップ
                            if (!content) { continue; }
                            // ファイルに書き出す
                            fss.appendFile(`${HISTORY_DIRE}/${idempotencyKey}-${attempts}.txt`, content || '', {}, () => { });
                            // console.log(`${tokenCount.completion_tokens}: ${data.toString()}`);
                            // トークン数をカウント
                            tokenCount.completion_tokens++;
                            const text = JSON.parse(content)?.choices[0]?.delta?.content || '';
                            tokenBuilder += text;
                            tokenCount.tokenBuilder = tokenBuilder;

                            // streamHandlerを呼び出す
                            observer.next(text);
                        } catch (e) {
                            console.log(`reader.read() error: ${e}`);
                            console.log(e);
                        }
                    }
                    // console.log('readStreamFine');
                    return;
                }
                // ストリームの読み取りを開始
                // console.log('readStreamStart');
                return readStream();
            });
        } else if (this.openApiWrapper.wrapperOptions.provider === 'vertexai') {
            // 'gemini-1.5-flash-001'
            // Instantiate the models
            const generativeModel = vertex_ai.preview.getGenerativeModel({
                model: args.model,
                generationConfig: {
                    maxOutputTokens: args.max_tokens || 8192,
                    temperature: args.temperature || 0.1,
                    topP: args.top_p || 0.95,
                },
                safetySettings: [
                    { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE, },
                    { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE, },
                    { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE, },
                    { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE, }
                ],
            });
            // console.log(generativeModel);
            args.messages[0].content = args.messages[0].content || '';
            const req: GenerateContentRequest = {
                contents: [
                    // {
                    //     role: 'user', parts: [
                    //         { text: `konnichiha` },
                    //         {
                    //             inlineData: {
                    //                 mimeType: 'image/jpeg',
                    //                 data: fs.readFileSync('./sample.jpg').toString('base64')
                    //             }
                    //         }
                    //     ]
                    // }
                ],
            };

            let promptChars = 0;
            function countTokens(contents: ChatCompletionContentPart[] | string | null | undefined): number {
                let countChars = 0;
                if (contents) {
                    if (typeof contents === 'string') {
                        countChars += contents.length;
                    } else {
                        countChars += contents.reduce((prev, curr, index) => {
                            if (curr.type === 'text') {
                                prev += curr.text.length;
                            } else {
                                prev += 1024; // 画像音声系は良く分からないけど1000にしてしまう。
                            }
                            return prev;
                        }, countChars);
                    }
                } else {
                    // 
                }
                return countChars;
            }
            function blankTruncateFilter(message: ChatCompletionMessageParam) {
                // 空オブジェクトが混ざらないように消すやつ
                if (message.content) {
                    if (typeof message.content === 'string') {
                        return message.content;
                    } else if (Array.isArray(message.content)) {
                        message.content = message.content.filter(parts => {
                            if (parts.type === 'text') {
                                return parts.text && parts.text.length;
                            } else if (parts.type === 'image_url') {
                                return parts.image_url && parts.image_url.url;
                            } else {
                                return false;
                            }
                        })
                        return message.content.length;
                    }
                } else {
                    return false;
                }
                return message.content;
            }
            args.messages
                .filter(blankTruncateFilter)
                .reduce((prev, curr) => {
                    // ロールが連続する場合は1つのコンテンツとしてさまる（こうしないとGeminiがエラーになるので。）
                    if (prev.length === 0 || prev[prev.length - 1].role !== curr.role) {
                        prev.push(curr);
                    } else {
                        const prevContent = prev[prev.length - 1].content;
                        if (typeof prevContent === 'string') {
                            if (prevContent) {
                                // 1個前の同じロールのコンテンツがstring型だと連結できないので構造化配列にしておく。
                                prev[prev.length - 1].content = [{ type: 'text', text: prevContent }];
                                return prev;
                            } else {
                                // 空文字は無視する
                                return prev;
                            }
                        } else {
                            // 元々配列なので何もしない
                        }
                        const prevContentArray = prev[prev.length - 1].content;
                        if (Array.isArray(prevContentArray)) {
                            if (typeof curr.content === 'string') {
                                if (curr.content) {
                                    prevContentArray.push({ type: 'text', text: curr.content });
                                } else {
                                    // 中身がないものは削ってしまう。
                                }
                            } else if (curr.content) {
                                curr.content.forEach(obj => {
                                    if (obj.type === 'text' && obj.text) {
                                        // 中身があれば追加
                                        prevContentArray.push(obj);
                                    } else if (obj.type === 'image_url' && obj.image_url && obj.image_url.url) {
                                        // 中身があれば追加
                                        prevContentArray.push(obj);
                                    } else {
                                        // 中身がないので追加しない。
                                    }
                                });
                            } else {
                                // エラー
                            }
                        }
                    }
                    return prev;
                }, [] as ChatCompletionMessageParam[])
                .filter(blankTruncateFilter)
                .forEach(message => {
                    // 文字数カウント
                    promptChars += countTokens(message.content);

                    // 画像ファイルなどが入ってきたとき用の整理
                    if (typeof message.content === 'string') {
                        if (message.role === 'system') {
                            // systemはsystemInstructionに入れる
                            req.systemInstruction = message.content;
                        } else {
                            req.contents.push({ role: message.role, parts: [{ text: message.content }] });
                        }
                    } else if (Array.isArray(message.content)) {
                        const remappedContent = {
                            role: message.role,
                            parts:
                                message.content.map(content => {
                                    if (content.type === 'image_url') {
                                        // TODO URLには対応していない
                                        if (content.image_url.url.startsWith('data:video/')) {
                                            return { inlineData: { mimeType: content.image_url.url.substring(5, content.image_url.url.indexOf(';')), data: content.image_url.url.substring(content.image_url.url.indexOf(',') + 1) }, video_metadata: {} };
                                        } else if (content.image_url.url.startsWith('data:')) {
                                            return { inlineData: { mimeType: content.image_url.url.substring(5, content.image_url.url.indexOf(';')), data: content.image_url.url.substring(content.image_url.url.indexOf(',') + 1) }, };
                                        } else {
                                            return { file_data: { file_uri: content.image_url.url } };
                                        }
                                    } else if (content.type === 'text') {
                                        return { text: content.text as string };
                                    } else {
                                        console.log('unknown sub message type');
                                        return null;
                                    }
                                }).filter(is => is) as Part[],
                        };
                        if (message.role === 'system') {
                            // systemはsystemInstructionに入れる
                            req.systemInstruction = remappedContent;
                        } else {
                            req.contents.push(remappedContent);
                        }
                    } else {
                        console.log('unknown message type');
                    }
                });

            // console.log(`promptChars=${promptChars}`);
            // const _dum = JSON.parse(JSON.stringify(req))
            // _dum.contents = req.contents.filter(obj => obj.role !== 'system');
            // generativeModel.countTokens(_dum).then(obj => {
            //     console.log(obj);
            // });
            // return;
            // console.dir(req, { depth: null });
            // console.dir(generativeModel, { depth: null });
            // console.dir(req, { depth: null });
            const model = Object.keys(generativeModel).filter(key => key !== 'googleAuth').reduce((prev, currKey) => {
                prev[currKey] = (generativeModel as any)[currKey];
                return prev;
            }, {} as Record<string, any>);
            fss.writeFile(`${HISTORY_DIRE}/${idempotencyKey}-${attempts}.request.json`, JSON.stringify({ model, req }, Utils.genJsonSafer()), {}, (err) => { });
            runPromise = generativeModel.generateContentStream(req).then((streamingResp) => {

                let tokenBuilder: string = '';

                const _that = this;

                tokenCount.prompt_tokens = promptChars;
                tokenCount.completion_tokens = 0;
                // ストリームからデータを読み取る非同期関数
                async function readStream() {
                    let safetyRatings;
                    while (true) {
                        const { value, done } = await streamingResp.stream.next();
                        // console.log('0000000000000000------------------------=========================')
                        // console.dir(value, { depth: null });
                        // console.log('5555555555555555------------------------=========================')
                        // console.dir(done, { depth: null });
                        // console.log('3333333333333333------------------------=========================')
                        // [1] {
                        // [1]   promptFeedback: { blockReason: 'PROHIBITED_CONTENT' },
                        // [1]   usageMetadata: { promptTokenCount: 43643, totalTokenCount: 43643 }
                        // [1] }
                        if (done) {
                            // ストリームが終了したらループを抜ける
                            tokenCount.cost = tokenCount.calcCost();
                            console.log(logObject.output('fine', ''));
                            observer.complete();

                            _that.openApiWrapper.fire();

                            // ファイルに書き出す
                            const trg = args.response_format?.type === 'json_object' ? 'json' : 'md';
                            fss.writeFile(`${HISTORY_DIRE}/${idempotencyKey}-${attempts}.result.${trg}`, tokenBuilder || '', {}, () => { });
                            break;
                        }

                        // 中身を取り出す
                        const content = value;
                        // console.log(content);

                        // 中身がない場合はスキップ
                        if (!content) { continue; }

                        // 
                        if (content.usageMetadata) {
                            // tokenCount.prompt_tokens = content.usageMetadata.promptTokenCount || tokenCount.prompt_tokens;
                            // tokenCount.completion_tokens = content.usageMetadata.candidatesTokenCount || 0;

                            // vertexaiの場合はレスポンスヘッダーが取れない。その代わりストリームの最後にメタデータが飛んでくるのでそれを捕まえる。
                            fss.writeFile(`${HISTORY_DIRE}/${idempotencyKey}-${attempts}.response.json`, JSON.stringify({ model, req, response: content }, Utils.genJsonSafer()), {}, (err) => { });
                        } else { }

                        if (content.promptFeedback && content.promptFeedback.blockReason) {
                            // finishReasonが指定されている、かつSTOPではない場合はエラー終了させる。
                            // ストリームが終了したらループを抜ける
                            tokenCount.cost = tokenCount.calcCost();
                            throw JSON.stringify({ promptFeedback: content.promptFeedback });
                        } else { }

                        // 中身がない場合はスキップ
                        if (!content.candidates) { continue; }
                        // ファイルに書き出す
                        fss.appendFile(`${HISTORY_DIRE}/${idempotencyKey}-${attempts}.txt`, JSON.stringify(content) || '', {}, () => { });

                        if (content.candidates[0] && content.candidates[0].safetyRatings) {
                            safetyRatings = content.candidates[0] && content.candidates[0].safetyRatings;
                        }
                        // console.log(`${tokenCount.completion_tokens}: ${data.toString()}`);
                        if (content.candidates[0] && content.candidates[0].content && content.candidates[0].content.parts && content.candidates[0].content.parts[0] && content.candidates[0].content.parts[0].text) {
                            const text = content.candidates[0].content.parts[0].text || '';
                            tokenBuilder += text;
                            tokenCount.completion_tokens += text.length;

                            // streamHandlerを呼び出す
                            observer.next(text);
                        } else { }
                        // [1]   candidates: [ { finishReason: 'OTHER', index: 0, content: [Object] } ],
                        if (content.candidates[0] && content.candidates[0].finishReason && content.candidates[0].finishReason !== 'STOP') {
                            // finishReasonが指定されている、かつSTOPではない場合はエラー終了させる。
                            // ストリームが終了したらループを抜ける
                            tokenCount.cost = tokenCount.calcCost();
                            throw JSON.stringify({ safetyRatings, candidate: content.candidates[0] });
                        } else { }
                        // candidates: [ { finishReason: 'OTHER', index: 0, content: [Object] } ],
                    }
                    return;
                }
                // ストリームの読み取りを開始
                return readStream();

            });
        } else {
            const client =
                this.openApiWrapper.wrapperOptions.provider === 'groq' ? groq
                    : this.openApiWrapper.wrapperOptions.provider === 'mistral' ? mistral
                        : this.openApiWrapper.wrapperOptions.provider === 'deepseek' ? deepSeek
                            : this.openApiWrapper.wrapperOptions.provider === 'local' ? local
                                : openai;
            fss.writeFile(`${HISTORY_DIRE}/${idempotencyKey}-${attempts}.request.json`, JSON.stringify({ args, options }, Utils.genJsonSafer()), {}, (err) => { });
            runPromise = (client.chat.completions.create(args, options) as APIPromise<Stream<ChatCompletionChunk>>)
                .withResponse().then((response) => {
                    response.response.headers.get('x-ratelimit-limit-requests') && (ratelimitObj.limitRequests = Number(response.response.headers.get('x-ratelimit-limit-requests')));
                    response.response.headers.get('x-ratelimit-limit-tokens') && (ratelimitObj.limitTokens = Number(response.response.headers.get('x-ratelimit-limit-tokens')));
                    response.response.headers.get('x-ratelimit-remaining-requests') && (ratelimitObj.remainingRequests = Number(response.response.headers.get('x-ratelimit-remaining-requests')));
                    response.response.headers.get('x-ratelimit-remaining-tokens') && (ratelimitObj.remainingTokens = Number(response.response.headers.get('x-ratelimit-remaining-tokens')));
                    response.response.headers.get('x-ratelimit-reset-requests') && (ratelimitObj.resetRequests = response.response.headers.get('x-ratelimit-reset-requests') || '');
                    response.response.headers.get('x-ratelimit-reset-tokens') && (ratelimitObj.resetTokens = response.response.headers.get('x-ratelimit-reset-tokens') || '');

                    const headers: { [key: string]: string } = {};
                    response.response.headers.forEach((value, key) => {
                        // console.log(`${key}: ${value}`);
                        headers[key] = value;
                    });

                    fss.writeFile(`${HISTORY_DIRE}/${idempotencyKey}-${attempts}.response.json`, JSON.stringify({ args, options, response: { status: response.response.status, headers } }, Utils.genJsonSafer()), {}, (err) => { });

                    // ストリームからデータを読み取るためのリーダーを取得
                    const reader = response.data.toReadableStream().getReader();

                    let tokenBuilder: string = '';

                    const _that = this;

                    // ストリームからデータを読み取る非同期関数
                    async function readStream() {
                        while (true) {
                            const { value, done } = await reader.read();
                            if (done) {
                                // ストリームが終了したらループを抜ける
                                tokenCount.cost = tokenCount.calcCost();
                                console.log(logObject.output('fine', ''));
                                observer.complete();

                                _that.openApiWrapper.fire();

                                // ファイルに書き出す
                                const trg = args.response_format?.type === 'json_object' ? 'json' : 'md';
                                fss.writeFile(`${HISTORY_DIRE}/${idempotencyKey}-${attempts}.result.${trg}`, tokenBuilder || '', {}, () => { });
                                break;
                            }
                            // 中身を取り出す
                            const content = decoder.decode(value);
                            // console.log(content);

                            // 中身がない場合はスキップ
                            if (!content) { continue; }
                            // ファイルに書き出す
                            fss.appendFile(`${HISTORY_DIRE}/${idempotencyKey}-${attempts}.txt`, content || '', {}, () => { });
                            // console.log(`${tokenCount.completion_tokens}: ${data.toString()}`);
                            // トークン数をカウント
                            tokenCount.completion_tokens++;
                            const text = JSON.parse(content).choices[0].delta.content || '';
                            tokenBuilder += text;
                            tokenCount.tokenBuilder = tokenBuilder;

                            // streamHandlerを呼び出す
                            observer.next(text);
                        }
                        return;
                    }
                    // ストリームの読み取りを開始
                    return readStream();
                });
        }
        runPromise.catch(error => {
            attempts++;

            // エラーを出力
            console.log(logObject.output('error', JSON.stringify(error, Utils.genJsonSafer())));

            // 400エラーの場合は、リトライしない
            if (error.toString().startsWith('Error: 400')) {
                observer.error(error);
                this.openApiWrapper.fire(); // キューに着火
                throw error;
            } else { }

            // 最大試行回数に達したかチェック
            if (attempts >= maxAttempts) {
                // throw new Error(`API call failed after ${maxAttempts} attempts: ${error}`);
                console.log(logObject.output('error', 'retry over'));
                observer.error('retry over');
                this.openApiWrapper.fire(); // キューに着火
                throw error;
            } else { }

            // レートリミットに引っかかった場合は、レートリミットに書かれている時間分待機する。
            if (error.toString().startsWith('Error: 429') || JSON.stringify(error, Utils.genJsonSafer()).includes('"429"')) {
                let waitMs = Number(String(ratelimitObj.resetRequests).replace('ms', '')) || 0;
                let waitS = Number(String(ratelimitObj.resetTokens).replace('s', '')) || 0;
                // 待ち時間が設定されていなかったらとりあえずRPM/TPMを回復させるために60秒待つ。
                waitMs = waitMs === 0 ? ((waitS || 60) * 1000) : waitMs;
                console.log(logObject.output('wait', `wait ${waitMs}ms ${waitS}s`));
                setTimeout(() => { this.executeCall(); }, waitMs);
            } else { }

            observer.error(error);
            this.openApiWrapper.fire(); // キューに着火
            // throw error; // TODO 本当は throw error しても大丈夫なように作るべきだが、 Unhandled Error になるので一旦エラー出さない。
        });
        return runPromise;
    };
}


const VISION_MODELS = ['gpt-4o', 'gpt-4o-2024-05-13', 'gpt-4-turbo', 'gpt-4-turbo-2024-04-09', 'gpt-4-turbo-preview', 'gpt-4-vision-preview', 'gemini-1.5-flash-001', 'gemini-1.5-pro-001', 'gemini-1.0-pro-vision-001', 'gemini-1.5-flash', 'gemini-1.5-pro', 'gemini-1.0-pro-vision'];
const JSON_MODELS = ['gpt-4o', 'gpt-4o-2024-05-13', 'gpt-4-turbo', 'gpt-4-turbo-2024-04-09', 'gpt-4-turbo-preview', 'gpt-4-1106-preview', 'gpt-4-0125-preview', 'gpt-3.5-turbo', 'gpt-3.5-turbo-1106'];
const GPT4_MODELS = ['gpt-4o', 'gpt-4o-2024-05-13', 'gpt-4-turbo', 'gpt-4-turbo-2024-04-09', 'gpt-4-turbo-preview', 'gpt-4-1106-preview', 'gpt-4-0125-preview'];
/**
 * OpenAIのAPIを呼び出すラッパークラス
 */
export class OpenAIApiWrapper {

    // proxy設定用オブジェクト
    options: RequestOptions;

    // トークン数をカウントするためのリスト
    tokenCountList: TokenCount[] = [];

    // 実行待リスト key = short name
    waitQueue: { [key: string]: RunBit[] } = {};
    // 実行中リスト key = short name
    inProgressQueue: { [key: string]: RunBit[] } = {};
    // タイムアウト管理オブジェクト
    timeoutMap: { [key: string]: NodeJS.Timeout | null } = {};

    // レートリミット情報
    currentRatelimit: { [key: string]: Ratelimit } = {
        // openai
        'gpt3.5  ': { limitRequests: 10000, limitTokens: 1000000, remainingRequests: 1, remainingTokens: 5000000, resetRequests: '0ms', resetTokens: '0s', },
        'gpt3-16k': { limitRequests: 10000, limitTokens: 1000000, remainingRequests: 1, remainingTokens: 5000000, resetRequests: '0ms', resetTokens: '0s', },
        'gpt4    ': { limitRequests: 10000, limitTokens: 300000, remainingRequests: 1, remainingTokens: 8000, resetRequests: '0ms', resetTokens: '0s', },
        'gpt4-32k': { limitRequests: 10000, limitTokens: 300000, remainingRequests: 1, remainingTokens: 32000, resetRequests: '0ms', resetTokens: '0s', },
        'gpt4-128': { limitRequests: 10000, limitTokens: 800000, remainingRequests: 1, remainingTokens: 128000, resetRequests: '0ms', resetTokens: '0s', },
        'gpt4-vis': { limitRequests: 10000, limitTokens: 800000, remainingRequests: 1, remainingTokens: 128000, resetRequests: '0ms', resetTokens: '0s', },
        'gpt4-o  ': { limitRequests: 10000, limitTokens: 800000, remainingRequests: 1, remainingTokens: 128000, resetRequests: '0ms', resetTokens: '0s', },
        // groq
        'g-mxl-87': { limitRequests: 10, limitTokens: 100000, remainingRequests: 1, remainingTokens: 128000, resetRequests: '0ms', resetTokens: '0s', },
        'g-lm2-70': { limitRequests: 10, limitTokens: 100000, remainingRequests: 1, remainingTokens: 128000, resetRequests: '0ms', resetTokens: '0s', },
        // mistral
        'msl-7b  ': { limitRequests: 5, limitTokens: 2000000, remainingRequests: 1, remainingTokens: 128000, resetRequests: '1000ms', resetTokens: '60s', },
        'msl-87b ': { limitRequests: 5, limitTokens: 2000000, remainingRequests: 1, remainingTokens: 128000, resetRequests: '1000ms', resetTokens: '60s', },
        'msl-sm  ': { limitRequests: 5, limitTokens: 2000000, remainingRequests: 1, remainingTokens: 128000, resetRequests: '1000ms', resetTokens: '60s', },
        'msl-md  ': { limitRequests: 5, limitTokens: 2000000, remainingRequests: 1, remainingTokens: 128000, resetRequests: '1000ms', resetTokens: '60s', },
        'msl-lg  ': { limitRequests: 5, limitTokens: 2000000, remainingRequests: 1, remainingTokens: 128000, resetRequests: '1000ms', resetTokens: '60s', },

        'cla-1.2 ': { limitRequests: 5, limitTokens: 2000000, remainingRequests: 1, remainingTokens: 128000, resetRequests: '1000ms', resetTokens: '60s', },
        'cla-2   ': { limitRequests: 5, limitTokens: 2000000, remainingRequests: 1, remainingTokens: 128000, resetRequests: '1000ms', resetTokens: '60s', },
        'cla-2.1 ': { limitRequests: 5, limitTokens: 2000000, remainingRequests: 1, remainingTokens: 128000, resetRequests: '1000ms', resetTokens: '60s', },
        'cla-3-hk': { limitRequests: 5, limitTokens: 100000, remainingRequests: 5, remainingTokens: 50000, resetRequests: '1000ms', resetTokens: '60s', },
        'cla-3-sn': { limitRequests: 5, limitTokens: 100000, remainingRequests: 5, remainingTokens: 50000, resetRequests: '1000ms', resetTokens: '60s', },
        'cla-35sn': { limitRequests: 5, limitTokens: 100000, remainingRequests: 5, remainingTokens: 50000, resetRequests: '1000ms', resetTokens: '60s', },
        'cla-3-op': { limitRequests: 5, limitTokens: 100000, remainingRequests: 5, remainingTokens: 50000, resetRequests: '1000ms', resetTokens: '60s', },
        'dps-code': { limitRequests: 5, limitTokens: 50000, remainingRequests: 1, remainingTokens: 50000, resetRequests: '1000ms', resetTokens: '60s', },
        'dps-chat': { limitRequests: 5, limitTokens: 50000, remainingRequests: 1, remainingTokens: 50000, resetRequests: '1000ms', resetTokens: '60s', },

        'gem-15fl': { limitRequests: 100, limitTokens: 2000000, remainingRequests: 1, remainingTokens: 200000, resetRequests: '1000ms', resetTokens: '60s', },
        'gem-15pr': { limitRequests: 100, limitTokens: 2000000, remainingRequests: 1, remainingTokens: 200000, resetRequests: '1000ms', resetTokens: '60s', },
        'gem-10pr': { limitRequests: 100, limitTokens: 2000000, remainingRequests: 1, remainingTokens: 200000, resetRequests: '1000ms', resetTokens: '60s', },
        'gem-10pv': { limitRequests: 100, limitTokens: 2000000, remainingRequests: 1, remainingTokens: 200000, resetRequests: '1000ms', resetTokens: '60s', },

        // 'anthropic-ratelimit-requests-limit': '50',
        // 'anthropic-ratelimit-requests-remaining': '46',
        // 'anthropic-ratelimit-requests-reset': '2024-03-09T08:35:00Z',
        // 'anthropic-ratelimit-tokens-limit': '50000',
        // 'anthropic-ratelimit-tokens-remaining': '31000',
        // 'anthropic-ratelimit-tokens-reset': '2024-03-09T08:35:00Z',
    };

    constructor(
        public wrapperOptions: WrapperOptions = { allowLocalFiles: false, provider: 'vertexai' }
    ) {
        this.options = options;
        this.options.stream = true;
        // this.options.timeout = 1200000;

        // this.options = {};
        // console.log(this.options);

        try { fs.mkdirSync(`${HISTORY_DIRE}`, { recursive: true }); } catch (e) { }
        // ヘッダー出力
        console.log(`timestamp               step  R time[ms]  prompt comple model    cost   label`);
    }

    /**
     * OpenAIのAPIを呼び出す関数
     * @param args:ChatCompletionCreateParamsBase Streamモード固定で動かすのでstreamオプションは指定しても無駄。
     * @param options:{idempotencyKey: string} RequestOptionsのidempotencyKeyのみ指定可能とする。他はコンストラクタで指定した値。
     * 
     * @returns Observable<string>でOpenAIのレスポンスの中身のテキストだけをストリーミングする。
     */
    chatCompletionObservableStream(
        args: ChatCompletionCreateParamsStreaming,
        options?: { label?: string }, // idempotencyKeyの元ネタにするラベル。指定しない場合は、argsのhashを使う。
    ): Observable<string> {
        return new Observable<string>((observer) => {

            // 強制的にストリームモードにする。
            args.stream = true;

            // フォーマットがjson指定なのにjsonという文字列が入ってない場合は追加する。
            if (args.response_format?.type == 'json_object' && JSON_MODELS.indexOf(args.model) !== -1) {
                const userMessage = args.messages.filter(message => message.role === 'user');
                const lastUserMessage = args.messages[args.messages.indexOf(userMessage[userMessage.length - 1])];
                if (!(lastUserMessage.content as string).includes('json')) {
                    lastUserMessage.content += '\n\n# Output format\njson';
                } else { /* それ以外は何もしない */ }
            } else {
                // それ以外はjson_object使えないのでフォーマットを削除する。
                delete args.response_format;
            }

            if (args.temperature && typeof args.temperature === 'string') {
                args.temperature = Number(args.temperature) || 0.7;
            } else { }
            if (args.top_p && typeof args.top_p === 'string') {
                args.top_p = Number(args.top_p) || 1;
            } else { }
            if (args.n && typeof args.n === 'string') {
                args.n = Number(args.n);
            } else { }

            let imagePrompt = 0;
            if (VISION_MODELS.indexOf(args.model) !== -1) {
                args.messages.forEach(message => {
                    if (Array.isArray(message.content)) {
                        message.content.forEach((content: ChatCompletionContentPart) => {
                            if (content.type === 'image_url' && content.image_url && content.image_url.url) {
                                // DANGER!!! ローカルファイルを読み込むのでオンラインから使わせるときはセキュリティ的に問題がある。
                                // ファイルの種類を判定して、画像の場合はbase64に変換してcontent.image_url.urlにセットする。
                                // TODO 外のURLには対応していない。
                                // console.log(content.image_url.url);
                                if (content.image_url.url.startsWith('file:///')) {
                                    if (this.wrapperOptions.allowLocalFiles) {
                                        const filePath = content.image_url.url.substring('file://'.length);
                                        const data = fs.readFileSync(filePath);
                                        const metaInfo = sizeOf(data);
                                        console.log(metaInfo);
                                        content.image_url.url = `data:image/${metaInfo.type === 'jpg' ? 'jpeg' : metaInfo.type};base64,${data.toString('base64')}`;
                                        // 画像のトークン数を計算する。
                                        imagePrompt += calculateTokenCost(metaInfo.width || 0, metaInfo.height || 0);
                                    } else {
                                        // エラー
                                        throw new Error(`ローカルファイルアクセスは禁止`);
                                    }
                                } else if (content.image_url.url.startsWith('data:')) {
                                    // データURLからデータを取り出してサイズを判定する。
                                    const data = Buffer.from(content.image_url.url.substring(content.image_url.url.indexOf(',') + 1), 'base64');
                                    const label = (content.image_url as any)['label'] as string;
                                    const trg = label.toLocaleLowerCase().replace(/.*\./g, '');
                                    const textTrgList = ['java', 'md', 'csh', 'sh', 'pl', 'php', 'rs', 'py', 'ipynb', 'cob', 'cbl', 'pco', 'copy', 'cpy', 'c', 'pc', 'h', 'cpp', 'hpp', 'yaml', 'yml', 'xml', 'properties', 'kt', 'sql', 'ddl', 'awk'];
                                    if (content.image_url.url.startsWith('data:image/')) {
                                        const metaInfo = sizeOf(data);
                                        // 画像のトークン数を計算する。
                                        imagePrompt += calculateTokenCost(metaInfo.width || 0, metaInfo.height || 0);
                                    } else if (content.image_url.url.startsWith('data:text/') || content.image_url.url.startsWith('data:application/octet-stream;base64,') || textTrgList.includes(trg)) {
                                        // テキストファイルの場合はデコードしてテキストにしてしまう。
                                        (content.type as any) = 'text';
                                        const detectedEncoding = detect(data);
                                        if (detectedEncoding.encoding === 'ISO-8859-2') {
                                            detectedEncoding.encoding = 'SHIFT_JIS'; // 文字コード自動判定でSJISがISO-8859-2ことがあるので
                                        }
                                        const decoder = new TextDecoder(detectedEncoding.encoding);
                                        const decodedString = decoder.decode(data);
                                        if ('label' in (content.image_url as any) && !trg.endsWith('.md')) {
                                            // label項目でファイル名が来ているときはmarkdownとして埋め込む。
                                            const label = (content.image_url as any).label as string;
                                            const trg = label.replace(/.*\./g, '');
                                            (content as any).text = '```' + trg + ' ' + label + '\n' + decodedString + '\n```';
                                        } else {
                                            (content as any).text = decodedString;
                                        }
                                        delete (content as any).image_url;
                                    }
                                } else {
                                    // 外部URLの場合は何もしない。トークン計算もしない。
                                }
                                // visionAPIはmax_tokenを指定しないと凄く短く終わるので最大化しておく。visionAPIのmax_tokenは4096が最大。
                                args.max_tokens = Math.max(args.max_tokens || 4096, 4096);
                            } else { /* それ以外は何もしない */ }
                        });
                    } else { /* それ以外は何もしない */ }
                });
            } else { /* それ以外は何もしない */ }

            // idempotencyKey の先頭にタイムスタンプをつける。（idempotencyKeyで履歴ファイルを作るので、時系列で履歴ファイルが並ぶようにと、あと単純に）
            const timestamp = Utils.formatDate(new Date(), 'yyyyMMddHHmmssSSS');

            let label = ''; // タイムスタンプをつける前のidempotencyKey。
            // idempotencyKeyが設定されてい無い場合は入力のhashを使う。
            const reqOptions: RequestOptions = {};
            const argsHash = crypto.createHash('MD5').update(JSON.stringify(args)).digest('hex');
            // const argsHash = crypto.createHash('sha256').update(JSON.stringify(args)).digest('hex');
            if (options && options.label) {
                // idempotencyKeyが設定されている場合。
                label = options.label;
                reqOptions.idempotencyKey = `${timestamp}-${argsHash}-${Utils.safeFileName(options.label)}`;
            } else {
                label = argsHash;
                reqOptions.idempotencyKey = `${timestamp}-${argsHash}`;
            }

            let attempts = 0;

            // ログ出力用オブジェクト
            const prompt = args.messages.map(message => `<im_start>${message.role}\n${typeof message.content === 'string' ? message.content : message.content?.map(content => content.type === 'text' ? content.text : content.image_url.url)}<im_end>`).join('\n');
            const tokenCount = new TokenCount(args.model as GPTModels, 0, 0);
            // gpt-4-1106-preview に未対応のため、gpt-4に置き換え。プロンプトのトークンを数えるだけなのでモデルはどれにしてもしても同じだと思われるが。。。
            if (args.model.startsWith('claude-')) {
                // 本当はAPIの戻りでトークン数を出したいけど、API投げる前にトークン数表示するログにしてしまったので、やむなくtiktokenのトークン数を表示する。APIで入力トークン数がわかったらそれを上書きするようにした。
                tokenCount.prompt_tokens = getEncoder((GPT4_MODELS.indexOf((tokenCount.modelTikToken as any)) !== -1) ? 'gpt-4' : tokenCount.modelTikToken).encode(prompt).length;
            } else if (args.model.startsWith('gemini-')) {
                // 本当はAPIの戻りでトークン数を出したいけど、API投げる前にトークン数表示するログにしてしまったので、やむなくtiktokenのトークン数を表示する。APIで入力トークン数がわかったらそれを上書きするようにした。
                tokenCount.prompt_tokens = getEncoder((GPT4_MODELS.indexOf((tokenCount.modelTikToken as any)) !== -1) ? 'gpt-4' : tokenCount.modelTikToken).encode(prompt).length;
            } else {
                tokenCount.prompt_tokens = getEncoder((GPT4_MODELS.indexOf((tokenCount.modelTikToken as any)) !== -1) ? 'gpt-4' : tokenCount.modelTikToken).encode(prompt).length;
            }
            // tokenCount.prompt_tokens = encoding_for_model((['gpt-4-turbo-preview', 'gpt-4-1106-preview', 'gpt-4-0125-preview', 'gpt-4-vision-preview'].indexOf((tokenCount.modelTikToken as any)) !== -1) ? 'gpt-4' : tokenCount.modelTikToken).encode(prompt).length;
            tokenCount.prompt_tokens += imagePrompt;
            this.tokenCountList.push(tokenCount);

            class LogObject {
                constructor(public baseTime: number) { }
                output(stepName: string, error: any = ''): string {
                    const take = numForm(Date.now() - this.baseTime, 10);
                    this.baseTime = Date.now(); // baseTimeを更新しておく。
                    const prompt_tokens = numForm(tokenCount.prompt_tokens, 6);
                    // 以前は1レスポンス1トークンだったが、今は1レスポンス1トークンではないので、completion_tokensは最後に再計算するようにした。
                    // tokenCount.completion_tokens = encoding_for_model((GPT4_MODELS.indexOf((tokenCount.modelTikToken as any)) !== -1) ? 'gpt-4' : tokenCount.modelTikToken).encode(tokenCount.tokenBuilder ? `<im_start>${tokenCount.tokenBuilder}` : '').length;
                    if (args.model.startsWith('claude-') || args.model.startsWith('gemini-')) {
                        // claudeの場合はAPIレスポンスでトークン数がわかっているのでそれを使う。
                    } else {
                        tokenCount.completion_tokens = getEncoder((GPT4_MODELS.indexOf((tokenCount.modelTikToken as any)) !== -1) ? 'gpt-4' : tokenCount.modelTikToken).encode(tokenCount.tokenBuilder ? `<im_start>${tokenCount.tokenBuilder}` : '').length;
                    }
                    const completion_tokens = numForm(tokenCount.completion_tokens, 6);

                    const costStr = (tokenCount.completion_tokens > 0 ? ('$' + (Math.ceil(tokenCount.cost * 100) / 100).toFixed(2)) : '').padStart(6, ' ');
                    const logString = `${Utils.formatDate()} ${stepName.padEnd(5, ' ')} ${attempts} ${take} ${prompt_tokens} ${completion_tokens} ${tokenCount.modelShort} ${costStr} ${label} ${error}`;
                    fss.appendFile(`history.log`, `${logString}\n`, {}, () => { });
                    return logString;
                }
            }
            const logObject = new LogObject(Date.now());
            console.log(logObject.output('enque'));
            // console.log(logString('enque'));

            const runBit = new RunBit(logObject, tokenCount, args, { ...reqOptions, ...this.options }, this, observer);
            // 未知モデル名の場合は空queueを追加しておく
            if (!this.waitQueue[tokenCount.modelShort]) this.waitQueue[tokenCount.modelShort] = [], this.inProgressQueue[tokenCount.modelShort] = [];
            this.waitQueue[tokenCount.modelShort].push(runBit);
            this.fire();
        });
    }


    fire(): void {
        const waitQueue = this.waitQueue;
        const inProgressQueue = this.inProgressQueue;
        for (const key of Object.keys(waitQueue)) {
            // 未知モデル名の場合は空Objectを追加しておく
            if (!this.currentRatelimit[key]) this.currentRatelimit[key] = { limitRequests: 0, limitTokens: 0, remainingRequests: 0, remainingTokens: 0, resetRequests: '', resetTokens: '' };
            const ratelimitObj = this.currentRatelimit[key];
            // console.log(`fire ${key} x waitQueue:${waitQueue[key].length} inProgressQueue:${inProgressQueue[key].length} reqlimit:${ratelimitObj.limitRequests} toklimit:${ratelimitObj.limitTokens} remainingRequests:${ratelimitObj.remainingRequests} remaingTokens:${ratelimitObj.remainingTokens}`);
            for (let i = 0; i < Math.min(waitQueue[key].length, ratelimitObj.remainingRequests - inProgressQueue[key].length); i++) {
                // console.log(`fire ${key} ${i} waitQueue:${waitQueue[key].length} inProgressQueue:${inProgressQueue[key].length} reqlimit:${ratelimitObj.limitRequests} toklimit:${ratelimitObj.limitTokens} remainingRequests:${ratelimitObj.remainingRequests} remaingTokens:${ratelimitObj.remainingTokens}`);
                if (waitQueue[key][i].tokenCount.prompt_tokens > ratelimitObj.remainingTokens
                    && ratelimitObj.remainingTokens !== ratelimitObj.limitTokens) { // そもそもlimitオーバーのトークンは弾かずに投げてしまう。
                    // console.log(`${i} ${queue[key][i].tokenCount.prompt_tokens} > ${ratelimitObj.remainingTokens}`);
                    continue;
                }
                const runBit = waitQueue[key].shift();
                if (!runBit) { break; }
                inProgressQueue[key].push(runBit);
                runBit.executeCall()
                    .then((response: any) => {
                        // console.log(`execute Call then ${runBit.tokenCount.modelShort} ${runBit.tokenCount.prompt_tokens} ${response}`);
                    })
                    .catch((error: any) => {
                        // console.log(`execute Call catc ${runBit.tokenCount.modelShort} ${runBit.tokenCount.prompt_tokens} ${JSON.stringify(error, Utils.genJsonSafer())}`);
                    })
                    .finally(() => {
                        // console.log(`execute Call fine ${runBit.tokenCount.modelShort} ${runBit.tokenCount.prompt_tokens}`);
                        inProgressQueue[key].splice(inProgressQueue[key].indexOf(runBit), 1);
                    });

                ratelimitObj.remainingRequests--;
                ratelimitObj.remainingTokens -= runBit.tokenCount.prompt_tokens;
            }
            // キューの残りがあるかチェック。
            if (waitQueue[key].length > 0) {
                // キューが捌けてない場合。
                if (this.timeoutMap[key] == null) {
                    // 待ちスレッドを立てる。
                    // TODO 待ち時間の計算がなんか変。。。
                    let waitMs = Number(String(ratelimitObj.resetRequests).replace('ms', '')) || 0;
                    let waitS = Number(String(ratelimitObj.resetTokens).replace('s', '')) || 0;
                    // 待ち時間が設定されていなかったらとりあえずRPM/TPMを回復させるために60秒待つ。
                    waitMs = waitMs === 0 ? ((waitS || 60) * 1000) : waitMs;
                    this.timeoutMap[key] = setTimeout(() => {
                        // console.log(ratelimitObj);
                        // console.log(queue[key].length);
                        ratelimitObj.remainingRequests = ratelimitObj.limitRequests - inProgressQueue[key].length;
                        ratelimitObj.remainingTokens = ratelimitObj.limitTokens;
                        this.timeoutMap[key] = null; // 監視スレッドをクリアしておかないと、次回以降のキュー追加時に監視スレッドが立たなくなる。
                        this.fire(); // 待ち時間が経過したので再点火する。
                    }, waitMs);
                } else {
                    // 既に待ちスレッドが立っている場合は何もしない。
                }
            } else {
                /** キューが捌けたので待ちスレッドをクリアする */
                this.timeoutMap[key] = null;
            }
        }
    }

    public total(): { [key: string]: TokenCount } {
        return this.tokenCountList.reduce((prev: { [key: string]: TokenCount }, current: TokenCount) => {
            const tokenCount = prev[current.modelShort] || new TokenCount(current.model, 0, 0);
            tokenCount.add(current);
            prev.all.add(current);
            prev[current.modelShort] = tokenCount;
            return prev;
        }, { 'all': new TokenCount('all' as any, 0, 0) });
    }
}

// TiktokenModelが新モデルに追いつくまでは自己定義で対応する。
// export type GPTModels = 'gpt-4' | 'gpt-4-0314' | 'gpt-4-0613' | 'gpt-4-32k' | 'gpt-4-32k-0314' | 'gpt-4-32k-0613' | 'gpt-4-turbo-preview' | 'gpt-4-1106-preview' | 'gpt-4-0125-preview' | 'gpt-4-vision-preview' | 'gpt-3.5-turbo' | 'gpt-3.5-turbo-0301' | 'gpt-3.5-turbo-0613' | 'gpt-3.5-turbo-16k' | 'gpt-3.5-turbo-16k-0613';
export type GPTModels = TiktokenModel
    | 'gpt-4o-2024-05-13' | 'gpt-4o'
    | 'llama2-70b-4096'
    | 'gemini-1.5-flash-001' | 'gemini-1.5-pro-001' | 'gemini-1.0-pro-001' | 'gemini-1.0-pro-vision-001'
    | 'gemini-1.5-flash' | 'gemini-1.5-pro' | 'gemini-1.0-pro' | 'gemini-1.0-pro-vision'
    | 'mixtral-8x7b-32768' | 'open-mistral-7b' | 'mistral-tiny-2312' | 'mistral-tiny' | 'open-mixtral-8x7b'
    | 'mistral-small-2312' | 'mistral-small' | 'mistral-small-2402' | 'mistral-small-latest' | 'mistral-medium-latest' | 'mistral-medium-2312' | 'mistral-medium' | 'mistral-large-latest' | 'mistral-large-2402' | 'mistral-embed'
    | 'claude-instant-1.2' | 'claude-2' | 'claude-2.1' | 'claude-3-haiku-20240307' | 'claude-3-sonnet-20240229' | 'claude-3-opus-20240229' | 'claude-3-5-sonnet-20240620'
    | 'deepseek-coder' | 'deepseek-chat';

/**
 * トークン数とコストを計算するクラス
 */
export class TokenCount {

    // モデル名とコストの対応表
    static COST_TABLE: { [key: string]: { prompt: number, completion: number } } = {
        'all     ': { prompt: 0.00000, completion: 0.00000, },
        'gpt3.5  ': { prompt: 0.00150, completion: 0.00200, },
        'gpt3-16k': { prompt: 0.00050, completion: 0.00150, },
        'gpt4    ': { prompt: 0.03000, completion: 0.06000, },
        'gpt4-32k': { prompt: 0.06000, completion: 0.12000, },
        'gpt4-vis': { prompt: 0.01000, completion: 0.03000, },
        'gpt4-128': { prompt: 0.01000, completion: 0.03000, },
        'gpt4-o  ': { prompt: 0.00500, completion: 0.01500, },
        'cla-1.2 ': { prompt: 0.00800, completion: 0.02400, },
        'cla-2   ': { prompt: 0.00800, completion: 0.02400, },
        'cla-2.1 ': { prompt: 0.00800, completion: 0.02400, },
        'cla-3-hk': { prompt: 0.00025, completion: 0.00125, },
        'cla-3-sn': { prompt: 0.00300, completion: 0.01500, },
        'cla-35sn': { prompt: 0.00300, completion: 0.01500, },
        'cla-3-op': { prompt: 0.01500, completion: 0.07500, },
        'g-mxl-87': { prompt: 0.00027, completion: 0.00027, },
        'g-lm2-70': { prompt: 0.00070, completion: 0.00080, },
        'msl-7b  ': { prompt: 0.00025, completion: 0.00025, },
        'msl-87b ': { prompt: 0.00070, completion: 0.00070, },
        'msl-sm  ': { prompt: 0.00200, completion: 0.00600, },
        'msl-md  ': { prompt: 0.00270, completion: 0.00810, },
        'msl-lg  ': { prompt: 0.00870, completion: 0.02400, },
        'dps-code': { prompt: 0.00000, completion: 0.00000, },
        'dps-chat': { prompt: 0.00000, completion: 0.00000, },
        'gem-15fl': { prompt: 0.000125, completion: 0.00025, },
        'gem-15pr': { prompt: 0.00250, completion: 0.00250, },
        'gem-10pr': { prompt: 0.000125, completion: 0.00025, },
        'gem-10pv': { prompt: 0.000125, completion: 0.000125, },
    };

    static SHORT_NAME: { [key: string]: string } = {
        // 'text-davinci-003': 'unused',
        // 'text-davinci-002': 'unused',
        // 'text-davinci-001': 'unused',
        // 'text-curie-001': 'unused',
        // 'text-babbage-001': 'unused',
        // 'text-ada-001': 'unused',
        // 'davinci': 'unused',
        // 'curie': 'unused',
        // 'babbage': 'unused',
        // 'ada': 'unused',
        // 'code-davinci-002': 'unused',
        // 'code-davinci-001': 'unused',
        // 'code-cushman-002': 'unused',
        // 'code-cushman-001': 'unused',
        // 'davinci-codex': 'unused',
        // 'cushman-codex': 'unused',
        // 'text-davinci-edit-001': 'unused',
        // 'code-davinci-edit-001': 'unused',
        // 'text-embedding-ada-002': 'unused',
        // 'text-similarity-davinci-001': 'unused',
        // 'text-similarity-curie-001': 'unused',
        // 'text-similarity-babbage-001': 'unused',
        // 'text-similarity-ada-001': 'unused',
        // 'text-search-davinci-doc-001': 'unused',
        // 'text-search-curie-doc-001': 'unused',
        // 'text-search-babbage-doc-001': 'unused',
        // 'text-search-ada-doc-001': 'unused',
        // 'code-search-babbage-code-001': 'unused',
        // 'code-search-ada-code-001': 'unused',
        // 'gpt2': 'unused',
        'gpt-4': 'gpt4    ',
        'gpt-4-0314': 'gpt4    ',
        'gpt-4-0613': 'gpt4    ',
        'gpt-4-32k': 'gpt4-32k',
        'gpt-4-32k-0314': 'gpt4-32k',
        'gpt-4-32k-0613': 'gpt4-32k',
        'gpt-4-turbo': 'gpt4-128',
        'gpt-4-turbo-2024-04-09': 'gpt4-128',
        'gpt-4-turbo-preview': 'gpt4-128',
        'gpt-4-1106-preview': 'gpt4-128',
        'gpt-4-0125-preview': 'gpt4-128',
        'gpt-4-vision-preview': 'gpt4-vis',
        'gpt-4o': 'gpt4-o  ',
        'gpt-4o-2024-05-13': 'gpt4-o  ',
        'gpt-3.5-turbo': 'gpt3-16k',
        'gpt-3.5-turbo-0125': 'gpt3-16k',
        'gpt-3.5-turbo-0301': 'gpt3.5  ',
        'gpt-3.5-turbo-0613': 'gpt3.5  ',
        'gpt-3.5-turbo-1106': 'gpt3-16k',
        'gpt-3.5-turbo-16k': 'gpt3-16k',
        'gpt-3.5-turbo-16k-0613	': 'gpt3-16k',
        'gpt-3.5-turbo-instruct': 'gpt3.5  ',
        'gpt-3.5-turbo-instruct-0914': 'gpt3.5  ',
        'mixtral-8x7b-32768': 'g-mxl-87',
        'llama2-70b-4096': 'g-lm2-70',
        'open-mistral-7b': 'msl-7b  ',
        'claude-instant-1.2': 'cla-1.2 ',
        'claude-2': 'cla-2   ',
        'claude-2.1': 'cla-2.1 ',
        'claude-3-haiku-20240307': 'cla-3-hk',
        'claude-3-sonnet-20240229': 'cla-3-sn',
        'claude-3-opus-20240229': 'cla-3-op',
        'claude-3-5-sonnet-20240620': 'cla-35sn',
        'mistral-tiny-2312': 'msl-tiny',
        'mistral-tiny': 'msl-tiny',
        'open-mixtral-8x7b': 'msl-87b ',
        'mistral-small-2312': 'msl-sm  ',
        'mistral-small': 'msl-sm  ',
        'mistral-small-2402': 'msl-sm  ',
        'mistral-small-latest': 'msl-sm  ',
        'mistral-medium-latest': 'msl-md  ',
        'mistral-medium-2312': 'msl-md  ',
        'mistral-medium': 'msl-md  ',
        'mistral-large-latest': 'msl-lg  ',
        'mistral-large-2402': 'msl-lg  ',
        'mistral-embed': 'msl-em  ',
        'deepseek-coder': 'dps-code',
        'deepseek-chat': 'dps-chat',
        'gemini-1.5-flash-001': 'gem-15fl',
        'gemini-1.5-pro-001': 'gem-15pr',
        'gemini-1.0-pro-001': 'gem-10pr',
        'gemini-1.0-pro-vision-001': 'gem-10pv',
        'gemini-1.5-flash': 'gem-15fl',
        'gemini-1.5-pro': 'gem-15pr',
        'gemini-1.0-pro': 'gem-10pr',
        'gemini-1.0-pro-vision': 'gem-10pv',
    };

    // コスト
    public cost: number = 0;

    // モデル名の短縮形
    public modelShort: string;

    // モデル名トークンカウント用
    public modelTikToken: TiktokenModel;

    /**
     * @param model: 'gpt-3.5-turbo'|'gpt-4' モデル名
     * @param prompt_tokens: number  プロンプトのトークン数
     * @param completion_tokens: number コンプリーションのトークン数
     * @returns TokenCount インスタンス
     */
    constructor(
        public model: GPTModels,
        public prompt_tokens: number = 0,
        public completion_tokens: number = 0,
        public tokenBuilder: string = '',
    ) {
        this.modelShort = 'all     ';
        this.modelTikToken = 'gpt-3.5-turbo';
        this.modelShort = TokenCount.SHORT_NAME[model] || model;
        this.modelTikToken = model as TiktokenModel;
    }

    calcCost(): number {
        this.cost = (
            (TokenCount.COST_TABLE[this.modelShort]?.prompt || 0) * this.prompt_tokens +
            (TokenCount.COST_TABLE[this.modelShort]?.completion || 0) * this.completion_tokens
        ) / 1000;
        return this.cost;
    }

    /**
     * トークン数とコストを加算する
     * @param obj 
     * @returns 
     */
    add(obj: TokenCount): TokenCount {
        this.cost += obj.cost;
        this.prompt_tokens += obj.prompt_tokens;
        this.completion_tokens += obj.completion_tokens;
        return this;
    }

    /** 
     * @returns string ログ出力用の文字列
     */
    toString(): string {
        return `${this.modelShort.padEnd(8)} ${this.prompt_tokens.toLocaleString().padStart(6, ' ')} ${this.completion_tokens.toLocaleString().padStart(6, ' ')} ${('$' + (Math.ceil(this.cost * 100) / 100).toFixed(2)).padStart(6, ' ')}`;
    }
}

/**
 * 画像のトークン数を計算する
 * @param width 
 * @param height 
 * @param detail 
 * @returns 
 */
function calculateTokenCost(width: number, height: number, detail: 'low' | 'high' | 'auto' = 'high'): number {
    if (detail === 'low') {
        return 85;
    } else {
        // Scale down the image to fit within a 2048 x 2048 square if necessary
        if (width > 2048 || height > 2048) {
            const scaleFactor = Math.min(2048 / width, 2048 / height);
            width *= scaleFactor;
            height *= scaleFactor;
        }

        // Scale the image such that the shortest side is 768px long
        const scaleFactor = 768 / Math.min(width, height);
        width *= scaleFactor;
        height *= scaleFactor;

        // Count how many 512px squares the image consists of
        const numSquares = Math.ceil(width / 512) * Math.ceil(height / 512);

        // Each square costs 170 tokens, with an additional 85 tokens added to the total
        const totalCost = 170 * numSquares + 85;

        return totalCost;
    }
}

function numForm(dec: number, len: number) { return (dec || '').toLocaleString().padStart(len, ' '); };
async function wait(ms: number) { return new Promise(resolve => setTimeout(resolve, ms)); }

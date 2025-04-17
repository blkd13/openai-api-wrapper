import { Chat, ChatCompletion, ChatCompletionContentPartText, ChatCompletionMessageToolCall, ChatCompletionStreamOptions, ChatCompletionTool, ChatCompletionToolChoiceOption, ChatCompletionToolMessageParam, CompletionUsage } from 'openai/resources/index';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { EMPTY, Observable, Subscriber, catchError, concat, concatMap, concatWith, endWith, filter, find, forkJoin, from, map, merge, of, startWith, switchMap, tap, toArray } from 'rxjs';
import * as crypto from 'crypto';
import * as fs from 'fs';
import sizeOf from 'image-size';
import { detect } from 'jschardet';

const { GCP_PROJECT_ID, GCP_REGION, GCP_REGION_ANTHROPIC, GCP_API_BASE_PATH } = process.env as { GCP_PROJECT_ID: string, GCP_REGION: string, GCP_REGION_ANTHROPIC: string, GCP_API_BASE_PATH: string };
// if (!PROJECT_ID || !LOCATION) {
//     throw new Error('Missing required environment variables');
// }

// configureGlobalFetchを読み込むとfetchのproxyが効くようになるので、VertexAI用にただ読み込むだけ。
import * as configureGlobalFetch from './configureGlobalFetch.js'; configureGlobalFetch;

import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { AnthropicVertex } from '@anthropic-ai/vertex-sdk';
import { Content, FunctionCall, FunctionDeclarationsTool, GenerateContentRequest, GenerateContentResponse, GenerateContentResult, HarmBlockThreshold, HarmCategory, Part, StreamGenerateContentResult, UsageMetadata, VertexAI } from '@google-cloud/vertexai';
import { generateContentStream } from '@google-cloud/vertexai/build/src/functions/generate_content.js';

// import { EnhancedGenerateContentResponse, GoogleGenerativeAI } from '@google/generative-ai';
import * as googleGenerativeAI from '@google/generative-ai';

import { AzureOpenAI } from 'openai';

import { Cohere, CohereClientV2 } from "cohere-ai";
import { StreamedChatResponseV2, V2ChatStreamRequest } from 'cohere-ai/api';
import { V2 } from 'cohere-ai/api/resources/v2/client/Client';

import { APIPromise, RequestOptions } from 'openai/core';
import { ChatCompletionChunk, ChatCompletionContentPart, ChatCompletionCreateParamsBase, ChatCompletionCreateParamsStreaming, ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { Stream } from 'openai/streaming';
import { Tiktoken, TiktokenModel, encoding_for_model } from 'tiktoken';

import fss from './fss.js';
import { Utils } from "./utils.js";
import { getMetaDataFromDataURL } from './media-funcs.js';
import { COST_TABLE, SHORT_NAME, Ratelimit, AiProvider, currentRatelimit, GPTModels, GPT4_MODELS, VISION_MODELS, JSON_MODELS } from './model-definition.js';

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
const cerebras = new OpenAI({
    apiKey: process.env['CEREBRAS_API_KEY'] || 'dummy',
    baseURL: 'https://api.cerebras.ai/v1',
});

const anthropic = new Anthropic({
    apiKey: process.env['ANTHROPIC_API_KEY'] || 'dummy',
    httpAgent: options.httpAgent,
    maxRetries: 3,
});

const gemini = new googleGenerativeAI.GoogleGenerativeAI(process.env['GEMINI_API_KEY'] || 'dummy');

const deepseek = new OpenAI({
    apiKey: process.env['DEEPSEEK_API_KEY'] || 'dummy',
    baseURL: 'https://api.deepseek.com',
});

const cohere = new CohereClientV2({ token: process.env['COHERE_API_KEY'] || 'dummy' });

const local = new OpenAI({
    apiKey: process.env['LOCAL_AI_API_KEY'] || 'dummy',
    baseURL: process.env['LOCAL_AI_BASE_URL'] || 'dummy',
    httpAgent: false,
});

// 環境変数からAPIキーとエンドポイントを取得
const AZURE_OPENAI_API_KEY_01 = process.env.AZURE_OPENAI_API_KEY_01 || 'dummy';
const AZURE_OPENAI_ENDPOINT_01 = process.env.AZURE_OPENAI_ENDPOINT_01 || 'dummy';
const AZURE_OPENAI_DEPLOYMENT_01 = process.env.AZURE_OPENAI_DEPLOYMENT_01 || 'dummy';

const AZURE_OPENAI_API_KEY_02 = process.env.AZURE_OPENAI_API_KEY_02 || 'dummy';
const AZURE_OPENAI_ENDPOINT_02 = process.env.AZURE_OPENAI_ENDPOINT_02 || 'dummy';
const AZURE_OPENAI_DEPLOYMENT_02 = process.env.AZURE_OPENAI_DEPLOYMENT_02 || 'dummy';

const AZURE_OPENAI_API_KEY_03 = process.env.AZURE_OPENAI_API_KEY_03 || 'dummy';
const AZURE_OPENAI_ENDPOINT_03 = process.env.AZURE_OPENAI_ENDPOINT_03 || 'dummy';
const AZURE_OPENAI_DEPLOYMENT_03 = process.env.AZURE_OPENAI_DEPLOYMENT_03 || 'dummy';

// const apiVersion = '2024-08-01-preview';
const apiVersion = '2024-12-01-preview';
const azureClient_01 = new AzureOpenAI({ baseURL: AZURE_OPENAI_ENDPOINT_01, apiKey: AZURE_OPENAI_API_KEY_01, deployment: AZURE_OPENAI_DEPLOYMENT_01, apiVersion });
const azureClient_02 = new AzureOpenAI({ baseURL: AZURE_OPENAI_ENDPOINT_02, apiKey: AZURE_OPENAI_API_KEY_02, deployment: AZURE_OPENAI_DEPLOYMENT_02, apiVersion });
const azureClient_03 = new AzureOpenAI({ baseURL: AZURE_OPENAI_ENDPOINT_03, apiKey: AZURE_OPENAI_API_KEY_03, deployment: AZURE_OPENAI_DEPLOYMENT_03, apiVersion });


import { CachedContent, countChars, GenerateContentRequestExtended, mapForGemini, mapForGeminiExtend, MyVertexAiClient } from './my-vertexai.js';
import { ContentBlockParam, DocumentBlockParam, ImageBlockParam, MessageParam, MessageStreamEvent, MessageStreamParams, Tool, Usage } from '@anthropic-ai/sdk/resources/index.js';
import { ReadableStream } from '@anthropic-ai/sdk/_shims/index.js';
import { convertAnthropicToOpenAI, remapAnthropic } from './my-anthropic.js';

// Initialize Vertex with your Cloud project and location
export const my_vertexai = new MyVertexAiClient();
export const vertex_ai = new VertexAI({ project: GCP_PROJECT_ID || '', location: GCP_REGION || 'asia-northeast1', apiEndpoint: `${GCP_REGION}-${GCP_API_BASE_PATH}` });
export const anthropicVertex = new AnthropicVertex({ projectId: GCP_PROJECT_ID || '', region: GCP_REGION_ANTHROPIC || 'europe-west1', baseURL: `https://${GCP_REGION_ANTHROPIC}-${GCP_API_BASE_PATH}/v1`, httpAgent: options.httpAgent }); //TODO 他で使えるようになったら変える。

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

export function providerPrediction(model: string, provider?: AiProvider): AiProvider {
    // providerが指定されている場合は、そのプロバイダーを使う。
    // 指定されていなかったら、モデル名からプロバイダーを推測する。
    if (provider) {
        return provider as AiProvider;
    } else if (model.startsWith('gemini-')) {
        return 'gemini';
        return 'vertexai';
    } else if (model.startsWith('meta/llama3-')) {
        return 'openapi_vertexai';
    } else if (model.startsWith('claude-')) {
        return 'anthropic';
        return 'anthropic_vertexai';
    } else if (model.startsWith('gpt-') || model.startsWith('o1') || model.startsWith('o3')) {
        return 'openai';
        return 'azure';
    } else if (model.startsWith('deepseek-r1-distill-') || model.startsWith('llama-3.3-70b-')) {
        return 'groq';
    } else if (model.startsWith('llama-3.3-70b')) {
        return 'cerebras';
    } else if (model.startsWith('command-') || model.startsWith('c4ai-')) {
        return 'cohere';
    } else if (model.startsWith('deepseek-')) {
        return 'deepseek';
    } else {
        // 未知モデルはlocalに向ける。
        return 'local';
    }
}

export interface WrapperOptions {
    allowLocalFiles: boolean;
}

// Uint8Arrayを文字列に変換
const decoder = new TextDecoder();

export interface MyToolInfo {
    isActive: boolean;
    group: string;
    name?: string;
    label: string;
    isInteractive?: boolean; // ユーザーの入力を要するもの
    responseType?: 'json' | 'text' | 'markdown';
}
export interface MyToolType {
    info: MyToolInfo;
    definition: ChatCompletionTool;
    handler: (args: any) => Promise<unknown>,
}
export interface MyCompletionOptions {
    // idempotencyKey: string;
    // stream?: boolean;
    label?: string,
    toolCallCounter?: number,
    cachedContent?: CachedContent,
    tenantKey?: string,
    userId?: string,
    ip?: string,
    authType?: string,
    functions?: Record<string, MyToolType>;
    provider?: AiProvider;
}

class RunBit {
    attempts: number = 0;
    constructor(
        public logObject: { output: (stepName: string, error?: any, message?: string) => string },
        public tokenCount: TokenCount,
        public args: ChatCompletionCreateParamsBase,
        public provider: AiProvider,
        public options: RequestOptions,
        public openApiWrapper: OpenAIApiWrapper,
        public observer: Subscriber<ChatCompletionChunk>,
    ) { }

    async executeCall(): Promise<void> {
        const commonArgs = JSON.parse(JSON.stringify(this.args)) as ChatCompletionCreateParamsBase;
        const args = commonArgs;
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

        // max_tokensの調整
        if (commonArgs.max_tokens) {
            // トークン数が指定されている場合は、最大値を上限に設定
            commonArgs.max_tokens = Math.min(commonArgs.max_tokens, ratelimitObj.maxTokens);
        } else {
            // トークン数が指定されていない場合は、最大値を設定
            delete commonArgs.max_tokens;
        }

        const usageMetadata = {};
        console.log(logObject.output('start', ''));
        try {

            if (this.provider === 'anthropic' || this.provider === 'anthropic_vertexai') {
                const args = remapAnthropic(commonArgs);
                // anthropicの場合はmax_tokensは必須項目
                args.max_tokens = args.max_tokens === 0 ? ratelimitObj.maxTokens : args.max_tokens;
                runPromise = new Promise<void>(async (resolve, reject) => {
                    try {
                        // リクエストをファイルに書き出す
                        fss.writeFile(`${HISTORY_DIRE}/${idempotencyKey}-${attempts}.request.json`, JSON.stringify({ args, options }, Utils.genJsonSafer()), {}, (err) => { });
                        const client = this.provider === 'anthropic' ? anthropic : anthropicVertex;
                        const response: ReadableStream = args.model.includes('-thinking')
                            ? client.beta.messages.stream({ ...args, 'betas': 'output-128k-2025-02-19' } as MessageStreamParams).toReadableStream()
                            : client.messages.stream(args as MessageStreamParams).toReadableStream();
                        // console.dir(response);
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

                        const baseMessage = { id: '', role: 'assistant', created: 0, model: '' } as { id: string, role: 'system' | 'user' | 'assistant' | 'tool', created: number, model: string };

                        let type: 'text' | 'tool_use';
                        let index = 0;
                        // const toolCallUUID = Utils.generateUUID(); // ツールコールのUUIDを一つに統一するためとりあえず生成しておく
                        // ストリームからデータを読み取る非同期関数
                        async function readStream() {
                            while (true) {
                                try {
                                    const { value, done } = await reader.read();
                                    if (done) {
                                        // ストリームが終了したらループを抜ける
                                        tokenCount.cost = tokenCount.calcCost();
                                        console.log(logObject.output('fine', '', JSON.stringify(usageMetadata)));
                                        observer.complete();

                                        resolve();
                                        // ファイルに書き出す
                                        const trg = commonArgs.response_format?.type === 'json_object' ? 'json' : 'md';
                                        fss.writeFile(`${HISTORY_DIRE}/${idempotencyKey}-${attempts}.result.${trg}`, tokenBuilder || '', {}, () => { });
                                        _that.openApiWrapper.fire();
                                        break;
                                    }
                                    const content = decoder.decode(value);
                                    // console.log(content);

                                    // 中身がない場合はスキップ
                                    if (!content) { continue; }

                                    // ファイルに書き出す
                                    fss.appendFile(`${HISTORY_DIRE}/${idempotencyKey}-${attempts}.txt`, content || '', {}, () => { });
                                    const obj: MessageStreamEvent = JSON.parse(content);

                                    function remapAnthropic(obj: MessageStreamEvent): ChatCompletionChunk[] {
                                        if (obj.type === 'message_start') {
                                            baseMessage.id = obj.message.id;
                                            baseMessage.role = obj.message.role;

                                            tokenCount.prompt_tokens = obj.message.usage.input_tokens;
                                            tokenCount.completion_tokens = obj.message.usage.output_tokens;
                                            Object.assign(usageMetadata, obj.message.usage);
                                        } else if (obj.type === 'content_block_start') {
                                            index = obj.index;
                                            const choice: ChatCompletionChunk.Choice = {
                                                index: obj.index,
                                                delta: { role: baseMessage.role, content: null, refusal: null },
                                                logprobs: null,
                                                finish_reason: null,
                                            };
                                            const chunk: ChatCompletionChunk = {
                                                id: baseMessage.id,
                                                object: 'chat.completion.chunk',
                                                created: baseMessage.created,
                                                model: baseMessage.model,
                                                service_tier: 'default',
                                                system_fingerprint: '',
                                                choices: [choice],
                                            };

                                            if (obj.content_block.type === 'text') {
                                                choice.delta.content = obj.content_block.text;
                                            } else if (obj.content_block.type === 'tool_use') {
                                                choice.delta.tool_calls = [{
                                                    index: obj.index,
                                                    id: obj.content_block.id,
                                                    function: {
                                                        arguments: '', // obj.content_block.input || ''
                                                        name: obj.content_block.name,
                                                    },
                                                    type: 'function',
                                                }];
                                            } else {
                                                // 何もしない
                                                return [];
                                            }
                                            return [chunk];
                                        } else if (obj.type === 'content_block_delta') {
                                            const choice: ChatCompletionChunk.Choice = {
                                                index: obj.index,
                                                delta: { content: null, refusal: null },
                                                logprobs: null,
                                                finish_reason: null,
                                            };
                                            const chunk: ChatCompletionChunk = {
                                                id: baseMessage.id,
                                                object: 'chat.completion.chunk',
                                                created: baseMessage.created,
                                                model: baseMessage.model,
                                                service_tier: 'default',
                                                system_fingerprint: '',
                                                choices: [choice],
                                            };
                                            // // トークン数をカウント
                                            // tokenCount.completion_tokens++;
                                            if (obj.delta.type === 'text_delta') {
                                                choice.delta.content = obj.delta.text;

                                                tokenBuilder += obj.delta.text;
                                                tokenCount.tokenBuilder = tokenBuilder;
                                            } else if (obj.delta.type === 'input_json_delta') {
                                                const toolCall: ChatCompletionChunk.Choice.Delta.ToolCall = {
                                                    index: obj.index,
                                                    function: { arguments: obj.delta.partial_json || '', },
                                                    type: 'function',
                                                };
                                                choice.delta.tool_calls = [toolCall];
                                            } else if (obj.delta.type === 'thinking_delta') {
                                                (choice as any).thinking = obj.delta.thinking;
                                            } else if (obj.delta.type === 'signature_delta') {
                                                (choice as any).signature = obj.delta.signature;
                                            } else {
                                                // 何もしない
                                                return [];
                                            }
                                            return [chunk];
                                        } else if (obj.type === 'content_block_stop') {
                                            // // finish_reasonだけを飛ばす
                                            // const choice: ChatCompletionChunk.Choice = {
                                            //     index: index,
                                            //     delta: { content: null, refusal: null },
                                            //     logprobs: null,
                                            //     finish_reason: 'stop',
                                            // };
                                            // const chunk: ChatCompletionChunk = {
                                            //     id: baseMessage.id,
                                            //     object: 'chat.completion.chunk',
                                            //     created: baseMessage.created,
                                            //     model: baseMessage.model,
                                            //     service_tier: 'default',
                                            //     system_fingerprint: '',
                                            //     choices: [choice],
                                            // };
                                            // return [chunk];
                                        } else if (obj.type === 'message_delta') {
                                            Object.assign(usageMetadata, obj.usage);
                                            tokenCount.completion_tokens = obj.usage.output_tokens;

                                            const choice: ChatCompletionChunk.Choice = {
                                                index: index,
                                                delta: { content: null, refusal: null },
                                                logprobs: null,
                                                finish_reason: null,
                                            };
                                            const chunk: ChatCompletionChunk = {
                                                id: baseMessage.id,
                                                object: 'chat.completion.chunk',
                                                created: baseMessage.created,
                                                model: baseMessage.model,
                                                service_tier: 'default',
                                                system_fingerprint: '',
                                                choices: [choice],
                                            };

                                            if (obj.delta.stop_reason === 'end_turn') {
                                                // 何もしない
                                                // choice.finish_reason = 'stop';
                                            } else if (obj.delta.stop_reason === 'tool_use') {
                                                // 何もしない
                                                // choice.finish_reason = 'function_call';
                                            } else {
                                                // 何もしない
                                                return [];
                                            }
                                            return [chunk];
                                        } else if (obj.type === 'message_stop') {
                                            // 何もしない
                                            const chunk: ChatCompletionChunk = {
                                                id: baseMessage.id,
                                                object: 'chat.completion.chunk',
                                                created: baseMessage.created,
                                                model: baseMessage.model,
                                                service_tier: 'default',
                                                system_fingerprint: '',
                                                choices: [],
                                                usage: convertAnthropicToOpenAI(usageMetadata as any),
                                            };
                                            return [chunk];
                                        } else {
                                            // 何もしない
                                        }

                                        // return res;
                                        return [];
                                    }
                                    remapAnthropic(obj).forEach(chunk => {
                                        observer.next(chunk);
                                    });

                                } catch (e) {
                                    reject(e);
                                    break;
                                }
                            }
                            // console.log('readStreamFine');
                            return;
                        }
                        // ストリームの読み取りを開始
                        // console.log('readStreamStart');
                        return await readStream();
                    } catch (e) {
                        reject(e);
                    }
                    return;
                });
            } else if (this.provider === 'azure') {
                for (const key of ['safetySettings', 'cachedContent', 'gcpProjectId', 'isGoogleSearch']) delete (args as any)[key]; // Gemini用プロパティを消しておく
                const _options = { idempotencyKey: options.idempotencyKey, stream: options.stream };
                // 画像を50枚までに制限する
                const maxImageCount = 50;
                let imageCounter = 0;
                args.messages.forEach(message => {
                    if (Array.isArray(message.content)) {
                        message.content = message.content.map(c => {
                            imageCounter += c.type === 'image_url' ? 1 : 0;
                            if (imageCounter >= maxImageCount && c.type === 'image_url') {
                                // '画像が50枚を越えたため削除しました' 
                                return { type: 'text', text: `Images have been removed because the limit of ${maxImageCount} was exceeded.` };
                            } else {
                                return c;
                            }
                        }) as ChatCompletionContentPart[];
                    } else { }
                });
                if (args.model.startsWith('o1') || args.model.startsWith('o3')) {
                    // o1用にパラメータを調整
                    delete (args as any)['max_completion_tokens'];
                    delete args.max_tokens;
                    args.temperature = 1;
                    delete args.stream;
                    delete args.stream_options;
                    let tokenBuilder = '';
                    fss.writeFile(`${HISTORY_DIRE}/${idempotencyKey}-${attempts}.request.json`, JSON.stringify({ args, options: _options }, Utils.genJsonSafer()), {}, (err) => { });
                    // console.log({ idempotencyKey: options.idempotencyKey, stream: options.stream });
                    // なんでか知らんけどazureClientを通すとargs.modelが消えてしまったり、破壊的なことが起こるのでコピーを送る
                    runPromise = (((args.model === 'o1' || args.model === 'o3-mini') ? azureClient_03 : azureClient_02).chat.completions.create({ ...args }, _options) as APIPromise<Stream<ChatCompletionChunk>>)
                        .withResponse().then(async (response) => {
                            // < x-ratelimit-remaining-requests: 99
                            // < x-ratelimit-remaining-tokens: 99888
                            if ((response as any).headers) {
                                // azureのライブラリを直接改造してないとここは取れない。
                                'x-ratelimit-remaining-requests' in (response as any).headers && (ratelimitObj.remainingRequests = Number((response as any).headers['x-ratelimit-remaining-requests'])) || 1;
                                'x-ratelimit-remaining-tokens' in (response as any).headers && (ratelimitObj.remainingTokens = Number((response as any).headers['x-ratelimit-remaining-tokens'])) || 1;
                                // console.log((response as any).headers);
                            } else {
                            }

                            const headers: { [key: string]: string } = {};
                            response.response.headers.forEach((value, key) => {
                                // console.log(`${key}: ${value}`);
                                headers[key] = value;
                            });
                            // console.log(response.data);
                            const body = response.data as any as ChatCompletion;
                            const line = JSON.stringify(body);

                            this.openApiWrapper.fire();

                            fss.writeFile(`${HISTORY_DIRE}/${idempotencyKey}-${attempts}.response.json`, JSON.stringify({ args, options: _options, response: { status: response.response.status, headers, body } }, Utils.genJsonSafer()), {}, (err) => { });

                            // ファイルに書き出す
                            fss.appendFile(`${HISTORY_DIRE}/${idempotencyKey}-${attempts}.txt`, line, {}, () => { });

                            // トークン数をカウント
                            tokenCount.completion_tokens = body.usage?.completion_tokens || 0;
                            tokenCount.prompt_tokens = body.usage?.prompt_tokens || 0;

                            tokenBuilder += body.choices.map(choice => choice.message).filter(message => message).map(message => message.content).join('');
                            tokenCount.tokenBuilder = tokenBuilder;

                            const trg = args.response_format?.type === 'json_object' ? 'json' : 'md';
                            fss.writeFile(`${HISTORY_DIRE}/${idempotencyKey}-${attempts}.result.${trg}`, tokenBuilder || '', {}, () => { });

                            tokenCount.cost = tokenCount.calcCost();
                            console.log(logObject.output('fine', JSON.stringify(body.usage)));

                            // streamHandlerを呼び出す
                            // observer.next(text);
                            observer.next({
                                id: body.id,
                                choices: body.choices.map(choice => ({
                                    finish_reason: choice.finish_reason,
                                    index: choice.index,
                                    logprobs: choice.logprobs,
                                    delta: {
                                        role: choice.message.role,
                                        content: choice.message.content,
                                        refusal: choice.message.refusal,
                                        tool_calls: choice.message.tool_calls,
                                        function_call: choice.message.function_call,
                                    },
                                }) as ChatCompletionChunk.Choice),
                                created: body.created,
                                model: body.model,
                                object: 'chat.completion.chunk',
                                service_tier: body.service_tier,
                                system_fingerprint: body.system_fingerprint,
                                usage: body.usage,
                            });
                            // as ChatCompletionChunk
                            observer.complete();
                        });
                } else {
                    fss.writeFile(`${HISTORY_DIRE}/${idempotencyKey}-${attempts}.request.json`, JSON.stringify({ args, options: _options }, Utils.genJsonSafer()), {}, (err) => { });
                    runPromise = (azureClient_01.chat.completions.create({ ...args }, _options) as APIPromise<Stream<ChatCompletionChunk>>)
                        .withResponse().then(async (response) => {
                            // < x-ratelimit-remaining-requests: 99
                            // < x-ratelimit-remaining-tokens: 99888
                            if ((response as any).headers) {
                                // azureのライブラリを直接改造してないとここは取れない。
                                'x-ratelimit-remaining-requests' in (response as any).headers && (ratelimitObj.remainingRequests = Number((response as any).headers['x-ratelimit-remaining-requests'])) || 1;
                                'x-ratelimit-remaining-tokens' in (response as any).headers && (ratelimitObj.remainingTokens = Number((response as any).headers['x-ratelimit-remaining-tokens'])) || 1;
                                // console.log((response as any).headers);
                            } else {
                            }

                            const headers: { [key: string]: string } = {};
                            response.response.headers.forEach((value, key) => {
                                // console.log(`${key}: ${value}`);
                                headers[key] = value;
                            });

                            fss.writeFile(`${HISTORY_DIRE}/${idempotencyKey}-${attempts}.response.json`, JSON.stringify({ args, options: _options, response: { status: response.response.status, headers } }, Utils.genJsonSafer()), {}, (err) => { });

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
                                        console.log(logObject.output('fine', '', JSON.stringify(usageMetadata)));
                                        observer.complete();

                                        _that.openApiWrapper.fire();

                                        // ファイルに書き出す
                                        const trg = args.response_format?.type === 'json_object' ? 'json' : 'md';
                                        fss.writeFile(`${HISTORY_DIRE}/${idempotencyKey}-${attempts}.result.${trg}`, tokenBuilder || '', {}, () => { });
                                        break;
                                    }
                                    // 中身を取り出す
                                    const content = decoder.decode(value);
                                    // console.dir(content, { depth: null });

                                    // 中身がない場合はスキップ
                                    if (!content) { continue; }
                                    const obj = JSON.parse(content) as ChatCompletionChunk;

                                    // ファイルに書き出す
                                    fss.appendFile(`${HISTORY_DIRE}/${idempotencyKey}-${attempts}.txt`, content || '', {}, () => { });

                                    tokenBuilder += obj.choices.map(choice => choice.delta).filter(delta => delta).map(delta => delta.content || '').join('');
                                    tokenCount.tokenBuilder = tokenBuilder;

                                    if (obj.usage) {
                                        tokenCount.prompt_tokens = obj.usage.prompt_tokens || tokenCount.prompt_tokens;
                                        tokenCount.completion_tokens = obj.usage.completion_tokens || 0;
                                        Object.assign(usageMetadata, obj.usage);
                                    } else { }
                                    // streamHandlerを呼び出す
                                    observer.next(obj);
                                }
                                return;
                            }
                            // ストリームの読み取りを開始
                            return await readStream();
                        });
                }
            } else if (this.provider === 'vertexai') {
                // console.log(generativeModel);
                commonArgs.messages[0].content = commonArgs.messages[0].content || '';
                // argsをGemini用に変換
                const req: GenerateContentRequestExtended = mapForGeminiExtend(commonArgs, mapForGemini(commonArgs));
                // 文字数をカウント
                const countCharsObj = countChars(commonArgs);
                let promptChars = countCharsObj.audio + countCharsObj.text + countCharsObj.image + countCharsObj.video;

                // req は 不要な項目もまとめて保持しているので、実際のリクエスト用にスッキリさせる。
                const args: GenerateContentRequest = { contents: req.contents, tools: req.tools || [], systemInstruction: req.systemInstruction };
                // コンテキストキャッシュの有無で編集を変える
                if (req.cached_content) {
                    (args as any).cached_content = req.cached_content; // コンテキストキャッシュを足しておく
                } else {
                }
                fss.writeFile(`${HISTORY_DIRE}/${idempotencyKey}-${attempts}.request.json`, JSON.stringify(req, Utils.genJsonSafer()), {}, (err) => { });

                let isOver128 = false;
                runPromise = generateContentStream(req.region, req.resourcePath, my_vertexai.getAccessToken(), args, `${req.region}-${GCP_API_BASE_PATH}`, req.generationConfig, req.safetySettings, req.tools, {}).then(async streamingResp => {
                    // かつてはModelを使って投げていた。
                    // runPromise = vertex_ai.preview.getGenerativeModel({ model: args.model, generationConfig: req.generationConfig, safetySettings: req.safetySettings }).generateContentStream(_req);

                    let tokenBuilder: string = '';

                    const _that = this;

                    tokenCount.prompt_tokens = promptChars;
                    tokenCount.completion_tokens = 0;
                    // ストリームからデータを読み取る非同期関数
                    async function readStream() {
                        let safetyRatings;
                        let lastType: 'text' | 'function' | null = null;
                        while (true) {
                            const { value, done } = await streamingResp.stream.next();
                            // [1] {
                            // [1]   promptFeedback: { blockReason: 'PROHIBITED_CONTENT' },
                            // [1]   usageMetadata: { promptTokenCount: 43643, totalTokenCount: 43643 }
                            // [1] }
                            if (done) {
                                // ストリームが終了したらループを抜ける
                                tokenCount.cost = tokenCount.calcCost() * (isOver128 ? 2 : 1);
                                console.log(logObject.output('fine', '', JSON.stringify(usageMetadata)));
                                observer.complete();

                                _that.openApiWrapper.fire();

                                // ファイルに書き出す
                                const trg = commonArgs.response_format?.type === 'json_object' ? 'json' : 'md';
                                fss.writeFile(`${HISTORY_DIRE}/${idempotencyKey}-${attempts}.result.${trg}`, tokenBuilder || '', {}, () => { });
                                break;
                            }

                            // 中身を取り出す
                            const content = value;
                            // console.dir(content, { depth: null });

                            // ファイルに書き出す
                            fss.appendFile(`${HISTORY_DIRE}/${idempotencyKey}-${attempts}.txt`, (JSON.stringify(content) || '') + '\n', {}, () => { });

                            // 中身がない場合はスキップ
                            if (!content) { continue; }

                            // 
                            if (content.usageMetadata) {
                                // 128k超えてるかどうか判定。
                                if (content.usageMetadata.totalTokenCount) {
                                    isOver128 = content.usageMetadata.totalTokenCount > 128000;
                                } else { }
                                Object.assign(usageMetadata, content.usageMetadata);
                                if (commonArgs.model.startsWith('gemini-2')) {
                                    // gemini-2系からはトークンベースの課金になるので、トークン数を使う。
                                    tokenCount.prompt_tokens = content.usageMetadata.promptTokenCount || tokenCount.prompt_tokens;
                                    tokenCount.completion_tokens = content.usageMetadata.candidatesTokenCount || 0;
                                } else {
                                    // それ以外は文字数ベースの課金なのでトークン数は使わない。
                                    // tokenCount.prompt_tokens = content.usageMetadata.promptTokenCount || tokenCount.prompt_tokens;
                                    // tokenCount.completion_tokens = content.usageMetadata.candidatesTokenCount || 0;
                                }

                                // vertexaiの場合はレスポンスヘッダーが取れない。その代わりストリームの最後にメタデータが飛んでくるのでそれを捕まえる。
                                fss.writeFile(`${HISTORY_DIRE}/${idempotencyKey}-${attempts}.response.json`, JSON.stringify({ req, response: content }, Utils.genJsonSafer()), {}, (err) => { });
                            } else { }

                            if (content.promptFeedback && content.promptFeedback.blockReason) {
                                // finishReasonが指定されている、かつSTOPではない場合はエラー終了させる。
                                // ストリームが終了したらループを抜ける
                                tokenCount.cost = tokenCount.calcCost() * (isOver128 ? 2 : 1);
                                throw JSON.stringify({ promptFeedback: content.promptFeedback });
                            } else { }

                            // 中身がない場合はスキップ
                            if (!content.candidates) { continue; }

                            if (content.candidates[0] && content.candidates[0].safetyRatings) {
                                safetyRatings = content.candidates[0] && content.candidates[0].safetyRatings;
                            } else { }


                            function responseRemap(content: GenerateContentResponse): ChatCompletionChunk[] {
                                const remaped: ChatCompletionChunk[] = [];
                                if (content.candidates) {
                                    content.candidates.forEach(candidate => {

                                        // partsをイテレートする前に、現在のタイプをチェック
                                        (candidate.content.parts || []).forEach((c, index) => {
                                            const currentType = c.text ? 'text' : c.functionCall ? 'function' : null;

                                            // // タイプが変わった場合、前のタイプの終了チャンクを挿入
                                            // // console.log(`${lastType} && ${currentType} && ${lastType} !== ${currentType}`);
                                            // if (lastType && currentType && lastType !== currentType) {
                                            //     const terminationChoice: ChatCompletionChunk.Choice = {
                                            //         delta: { content: '' },
                                            //         finish_reason: 'stop',
                                            //         index: candidate.index,
                                            //         logprobs: null,
                                            //     };
                                            //     remaped.push({
                                            //         id: (content as any).responseId,
                                            //         choices: [terminationChoice],
                                            //         created: 0,
                                            //         model: (content as any).modelVersion || commonArgs.model,
                                            //         object: 'chat.completion.chunk',
                                            //         service_tier: null,
                                            //         system_fingerprint: '',
                                            //     });
                                            // }

                                            // 通常のチャンクを作成
                                            const choice: ChatCompletionChunk.Choice = {
                                                delta: {} as ChatCompletionChunk.Choice.Delta,
                                                finish_reason: (candidate.finishReason?.toLocaleLowerCase() || null) as any,
                                                index: candidate.index,
                                                logprobs: null,
                                            };

                                            if (c.text) {
                                                choice.delta = { content: c.text };
                                            } else if (c.functionCall) {
                                                const func: ChatCompletionChunk.Choice.Delta.ToolCall = {
                                                    id: Utils.generateUUID(),
                                                    index,
                                                    type: 'function',
                                                    'function': { name: c.functionCall.name }
                                                };
                                                if (c.functionCall.args && func.function) {
                                                    func.function.arguments = JSON.stringify(c.functionCall.args);
                                                }
                                                choice.delta = { tool_calls: [func] };
                                                choice.finish_reason = null; // ツールコールの場合、vertexaiはfunctionが配列で返ってくるので末尾のやつだけにfinisho_reasonを付けるようにすべきだが、面倒なので全部nullにしてしまう。どうせ最後にstopが来るはずなので。
                                                // console.log('-------------------------------===FUNC===-------------------------------------------------======');
                                                // console.dir(func);
                                                // console.log('-------------------------------===XXX===-------------------------------------------------======');
                                            }

                                            if (candidate.groundingMetadata) {
                                                (choice as any).groundingMetadata = candidate.groundingMetadata;
                                            }

                                            remaped.push({
                                                id: (content as any).responseId,
                                                choices: [choice],
                                                created: 0,
                                                model: (content as any).modelVersion || commonArgs.model,
                                                object: 'chat.completion.chunk',
                                                service_tier: null,
                                                system_fingerprint: '',
                                            });

                                            lastType = currentType;
                                        });
                                    });
                                }
                                return remaped;
                            }

                            responseRemap(content).forEach(chunk => {
                                // console.log(chunk.choices[0].finish_reason, chunk.choices[0].delta);
                                observer.next(chunk);
                            });

                            if (content.candidates[0] && content.candidates[0].content && content.candidates[0].content.parts && content.candidates[0].content.parts[0]) {
                                if (content.candidates[0].content.parts[0].text) {
                                    const text = content.candidates[0].content.parts[0].text || '';
                                    tokenBuilder += text;
                                    tokenCount.tokenBuilder = tokenBuilder;
                                    tokenCount.completion_tokens += text.replace(/\s/g, '').length; // 空白文字を除いた文字数
                                } else {
                                    // 何もしない
                                }
                            } else { }
                            // [1]   candidates: [ { finishReason: 'OTHER', index: 0, content: [Object] } ],
                            if (content.candidates[0] && content.candidates[0].finishReason && !['STOP', 'MAX_TOKENS'].includes(content.candidates[0].finishReason)) {
                                // finishReasonが指定されている、かつSTOPではない場合はエラー終了させる。
                                // ストリームが終了したらループを抜ける
                                tokenCount.cost = tokenCount.calcCost() * (isOver128 ? 2 : 1);
                                throw JSON.stringify({ safetyRatings, candidate: content.candidates[0] });
                            } else { }
                            // candidates: [ { finishReason: 'OTHER', index: 0, content: [Object] } ],
                        }
                        return;
                    }
                    // ストリームの読み取りを開始
                    return await readStream();

                });
            } else if (this.provider === 'gemini') {
                // console.log(generativeModel);
                commonArgs.messages[0].content = commonArgs.messages[0].content || '';
                // argsをGemini用に変換
                const req: GenerateContentRequestExtended = mapForGeminiExtend(commonArgs, mapForGemini(commonArgs));
                // 文字数をカウント
                const countCharsObj = countChars(commonArgs);
                let promptChars = countCharsObj.audio + countCharsObj.text + countCharsObj.image + countCharsObj.video;

                // req は 不要な項目もまとめて保持しているので、実際のリクエスト用にスッキリさせる。
                const args: GenerateContentRequest = { contents: req.contents, tools: req.tools || [], systemInstruction: req.systemInstruction };
                // コンテキストキャッシュの有無で編集を変える
                if (req.cached_content) {
                    (args as any).cached_content = req.cached_content; // コンテキストキャッシュを足しておく
                } else {
                }
                const reqGemini: googleGenerativeAI.GenerateContentRequest = {
                    contents: req.contents,
                    systemInstruction: req.systemInstruction,
                    cachedContent: req.cachedContent as any,
                    generationConfig: req.generationConfig as any,
                    safetySettings: req.safetySettings,
                    toolConfig: req.toolConfig as any,
                    tools: req.tools as any,
                };

                fss.writeFile(`${HISTORY_DIRE}/${idempotencyKey}-${attempts}.request.json`, JSON.stringify({ model: commonArgs.model, req: reqGemini }, Utils.genJsonSafer()), {}, (err) => { });

                let isOver128 = false;
                // export declare interface ModelParams extends BaseParams {
                //     model: string;
                //     tools?: Tool[];
                //     toolConfig?: ToolConfig;
                //     systemInstruction?: string | Part | Content;
                //     cachedContent?: CachedContent;
                // }
                runPromise = gemini.getGenerativeModel({ model: commonArgs.model }).generateContentStream(reqGemini).then(async streamingResp => {
                    // かつてはModelを使って投げていた。
                    // runPromise = vertex_ai.preview.getGenerativeModel({ model: args.model, generationConfig: req.generationConfig, safetySettings: req.safetySettings }).generateContentStream(_req);

                    let tokenBuilder: string = '';

                    const _that = this;

                    tokenCount.prompt_tokens = promptChars;
                    tokenCount.completion_tokens = 0;
                    // ストリームからデータを読み取る非同期関数
                    async function readStream() {
                        let safetyRatings;
                        let lastType: 'text' | 'function' | null = null;
                        while (true) {
                            const { value, done } = await streamingResp.stream.next();
                            // [1] {
                            // [1]   promptFeedback: { blockReason: 'PROHIBITED_CONTENT' },
                            // [1]   usageMetadata: { promptTokenCount: 43643, totalTokenCount: 43643 }
                            // [1] }
                            if (done) {
                                // ストリームが終了したらループを抜ける
                                tokenCount.cost = tokenCount.calcCost() * (isOver128 ? 2 : 1);
                                console.log(logObject.output('fine', '', JSON.stringify(usageMetadata)));
                                observer.complete();

                                _that.openApiWrapper.fire();

                                // ファイルに書き出す
                                const trg = commonArgs.response_format?.type === 'json_object' ? 'json' : 'md';
                                fss.writeFile(`${HISTORY_DIRE}/${idempotencyKey}-${attempts}.result.${trg}`, tokenBuilder || '', {}, () => { });
                                break;
                            }

                            // 中身を取り出す
                            const content = value;
                            // console.dir(content, { depth: null });

                            // ファイルに書き出す
                            fss.appendFile(`${HISTORY_DIRE}/${idempotencyKey}-${attempts}.txt`, (JSON.stringify(content) || '') + '\n', {}, () => { });

                            // 中身がない場合はスキップ
                            if (!content) { continue; }

                            // 
                            if (content.usageMetadata) {
                                // 128k超えてるかどうか判定。
                                if (content.usageMetadata.totalTokenCount) {
                                    isOver128 = content.usageMetadata.totalTokenCount > 128000;
                                } else { }
                                Object.assign(usageMetadata, content.usageMetadata);
                                if (commonArgs.model.startsWith('gemini-2.0-')) {
                                    // gemini-2系からはトークンベースの課金になるので、トークン数を使う。
                                    tokenCount.prompt_tokens = content.usageMetadata.promptTokenCount || tokenCount.prompt_tokens;
                                    tokenCount.completion_tokens = content.usageMetadata.candidatesTokenCount || 0;
                                } else {
                                    // それ以外は文字数ベースの課金なのでトークン数は使わない。
                                    // tokenCount.prompt_tokens = content.usageMetadata.promptTokenCount || tokenCount.prompt_tokens;
                                    // tokenCount.completion_tokens = content.usageMetadata.candidatesTokenCount || 0;
                                }

                                // vertexaiの場合はレスポンスヘッダーが取れない。その代わりストリームの最後にメタデータが飛んでくるのでそれを捕まえる。
                                fss.writeFile(`${HISTORY_DIRE}/${idempotencyKey}-${attempts}.response.json`, JSON.stringify({ model: commonArgs.model, req: reqGemini, response: content }, Utils.genJsonSafer()), {}, (err) => { });
                            } else { }

                            if (content.promptFeedback && content.promptFeedback.blockReason) {
                                // finishReasonが指定されている、かつSTOPではない場合はエラー終了させる。
                                // ストリームが終了したらループを抜ける
                                tokenCount.cost = tokenCount.calcCost() * (isOver128 ? 2 : 1);
                                throw JSON.stringify({ promptFeedback: content.promptFeedback });
                            } else { }

                            // 中身がない場合はスキップ
                            if (!content.candidates) { continue; }

                            if (content.candidates[0] && content.candidates[0].safetyRatings) {
                                safetyRatings = content.candidates[0] && content.candidates[0].safetyRatings;
                            } else { }


                            function responseRemap(content: googleGenerativeAI.EnhancedGenerateContentResponse): ChatCompletionChunk[] {
                                const remaped: ChatCompletionChunk[] = [];
                                if (content.candidates) {
                                    content.candidates.forEach(candidate => {

                                        // partsをイテレートする前に、現在のタイプをチェック
                                        (candidate.content.parts || []).forEach((c, index) => {
                                            const currentType = c.text ? 'text' : c.functionCall ? 'function' : null;

                                            // 通常のチャンクを作成
                                            const choice: ChatCompletionChunk.Choice = {
                                                delta: {} as ChatCompletionChunk.Choice.Delta,
                                                finish_reason: (candidate.finishReason?.toLocaleLowerCase() || null) as any,
                                                index: candidate.index,
                                                logprobs: null,
                                            };

                                            if (c.text) {
                                                choice.delta = { content: c.text };
                                            } else if (c.functionCall) {
                                                const func: ChatCompletionChunk.Choice.Delta.ToolCall = {
                                                    id: Utils.generateUUID(),
                                                    index,
                                                    type: 'function',
                                                    'function': { name: c.functionCall.name }
                                                };
                                                if (c.functionCall.args && func.function) {
                                                    func.function.arguments = JSON.stringify(c.functionCall.args);
                                                }
                                                choice.delta = { tool_calls: [func] };
                                                choice.finish_reason = null; // ツールコールの場合、vertexaiはfunctionが配列で返ってくるので末尾のやつだけにfinisho_reasonを付けるようにすべきだが、面倒なので全部nullにしてしまう。どうせ最後にstopが来るはずなので。
                                                // console.log('-------------------------------===FUNC===-------------------------------------------------======');
                                                // console.dir(func);
                                                // console.log('-------------------------------===XXX===-------------------------------------------------======');
                                            }

                                            if (candidate.groundingMetadata) {
                                                (choice as any).groundingMetadata = candidate.groundingMetadata;
                                            }

                                            remaped.push({
                                                id: (content as any).responseId,
                                                choices: [choice],
                                                created: 0,
                                                model: (content as any).modelVersion || commonArgs.model,
                                                object: 'chat.completion.chunk',
                                                service_tier: null,
                                                system_fingerprint: '',
                                            });

                                            lastType = currentType;
                                        });
                                    });
                                }
                                return remaped;
                            }

                            responseRemap(content).forEach(chunk => {
                                // console.log(chunk.choices[0].finish_reason, chunk.choices[0].delta);
                                observer.next(chunk);
                            });

                            if (content.candidates[0] && content.candidates[0].content && content.candidates[0].content.parts && content.candidates[0].content.parts[0]) {
                                if (content.candidates[0].content.parts[0].text) {
                                    const text = content.candidates[0].content.parts[0].text || '';
                                    tokenBuilder += text;
                                    tokenCount.tokenBuilder = tokenBuilder;
                                    tokenCount.completion_tokens += text.replace(/\s/g, '').length; // 空白文字を除いた文字数
                                } else {
                                    // 何もしない
                                }
                            } else { }
                            // [1]   candidates: [ { finishReason: 'OTHER', index: 0, content: [Object] } ],
                            if (content.candidates[0] && content.candidates[0].finishReason && !['STOP', 'MAX_TOKENS'].includes(content.candidates[0].finishReason)) {
                                // finishReasonが指定されている、かつSTOPではない場合はエラー終了させる。
                                // ストリームが終了したらループを抜ける
                                tokenCount.cost = tokenCount.calcCost() * (isOver128 ? 2 : 1);
                                throw JSON.stringify({ safetyRatings, candidate: content.candidates[0] });
                            } else { }
                            // candidates: [ { finishReason: 'OTHER', index: 0, content: [Object] } ],
                        }
                        return;
                    }
                    // ストリームの読み取りを開始
                    return await readStream();

                });
            } else if (this.provider === 'openapi_vertexai') {
                // vertexホストのllamaとか。
                for (const key of ['safetySettings', 'cachedContent', 'gcpProjectId', 'isGoogleSearch']) delete (args as any)[key]; // Gemini用プロパティを消しておく
                fss.writeFile(`${HISTORY_DIRE}/${idempotencyKey}-${attempts}.request.json`, JSON.stringify({ args, options }, Utils.genJsonSafer()), {}, (err) => { });
                // vertexai でllama3を使う場合。
                runPromise = my_vertexai.getAccessToken().then(async token => {
                    const REGION = 'us-central1';

                    // const ENDPOINT = `us-central1-aiplatform.googleapis.com`;
                    const ENDPOINT = `us-central1-${GCP_API_BASE_PATH}`;
                    const client = new OpenAI({
                        apiKey: token,
                        baseURL: `https://${ENDPOINT}/v1beta1/projects/${GCP_PROJECT_ID}/locations/${REGION}/endpoints/openapi/`,
                    });

                    // llama3は構造化されたcontentに対応していないのでただのstringにする
                    args.messages.forEach(message => {
                        if (!message.content) {
                        } else if (typeof message.content === 'string') {
                            // 文字列ならそのまま
                        } else if (typeof message.content === 'object') {
                            // 構造化contextになっていたらただのstringに戻す。
                            if (Array.isArray(message.content)) {
                                message.content = message.content.map(content => {
                                    content.type;
                                    if (content.type === 'text') {
                                        return content.text;
                                    } else if (content.type === 'image_url') {
                                        if (content.image_url && content.image_url.url) {
                                            return content.image_url.url;
                                        } else { }
                                        // } else if (content.type === 'input_audio') {
                                        //     // TODO 
                                        // } else if (content.type === 'refusal') {
                                        //     // TODO 
                                    } else { }
                                }).join('\n');
                            } else { }
                        }
                    });
                    await (client.chat.completions.create(args, options) as APIPromise<Stream<ChatCompletionChunk>>)
                        .withResponse().then(async (response) => {
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
                                    const content = decoder.decode(value).replaceAll(/\\\\n/g, '\\n');
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
                                    observer.next(JSON.parse(content));
                                }
                                return;
                            }
                            // ストリームの読み取りを開始
                            return await readStream();
                        });
                })
            } else if (this.provider === 'cohere') {
                // 元のargsを破壊してしまうとろくなことにならないので、JSON.stringifyしてからparseしている。
                const args = commonArgs as V2ChatStreamRequest;
                const _args = args as ChatCompletionCreateParamsBase;
                // cohereはstream_optionsとtool_choiceを消しておく必要あり。
                delete _args.stream_options;
                delete _args.tool_choice;
                for (const key of ['safetySettings', 'cachedContent', 'gcpProjectId', 'isGoogleSearch']) delete (args as any)[key]; // Gemini用プロパティを消しておく
                if (_args.response_format) {
                    if (_args.response_format.type === 'json_object') {
                        args.responseFormat = _args.response_format;
                    } else if (_args.response_format.type === 'text') {
                        args.responseFormat = _args.response_format;
                    } else {
                        args.responseFormat = { type: 'text' };
                    }
                    delete _args.response_format;
                }
                if (_args.tool_choice) {
                    if (_args.tool_choice === 'none') {
                        args.toolChoice = Cohere.V2ChatStreamRequestToolChoice.None;
                    } else if (_args.tool_choice === 'required') {
                        args.toolChoice = Cohere.V2ChatStreamRequestToolChoice.Required;
                    } else {
                        // 指定しなければautoになるってこと？？
                    }
                    delete _args.tool_choice;
                } else { }

                args.temperature = 0.3; // デフォルト値を入れておく。
                // argsをCohere用に変換
                _args.messages.forEach(message => {
                    // console.dir(message, { depth: null });
                    // userプロンプト以外は文字列にしておく。
                    if (message.role === 'system' || (message.role === 'assistant') || message.role === 'tool') {
                        if (typeof message.content === 'string') {
                        } else if (Array.isArray(message.content)) {
                            message.content = message.content.filter(content => content.type === 'text').map(content => content.type === 'text' ? content.text : '').join('');
                        } else { }
                    } else { }
                    // ツールコール系
                    if (message.role === 'assistant' && message.tool_calls) {
                        // 何でか知らんがSDK経由だとCamelCaseにしないとダメみたい。
                        (message as any).toolPlan = message.content; // 既にstringになっているのでそのまま代入でOK
                        delete (message as any).content;
                        (message as any).toolCalls = message.tool_calls;
                        delete (message as any).tool_calls;
                    } else { }
                    if (message.role === 'tool') {
                        // 何でか知らんがSDK経由だとCamelCaseにしないとダメみたい。
                        (message as any).toolCallId = message.tool_call_id;
                        delete (message as any).tool_call_id;
                    } else { }
                });
                // console.log('cohere--------------END');

                // リクエストをファイルに書き出す
                fss.writeFile(`${HISTORY_DIRE}/${idempotencyKey}-${attempts}.request.json`, JSON.stringify({ args, options }, Utils.genJsonSafer()), {}, (err) => { });

                // Cohere API呼び出し
                runPromise = cohere.chatStream(args as V2ChatStreamRequest, options as V2.RequestOptions).then(async (response) => {

                    // ヘッダー情報を取得
                    const headers: { [key: string]: string } = {};
                    ((response as any).headers as Headers).forEach((value, key) => headers[key] = value);

                    // レート制限情報の取得
                    headers['x-endpoint-monthly-call-limit'] && (ratelimitObj.limitRequests = Number(headers['x-endpoint-monthly-call-limit']));
                    headers['x-trial-endpoint-call-limit'] && (ratelimitObj.limitTokens = Number(headers['x-trial-endpoint-call-limit']));
                    headers['x-trial-endpoint-call-remaining'] && (ratelimitObj.remainingRequests = Number(headers['x-trial-endpoint-call-remaining']));

                    fss.writeFile(`${HISTORY_DIRE}/${idempotencyKey}-${attempts}.response.json`, JSON.stringify({ args, options, response: { headers } }, Utils.genJsonSafer()), {}, (err) => { });

                    let tokenBuilder: string = '';
                    const baseMessage = { id: '', role: 'assistant', created: 0, model: '' } as { id: string, role: 'system' | 'user' | 'assistant' | 'tool', created: number, model: string };
                    let index = 0;
                    let toolCallsMap: Map<number, any> = new Map();

                    function remapCohere(obj: StreamedChatResponseV2): ChatCompletionChunk[] {
                        if (obj.type === 'message-start') {
                            baseMessage.id = obj.id || '';
                            baseMessage.role = 'assistant';
                            baseMessage.created = Math.floor(Date.now() / 1000);
                            baseMessage.model = args.model || '';

                            const choice: ChatCompletionChunk.Choice = {
                                index: 0,
                                delta: { role: 'assistant', content: '', refusal: null },
                                logprobs: null,
                                finish_reason: null,
                            };

                            const chunk: ChatCompletionChunk = {
                                id: baseMessage.id,
                                object: 'chat.completion.chunk',
                                created: baseMessage.created,
                                model: baseMessage.model,
                                service_tier: 'default',
                                system_fingerprint: '',
                                choices: [choice],
                            };

                            return [chunk];
                        } else if (obj.type === 'content-delta') {
                            const text = obj.delta?.message?.content?.text || '';
                            tokenBuilder += text;
                            const choice: ChatCompletionChunk.Choice = {
                                index: 0,
                                delta: { content: text, refusal: null },
                                logprobs: null,
                                finish_reason: null,
                            };
                            const chunk: ChatCompletionChunk = {
                                id: baseMessage.id,
                                object: 'chat.completion.chunk',
                                created: baseMessage.created,
                                model: baseMessage.model,
                                service_tier: 'default',
                                system_fingerprint: '',
                                choices: [choice],
                            };
                            return [chunk];
                        } else if (obj.type === 'tool-plan-delta') {
                            // ツール計画のデルタは通常のメッセージと同じように扱う
                            const text = obj.delta?.message?.toolPlan || '';
                            tokenBuilder += text;
                            const choice: ChatCompletionChunk.Choice = {
                                index: 0,
                                delta: { content: text, refusal: null },
                                logprobs: null,
                                finish_reason: null,
                            };
                            const chunk: ChatCompletionChunk = {
                                id: baseMessage.id,
                                object: 'chat.completion.chunk',
                                created: baseMessage.created,
                                model: baseMessage.model,
                                service_tier: 'default',
                                system_fingerprint: '',
                                choices: [choice],
                            };
                            return [chunk];
                        } else if (obj.type === 'tool-call-start') {



                            const index = obj.index as number;
                            if (obj.delta && obj.delta.message && obj.delta.message.toolCalls && obj.delta.message.toolCalls.id && obj.delta.message.toolCalls.function && obj.delta.message.toolCalls.function.name) {
                                // ツールコールの情報がある場合は保存
                            } else {
                                // ツールコールの情報がない場合はスキップ
                                return [];
                            }

                            const toolCallId = obj.delta.message.toolCalls.id;
                            const functionName = obj.delta.message.toolCalls.function.name;

                            // ツールコール情報を保存
                            toolCallsMap.set(index, {
                                id: toolCallId,
                                name: functionName,
                                arguments: ''
                            });

                            const choice: ChatCompletionChunk.Choice = {
                                index: 0,
                                delta: { content: null, refusal: null },
                                logprobs: null,
                                finish_reason: null,
                            };

                            choice.delta.tool_calls = [{
                                index: index,
                                id: toolCallId,
                                function: {
                                    arguments: '',
                                    name: functionName,
                                },
                                type: 'function',
                            }];

                            const chunk: ChatCompletionChunk = {
                                id: baseMessage.id,
                                object: 'chat.completion.chunk',
                                created: baseMessage.created,
                                model: baseMessage.model,
                                service_tier: 'default',
                                system_fingerprint: '',
                                choices: [choice],
                            };

                            return [chunk];
                        } else if (obj.type === 'tool-call-delta') {
                            const index = obj.index as number;
                            if (!toolCallsMap.has(index) || !obj.delta || !obj.delta.message || !obj.delta.message.toolCalls || !obj.delta.message.toolCalls.function) {
                                // ツールコール情報がない場合はスキップ
                                return [];
                            }

                            const argumentsDelta = obj.delta.message.toolCalls.function.arguments || '';

                            // 保存されているツールコールに引数を追加
                            const toolCall = toolCallsMap.get(index);
                            if (toolCall) {
                                toolCall.arguments += argumentsDelta;
                                toolCallsMap.set(index, toolCall);
                            }

                            const choice: ChatCompletionChunk.Choice = {
                                index: 0,
                                delta: { content: null, refusal: null },
                                logprobs: null,
                                finish_reason: null,
                            };

                            choice.delta.tool_calls = [{
                                index: index,
                                function: { arguments: argumentsDelta },
                                type: 'function',
                            }];

                            const chunk: ChatCompletionChunk = {
                                id: baseMessage.id,
                                object: 'chat.completion.chunk',
                                created: baseMessage.created,
                                model: baseMessage.model,
                                service_tier: 'default',
                                system_fingerprint: '',
                                choices: [choice],
                            };

                            return [chunk];
                        } else if (obj.type === 'tool-call-end') {
                            // ツールコール終了イベントは特にチャンクを送らない
                            return [];
                        } else if (obj.type === 'message-end') {
                            if (obj.delta && obj.delta.finishReason) {
                            } else {
                                return [];
                            }
                            const finishReason = obj.delta.finishReason === 'TOOL_CALL' ? 'tool_calls' : 'stop';

                            // 使用トークン数を更新
                            if (obj.delta.usage && obj.delta.usage.tokens) {
                                tokenCount.prompt_tokens = obj.delta.usage.tokens.inputTokens || 0;
                                tokenCount.completion_tokens = obj.delta.usage.tokens.outputTokens || 0;

                                const tokenUsage = {
                                    prompt_tokens: tokenCount.prompt_tokens,
                                    completion_tokens: tokenCount.completion_tokens,
                                    total_tokens: tokenCount.prompt_tokens + tokenCount.completion_tokens
                                };

                                Object.assign(usageMetadata, tokenUsage);
                            }

                            const choice: ChatCompletionChunk.Choice = {
                                index: 0,
                                delta: { content: null, refusal: null },
                                logprobs: null,
                                finish_reason: finishReason,
                            };

                            const chunk: ChatCompletionChunk = {
                                id: baseMessage.id,
                                object: 'chat.completion.chunk',
                                created: baseMessage.created,
                                model: baseMessage.model,
                                service_tier: 'default',
                                system_fingerprint: '',
                                choices: [choice],
                                usage: {
                                    prompt_tokens: tokenCount.prompt_tokens,
                                    completion_tokens: tokenCount.completion_tokens,
                                    total_tokens: tokenCount.prompt_tokens + tokenCount.completion_tokens
                                },
                            };

                            return [chunk];
                        } else {
                            // その他のイベントタイプは無視
                            return [];
                        }
                    }
                    const _that = this;

                    // ストリームからデータを読み取る非同期関数
                    for await (const value of response) {
                        // ファイルに書き出す
                        fss.appendFile(`${HISTORY_DIRE}/${idempotencyKey}-${attempts}.txt`, (JSON.stringify(value) + '\n') || '', {}, () => { });

                        remapCohere(value).forEach(chunk => {
                            observer.next(chunk);
                        });
                    }

                    // ストリームが終了したらループを抜ける
                    tokenCount.cost = tokenCount.calcCost();
                    console.log(logObject.output('fine', '', JSON.stringify(usageMetadata)));
                    observer.complete();

                    // ファイルに書き出す
                    const trg = args.responseFormat?.type === 'json_object' ? 'json' : 'md';
                    fss.writeFile(`${HISTORY_DIRE}/${idempotencyKey}-${attempts}.result.${trg}`, tokenBuilder || '', {}, () => { });
                    _that.openApiWrapper.fire();
                });
            } else {
                // Gemini用プロパティを消しておく
                const keys = ['messages', 'model', 'audio', 'frequency_penalty', 'function_call', 'functions', 'logit_bias', 'logprobs', 'max_completion_tokens', 'max_tokens', 'metadata', 'modalities', 'n', 'parallel_tool_calls', 'prediction', 'presence_penalty', 'reasoning_effort', 'response_format', 'seed', 'service_tier', 'stop', 'store', 'stream', 'stream_options', 'temperature', 'tool_choice', 'tools', 'top_logprobs', 'top_p', 'user'];
                Object.keys(args).forEach(key => { if (!keys.includes(key)) { delete (args as any)[key]; } });
                // messages: Array<ChatCompletionMessageParam>;
                // model: (string & {}) | ChatAPI.ChatModel;
                // audio?: ChatCompletionAudioParam | null;
                // frequency_penalty?: number | null;
                // function_call?: 'none' | 'auto' | ChatCompletionFunctionCallOption;
                // functions?: Array<ChatCompletionCreateParams.Function>;
                // logit_bias?: Record<string, number> | null;
                // logprobs?: boolean | null;
                // max_completion_tokens?: number | null;
                // max_tokens?: number | null;
                // metadata?: Shared.Metadata | null;
                // modalities?: Array<ChatCompletionModality> | null;
                // n?: number | null;
                // parallel_tool_calls?: boolean;
                // prediction?: ChatCompletionPredictionContent | null;
                // presence_penalty?: number | null;
                // reasoning_effort?: ChatCompletionReasoningEffort;
                // response_format?:
                // seed?: number | null;
                // service_tier?: 'auto' | 'default' | null;
                // stop?: string | null | Array<string>;
                // store?: boolean | null;
                // stream?: boolean | null;
                // stream_options?: ChatCompletionStreamOptions | null;
                // temperature?: number | null;
                // tool_choice?: ChatCompletionToolChoiceOption;
                // tools?: Array<ChatCompletionTool>;
                // top_logprobs?: number | null;
                // top_p?: number | null;
                // user?: string;
                const clientMap: { [key: string]: OpenAI } = {
                    groq, mistral, deepseek, cerebras, local, openai,
                };
                const client = clientMap[this.provider] || openai;
                if (this.provider !== 'openai' && this.provider !== 'local') {
                    // userプロンプト以外は文字列にしておく。
                    args.messages.forEach(message => {
                        if (message.role === 'system' || message.role === 'assistant' || message.role === 'tool') {
                            if (typeof message.content === 'string') {
                            } else if (Array.isArray(message.content)) {
                                message.content = message.content.filter(content => content.type === 'text').map(content => content.type === 'text' ? content.text : '').join('');
                            } else { }
                        } else { }
                    });
                } else { }

                if (args.model.startsWith('o1') || args.model.startsWith('o3')) {
                    // o1用にパラメータを調整
                    delete (args as any)['max_completion_tokens'];
                    delete args.max_tokens;
                    delete args.temperature;
                } else { }

                // TODO無理矢理すぎる。。proxy設定のやり方を再考する。
                options.httpAgent = client.httpAgent;
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
                                    console.log(logObject.output('fine', '', JSON.stringify(usageMetadata)));
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
                                const obj: ChatCompletionChunk = JSON.parse(content);

                                tokenBuilder += obj.choices.map(choice => choice.delta).filter(delta => delta).map(delta => delta.content || '').join('');
                                tokenCount.tokenBuilder = tokenBuilder;

                                if (obj.usage) {
                                    tokenCount.prompt_tokens = obj.usage.prompt_tokens || tokenCount.prompt_tokens;
                                    tokenCount.completion_tokens = obj.usage.completion_tokens || 0;
                                    Object.assign(usageMetadata, obj.usage);
                                } else { }
                                observer.next(obj);
                            }
                            return;
                        }
                        // ストリームの読み取りを開始
                        return readStream();
                    });
            }
        } catch (e) {
            console.error(e);
            throw e;
        }
        await runPromise.catch(async error => {
            this.attempts++;

            const formattedError = Utils.errorFormat(error, false);
            // エラーを出力
            console.log(logObject.output('error', formattedError));
            // 400エラーの場合は、リトライしない
            if (error.toString().startsWith('Error: 400')) {
                observer.error(error);
                this.openApiWrapper.fire(); // キューに着火
                throw error;
            } else { }

            // 最大試行回数に達したかチェック
            if (this.attempts >= maxAttempts) {
                // throw new Error(`API call failed after ${maxAttempts} attempts: ${error}`);
                console.log(logObject.output('error', 'retry over'));
                observer.error('retry over');
                this.openApiWrapper.fire(); // キューに着火
                throw error;
            } else { }

            // [1] ClientError: [VertexAI.ClientError]: got status: 401 Unauthorized. {"error":{"code":401,"message":"Request had invalid authentication credentials. Expected OAuth 2 access token, login cookie or other valid authentication credential. See https://developers.google.com/identity/sign-in/web/devconsole-project.","status":"UNAUTHENTICATED","details":[{"@type":"type.googleapis.com/google.rpc.ErrorInfo","reason":"ACCESS_TOKEN_TYPE_UNSUPPORTED","metadata":{"method":"google.cloud.aiplatform.v1.PredictionService.StreamGenerateContent","service":"aiplatform.googleapis.com"}}]}}
            if (error.toString().indexOf('status: 401 Unauthorized.') >= 0) {
                // 401はアクセストークン取り直してリトライ。
                await my_vertexai.getAccessToken(true).then(accessToken => {
                    setTimeout(() => {
                        try {
                            this.executeCall()
                                .catch(error => {
                                    observer.error(error);
                                    this.openApiWrapper.fire(); // キューに着火
                                });
                        } catch (e) {
                            observer.error(error);
                            this.openApiWrapper.fire(); // キューに着火
                        }
                    }, 1000);
                });
                return;
            } else { }
            // レートリミットに引っかかった場合は、レートリミットに書かれている時間分待機する。
            const pattern = /(?<!\d)429(?!\d)/; // 429で前後が数字じゃないパターン。タイムスタンプが偶然429を含むと変なことにはなるので、もうちょっとチェックを追加した方が良いかもしれない。
            const pattern2 = /(?<!\d)Overloaded(?!\d)/; // 429で前後が数字じゃないパターン。タイムスタンプが偶然429を含むと変なことにはなるので、もうちょっとチェックを追加した方が良いかもしれない。
            // console.log(`UUUUUUUUUUUUUUUUUUUUUUUUUUUUUUU\n` + error.toString());
            // console.log(`UUUUUUUUUUUUUUUUUUUUUUUUUUUUUUU\n` + formattedError);
            if (pattern.test(formattedError) || pattern2.test(formattedError)) {
                let waitMs = Number(String(ratelimitObj.resetRequests).replace('ms', '')) || 0;
                let waitS = Number(String(ratelimitObj.resetTokens).replace('s', '')) || 0;
                // 待ち時間が設定されていなかったらとりあえずRPM/TPMを回復させるために60秒待つ。
                waitMs = waitMs === 0 ? ((waitS || 60) * 1000) : waitMs;
                console.log(logObject.output('wait', `wait ${waitMs}ms ${waitS}s`));
                setTimeout(() => {
                    try {
                        this.executeCall()
                            .catch(error => {
                                observer.error(error);
                                this.openApiWrapper.fire(); // キューに着火
                            });
                    } catch (e) {
                        observer.error(error);
                        this.openApiWrapper.fire(); // キューに着火
                    }
                }, waitMs);
                return;
            } else { }

            // console.log(`retry3 ${this.attempts}`);
            observer.error(error);
            this.openApiWrapper.fire(); // キューに着火
            // throw error; // TODO 本当は throw error しても大丈夫なように作るべきだが、 Unhandled Error になるので一旦エラー出さない。
        });
        // console.log(`retry-end ${this.attempts}`);
        return runPromise;
    };
}

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
    currentRatelimit: { [key: string]: Ratelimit } = currentRatelimit;

    constructor(
        public wrapperOptions: WrapperOptions = { allowLocalFiles: false }
    ) {
        this.options = options;
        this.options.stream = true;

        // this.options = {};
        // console.log(this.options);

        try { fs.mkdirSync(`${HISTORY_DIRE}`, { recursive: true }); } catch (e) { }
        // ヘッダー出力
        console.log(`timestamp               step  R time[ms]  prompt comple model    cost   label`);
    }

    /**
     * OpenAIのAPIを呼び出す関数
     * @param args:ChatCompletionCreateParamsBase Streamモード固定で動かすのでstreamオプションは指定しても無駄。
     * @param options:MyCompletionOptions RequestOptionsのidempotencyKeyのみ指定可能とする。他はコンストラクタで指定した値。
     * 
     * @returns Observable<ChatCompletionChunk>でOpenAI形式のレスポンスをストリーミングする。
     */
    chatCompletionObservableStream(
        args: ChatCompletionCreateParamsStreaming,
        options?: MyCompletionOptions,
        _provider?: AiProvider,
    ): Observable<ChatCompletionChunk> {
        // プロバイダーをconstで定義する。
        const provider = providerPrediction(args.model, _provider);

        // 強制的にストリームモードにする。
        args.stream = true;
        // トークン数をカウントするオプションを追加
        if (args.stream) {
            args.stream_options = { include_usage: true };
        } else { }

        // ツールを使う場合は、ツールを選択する。
        if (args.tools && args.tools.length > 0 && args.tool_choice !== 'none') {
            if (args.tool_choice === undefined) {
                args.tool_choice = 'auto';
            } else { }
        } else {
            delete args.tools;
            delete args.tool_choice;
        }

        // optionsを設定する。
        options = options || {};
        // ツール呼び出しのカウンターをインクリメントする。
        const toolLabel = options.toolCallCounter === undefined ? '' : `-tool-${options.toolCallCounter}`;
        // const toolCounterLimit = 20;
        // if (options.toolCallCounter && options.toolCallCounter > toolCounterLimit) {
        //     throw new Error(`toolCallCounter over ${toolCounterLimit}`);
        // } else { }

        // 
        (args as any).cachedContent = (args as any).cachedContent || options?.cachedContent;

        let text = ''; // ちゃんとしたオブジェクトにした方がいいかもしれない。。。
        const responseMessages: ChatCompletionMessageParam[] = [];
        const toolCallsAll: ChatCompletionChunk.Choice.Delta.ToolCall[] = [];
        let toolCall: ChatCompletionChunk.Choice.Delta.ToolCall = { index: -1, id: '', function: { name: '', arguments: '' } };

        // 入力を整形しておく。
        return normalizeMessage(args, this.wrapperOptions.allowLocalFiles).pipe(
            switchMap(obj => new Observable<ChatCompletionChunk>((observer) => {
                const args = obj.args;

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
                    reqOptions.idempotencyKey = `${timestamp}-${argsHash}-${Utils.safeFileName(options.label)}${toolLabel}`;
                } else {
                    label = argsHash;
                    reqOptions.idempotencyKey = `${timestamp}-${argsHash}`;
                }

                let attempts = 0;

                // ログ出力用オブジェクト
                const prompt = args.messages.map(message => `<im_start>${message.role}\n${typeof message.content === 'string' ? message.content : message.content?.map(content => content.type === 'text' ? content.text : '')}<im_end>`).join('\n');

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
                tokenCount.prompt_tokens += obj.countObject.image;
                this.tokenCountList.push(tokenCount);

                class LogObject {
                    constructor(public baseTime: number) { }
                    output(stepName: string, error: any = '', message: string = ''): string {
                        const _take = Date.now() - this.baseTime;
                        const take = numForm(_take, 10);
                        this.baseTime = Date.now(); // baseTimeを更新しておく。
                        const prompt_tokens = numForm(tokenCount.prompt_tokens, 6);
                        // 以前は1レスポンス1トークンだったが、今は1レスポンス1トークンではないので、completion_tokensは最後に再計算するようにした。
                        // tokenCount.completion_tokens = encoding_for_model((GPT4_MODELS.indexOf((tokenCount.modelTikToken as any)) !== -1) ? 'gpt-4' : tokenCount.modelTikToken).encode(tokenCount.tokenBuilder ? `<im_start>${tokenCount.tokenBuilder}` : '').length;
                        if (args.model && (args.model.startsWith('claude-') || args.model.startsWith('gemini-'))) {
                            // claudeの場合はAPIレスポンスでトークン数がわかっているのでそれを使う。
                        } else {
                            // APIのレスポンスでトークン数がわかっている場合はそれを使う。
                            // tokenCount.completion_tokens = getEncoder((GPT4_MODELS.indexOf((tokenCount.modelTikToken as any)) !== -1) ? 'gpt-4' : tokenCount.modelTikToken).encode(tokenCount.tokenBuilder ? `<im_start>${tokenCount.tokenBuilder}` : '').length;
                        }
                        const completion_tokens = numForm(tokenCount.completion_tokens, 6);

                        const costStr = (tokenCount.completion_tokens > 0 ? ('$' + (Math.ceil(tokenCount.cost * 100) / 100).toFixed(2)) : '').padStart(6, ' ');
                        const logString = `${Utils.formatDate()} ${stepName.padEnd(5, ' ')} ${attempts} ${take} ${prompt_tokens} ${completion_tokens} ${tokenCount.modelShort} ${costStr} ${label}${toolLabel} ${error}`;
                        fss.appendFile(`history.log`, `${logString}\n`, {}, () => { });

                        setTimeout(() => {
                            // TODO ここでDB更新なんてしたくなかったがどうしても外に出せずやむなく、、
                            // 影響を局所化するためimport文もここでローカルで打つ。labelでPredictHistoryWrapperと紐づく
                            try {
                                Promise.all([import('../service/db.js'), import('../service/entity/project-models.entity.js')]).then(mods => {
                                    return mods[0].ds.transaction(runInTransaction => {
                                        const entity = new mods[1].PredictHistoryEntity();
                                        entity.idempotencyKey = reqOptions.idempotencyKey || '';
                                        entity.argsHash = argsHash;
                                        entity.label = `${label}${toolLabel}`;
                                        entity.provider = provider;
                                        entity.model = args.model;
                                        entity.take = _take;
                                        entity.reqToken = tokenCount.prompt_tokens;
                                        entity.resToken = tokenCount.completion_tokens;
                                        entity.cost = tokenCount.cost;
                                        entity.status = stepName as any;
                                        entity.message = String(error) || message; // 追加メッセージがあれば書く。
                                        entity.tenantKey = options?.tenantKey || 'unknown'; // ここでは利用者不明
                                        entity.createdBy = options?.userId || 'batch'; // ここでは利用者不明
                                        entity.updatedBy = options?.userId || 'batch'; // ここでは利用者不明
                                        if (options?.ip) {
                                            entity.createdIp = options.ip; // ここでは利用者不明
                                            entity.updatedIp = options.ip; // ここでは利用者不明
                                        } else { }
                                        return runInTransaction.save(entity);
                                    })
                                });
                            } catch (e) { /** 登録失敗してもなんもしない。所詮ログなので */ console.log(e); }
                        }, 1);
                        return logString;
                    }
                }
                const logObject = new LogObject(Date.now());
                console.log(logObject.output('enque'));
                // console.log(logString('enque'));

                const runBit = new RunBit(logObject, tokenCount, args, provider, { ...reqOptions, ...this.options }, this, observer);
                // 未知モデル名の場合は空queueを追加しておく
                if (!this.waitQueue[tokenCount.modelShort]) this.waitQueue[tokenCount.modelShort] = [], this.inProgressQueue[tokenCount.modelShort] = [];
                this.waitQueue[tokenCount.modelShort].push(runBit);
                this.fire();
            })),
            switchMap(chunk => {
                // OpenAIのAPIのレスポンスをストリーム相当の形に変換されたものを更に変換して返す。
                // toolCallの処理。これはtoolCallを実際呼び出す関数リストに溜めるための処理。(toolCall/toolCallsAllを作る)
                // ※扱いやすいオブジェクト型に変換してしまって問題ないのでシンプル。
                // なんか失敗してるなぁ。。もっとシンプルにしたい。。
                const toolCallsSub: ChatCompletionChunk.Choice.Delta.ToolCall[] = [];
                chunk.choices.forEach(choice => {
                    text += choice.delta?.content || '';
                    const tail = responseMessages[responseMessages.length - 1];
                    // console.log(`tail ${JSON.stringify(tail)}`);
                    if (tail) {
                        if (typeof tail.content === 'string') {
                        } else if (Array.isArray(tail.content)) {
                            if (tail.content.length > 0 &&
                                (
                                    (tail.content[tail.content.length - 1].type === 'text' && choice.delta.content) ||
                                    (tail.content[tail.content.length - 1].type as any === 'thinking' && ((choice as any).thinking || (choice as any).signature))
                                )
                            ) {
                                if (choice.delta.content) {
                                    (tail.content[tail.content.length - 1] as any).text += choice.delta.content;
                                } else if ((choice as any).thinking) {
                                    (tail.content[tail.content.length - 1] as any).thinking += (choice as any).thinking;
                                } else if ((choice as any).signature) {
                                    (tail.content[tail.content.length - 1] as any).signature = (choice as any).signature;
                                }
                            } else {
                                if (choice.delta.content) {
                                    // console.log(`tail.content ${JSON.stringify(tail.content)}`);
                                    tail.content.push({ type: 'text', text: choice.delta.content, });
                                } else if ((choice as any).thinking) {
                                    tail.content.push({ type: 'thinking', thinking: (choice as any).thinking, } as any);
                                }
                            }
                        } else {
                            console.log(`SKIP: tail.content ${JSON.stringify(tail.content)}`);
                        }
                    } else {
                        const content = [] as ChatCompletionContentPartText[];
                        responseMessages.push({ role: 'assistant', content, });
                        if (choice.delta.content) {
                            content.push({ type: 'text', text: choice.delta.content, });
                        } else if ((choice as any).thinking) {
                            content.push({ type: 'thinking', thinking: (choice as any).thinking, } as any);
                        }
                    }
                    // 
                    if (options && options.functions && choice.delta && choice.delta.tool_calls && choice.delta.tool_calls.length > 0) {
                        choice.delta.tool_calls.forEach(tool_call => {
                            // console.log(`tool_call ${tool_call.index} ${tool_call.id} ${tool_call.function?.name} ${tool_call.function?.arguments}`);
                            // indexが変わったら新しいtoolCallを作る。
                            if (tool_call.id && toolCall.id !== tool_call.id) {
                                if (tool_call.id === tool_call?.function?.name) {
                                    // toolCall.idが関数名が入ってきてしまっている場合はID振り直す。（cohereのバグ）
                                    tool_call.id = Utils.generateUUID();
                                } else { }

                                toolCall = { index: tool_call.index, id: tool_call.id, function: { name: '', arguments: '' } };
                                toolCallsAll.push(toolCall);
                                toolCallsSub.push(toolCall);
                                // console.log(`toolCall ${toolCall.index} ${toolCall.id}`);
                            } else { /** argments行の時は何もしない */ }
                            if (toolCall.function && tool_call.function) {
                                toolCall.function.name += tool_call.function.name || '';
                                toolCall.function.arguments += tool_call.function.arguments || '';
                            } else { /** functionが無いことはないはず */ }
                        });
                    } else {/** tool_callsが無ければ何もしない */ }
                });
                // console.log(`toolCallsAll ${toolCallsAll.length} toolCallsSub ${toolCallsSub.length}`);
                // console.dir(toolCallsAll);
                // console.dir(toolCallsSub);
                if (toolCallsSub.length > 0) {
                    // toolCallがある場合は、infoを先頭に発行する。
                    const infos = toolCallsSub.map(toolCall => {
                        // console.dir(`toolCall>> ${toolCall.index} ${toolCall.id} ${toolCall.function?.name} ${toolCall.function?.arguments}`);
                        // console.dir(toolCall);
                        // console.log(`options.functions ${options.functions}---------------------------------------------`);
                        if (options && options.functions && toolCall.id && toolCall.function && toolCall.function.name && options.functions[toolCall.function.name]) {
                            options.toolCallCounter = options.toolCallCounter || 0;

                            // TODO 20回目で継続するかどうかを問うためにinteractiveをtrueにする。でもこれ40回の時には出ないバグになってる。。直したい。isInteractiveはbooleanだが、intにした方が使いやすかったなぁ。。
                            if ((options.toolCallCounter > 1 && ((options.toolCallCounter - 1) % 20) === 0) && options.functions) {
                                // TODO ここ、functionsは定義なので静的な前提な気もするので破壊するのは気まずいが大丈夫なんだろうか。。
                                options.functions[toolCall.function.name].info.isInteractive = true;
                            } else { }

                            console.log(`info ${toolCall.index} ${toolCall.id} ${toolCall.function.name}`);
                            const choice = {
                                delta: {
                                    tool_call_id: toolCall.id,
                                    role: 'info' as any,
                                    content: JSON.stringify(options.functions[toolCall.function.name].info), // contentのみ空で先に進めるようにしておく。
                                } as ChatCompletionChunk.Choice.Delta,
                                finish_reason: null, // 連続呼び出しは1つのtollCallGroupにしたいのでnullを入れておく
                                index: toolCall.index,
                            } as ChatCompletionChunk.Choice;
                            const _chunk: ChatCompletionChunk = {
                                id: chunk.id,
                                object: chunk.object,
                                created: chunk.created,
                                model: chunk.model,
                                service_tier: chunk.service_tier,
                                system_fingerprint: chunk.system_fingerprint,
                                choices: [choice],
                            };
                            // console.dir(`info ${toolCall.index} ${toolCall.id} ${toolCall.function?.name} ${toolCall.function?.arguments}`);
                            // console.dir(chunk, { depth: null });
                            // console.dir(_chunk, { depth: null });;
                            return _chunk;
                        } else {
                            return null;
                        }
                    }).filter(chunk => !!chunk);
                    // console.log(`infos ${infos.length}`);
                    toolCallsSub.length = 0; // toolCallsAllを空にしておくと動かなくなるけど、なんでこうしたかったんだっけ？    
                    return concat(...infos.map(info => of(info)), of(chunk));
                } else {
                    return of(chunk);
                }
            }),
            concatWith(of(toolCallsAll).pipe(
                switchMap(toolCallsAll => {
                    // console.dir(responseMessages, { depth: null });
                    // responseMessagesをargs.messagesに追加する。
                    responseMessages.forEach((message, index) => args.messages.push(message));
                    // TODO 面倒だがofでObservable化して遅延評価にしないとtoolCallsAllが常に空として評価されてしまうので、あえてofでObservable化してswitchMapで中身を切り替えるやり方にした。もっとスマートなやり方がありそうだが思い付かなかったので。。。
                    return (toolCallsAll.length && options) ? this.toolCallObservableStream(args, options, provider, toolCallsAll) : EMPTY;
                }),
            )),
        );
    }

    /**
     * functionCallを実行する関数
     * @param args 
     * @param options 
     * @param text 
     * @param toolCalls 
     * @returns 
     */
    toolCallObservableStream(args: ChatCompletionCreateParamsStreaming, options: MyCompletionOptions, provider: AiProvider, toolCalls: ChatCompletionChunk.Choice.Delta.ToolCall[], input?: any): Observable<ChatCompletionChunk> {
        const functions = options.functions as Record<string, MyToolType>;

        const tool_calls: ChatCompletionMessageToolCall[] = toolCalls.map(toolCall => ({ id: toolCall.id || '', type: 'function', function: { name: toolCall.function?.name || '', arguments: toolCall.function?.arguments || '' } }));
        if (args.messages[args.messages.length - 1].role === 'assistant') {
            // 末尾がassistant（ということはツール呼び出しとテキストのレスポンスが混在しているタイプ）の場合は、レスポンスメッセージにtool_callsを追加する。
            (args.messages[args.messages.length - 1] as any).tool_calls = tool_calls;
        } else {
            // 末尾がassistantじゃない場合は、新規メッセージとしてtool_callsを追加する。
            args.messages.push({ role: 'assistant', content: [], tool_calls: tool_calls, });
        }
        // console.dir(args.messages, { depth: null });
        const toolCallArgs: ChatCompletionCreateParamsStreaming = {
            ...args,
            messages: [...args.messages,], // messagesだけ入れ替える
        };
        // const toolCallArgs = args;
        // args.messages.push({
        //     role: 'assistant',
        //     content: [],
        //     tool_calls: toolCalls.map(toolCall => ({ id: toolCall.id || '', type: 'function', function: { name: toolCall.function?.name || '', arguments: toolCall.function?.arguments || '' } })),
        // },);

        // console.log('--toolCalls--------------------------------------------');
        // console.dir(toolCallArgs, { depth: null });
        // console.log('---------------------------------------------------------------');
        // if (text) {
        //     // textが指定されていたらcontentに追加する。
        //     const content = toolCallArgs.messages[toolCallArgs.messages.length - 1].content;
        //     if (content && Array.isArray(content)) {
        //         content.push({ type: 'text', text });
        //     } else { }
        // } else { }
        let requireUserInput = false;
        let cancellation = false;
        // console.log('BeforeALLCALL:toolCallsConcat::');
        // console.dir(toolCalls, { depth: null });
        return concat(...toolCalls.map(toolCall => {
            // console.log('toolCallsConcat::');
            // console.dir(toolCall);
            if (!toolCall.function) {
                // functionが無い場合は何もしない。
                return EMPTY;
            } else { }
            // functionがある場合は実行する。面倒なのでundefinedを潰しておく。
            const func = toolCall.function;
            func.name = func.name || '';
            func.arguments = func.arguments || '';
            // console.log(`toolCall ${toolCall.index} ${toolCall.id} ${toolCall.function?.name}`);
            // 外に知らせるためのchunkを作成
            const choice = {
                delta: {
                    tool_call_id: toolCall.id, role: 'tool', content: '', // contentのみ空で先に進めるようにしておく。
                } as ChatCompletionChunk.Choice.Delta,
                finish_reason: null, // 連続呼び出しは1つのtollCallGroupにしたいのでnullを入れておく
                index: toolCall.index,
            } as ChatCompletionChunk.Choice;
            const chunk: ChatCompletionChunk = {
                id: toolCall.id || '', // toolCall.idが無い場合は空文字列にしておく。
                object: 'chat.completion.chunk',
                created: Date.now(),
                model: args.model,
                choices: [choice],
            };

            // console.log(`toolCall ${toolCall.index} ${toolCall.id} ${toolCall.name} ${toolCall.arguments}`);
            // 関数実行に失敗したら isError: true, error: 'エラーメッセージ' を返す。
            try {
                if (!functions[func.name]) throw new Error(`Function "${func.name}" is not defined.`);

                // inputがundefinedじゃなければ関数を実行する。
                // functions[func.name].info.isInteractive || functions[func.name].info.isInteractive
                if (input === undefined && functions[func.name].info.isInteractive) {
                    requireUserInput = true;
                    // // query
                    // choice.delta.role = 'query' as any; // 
                    // choice.delta.content = JSON.stringify(toolCall);
                    // // pl側の作りをqueryが最初じゃないと動かないように作ってしまったのでquery,infoの順にする。
                    // return of(chunk);
                    return EMPTY; // query要らないのでは？infoとcallで十分な気がする。
                } else {
                    console.log(`toolCall ${toolCall.index} ${toolCall.id} ${toolCall.function?.name} ${toolCall.function?.arguments}`);
                    let argmentsObject;
                    try {
                        argmentsObject = JSON.parse(func.arguments || '{}');
                    } catch (error) {
                        // console.log(func.arguments);
                        console.error(error);
                        argmentsObject = {};
                    }

                    let functionResultPromise;
                    // console.dir(input);
                    if (input && input[0].body && input[0].body.command === 'cancel') {
                        // キャンセルコマンドが来た場合はキャンセルする。
                        functionResultPromise = Promise.resolve({ command: 'cancel', message: 'The user has requested a cancellation.' });
                        cancellation = true;
                    } else {
                        try {
                            // console.log(`input=${input}, argmentsObject=${argmentsObject} func.name=${func.name}`);
                            functionResultPromise = functions[func.name].handler(argmentsObject).then(res => {
                                // console.log('LOG:--------------------');
                                // console.dir(res);
                                return res;
                            }).catch(error => {
                                // handler実行時の非同期エラーをキャッチする
                                // console.error(`error-----------------------`);
                                // console.error(error);
                                return { isError: true, error: Utils.errorFormattedObject(error, false) };
                            });
                        } catch (error) {
                            // handler実行時の同期エラーをキャッチする
                            functionResultPromise = Promise.resolve({ isError: true, error: Utils.errorFormattedObject(error, false) });
                        }
                    }

                    const result = from(functionResultPromise).pipe(
                        catchError(error => {
                            // ここは既にエラーが起きることはないプロミスに変換後なのでcatchErrorする必要はないかもしれない。。
                            // console.error("Error executing function:", error);
                            return of({ isError: true, error: Utils.errorFormattedObject(error, false) });
                        }),
                        map(response => {
                            // console.log(`Executing function "${toolCall.name}" with arguments:`, JSON.parse(toolCall.arguments));
                            // console.log("Function response:", response);
                            //// 外に知らせるためのものと次の関数呼び出しに渡すためのもの、ほぼ同じだけど別々の用途なので面倒でも分けて作る必要がある。
                            // 関数の実行結果を外に知らせるためのもの
                            const text = JSON.stringify(response, Utils.genJsonSafer());
                            choice.delta.content = text;
                            // console.log(`----------------------TEXT-------------\n${text.substring(0, 40)}\n----------------------RESULT`);
                            // 関数呼び出し後にAIに返すためのもの
                            toolCallArgs.messages.push({ role: 'tool', content: [{ type: 'text', text }], tool_call_id: toolCall.id || '' });
                            return chunk;
                        }),
                    );
                    return result;
                    // if (input === undefined) {
                    //     // 次の関数呼び出しに渡すためのもの
                    //     return result;
                    // } else {
                    //     const inputChunk = JSON.parse(JSON.stringify(chunk)) as ChatCompletionChunk;;
                    //     inputChunk.choices[0].delta.role = 'command' as any;
                    //     inputChunk.choices[0].delta.content = JSON.stringify(input);
                    //     return concat(of(inputChunk), result);
                    // } else {
                    //     const inputChunk = JSON.parse(JSON.stringify(chunk)) as ChatCompletionChunk;;
                    //     inputChunk.choices[0].delta.role = 'command' as any;
                    //     inputChunk.choices[0].delta.content = JSON.stringify(input);
                    //     return concat(of(inputChunk), result);
                    // }
                }
            } catch (error) {
                // 実行時にエラーになった場合
                console.error("Error executing function:", error);
                //// 外に知らせるためのものと次の関数呼び出しに渡すためのもの、ほぼ同じだけど別々の用途なので面倒でも分けて作る必要がある。
                // 外に知らせるためのもの
                choice.delta.content = JSON.stringify({ isError: true, error: Utils.errorFormattedObject(error, false) });
                // 関数呼び出し後にAIに返すためのもの
                toolCallArgs.messages.push({ role: 'tool', content: [{ type: 'text', text: JSON.stringify({ isError: true, error: Utils.errorFormattedObject(error, false) }) }], tool_call_id: toolCall.id || '' });
                return of(chunk);
            }
        })).pipe(
            // ココも面倒だけど、ofで遅延評価にしてswitchMapで中身を切り替えるやり方にしないと、toolCallArgsが常に空として評価されてしまうので、あえてこのやり方。
            concatWith(of(toolCallArgs).pipe(switchMap(toolCallArgs => {
                if (typeof options.toolCallCounter === 'number') {
                    options.toolCallCounter++;
                } else {
                    options.toolCallCounter = 0;
                }
                // 関数グループ打ち終わりのチャンクを返す。
                const stopChunk: ChatCompletionChunk = {
                    id: '',
                    object: 'chat.completion.chunk',
                    created: Date.now(),
                    model: args.model,
                    choices: [{ finish_reason: 'stop' } as ChatCompletionChunk.Choice],
                };

                // キャンセルコマンドが来た場合はキャンセルする。
                const cancelChunk: ChatCompletionChunk = {
                    ...stopChunk,
                    choices: [{ delta: { content: `キャンセルしました。` }, finish_reason: 'stop' } as ChatCompletionChunk.Choice],
                };

                console.log(`cancellation=${cancellation}, requireUserInput=${requireUserInput}`);

                return cancellation
                    ? concat(of(stopChunk), of(cancelChunk))
                    : requireUserInput
                        ? of(stopChunk)
                        : concat(of(stopChunk), this.chatCompletionObservableStream(toolCallArgs, options, provider));
            }))),
        );
        // 2. function_callの処理関数
        function executeFunctionCall(functionCall: FunctionCall) {
            const { name, args } = functionCall;

            if (!functions[name]) {
                console.error(`Function "${name}" is not defined.`);
                throw new Error(`Function "${name}" is not defined.`);
            }

            try {
                // 関数を実行
                console.log(`Executing function "${name}" with arguments:`, args);
                return functions[name].handler(args);
            } catch (error) {
                console.error("Error executing function:", error);
                return null;
            }
        }
        return EMPTY;
    }

    /**
     * キューにたまっているリクエストを処理する。
     */
    fire(): void {
        const waitQueue = this.waitQueue;
        const inProgressQueue = this.inProgressQueue;
        for (const key of Object.keys(waitQueue)) {
            // 未知モデル名の場合はlimit=1のObjectを追加しておく
            if (!this.currentRatelimit[key]) this.currentRatelimit[key] = { maxTokens: 4096, limitRequests: 1, limitTokens: 1, remainingRequests: 1, remainingTokens: 0, resetRequests: '', resetTokens: '' };
            // console.log(`fire ${key} x waitQueue:${waitQueue[key].length} inProgressQueue:${inProgressQueue[key].length} reqlimit:${this.currentRatelimit[key].limitRequests} toklimit:${this.currentRatelimit[key].limitTokens} remainingRequests:${this.currentRatelimit[key].remainingRequests} remaingTokens:${this.currentRatelimit[key].remainingTokens}`);
            const ratelimitObj = this.currentRatelimit[key];
            // console.log(`fire ${key} x waitQueue:${waitQueue[key].length} inProgressQueue:${inProgressQueue[key].length} reqlimit:${ratelimitObj.limitRequests} toklimit:${ratelimitObj.limitTokens} remainingRequests:${ratelimitObj.remainingRequests} remaingTokens:${ratelimitObj.remainingTokens}`);
            for (let i = 0; i < Math.min(waitQueue[key].length, ratelimitObj.remainingRequests - inProgressQueue[key].length); i++) {
                // console.log(`fire ${key} ${i} waitQueue:${waitQueue[key].length} inProgressQueue:${inProgressQueue[key].length} reqlimit:${ratelimitObj.limitRequests} toklimit:${ratelimitObj.limitTokens} remainingRequests:${ratelimitObj.remainingRequests} remaingTokens:${ratelimitObj.remainingTokens}`);
                if (waitQueue[key][i].tokenCount.prompt_tokens > ratelimitObj.remainingTokens
                    && ratelimitObj.remainingTokens !== ratelimitObj.limitTokens) { // そもそもlimitオーバーのトークンは弾かずに投げてしまう。
                    // console.log(`${i} ${waitQueue[key][i].tokenCount.prompt_tokens} > ${ratelimitObj.remainingTokens}`);
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

export function normalizeMessage(_args: ChatCompletionCreateParamsStreaming, allowLocalFiles: boolean): Observable<{ args: ChatCompletionCreateParamsStreaming, countObject: { image: number, audio: number, video: number } }> {
    const args = { ..._args };
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
        args.temperature = Number(args.temperature) || 1.0;
    } else { }
    if (args.top_p && typeof args.top_p === 'string') {
        args.top_p = Number(args.top_p) || 1;
    } else { }
    if (args.n && typeof args.n === 'string') {
        args.n = Number(args.n);
    } else { }

    const countObject = { image: 0, audio: 0, video: 0 };
    return forkJoin(args.messages.map(message => {
        if (Array.isArray(message.content)) {
            // メディアモデルの場合のトークン計測とか
            return forkJoin(message.content.map(content => {  // TODO アップデートしたら型合わなくなった。。。
                if (content.type === 'image_url' && content.image_url && content.image_url.url) {
                    // DANGER!!! ローカルファイルを読み込むのでオンラインから使わせるときはセキュリティ的に問題がある。
                    // ファイルの種類を判定して、画像の場合はbase64に変換してcontent.image_url.urlにセットする。
                    // TODO 外のURLには対応していない。
                    // console.log(content.image_url.url);
                    if (content.image_url.url.startsWith('file:///')) {
                        if (allowLocalFiles) {
                            const filePath = content.image_url.url.substring('file://'.length);
                            const data = fs.readFileSync(filePath);
                            const metaInfo = sizeOf(data);
                            console.log(metaInfo);
                            content.image_url.url = `data:image/${metaInfo.type === 'jpg' ? 'jpeg' : metaInfo.type};base64,${data.toString('base64')}`;
                            // 画像のトークン数を計算する。
                            countObject.image += calculateTokenCost(metaInfo.width || 0, metaInfo.height || 0);
                        } else {
                            // エラー
                            throw new Error(`ローカルファイルアクセスは禁止`);
                        }
                    } else if (content.image_url.url.startsWith('data:')) {
                        // データURLからデータを取り出してサイズを判定する。
                        const label = (content.image_url as any)['label'] as string;
                        const trg = label?.toLowerCase().replace(/.*\./g, '');
                        const mimeType = content.image_url.url.substring(5, content.image_url.url.indexOf(';'));
                        if ((content.image_url.url.startsWith('data:image/') || imageExtensions.includes(trg))
                            && !content.image_url.url.startsWith('data:image/svg')
                            && !content.image_url.url.startsWith('data:image/tiff')
                            && !content.image_url.url.startsWith('data:image/x-tiff')
                        ) { // svgは画像じゃなくてテキストとして処理させる
                            const data = Buffer.from(content.image_url.url.substring(content.image_url.url.indexOf(',') + 1), 'base64');
                            try {
                                const metaInfo = sizeOf(data);
                                // 画像のトークン数を計算する。
                                countObject.image += calculateTokenCost(metaInfo.width || 0, metaInfo.height || 0);
                            } catch (e) {
                                console.log(`エラーになるのでメタ情報取得をスキップします。${content.image_url.url.substring(0, content.image_url.url.indexOf(','))}`);
                                console.log(e);
                                // countObject.image += calculateTokenCost(metaInfo.width || 0, metaInfo.height || 0);
                            }
                            // } else if (content.image_url.url.startsWith('data:audio/') || audioExtensions.includes(trg)) {
                        } else if (content.image_url.url.startsWith('data:audio/')) {
                            console.log(`audio trg=${trg} url=${content.image_url.url.substring(5, content.image_url.url.indexOf(';'))}`);
                            // 音声
                            return getMetaDataFromDataURL(content.image_url.url).pipe(map(metaData => {
                                (content.image_url as any).second = metaData.format.duration;
                                countObject.audio += metaData.format.duration || 0;
                                return content;
                            }));
                            // } else if (content.image_url.url.startsWith('data:video/') || videoExtensions.includes(trg)) {
                        } else if (content.image_url.url.startsWith('data:video/')) {
                            console.log(`video trg=${trg} url=${content.image_url.url.substring(5, content.image_url.url.indexOf(';'))}`);
                            // 動画
                            return getMetaDataFromDataURL(content.image_url.url).pipe(map(metaData => {
                                (content.image_url as any).second = metaData.format.duration;
                                countObject.video += metaData.format.duration || 0;
                                return content;
                            }));
                        } else if (content.image_url.url.startsWith('data:text/') || plainExtensions.includes(trg) || plainMime.includes(mimeType) || mimeType.endsWith('+xml') || content.image_url.url.startsWith('data:application/octet-stream;base64,IyEv')) {
                            let decodedString;
                            (content.type as any) = 'text';
                            const base64String = content.image_url.url.substring(content.image_url.url.indexOf(',') + 1);
                            // テキストファイルの場合はデコードしてテキストにしてしまう。
                            if (base64String) {
                                const data = Buffer.from(base64String, 'base64');
                                const detectedEncoding = detect(data);
                                if (detectedEncoding.encoding === 'ISO-8859-2') {
                                    detectedEncoding.encoding = 'Windows-31J'; // 文字コード自動判定でSJISがISO-8859-2ことがあるので
                                } else if (!detectedEncoding.encoding) {
                                    detectedEncoding.encoding = 'Windows-31J'; // nullはおかしいのでとりあえず
                                }
                                const decoder = new TextDecoder(detectedEncoding.encoding);
                                decodedString = decoder.decode(data);
                            } else {
                                // 空の場合はデコーダーに掛けると面倒なので直接空文字を入れる
                                decodedString = '';
                            }
                            if ('label' in (content.image_url as any) && !trg.endsWith('.md')) {
                                // label項目でファイル名が来ているときはmarkdownとして埋め込む。
                                const label = (content.image_url as any).label as string;
                                let trg = label.replace(/.*\./g, '');
                                trg = trgReplace[trg] || trg;
                                (content as any).text = '```' + trg + ' ' + label + '\n' + decodedString + '\n```';
                            } else {
                                (content as any).text = decodedString;
                            }
                            delete (content as any).image_url;
                        } else {
                            console.log(`normalizeMessage skip ${content.image_url.url.substring(0, content.image_url.url.indexOf(','))}`);
                        }
                    } else {
                        // 外部URLの場合は何もしない。トークン計算もしない。
                    }
                } else { /* それ以外は何もしない */ }
                return of(content);
            })).pipe(toArray(), map(contents => message));
        } else {
            /* それ以外は何もしない */
            return of(message);
        }
    })).pipe(toArray(), map(messages => {
        // console.dir(args.messages, { depth: null });
        if (VISION_MODELS.indexOf(args.model) !== -1) {
        } else {
            args.messages.forEach((message, index) => {
                if (message.content && Array.isArray(message.content)) {
                    message.content.forEach(content => {
                        if (content.type === 'image_url') {
                            const _content = content as any as ChatCompletionContentPartText;
                            _content.type = 'text';
                            _content.text = content.image_url.url;
                            delete (content as any).image_url;
                        } else { }
                    });
                } else { }
            });
        }
        return args;
    })).pipe(map(args => {
        // console.dir(args.messages, { depth: null });
        // ゴミメッセージを削除する。
        args.messages = args.messages.filter(message => {
            if (message.content) {
                // テキストがあるか、画像があるか、どちらかがあればOKとする。
                if (typeof message.content === 'string') {
                    // テキストの場合は空白文字を削除してから長さが0より大きいかチェックする。
                    return message.content.trim().length > 0;
                } else if ((message as any).tool_calls) {
                    // TODO tool_callsが何故anyなのか？？？
                    // tool_callsがある場合は無視する。
                    return true;
                } else if (Array.isArray(message.content)) {
                    // 配列の場合は、中身の要素が存在するかをチェックする。
                    message.content = (message.content as Array<ChatCompletionContentPart>).filter(content => {
                        // テキストがあるか、画像があるか、どちらかがあればOKとする。
                        if (content.type === 'text') {
                            // テキストの場合は空白文字を削除してから長さが0より大きいかチェックする。
                            return content.text.trim().length > 0;
                        } else if (content.type === 'image_url') {
                            // 画像の場合はURLがあるかチェックする。
                            return content.image_url.url.trim().length > 0;
                        } else if (content.type === 'tool_result' as any) {
                            // tool_resultは生かす。なんでanyなのか、、、
                            return true;
                        } else if (content.type === 'thinking' as any) {
                            // thinkingの場合は空白文字を削除してから長さが0より大きいかチェックする。
                            return (content as any).thinking.trim().length > 0;
                        } else {
                            // それ以外は無視する。
                            return false;
                        }
                    }) as ChatCompletionContentPart[]; // TODO アップデートしたら型合わなくなったので as を入れる。
                    return message.content.length > 0; // 中身の要素が無ければfalseで返す
                } else {
                    console.log(`normalizeMessage skip ${message.content}`);
                    // それ以外はありえないので無視する。
                    return false;
                }
            } else if ((message as any).tool_calls) {
                // TODO tool_callsが何故anyなのか？？？
                return true;
            } else {
                // contentもtool_callsもない場合は無視する。
                return false;
            }
        });
        // console.dir(args.messages, { depth: null });

        // 同一のロールが連続する場合は1つのメッセージとして纏める（こうしないとGeminiがエラーになるので。）
        args.messages = args.messages.reduce((prev, curr) => {
            // TODO tool_call_idが何故anyなのか？？？
            if (prev.length === 0 || prev[prev.length - 1].role !== curr.role || (prev[prev.length - 1] as any).tool_call_id !== (curr as any).tool_call_id) {
                prev.push(curr);
            } else {
                const prevContent = prev[prev.length - 1].content;
                if (typeof prevContent === 'string') {
                    if (prevContent) {
                        console.log(`prevContent:${prevContent}`);
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
                // TODO アップデートしたら型合わなくなったので as を入れる
                const prevContentArray: ChatCompletionContentPart[] = prev[prev.length - 1].content as ChatCompletionContentPart[];
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
                                // console.log(`obj.text:${obj.text}`);
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
        }, [] as ChatCompletionMessageParam[]);
    })).pipe(map(() => ({ args, countObject })));
}

/**
 * トークン数とコストを計算するクラス
 */
export class TokenCount {

    // モデル名とコストの対応表
    static COST_TABLE: { [key: string]: { prompt: number, completion: number } } = COST_TABLE;

    static SHORT_NAME: { [key: string]: string } = SHORT_NAME;

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

export const audioExtensions = ['wav', 'mp3', 'aac', 'flac', 'alac', 'ogg', 'ape', 'dts', 'ac3', 'm4a', 'm4b', 'm4p', 'mka', 'aiff', 'aif', 'au', 'snd', 'voc', 'wma', 'ra', 'ram', 'caf', 'tta', 'shn', 'dff', 'dsf', 'atrac', 'atrac3', 'atrac3plus'];
export const videoExtensions = ['mp4', 'mov', 'avi', 'mkv', 'wmv', 'flv', 'webm', 'ogv', 'mpg', 'mpeg', 'm4v', '3gp', '3g2', 'asf', 'dv', 'mxf', 'vob', 'ifo', 'rm', 'rmvb', 'swf'];
export const imageExtensions = ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'tiff', 'tif', 'svg', 'webp', 'ico', 'cur', 'ani', 'psd', 'ai', 'eps', 'cdr', 'pcx', 'pnm', 'pbm', 'pgm', 'ppm', 'ras', 'xbm', 'xpm'];
export const plainExtensions = ['js', 'javascript', 'ts', 'typescript', 'jsx', 'tsx', 'java', 'c', 'cpp', 'cs', 'php', 'py', 'python', 'ipynb', 'pc', 'cob', 'cbl', 'pco', 'copy', 'cpy', 'rb', 'ruby', 'swift', 'go', 'rust', 'sql', 'pl', 'pm', 'tcl', 'tk', 'lua', 'luau', 'kt', 'ddl', 'awk', 'vb', 'vbs', 'vbnet', 'asp', 'aspx', 'jsp', 'jspx', 'jspxm', 'jspxmi', 'jspxml', 'jspxmi', 'jspxml', 'html', 'htm', 'css', 'scss', 'sass', 'less', 'styl', 'xml', 'xhtml', 'xslt', 'xsd', 'xsl', 'xsd', 'wsdl', 'bash', 'sh', 'zsh', 'ksh', 'csh', 'tcsh', 'perl', 'pl', 'pm', 'tcl', 'tk', 'lua', 'luau', 'coffee', 'dart', 'elixir', 'erlang', 'groovy', 'haskell', 'kotlin', 'latex', 'matlab', 'objective-c', 'pascal', 'prolog', 'r', 'scala', 'verilog', 'vhdl', 'asm', 's', 'S', 'inc', 'h', 'hpp', 'hxx', 'cxx', 'cc', 'cpp', 'c++', 'm', 'mm', 'swift', 'go', 'makefile', 'cmake', 'gradle', 'pom', 'podfile', 'Gemfile', 'requirements', 'package', 'yaml', 'yml', 'json', 'toml', 'ini', 'conf', 'cfg', 'properties', 'prop', 'xml', 'xsd', 'xsl', 'xslt', 'txt', 'text', 'log', 'md', 'markdown', 'rst', 'restructuredtext', 'csv', 'tsv', 'tab', 'diff', 'patch'];
export const plainMime = [
    'application/json',
    'application/manifest+json',
    'application/xml',
    'application/x-yaml',
    'application/x-toml',
    'application/yaml',
    'application/toml',
    'application/csv',
    'application/x-ndjson',
    'application/javascript',
    'application/x-typescript',
    'application/sql',
    'application/graphql',
    'application/x-sh',
    'application/x-python',
    'application/x-ipynb+json',
    'application/x-ruby',
    'application/x-php',
    'application/x-latex',
    'application/x-troff',
    'application/x-tex',
    'application/x-www-form-urlencoded',
    'application/ld+json',
    'application/vnd.api+json',
    'application/problem+json',
    'application/rtf',
    'application/x-sql',
    'application/xhtml+xml',
    'application/rss+xml',
    'application/atom+xml',
    'application/x-tcl',
    'application/x-lisp',
    'application/x-r',
    'application/postscript',
    'application/vnd.google-earth.kml+xml',
    'application/x-bash',
    'application/x-csh',
    'application/x-scala',
    'application/x-kotlin',
    'application/x-swift',
    'application/x-plist',
    'application/vnd.apple.mpegurl',
    'application/x-apple-diskimage',
    'application/x-objc',
    'application/vnd.apple.pkpass',
    'application/x-darwin-app',
    'application/pem-certificate-chain',
    'application/x-x509-ca-cert',
    'application/x-ns-proxy-autoconfig',
    'image/svg',
    'image/svg+xml',
    'application/xaml+xml',
    'application/x-perl',
]
export const invalidMimeList = [
    'application/octet-stream',
    // 'application/vnd.ms-excel',
    // 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/java-vm',
    'application/x-elf',
    // 'application/xml',
    'application/x-msdownload',
    'application/gzip',
    'application/zip',
    "application/zstd",
    "application/x-gzip",
    "application/x-tar",
    "application/x-bzip2",
    "application/x-xz",
    "application/x-rar-compressed",
    'application/x-7z-compressed',
    "application/x-compress",
    'image/x-icon',
    'application/font-woff',
    'application/vnd.ms-fontobject',
    'font/woff',
    'font/woff2',
    'font/ttf',
    'font/otf',
    'font/eot',
    'font/collection',
    'application/x-font-ttf',
    'application/x-font-otf',
    'application/x-font-woff',
    'font/sfnt',
    'application/pem-certificate-chain',
    'application/x-x509-ca-cert', // 証明書は外す
    'application/x-ms-application',
    'application/x-pkcs12',
    'application/pkix-cert',
    'application/x-sqlite3',
    'application/x-cfb',
];

const trgReplace: { [key: string]: string } = {
    // 一般的なプログラミング言語
    js: 'javascript',
    ts: 'typescript',
    py: 'python',
    rb: 'ruby',
    java: 'java',
    cpp: 'cpp',
    cs: 'csharp',
    go: 'go',
    rs: 'rust',
    swift: 'swift',
    kt: 'kotlin',
    php: 'php',

    // マークアップ/スタイル
    md: 'markdown',
    html: 'html',
    css: 'css',
    scss: 'scss',
    sass: 'sass',
    less: 'less',

    // シェル関連
    sh: 'shell',
    bash: 'bash',
    zsh: 'zsh',
    ps: 'powershell',

    // データフォーマット
    json: 'json',
    yaml: 'yaml',
    yml: 'yaml',
    xml: 'xml',
    toml: 'toml',

    // データベース
    sql: 'sql',
    psql: 'postgresql',
    mysql: 'mysql',

    // 設定ファイル
    conf: 'conf',
    ini: 'ini',
    env: 'env',

    // その他
    docker: 'dockerfile',
    makefile: 'makefile',
    gitignore: 'gitignore',
    diff: 'diff',
    tex: 'latex',
    graphql: 'graphql',

    // ----------------------------------
    // Web系
    // ----------------------------------
    htm: 'html',
    // XML / テンプレート類
    xhtml: 'xml',

    // ----------------------------------
    // JavaScript / TypeScript
    // ----------------------------------
    cjs: 'javascript', // CommonJS
    mjs: 'javascript', // ES Modules
    jsx: 'javascript', // React（JSX入り）
    tsx: 'typescript', // React（TSX入り）

    // ----------------------------------
    // フロントエンドフレームワーク
    // ----------------------------------
    vue: 'vue',
    svelte: 'svelte',

    // ----------------------------------
    // マークアップ・ドキュメント
    // ----------------------------------
    mdx: 'mdx',
    markdown: 'markdown',

    // ----------------------------------
    // 各種プログラミング言語
    // ----------------------------------
    // C系
    c: 'c',
    h: 'c',    // CのヘッダとしてCでハイライトしてもOK
    cxx: 'cpp',
    cc: 'cpp',
    hpp: 'cpp', // C++のヘッダ
    hh: 'cpp',
    hxx: 'cpp',

    // Java系
    kts: 'kotlin',

    // Swift / Objective-C
    m: 'objectivec',
    mm: 'objectivec', // Objective-C++

    // その他
    dart: 'dart',
    scala: 'scala',
    groovy: 'groovy',
    lua: 'lua',

    // ----------------------------------
    // スクリプト・シェル系
    // ----------------------------------
    fish: 'fish',

    // PowerShell
    ps1: 'powershell',
    psm1: 'powershell',
    psd1: 'powershell',

    // ----------------------------------
    // データサイエンス・統計系
    // ----------------------------------
    r: 'r',
    rmd: 'r',

    // ----------------------------------
    // 関数型, その他スクリプト
    // ----------------------------------
    ex: 'elixir',
    exs: 'elixir',
    erl: 'erlang',
    fs: 'fsharp',  // F#
    fsx: 'fsharp',
    fsi: 'fsharp',
    ml: 'ocaml',
    mli: 'ocaml',
    clj: 'clojure',
    cljs: 'clojure',
    coffee: 'coffeescript',
    sc: 'scala',   // SuperCollider か Scala Script 用など

    // PL/pgSQL や PL/SQL は細かく分けられない場合が多い

    // ----------------------------------
    // その他
    // ----------------------------------
    vb: 'vbnet',      // Visual Basic
    pl: 'perl',
    pm: 'perl',       // Perl Module
    csproj: 'xml',    // C# Project File
};

// 画像のMIMEタイプ
export const disabledMimeList = [
];

// 不要に大きくてあんまり意味のないファイル
export const disabledFilenameList = [
    'package-lock.json',
    'yarn.lock',
    'go.sum',
];
export const disabledDirectoryList = [
    '.git',
    '.vscode',
    'node_modules',
    '.svn',
    '.idea',
    '.vs',
    '.hg',
    '.bzr',
    '__pycache__',
];

export const aiApi = new OpenAIApiWrapper();

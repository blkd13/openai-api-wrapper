import { HttpsProxyAgent } from 'https-proxy-agent';
import { Observable, Subscriber } from 'rxjs';
import * as crypto from 'crypto';
import * as fs from 'fs';
import sizeOf from 'image-size';

import OpenAI from 'openai';
import { APIPromise, RequestOptions } from 'openai/core';
import { ChatCompletionChunk, ChatCompletionContentPart, ChatCompletionCreateParamsBase, ChatCompletionCreateParamsStreaming } from 'openai/resources/chat/completions';
import { Stream } from 'openai/streaming';
import { Tiktoken, TiktokenModel, encoding_for_model } from 'tiktoken';

import fss from './fss.js';
import { Utils } from "./utils.js";

const HISTORY_DIRE = `./history`;
const openai = new OpenAI({
    apiKey: process.env['OPENAI_API_KEY'],
    // baseOptions: { timeout: 1200000, Configuration: { timeout: 1200000 } },
});

import { AzureKeyCredential, OpenAIClient } from "@azure/openai";
const azureClient = new OpenAIClient(
    process.env['AZURE_OPENAI_ENDPOINT'] as string,
    new AzureKeyCredential(process.env['AZURE_OPENAI_API_KEY'] as string)
);
export const azureDeployNameMap: Record<string, string> = {
    'gpt-3.5-turbo': 'gpt35',
    'gpt-4-vision-preview': 'gpt4',
};


/**
 * tiktokenのEncoderは取得に時間が掛かるので、取得したものはモデル名と紐づけて確保しておく。
 */
const encoderMap: Record<TiktokenModel, Tiktoken> = {} as any;
function getEncoder(model: TiktokenModel): Tiktoken {
    if (encoderMap[model]) {
    } else {
        encoderMap[model] = encoding_for_model(model);
    }
    return encoderMap[model];
}

export interface WrapperOptions {
    allowLocalFiles: boolean;
    useAzure: boolean;
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
        public logString: (stepName: string, error: any) => string,
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
        const logString = this.logString;
        let attempts = this.attempts;
        const maxAttempts = 5;
        const observer = this.observer;

        const ratelimitObj = this.openApiWrapper.currentRatelimit[this.tokenCount.modelShort];
        // 使用例: callAPI関数を最大5回までリトライする
        // console.log(this.logString('call', ''));
        // リクエストをファイルに書き出す
        fss.writeFile(`${HISTORY_DIRE}/${idempotencyKey}-${attempts}.request.json`, JSON.stringify({ args, options }, Utils.genJsonSafer()), {}, (err) => { });

        let runPromise = null;

        console.log(logString('start', ''));
        if (this.openApiWrapper.wrapperOptions.useAzure) {
            if (args.max_tokens) {
            } else if (args.model === 'gpt-4-vision-preview') {
                // vision-previの時にmax_tokensを設定しないと20くらいで返ってきてしまう。
                args.max_tokens = 4096;
            }
            // console.log('shot');
            runPromise = (azureClient.streamChatCompletions(azureDeployNameMap[args.model] || args.model, args.messages as any, { ...args as any })).then((response) => {
                // console.log('res');
                ratelimitObj.limitRequests = 0;
                ratelimitObj.limitTokens = 0;
                ratelimitObj.resetRequests = new Date().toISOString();
                ratelimitObj.remainingRequests = 1; // シングルスレッドで動かす
                ratelimitObj.remainingTokens = 1;

                if ((response as any).headers) {
                    // azureのライブラリを直接改造してないとここは取れない。
                    (response as any).headers['x-ratelimit-remaining-requests'] && (ratelimitObj.remainingRequests = Number((response as any).headers['x-ratelimit-remaining-requests']));
                    (response as any).headers['x-ratelimit-remaining-tokens'] && (ratelimitObj.remainingTokens = Number((response as any).headers['x-ratelimit-remaining-tokens']));
                } else {
                }

                // fss.writeFile(`${HISTORY_DIRE}/${idempotencyKey}-${attempts}.response.json`, JSON.stringify({ args, options, response: { status: response.response.status, headers } }, Utils.genJsonSafer()), {}, (err) => { });

                // ストリームからデータを読み取るためのリーダーを取得
                const reader = response.getReader();

                let tokenBuilder: string = '';

                // ストリームからデータを読み取る非同期関数
                async function readStream() {
                    while (true) {
                        const { value, done } = await reader.read();
                        if (done) {
                            // ストリームが終了したらループを抜ける
                            tokenCount.cost = tokenCount.calcCost();
                            console.log(logString('fine', ''));
                            observer.complete();

                            // ファイルに書き出す
                            const trg = args.response_format?.type === 'json_object' ? 'json' : 'md';
                            fss.writeFile(`${HISTORY_DIRE}/${idempotencyKey}-${attempts}.result.${trg}`, tokenBuilder || '', {}, () => { });
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
                    }
                }
                // ストリームの読み取りを開始
                readStream();
                this.openApiWrapper.fire();
            });
        } else {
            runPromise = (openai.chat.completions.create(args, options) as APIPromise<Stream<ChatCompletionChunk>>)
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

                    // ストリームからデータを読み取る非同期関数
                    async function readStream() {
                        while (true) {
                            const { value, done } = await reader.read();
                            if (done) {
                                // ストリームが終了したらループを抜ける
                                tokenCount.cost = tokenCount.calcCost();
                                console.log(logString('fine', ''));
                                observer.complete();

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
                    }
                    // ストリームの読み取りを開始
                    readStream();
                    this.openApiWrapper.fire();
                });
        }
        runPromise.catch(error => {
            attempts++;

            // エラーを出力
            console.log(logString('error', error));

            // 400エラーの場合は、リトライしない
            if (error.toString().startsWith('Error: 400')) {
                observer.error(error);
                throw error;
            } else { }

            // 最大試行回数に達したかチェック
            if (attempts >= maxAttempts) {
                // throw new Error(`API call failed after ${maxAttempts} attempts: ${error}`);
                console.log(logString('error', 'retry over'));
                observer.error('retry over');
                throw error;
            } else { }

            // レートリミットに引っかかった場合は、レートリミットに書かれている時間分待機する。
            if (error.toString().startsWith('Error: 429')) {
                const waitMs = Number(ratelimitObj.resetRequests.replace('ms', ''));
                const waitS = Number(ratelimitObj.resetTokens.replace('s', ''));
                console.log(logString('wait', `wait ${waitMs}ms ${waitS}s`));
                setTimeout(() => { this.executeCall(); }, waitMs);
            } else { }
        });
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

    // 実行待ちリスト
    queue: { [key: string]: RunBit[] } = {
        'gpt3.5  ': [],
        'gpt3-16k': [],
        'gpt4    ': [],
        'gpt4-32k': [],
        'gpt4-128': [],
        'gpt4-vis': [],
    };

    // レートリミット情報
    currentRatelimit: { [key: string]: Ratelimit } = {
        'gpt3.5  ': { limitRequests: 3500, limitTokens: 160000, remainingRequests: 1, remainingTokens: 4000, resetRequests: '0ms', resetTokens: '0s', },
        'gpt3-16k': { limitRequests: 3500, limitTokens: 160000, remainingRequests: 1, remainingTokens: 16000, resetRequests: '0ms', resetTokens: '0s', },
        'gpt4    ': { limitRequests: 5000, limitTokens: 80000, remainingRequests: 1, remainingTokens: 8000, resetRequests: '0ms', resetTokens: '0s', },
        'gpt4-32k': { limitRequests: 5000, limitTokens: 80000, remainingRequests: 1, remainingTokens: 32000, resetRequests: '0ms', resetTokens: '0s', },
        'gpt4-128': { limitRequests: 500, limitTokens: 300000, remainingRequests: 1, remainingTokens: 128000, resetRequests: '0ms', resetTokens: '0s', },
        'gpt4-vis': { limitRequests: 500, limitTokens: 300000, remainingRequests: 1, remainingTokens: 128000, resetRequests: '0ms', resetTokens: '0s', },
    };

    constructor(
        public wrapperOptions: WrapperOptions = { allowLocalFiles: false, useAzure: false }
    ) {
        // proxy設定判定用オブジェクト
        const proxyObj: { [key: string]: any } = {
            httpProxy: process.env['http_proxy'] as string || undefined,
            httpsProxy: process.env['https_proxy'] as string || undefined,
        };

        const noProxies = process.env['no_proxy']?.split(',') || [];
        let host = '';
        if (wrapperOptions.useAzure) {
            host = new URL(process.env['AZURE_OPENAI_ENDPOINT'] as string).host;
        } else {
            host = 'api.openai.com';
        }
        Object.keys(proxyObj).filter(key => noProxies.includes(host) || !proxyObj[key]).forEach(key => delete proxyObj[key]);
        this.options = Object.keys(proxyObj).filter(key => proxyObj[key]).length > 0 ? {
            httpAgent: new HttpsProxyAgent(proxyObj.httpsProxy || proxyObj.httpProxy || ''),
        } : {};
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
            if (args.response_format?.type == 'json_object' && ['gpt-4-turbo-preview', 'gpt-4-1106-preview', 'gpt-4-0125-preview', 'gpt-3.5-turbo', 'gpt-3.5-turbo-1106'].indexOf(args.model) !== -1) {
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
            if (['gpt-4-vision-preview'].indexOf(args.model) !== -1) {
                args.messages.forEach(message => {
                    if (Array.isArray(message.content)) {
                        message.content.forEach((content: ChatCompletionContentPart) => {
                            if (content.type === 'image_url' && content.image_url && content.image_url.url) {
                                // DANGER!!! ローカルファイルを読み込むのでオンラインから使わせるときはセキュリティ的に問題がある。
                                // ファイルの種類を判定して、画像の場合はbase64に変換してcontent.image_url.urlにセットする。
                                if (content.image_url.url.startsWith('file:///')) {
                                    if (this.wrapperOptions.allowLocalFiles) {
                                        const filePath = content.image_url.url.substring('file://'.length);
                                        const data = fs.readFileSync(filePath);
                                        const metaInfo = sizeOf(data);
                                        content.image_url.url = `data:image/${metaInfo.type === 'jpg' ? 'jpeg' : metaInfo.type};base64,${data.toString('base64')}`;
                                        // 画像のトークン数を計算する。
                                        imagePrompt += calculateTokenCost(metaInfo.width || 0, metaInfo.height || 0);
                                    } else {
                                        // エラー
                                        throw new Error(`ローカルファイルアクセスは禁止`);
                                    }
                                } else if (content.image_url.url.startsWith('data:image/')) {
                                    // データURLからデータを取り出してサイズを判定する。
                                    const data = Buffer.from(content.image_url.url.substring(content.image_url.url.indexOf(',') + 1), 'base64');
                                    const metaInfo = sizeOf(data);
                                    // 画像のトークン数を計算する。
                                    imagePrompt += calculateTokenCost(metaInfo.width || 0, metaInfo.height || 0);
                                } else {
                                    // 外部URLの場合は何もしない。トークン計算もしない。
                                }
                                // visionAPIはmax_tokenを指定しないと凄く短く終わるので最大化しておく。visionAPIのmax_tokenは4096が最大。
                                args.max_tokens = Math.min(args.max_tokens || 4096, 4096);
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
            const prompt = args.messages.map(message => `<im_start>${message.role}\n${message.content}<im_end>`).join('\n');
            const tokenCount = new TokenCount(args.model as GPTModels, 0, 0);
            // gpt-4-1106-preview に未対応のため、gpt-4に置き換え。プロンプトのトークンを数えるだけなのでモデルはどれにしてもしても同じだと思われるが。。。
            tokenCount.prompt_tokens = getEncoder((['gpt-4-turbo-preview', 'gpt-4-1106-preview', 'gpt-4-0125-preview', 'gpt-4-vision-preview'].indexOf((tokenCount.modelTikToken as any)) !== -1) ? 'gpt-4' : tokenCount.modelTikToken).encode(prompt).length;
            // tokenCount.prompt_tokens = encoding_for_model((['gpt-4-turbo-preview', 'gpt-4-1106-preview', 'gpt-4-0125-preview', 'gpt-4-vision-preview'].indexOf((tokenCount.modelTikToken as any)) !== -1) ? 'gpt-4' : tokenCount.modelTikToken).encode(prompt).length;
            tokenCount.prompt_tokens += imagePrompt;
            this.tokenCountList.push(tokenCount);

            let bef = Date.now();
            const logString = (stepName: string, error: any = ''): string => {
                const take = numForm(Date.now() - bef, 9);
                const prompt_tokens = numForm(tokenCount.prompt_tokens, 6);
                // 以前は1レスポンス1トークンだったが、今は1レスポンス1トークンではないので、completion_tokensは最後に再計算するようにした。
                // tokenCount.completion_tokens = encoding_for_model((['gpt-4-turbo-preview', 'gpt-4-1106-preview', 'gpt-4-0125-preview', 'gpt-4-vision-preview'].indexOf((tokenCount.modelTikToken as any)) !== -1) ? 'gpt-4' : tokenCount.modelTikToken).encode(tokenCount.tokenBuilder ? `<im_start>${tokenCount.tokenBuilder}` : '').length;
                tokenCount.completion_tokens = getEncoder((['gpt-4-turbo-preview', 'gpt-4-1106-preview', 'gpt-4-0125-preview', 'gpt-4-vision-preview'].indexOf((tokenCount.modelTikToken as any)) !== -1) ? 'gpt-4' : tokenCount.modelTikToken).encode(tokenCount.tokenBuilder ? `<im_start>${tokenCount.tokenBuilder}` : '').length;
                const completion_tokens = numForm(tokenCount.completion_tokens, 6);

                const costStr = (tokenCount.completion_tokens > 0 ? ('$' + (Math.ceil(tokenCount.cost * 100) / 100).toFixed(2)) : '').padStart(6, ' ');
                const logString = `${Utils.formatDate()} ${stepName.padEnd(5, ' ')} ${attempts} ${take} ${prompt_tokens} ${completion_tokens} ${tokenCount.modelShort} ${costStr} ${label} ${error}`;
                fss.appendFile(`history.log`, `${logString}\n`, {}, () => { });
                return logString;
            };

            console.log(logString('enque'));

            const runBit = new RunBit(logString, tokenCount, args, { ...reqOptions, ...this.options }, this, observer);
            // 未知モデル名の場合は空queueを追加しておく
            if (!this.queue[tokenCount.modelShort]) this.queue[tokenCount.modelShort] = [];
            this.queue[tokenCount.modelShort].push(runBit);
            this.fire();
        });
    }

    async fire(): Promise<void> {
        const queue = this.queue;
        for (const key of Object.keys(queue)) {
            // 未知モデル名の場合は空Objectを追加しておく
            if (!this.currentRatelimit[key]) this.currentRatelimit[key] = { limitRequests: 0, limitTokens: 0, remainingRequests: 0, remainingTokens: 0, resetRequests: '', resetTokens: '' };
            const ratelimitObj = this.currentRatelimit[key];
            for (let i = 0; i < Math.min(queue[key].length, ratelimitObj.remainingRequests); i++) {
                const runBit = queue[key].shift();
                if (!runBit) { break; }
                await runBit.executeCall();
                ratelimitObj.remainingRequests--;
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
export type GPTModels = TiktokenModel;

/**
 * トークン数とコストを計算するクラス
 */
export class TokenCount {

    // モデル名とコストの対応表
    static COST_TABLE: { [key: string]: { prompt: number, completion: number } } = {
        'all     ': { prompt: 0.0000, completion: 0.0000, },
        'gpt3.5  ': { prompt: 0.0015, completion: 0.0020, },
        'gpt3-16k': { prompt: 0.0005, completion: 0.0015, },
        'gpt4    ': { prompt: 0.0300, completion: 0.0600, },
        'gpt4-32k': { prompt: 0.0600, completion: 0.1200, },
        'gpt4-vis': { prompt: 0.0100, completion: 0.0300, },
        'gpt4-128': { prompt: 0.0100, completion: 0.0300, },
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
        'gpt-4-turbo-preview': 'gpt4-128',
        'gpt-4-1106-preview': 'gpt4-128',
        'gpt-4-0125-preview': 'gpt4-128',
        'gpt-4-vision-preview': 'gpt4-vis',
        'gpt-3.5-turbo': 'gpt3-16k',
        'gpt-3.5-turbo-0125': 'gpt3-16k',
        'gpt-3.5-turbo-0301': 'gpt3.5  ',
        'gpt-3.5-turbo-0613': 'gpt3.5  ',
        'gpt-3.5-turbo-1106': 'gpt3-16k',
        'gpt-3.5-turbo-16k': 'gpt3-16k',
        'gpt-3.5-turbo-16k-0613	': 'gpt3-16k',
        'gpt-3.5-turbo-instruct': 'gpt3.5  ',
        'gpt-3.5-turbo-instruct-0914': 'gpt3.5  ',
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

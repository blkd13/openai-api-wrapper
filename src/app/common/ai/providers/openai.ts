import OpenAI, { APIPromise } from 'openai';
import { Stream } from 'openai/streaming';

import fss from '../../fss.js';
import { HISTORY_DIRE } from '../../openai-api-wrapper.js';
import { Utils } from '../../utils.js';
import { getUndiciHttpProxy } from '../network.js';
import type { ExecutorContext } from '../types.js';

export class MyOpenAI {
    counter = 0;
    clients: OpenAI[] = [];

    constructor(public params: {
        endpoints: {
            apiKey: string,
            organization?: string,
            project?: string,
            baseURL?: string,
            httpAgent?: any,
        }[]
    }[]) {
        this.clients = this.params.flatMap(param =>
            (param.endpoints || []).map(endpoint => new OpenAI({
                apiKey: endpoint.apiKey || 'dummy',
                // organization: endpoint.organization,
                // project: endpoint.project,
                baseURL: endpoint.baseURL || 'https://api.openai.com/v1',
                // fetchOptions: { dispatcher: getUndiciHttpProxy(endpoint.baseURL || 'https://api.openai.com/v1') },
            }))
        );
    }

    get client(): OpenAI {
        const client = this.clients[this.counter % this.clients.length];
        this.counter++;
        return client;
    }

    async executor(
        ctx: ExecutorContext,
    ): Promise<void> {
        const args = ctx.commonArgs;
        const options = ctx.options || {};
        const { idempotencyKey, ratelimitObj, logObject, observer, attempts } = ctx;

        // Gemini用プロパティを消しておく
        for (const key of ['safetySettings', 'cachedContent', 'gcpProjectId',]) delete (args as any)[key]; // Gemini用プロパティを消しておく
        const client = this.client;

        if ((args as any).isGoogleSearch) {
            args.model = `${args.model}-search-preview`;
            args.web_search_options = {};
            delete args.temperature;
        } else { }
        delete (args as any).isGoogleSearch;

        const usageMetadata: { [key: string]: any } = {};
        if (args.model.startsWith('o1') || args.model.startsWith('o3') || args.model.startsWith('o4')) {
            // o1用にパラメータを調整
            delete (args as any)['max_completion_tokens'];
            delete args.max_tokens;
            delete args.temperature;
            if (args.model.endsWith('-high')) {
                args.model = args.model.replace('-high', '');
                args.reasoning_effort = 'high';
            } else { }
        } else { }

        console.dir(client);
        console.dir(client.baseURL);
        // TODO無理矢理すぎる。。proxy設定のやり方を再考する。
        options.fetchOptions = client.fetchOptions;
        options.fetchOptions = {};
        // delete options.fetchOptions

        fss.writeFile(`${HISTORY_DIRE}/${idempotencyKey}-${attempts}.request.json`, JSON.stringify({ args, options }, Utils.genJsonSafer()), {}, (err) => { });

        const decoder = new TextDecoder('utf-8');

        const runPromise = (client.chat.completions.create(args, options) as APIPromise<Stream<OpenAI.ChatCompletionChunk>>)
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

                let isThinking = false;

                // ストリームからデータを読み取る非同期関数
                async function readStream() {
                    while (true) {
                        const { value, done } = await reader.read();
                        if (done) {
                            // ストリームが終了したらループを抜ける
                            // tokenCount.cost = tokenCount.calcCost();
                            console.log(logObject.output('fine', '', JSON.stringify(usageMetadata)));
                            observer.complete();

                            // _that.openApiWrapper.fire();

                            // ファイルに書き出す
                            const trg = args.response_format?.type === 'json_object' ? 'json' : 'md';
                            fss.writeFile(`${HISTORY_DIRE}/${idempotencyKey}-${attempts}.result.${trg}`, ctx.tokenCount.tokenBuilder || '', {}, () => { });
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
                        const obj: OpenAI.ChatCompletionChunk = JSON.parse(content);

                        // deepseekのreasoning用
                        obj.choices.forEach(choice => {
                            if ((choice.delta as any).reasoning_content) {
                                (choice as any).thinking = (choice.delta as any).reasoning_content;
                            } else { }
                        });

                        const text = obj.choices.map(choice => choice.delta).filter(delta => delta).map(delta => delta.content || '').join('');

                        // <think></think> タグを処理する。
                        if (!ctx.tokenCount.tokenBuilder && text.trim() === '<think>') {
                            isThinking = true;
                            obj.choices.forEach(choice => delete choice.delta.content);
                        } else if (isThinking) {
                            if (text.trim() === '</think>') {
                                isThinking = false;
                            } else {
                                obj.choices.forEach(choice => {
                                    delete choice.delta.content;
                                    (choice as any).thinking = text;
                                });
                            }
                        } else {
                            // 通常処理
                            ctx.tokenCount.tokenBuilder += text;
                        }
                        if (obj.usage) {
                            // tokenCount.prompt_tokens = obj.usage.prompt_tokens || tokenCount.prompt_tokens;
                            // tokenCount.completion_tokens = obj.usage.completion_tokens || 0;
                            Object.assign(usageMetadata, obj.usage);
                        } else { }
                        observer.next(obj);
                    }
                    return;
                }
                // ストリームの読み取りを開始
                return readStream();
            });

        return runPromise;
    }
}

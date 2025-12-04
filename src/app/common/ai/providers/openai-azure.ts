import { socksDispatcher } from 'fetch-socks';
import OpenAI, { AzureOpenAI } from 'openai';
import { ProxyAgent } from 'undici';

import { RequestOptions } from 'openai/internal/request-options.js';
import { AzureOpenAIConfig } from '../../../service/entity/ai-model-manager.entity.js';
import fss from '../../fss.js';
import { HISTORY_DIRE } from '../../openai-api-wrapper.js';
import { Utils } from '../../utils.js';
import { TokenCount } from '../token-cost.js';
import type { ExecutorContext } from '../types.js';

function proxyStringToAgentObject(proxyString: string) {
    if (!proxyString) return undefined;
    if (proxyString.startsWith('http://')) {
        return new ProxyAgent(proxyString);
    }
    if (proxyString.startsWith('socks5://')) {
        return socksDispatcher({
            type: 5,
            host: proxyString.split(':')[1].replace('//', ''),
            port: parseInt(proxyString.split(':')[2]),
        });
    }
    return undefined;
}

const { AZURE_OPENAI_SOCKS_PROXY } = process.env as { AZURE_OPENAI_SOCKS_PROXY?: string };
const azureProxyAgent = proxyStringToAgentObject(AZURE_OPENAI_SOCKS_PROXY || '');

export class MyAzureOpenAI {
    counter = 0;
    clients: AzureOpenAI[] = [];

    constructor(public params: AzureOpenAIConfig[]) {
        this.clients = params.flatMap(param =>
            param.resources.map(resource => new AzureOpenAI({
                baseURL: resource.baseURL,
                apiKey: resource.apiKey,
                apiVersion: resource.apiVersion || '2025-01-01-preview',
                fetchOptions: { dispatcher: azureProxyAgent },
            }))
        );
    }

    get client(): AzureOpenAI {
        const client = this.clients[this.clients.length - 1];
        this.counter++;
        return client;
    }

    async executor(ctx: ExecutorContext): Promise<void> {

        const { idempotencyKey, ratelimitObj, logObject, observer, attempts, aiPrice } = ctx;
        const args = { ...ctx.commonArgs } as OpenAI.ChatCompletionCreateParams;
        const options = ctx.options as RequestOptions || undefined;

        // let runPromise: Promise<APIPromise<ChatCompletion>> | Promise<APIPromise<Stream<OpenAI.ChatCompletionChunk>>>;
        let runPromise: Promise<void>;
        const tokenCount: TokenCount = ctx.tokenCount;
        const decoder = new TextDecoder('utf-8');

        for (const key of ['safetySettings', 'cachedContent', 'gcpProjectId', 'isGoogleSearch']) delete (args as any)[key]; // Gemini用プロパティを消しておく

        const _options = { ...options, idempotencyKey: ctx.idempotencyKey, stream: ctx.commonArgs.stream || false } as RequestOptions;
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
                }) as OpenAI.ChatCompletionContentPart[];
            } else { }
        });

        if (args.model.endsWith('-high')) {
            args.model = args.model.replace('-high', '');
            args.reasoning_effort = 'high';
        } else { }
        if (args.model === 'o1-preview') {
            // o1-previewはシステムプロンプトが使えないので消しておく。
            args.messages.forEach(message => { if (message.role === 'system') { (message as any).role = 'user'; } else { } });
        }

        const client = this.client;

        const applyUsage = (usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number; }) => {
            if (!usage) return;
            tokenCount.prompt_tokens = usage.prompt_tokens ?? tokenCount.prompt_tokens;
            const completion = usage.completion_tokens ?? ((usage.total_tokens ?? 0) - tokenCount.prompt_tokens);
            tokenCount.completion_tokens = completion;
            if (aiPrice) {
                const inputPrice = Number(aiPrice.inputPricePerUnit) || 0;
                const outputPrice = Number(aiPrice.outputPricePerUnit) || 0;
                const denom = (aiPrice.unit || '').includes('1M') ? 1_000_000 : 1_000_000;
                tokenCount.cost = (tokenCount.prompt_tokens / denom) * inputPrice + (tokenCount.completion_tokens / denom) * outputPrice;
            }
        };

        const usageMetadata: { [key: string]: any } = {};
        if (args.model.startsWith('o1') || args.model.startsWith('o3') || args.model.startsWith('o4')) {
            // o1用にパラメータを調整
            delete (args as any)['max_completion_tokens'];
            delete args.max_tokens;
            args.temperature = 1;
            delete args.stream;
            delete args.stream_options;

            const argsInstance = args as OpenAI.ChatCompletionCreateParamsNonStreaming;
            argsInstance.stream = false;

            let tokenBuilder = '';
            fss.writeFile(`${HISTORY_DIRE}/${idempotencyKey}-${attempts}.request.json`, JSON.stringify({ args, options: _options }, Utils.genJsonSafer()), {}, (err) => { });
            // console.log({ idempotencyKey: options.idempotencyKey, stream: options.stream });
            // なんでか知らんけどazureClientを通すとargs.modelが消えてしまったり、破壊的なことが起こるのでコピーを送る

            runPromise = client.chat.completions.create(argsInstance, _options)
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
                    const body = response.data as any as OpenAI.ChatCompletion;
                    const line = JSON.stringify(body);

                    // this.openApiWrapper.fire();

                    fss.writeFile(`${HISTORY_DIRE}/${idempotencyKey}-${attempts}.response.json`, JSON.stringify({ args, options: _options, response: { status: response.response.status, headers, body } }, Utils.genJsonSafer()), {}, (err) => { });

                    // ファイルに書き出す
                    fss.appendFile(`${HISTORY_DIRE}/${idempotencyKey}-${attempts}.txt`, line, {}, () => { });

                    // トークン数をカウント
                    applyUsage(body.usage);

                    tokenBuilder += body.choices.map(choice => choice.message).filter(message => message).map(message => message.content).join('');
                    tokenCount.tokenBuilder = tokenBuilder;

                    const trg = args.response_format?.type === 'json_object' ? 'json' : 'md';
                    fss.writeFile(`${HISTORY_DIRE}/${idempotencyKey}-${attempts}.result.${trg}`, tokenBuilder || '', {}, () => { });

                    // tokenCount.cost = tokenCount.calcCost();
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
                        }) as OpenAI.ChatCompletionChunk.Choice),
                        created: body.created,
                        model: body.model,
                        object: 'chat.completion.chunk',
                        service_tier: body.service_tier,
                        system_fingerprint: body.system_fingerprint,
                        usage: body.usage,
                    });
                    // asOpenAI.ChatCompletionChunk
                    observer.complete();
                });
        } else {
            fss.writeFile(`${HISTORY_DIRE}/${idempotencyKey}-${attempts}.request.json`, JSON.stringify({ args, options: _options }, Utils.genJsonSafer()), {}, (err) => { });
            const argsInstance = args as OpenAI.ChatCompletionCreateParamsStreaming;
            argsInstance.stream = true;
            runPromise = client.chat.completions.create(argsInstance, _options)
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
                                fss.writeFile(`${HISTORY_DIRE}/${idempotencyKey}-${attempts}.result.${trg}`, tokenBuilder || '', {}, () => { });
                                break;
                            }
                            // 中身を取り出す
                            const content = decoder.decode(value);
                            // console.dir(content, { depth: null });

                            // 中身がない場合はスキップ
                            if (!content) { continue; }
                            const obj = JSON.parse(content) as OpenAI.ChatCompletionChunk;

                            // ファイルに書き出す
                            fss.appendFile(`${HISTORY_DIRE}/${idempotencyKey}-${attempts}.txt`, content || '', {}, () => { });

                            tokenBuilder += obj.choices.map(choice => choice.delta).filter(delta => delta).map(delta => delta.content || '').join('');
                            tokenCount.tokenBuilder = tokenBuilder;

                            if (obj.usage) {
                                applyUsage(obj.usage as any);
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
        return runPromise;
    }
}

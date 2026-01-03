import { ResponseUsage } from 'openai/resources/responses/responses.js';
import { socksDispatcher } from 'fetch-socks';
import OpenAI, { AzureOpenAI } from 'openai';
import { ProxyAgent } from 'undici';

import { RequestOptions } from 'openai/internal/request-options.js';
import { AIModelEntity, AIModelPricingEntity, AzureOpenAIConfig } from '../../../service/entity/ai-model-manager.entity.js';
import fss from '../../fss.js';
import { HISTORY_DIRE } from '../../openai-api-wrapper.js';
import { resizeImageToSquare } from '../../media-funcs.js';
import { Utils } from '../../utils.js';
import { TokenCount } from '../token-cost.js';
import type { ExecutorContext } from '../types.js';

interface ImageGenerationParams {
    prompt: string;
    size?: '1024x1024' | '1024x1536' | '1536x1024' | 'auto';
    quality?: 'low' | 'medium' | 'high';
    output_compression?: number;
    output_format?: 'png' | 'jpeg' | 'webp';
    background?: 'transparent' | 'white' | 'black';
    n?: number;
}

interface ImageEditParams {
    image: Buffer;
    mask?: Buffer;
    prompt: string;
    size?: '1024x1024' | '1024x1536' | '1536x1024' | 'auto';
    quality?: 'low' | 'medium' | 'high';
    output_compression?: number;
    output_format?: 'png' | 'jpeg' | 'webp';
    background?: 'transparent' | 'white' | 'black';
    n?: number;
}

interface ImageGenerationResponse {
    created: number;
    data: Array<{
        b64_json?: string;
        url?: string;
        revised_prompt?: string;
    }>;
    usage: {
        input_tokens: number;
        input_tokens_details: {
            image_tokens: number;
            text_tokens: number;
        };
        output_tokens: number;
        total_tokens: number;
    }
}

function proxyStringToAgentObject(proxyString: string) {
    // console.log(`proxyStringToAgentObject called with ${proxyString}`);
    if (!proxyString) return undefined;
    if (proxyString.startsWith('http://')) {
        return new ProxyAgent(proxyString);
    }
    if (proxyString.startsWith('socks5://')) {
        console.log(`Using SOCKS5 proxy for Azure OpenAI ${proxyString} ${JSON.stringify({
            type: 5,
            host: proxyString.split(':')[1].replace('//', ''),
            port: parseInt(proxyString.split(':')[2]),
        })}`);
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
    resourceConfigs: { baseURL: string; originalBaseURL: string; apiKey: string; apiVersion: string }[] = [];

    constructor(public params: AzureOpenAIConfig[]) {
        this.clients = params.flatMap(param =>
            param.resources.map(resource => {
                const url = new URL(resource.baseURL);
                if (resource.ipAddress) {
                    url.hostname = resource.ipAddress;
                }
                // リソース設定を保存（画像生成用）
                this.resourceConfigs.push({
                    baseURL: url.toString().replace(/\/$/, ''),
                    originalBaseURL: resource.baseURL,
                    apiKey: resource.apiKey,
                    apiVersion: resource.apiVersion || '2025-01-01-preview',
                });
                const obj = new AzureOpenAI({
                    baseURL: url.toString(),
                    apiKey: resource.apiKey,
                    apiVersion: resource.apiVersion || '2025-01-01-preview',
                    fetchOptions: { dispatcher: azureProxyAgent },
                });
                return obj;
            })
        );
    }

    get client(): AzureOpenAI {
        const client = this.clients[this.clients.length - 1];
        this.counter++;
        return client;
    }

    get currentResourceConfig() {
        return this.resourceConfigs[this.resourceConfigs.length - 1];
    }

    /**
     * 画像生成リクエストを実行する
     */
    async generateImage(deploymentName: string, params: ImageGenerationParams): Promise<ImageGenerationResponse> {
        const config = this.currentResourceConfig;
        const url = `${config.baseURL}/deployments/${deploymentName}/images/generations?api-version=2024-02-01`;

        const fetchOptions: RequestInit = {
            method: 'POST',
            headers: {
                'Host': (new URL(config.originalBaseURL)).hostname,
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${config.apiKey}`,
            },
            body: JSON.stringify(params),
        };

        if (azureProxyAgent) {
            (fetchOptions as any).dispatcher = azureProxyAgent;
        }

        // console.dir('--------------------------------');
        // console.dir(params);
        console.dir(url);
        // console.dir(config.originalBaseURL);
        // console.dir(fetchOptions);
        const response = await fetch(url, fetchOptions);
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Image generation failed: ${response.status} ${errorText}`);
        }
        return await response.json() as ImageGenerationResponse;
    }

    /**
     * 画像編集リクエストを実行する
     */
    async editImage(deploymentName: string, params: ImageEditParams): Promise<ImageGenerationResponse> {
        const config = this.currentResourceConfig;
        const url = `${config.baseURL}/deployments/${deploymentName}/images/edits?api-version=2024-02-01`;
        // https://shodigi1-openai-03-eastus2.openai.azure.com/openai/deployments/gpt-image-1.5/images/edits?api-version=2024-02-01
        // https://shodigi1-openai-03-eastus2.openai.azure.com/openai/deployments/gpt-image-1.5/images/edits?api-version=2024-02-01

        // 画像を1024x1024にリサイズ（gpt-image-1の画像編集APIは1024x1024のみ対応）
        // vipsを使用して別プロセスで実行するため、メインスレッドをブロックしない
        let processedImage: Buffer;
        try {
            console.log(`[editImage] Resizing image to 1024x1024...`);
            processedImage = await resizeImageToSquare(params.image, 1024);
            console.log(`[editImage] Image resized to 1024x1024`);
        } catch (resizeError) {
            console.error(`[editImage] Failed to resize image, using original:`, resizeError);
            processedImage = params.image; // リサイズに失敗した場合は元の画像を使用
        }
        console.dir(params);

        const formData = new FormData();
        // BufferをUint8Arrayに変換してBlobに渡す
        formData.append('image', new Blob([new Uint8Array(processedImage)]), 'image.png');
        if (params.mask) {
            formData.append('mask', new Blob([new Uint8Array(params.mask)]), 'mask.png');
        }
        formData.append('prompt', params.prompt);
        if (params.size) formData.append('size', params.size);
        if (params.quality) formData.append('quality', params.quality);
        if (params.output_compression !== undefined) formData.append('output_compression', params.output_compression.toString());
        if (params.output_format) formData.append('output_format', params.output_format);
        if (params.background) formData.append('background', params.background);
        if (params.n !== undefined) formData.append('n', params.n.toString());

        const fetchOptions: RequestInit = {
            method: 'POST',
            headers: {
                'Host': (new URL(config.originalBaseURL)).hostname,
                'Authorization': `Bearer ${config.apiKey}`,
            },
            body: formData,
        };

        if (azureProxyAgent) {
            (fetchOptions as any).dispatcher = azureProxyAgent;
        }

        console.dir('--------------------------------');
        console.dir(params);
        console.dir(formData);
        console.dir(url);
        console.dir(fetchOptions);
        const response = await fetch(url, fetchOptions);
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Image edit failed: ${response.status} ${errorText}`);
        }
        return await response.json() as ImageGenerationResponse;
    }

    /**
     * メッセージからプロンプトと画像を抽出する
     * 画像がある場合、かつ画像より後のテキストがある場合はそれを指示として使用
     * 画像がある場合、かつ画像より後のテキストがない場合はプロンプト全体を指示として使用
     */
    extractImageRequestParams(messages: OpenAI.ChatCompletionMessageParam[]): {
        prompt: string;
        hasImage: boolean;
        imageBuffer?: Buffer;
        postImagePrompt?: string;
    } {
        let promptParts: string[] = [];
        let hasImage = false;
        let imageBuffer: Buffer | undefined;
        let postImageTexts: string[] = [];

        for (const message of messages) {
            if (Array.isArray(message.content)) {
                let foundImageInMessage = false;

                for (const part of message.content) {
                    if (part.type === 'text') {
                        if (foundImageInMessage) {
                            postImageTexts.push(part.text);
                        } else {
                            promptParts.push(part.text);
                        }
                    } else if (part.type === 'image_url' && part.image_url) {
                        foundImageInMessage = true;
                        hasImage = true;
                        // Base64画像を抽出
                        const imageUrl = part.image_url.url;
                        if (imageUrl.startsWith('data:')) {
                            const base64Data = imageUrl.split(',')[1];
                            if (base64Data) {
                                imageBuffer = Buffer.from(base64Data, 'base64');
                            }
                        }
                    }
                }
            } else if (typeof message.content === 'string') {
                if (hasImage) {
                    // 画像が既に見つかっている場合は後続のプロンプトとして追加
                    postImageTexts.push(message.content);
                } else {
                    promptParts.push(message.content);
                }
            }
        }

        const fullPrompt = promptParts.join('\n').trim();
        const postImagePrompt = postImageTexts.join('\n').trim();

        return {
            prompt: fullPrompt,
            hasImage,
            imageBuffer,
            // 画像より後のテキストがある場合はそれを使用、なければプロンプト全体を使用
            postImagePrompt: postImagePrompt || (hasImage ? fullPrompt : undefined),
        };
    }

    /**
     * 画像生成/編集リクエストを実行する
     */
    async executeImageGeneration(ctx: ExecutorContext, args: OpenAI.ChatCompletionCreateParams): Promise<void> {
        const { idempotencyKey, logObject, observer, attempts, aiModel, aiPrice, tokenCount } = ctx as {
            idempotencyKey: string,
            logObject: any,
            observer: any,
            attempts: number,
            aiModel: AIModelEntity,
            aiPrice: AIModelPricingEntity,
            tokenCount: TokenCount,
        };

        // デプロイメント名を取得（モデル名をそのまま使用）
        const deploymentName = args.model;

        // メッセージからプロンプトと画像を抽出
        const extractedParams = this.extractImageRequestParams(args.messages);

        // 画像生成パラメータを設定
        const imageParams: ImageGenerationParams = {
            prompt: extractedParams.prompt,
            size: '1024x1024',
            quality: 'high',
            output_compression: 100,
            output_format: 'png',
            n: 1,
        };

        // 画像編集リクエスト
        const editParams: ImageEditParams = {
            image: extractedParams.imageBuffer!,
            prompt: extractedParams.postImagePrompt || 'Edit this image',
            size: '1024x1024',
            quality: 'high',
            output_compression: 100,
            output_format: 'png',
            n: 1,
        };

        // リクエストをログに保存
        fss.writeFile(`${HISTORY_DIRE}/${idempotencyKey}-${attempts}.request.json`,
            JSON.stringify(extractedParams.hasImage ? editParams : imageParams, Utils.genJsonSafer()),
            {}, (err) => { }
        );

        // console.log(logObject.output('start', extractedParams.hasImage ? 'Image Edit' : 'Image Generation'));

        try {
            let response: ImageGenerationResponse;

            if (extractedParams.hasImage && extractedParams.imageBuffer) {
                response = await this.editImage(deploymentName, editParams);
            } else {
                // 新規画像生成リクエスト
                response = await this.generateImage(deploymentName, imageParams);
            }

            // レスポンスをログに保存
            fss.writeFile(
                `${HISTORY_DIRE}/${idempotencyKey}-${attempts}.response.json`,
                JSON.stringify({ response }, Utils.genJsonSafer()),
                {},
                (err) => { }
            );

            for (const imageData of response.data) {
                // 生成された画像をBase64形式でレスポンスに含める

                let resultContent = '';
                let mimeType = 'image/png'; // デフォルトはPNG

                if (imageData.b64_json) {
                    // Base64画像データをデータURI形式で出力
                    resultContent = `data:${mimeType};base64,${imageData.b64_json}`;
                } else if (imageData.url) {
                    resultContent = imageData.url;
                }

                // 結果をファイルに保存（バイナリデータは保存しない、revised_promptのみ）
                const resultLog = {
                    revised_prompt: imageData.revised_prompt,
                    hasImage: !!imageData.b64_json || !!imageData.url,
                };
                fss.writeFile(`${HISTORY_DIRE}/${idempotencyKey}-${attempts}.result.json`, JSON.stringify(resultLog), {}, () => { });

                // トークンカウント（画像生成では実際のトークン使用量は異なる場合がある）
                tokenCount.tokenBuilder = imageData.revised_prompt || '';

                // ChatCompletionChunk形式でレスポンスを返す（VertexAIと同じ形式）
                const chunkResponse: OpenAI.ChatCompletionChunk = {
                    id: `img-${idempotencyKey}`,
                    choices: [{
                        finish_reason: null,
                        index: 0,
                        logprobs: null,
                        delta: {
                            role: 'assistant',
                            content: resultContent,
                        },
                    }],
                    created: response.created,
                    model: args.model,
                    object: 'chat.completion.chunk',
                };

                // mimeTypeを追加（VertexAIと同じ形式）
                (chunkResponse.choices[0].delta as any).mimeType = mimeType;

                // revised_promptがあれば追加
                if (imageData.revised_prompt) {
                    (chunkResponse.choices[0].delta as any).revised_prompt = imageData.revised_prompt;
                }

                observer.next(chunkResponse);
            }
            // トークン数を適用
            tokenCount.prompt_tokens = response.usage.input_tokens || 0;
            tokenCount.completion_tokens = response.usage.output_tokens || 0;
            tokenCount.cost = calcCost(tokenCount, aiModel, aiPrice, {
                prompt_tokens: response.usage.input_tokens,
                completion_tokens: response.usage.output_tokens,
                total_tokens: response.usage.total_tokens,
            });

            // tokenCount.cost = tokenCount.calcCost();
            console.log(logObject.output('fine', JSON.stringify(response.usage)));

            observer.complete();

        } catch (error: any) {
            // エラーをログに保存
            fss.writeFile(
                `${HISTORY_DIRE}/${idempotencyKey}-${attempts}.error.json`,
                JSON.stringify({ error: error.message || error }, Utils.genJsonSafer()),
                {},
                (err) => { }
            );

            console.error(logObject.output('error', error.message || 'Image generation failed'));
            throw error;
        }
    }

    async executor(ctx: ExecutorContext): Promise<void> {

        const { idempotencyKey, ratelimitObj, logObject, observer, attempts, aiModel, aiPrice, tokenCount } = ctx as {
            idempotencyKey: string,
            ratelimitObj: { remainingRequests?: number; remainingTokens?: number; },
            logObject: any,
            observer: any,
            attempts: number,
            aiModel: AIModelEntity,
            aiPrice: AIModelPricingEntity,
            tokenCount: TokenCount,
        };
        const args = { ...ctx.commonArgs } as OpenAI.ChatCompletionCreateParams;
        const options = ctx.options as RequestOptions || undefined;
        args.max_completion_tokens = args.max_completion_tokens || args.max_tokens || undefined;
        delete args.max_tokens;

        // let runPromise: Promise<APIPromise<ChatCompletion>> | Promise<APIPromise<Stream<OpenAI.ChatCompletionChunk>>>;
        let runPromise: Promise<void>;
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
        if (args.model.startsWith('gpt-5')) {
            args.temperature = 1;
        }

        // 画像生成モデルの処理 (gpt-image-*)
        if (args.model.startsWith('gpt-image')) {
            return this.executeImageGeneration(ctx, args);
        }

        const client = this.client;

        // console.dir(client, { depth: null });
        // console.dir(client.fetchOptions);

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

        const usageMetadata: OpenAI.Completions.CompletionUsage = {} as OpenAI.Completions.CompletionUsage;
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
                    if (body.usage) {
                        applyUsage(body.usage);
                        tokenCount.prompt_tokens = body.usage.prompt_tokens || 0;
                        tokenCount.completion_tokens = body.usage.completion_tokens || 0;
                        tokenCount.cost = calcCost(tokenCount, aiModel, aiPrice, body.usage);
                    } else { }

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
                                tokenCount.prompt_tokens = usageMetadata.prompt_tokens || 0;
                                tokenCount.completion_tokens = usageMetadata.completion_tokens || 0;
                                tokenCount.cost = calcCost(tokenCount, aiModel, aiPrice, usageMetadata);
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


export function calcCost(tokenCount: TokenCount, aiModel: AIModelEntity, aiPrice: AIModelPricingEntity, usage: OpenAI.Completions.CompletionUsage): number {
    tokenCount.cost = 0;
    usage.prompt_tokens = usage.prompt_tokens || 0;
    usage.completion_tokens = usage.completion_tokens || 0;
    if (aiPrice) {
        if (usage.prompt_tokens_details && usage.prompt_tokens_details.cached_tokens && usage.prompt_tokens_details.cached_tokens > 0 && aiPrice.metadata && aiPrice.metadata.cached_tokens > 0) {
            // キャッシュトークンがある場合の計算
            const billedPromptTokens = usage.prompt_tokens - usage.prompt_tokens_details.cached_tokens;
            tokenCount.cost += usage.prompt_tokens_details.cached_tokens * (aiPrice.metadata.cached_tokens || 0) / 1_000_000;
            tokenCount.cost += billedPromptTokens * (aiPrice.inputPricePerUnit || 0) / 1_000_000;
            tokenCount.cost += usage.completion_tokens * (aiPrice.outputPricePerUnit || 0) / 1_000_000;
        } else {
            tokenCount.cost += usage.prompt_tokens * (aiPrice.inputPricePerUnit || 0) / 1_000_000;
            tokenCount.cost += usage.completion_tokens * (aiPrice.outputPricePerUnit || 0) / 1_000_000;
        }
    }
    return tokenCount.cost;
}

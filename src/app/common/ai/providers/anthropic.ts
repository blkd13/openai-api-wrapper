import { Anthropic } from '@anthropic-ai/sdk';
import { AnthropicVertex } from '@anthropic-ai/vertex-sdk/client.js';
import { OpenAI } from 'openai/client.js';
import { ProxyAgent } from 'undici/index.js';
import { TextDecoder } from 'util';
import { AIModelPricingEntity, AnthropicVertexAIConfig, OpenAIConfig } from '../../../service/entity/ai-model-manager.entity.js';
import fss from '../../fss.js';
import { AIClient, HISTORY_DIRE } from '../../openai-api-wrapper.js';
import { Utils } from '../../utils.js';
import { getUndiciHttpProxy } from '../network.js';
import { ExecutorContext } from '../types.js';
import { convertAnthropicToOpenAI, remapAnthropic } from './anthropic-utils.js';

export abstract class MyAnthropicBase<T extends Anthropic | AnthropicVertex> implements AIClient {
    counter = 0;
    clients!: T[];

    get client(): T {
        const client = this.clients[this.counter % this.clients.length];
        this.counter++;
        return client;
    }

    executor(ctx: ExecutorContext): Promise<void> {
        const decoder = new TextDecoder();
        const args = remapAnthropic(ctx.commonArgs);
        // anthropicの場合はmax_tokensは必須項目
        args.max_tokens = args.max_tokens === 0 ? ctx.ratelimitObj.maxTokens : args.max_tokens;
        args.max_tokens = args.max_tokens === 409600000 ? 32000 : args.max_tokens;
        const runPromise = new Promise<void>(async (resolve, reject) => {
            try {
                // リクエストをファイルに書き出す
                //  beta: client.beta, betaはcredentialsを含むのでログに出しちゃダメ！
                const client = this.client;

                // logging用にcredentialを含まないオブジェクトを作成
                const optionsForLog = { ...ctx.options, baseURL: client.baseURL, maxRetries: client.maxRetries, projectId: (client as any).projectId };
                delete (optionsForLog as any).httpAgent; // credentialが流出しないように消しておく
                fss.writeFile(`${HISTORY_DIRE}/${ctx.idempotencyKey}-${ctx.attempts}.request.json`, JSON.stringify({ args, options: optionsForLog }, Utils.genJsonSafer()), {}, (err) => { });

                const response = args.model.includes('-thinking')
                    ? client.beta.messages.stream({ ...args, 'betas': 'output-128k-2025-02-19' } as Anthropic.MessageStreamParams).toReadableStream()
                    : client.messages.stream(args as Anthropic.MessageStreamParams).toReadableStream();
                // console.dir(response);
                // console.log('res');
                // ratelimitObj.limitRequests = 5; // 適当に5にしておく。
                // ratelimitObj.limitTokens = azureDeployTpmMap[args.model];
                // ratelimitObj.resetRequests = new Date().toISOString();
                // ratelimitObj.remainingRequests = 50; // ヘッダーが取得できないときはシングルスレッドで動かす
                // ratelimitObj.remainingTokens = 100000; // トークン数は適当

                fss.writeFile(`${HISTORY_DIRE}/${ctx.idempotencyKey}-${ctx.attempts}.response.json`, JSON.stringify({ args, options: optionsForLog, response }, Utils.genJsonSafer()), {}, (err) => { });

                // ストリームからデータを読み取るためのリーダーを取得
                const reader = response.getReader();

                let tokenBuilder: string = '';
                // const usageList = [] as Anthropic.Usage[];
                const usage: Anthropic.Usage = { input_tokens: 0, output_tokens: 0, cache_creation: null, cache_creation_input_tokens: null, cache_read_input_tokens: null, server_tool_use: null, service_tier: null };

                const baseMessage = { id: '', role: 'assistant', created: 0, model: '' } as { id: string, role: 'system' | 'user' | 'assistant' | 'tool', created: number, model: string };

                let index = 0;
                // const toolCallUUID = Utils.generateUUID(); // ツールコールのUUIDを一つに統一するためとりあえず生成しておく
                // ストリームからデータを読み取る非同期関数
                async function readStream() {
                    while (true) {
                        try {
                            const { value, done } = await reader.read();
                            if (done) {
                                // console.log('Stream complete');
                                // console.log('Final usage:', JSON.stringify(usage));
                                // console.log('Total output tokens:', usage.output_tokens);
                                // console.dir(ctx.aiPrice);
                                ctx.tokenCount.prompt_tokens = (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0);
                                ctx.tokenCount.completion_tokens = usage.output_tokens || 0;
                                if (ctx.aiPrice) {
                                    const cost = calcCost(usage, ctx.aiPrice);
                                    ctx.tokenCount.cost = cost.cost;
                                    // console.log(`Total cost calculated from usageList: $${cost.toFixed(6)}`);
                                }

                                ctx.logObject && ctx.logObject.output && console.log(ctx.logObject.output('fine', '', JSON.stringify(usage)));
                                ctx.observer.complete();

                                resolve();
                                // ファイルに書き出す
                                const trg = ctx.commonArgs.response_format?.type === 'json_object' ? 'json' : 'md';
                                fss.writeFile(`${HISTORY_DIRE}/${ctx.idempotencyKey}-${ctx.attempts}.result.${trg}`, tokenBuilder || '', {}, () => { });
                                break;
                            }
                            const content = decoder.decode(value);
                            // console.log(content);

                            // 中身がない場合はスキップ
                            if (!content) { continue; }

                            // ファイルに書き出す
                            fss.appendFile(`${HISTORY_DIRE}/${ctx.idempotencyKey}-${ctx.attempts}.txt`, content || '', {}, () => { });
                            const obj: Anthropic.MessageStreamEvent = JSON.parse(content);

                            function remapAnthropic(obj: Anthropic.MessageStreamEvent): OpenAI.ChatCompletionChunk[] {
                                const data = obj as any
                                const _usage: Anthropic.Usage = data.usage ? data.usage : (data.message && data.message.usage ? data.message.usage : null);
                                if (_usage) {
                                    console.log('usage:', JSON.stringify(_usage));
                                    // usageList.push(_usage);
                                    if (usage.input_tokens === 0) {
                                        // 初回のusage情報。input系が出そろう
                                        Object.assign(usage, _usage);
                                    } else {
                                        // 終了時のusage情報を収集。ouputだけなのでそれを足すだけ
                                        usage.output_tokens = (usage.output_tokens || 0) + (_usage.output_tokens || 0);
                                        if (Object.keys(_usage).length > 1) {
                                            // ありえないと思うけど。。
                                            console.warn('想定外のケース：複数のusage情報をマージします:', JSON.stringify(_usage));
                                            if (_usage.input_tokens) {
                                                usage.input_tokens = (usage.input_tokens || 0) + _usage.input_tokens;
                                            }
                                            if (_usage.cache_creation_input_tokens) {
                                                usage.cache_creation_input_tokens = (usage.cache_creation_input_tokens || 0) + _usage.cache_creation_input_tokens;
                                            }
                                            if (_usage.cache_read_input_tokens) {
                                                usage.cache_read_input_tokens = (usage.cache_read_input_tokens || 0) + _usage.cache_read_input_tokens;
                                            }
                                            if (_usage.server_tool_use) {
                                                if (!usage.server_tool_use) {
                                                    usage.server_tool_use = { web_search_requests: 0 };
                                                }
                                                if (_usage.server_tool_use.web_search_requests) {
                                                    usage.server_tool_use.web_search_requests = (usage.server_tool_use.web_search_requests || 0) + _usage.server_tool_use.web_search_requests;
                                                }
                                            }
                                        } else { }
                                    }
                                } else { }

                                if (obj.type === 'message_start') {
                                    baseMessage.id = obj.message.id;
                                    baseMessage.role = obj.message.role;
                                } else if (obj.type === 'content_block_start') {
                                    index = obj.index;
                                    const choice: OpenAI.ChatCompletionChunk.Choice = {
                                        index: obj.index,
                                        delta: { role: baseMessage.role, content: null, refusal: null },
                                        logprobs: null,
                                        finish_reason: null,
                                    };
                                    const chunk: OpenAI.ChatCompletionChunk = {
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
                                    const choice: OpenAI.ChatCompletionChunk.Choice = {
                                        index: obj.index,
                                        delta: { content: null, refusal: null },
                                        logprobs: null,
                                        finish_reason: null,
                                    };
                                    const chunk: OpenAI.ChatCompletionChunk = {
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
                                    } else if (obj.delta.type === 'input_json_delta') {
                                        const toolCall: OpenAI.ChatCompletionChunk.Choice.Delta.ToolCall = {
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
                                    // const choice:OpenAI.ChatCompletionChunk.Choice = {
                                    //     index: index,
                                    //     delta: { content: null, refusal: null },
                                    //     logprobs: null,
                                    //     finish_reason: 'stop',
                                    // };
                                    // const chunk:OpenAI.ChatCompletionChunk = {
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
                                    const choice: OpenAI.ChatCompletionChunk.Choice = {
                                        index: index,
                                        delta: { content: null, refusal: null },
                                        logprobs: null,
                                        finish_reason: null,
                                    };
                                    const chunk: OpenAI.ChatCompletionChunk = {
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
                                    const chunk: OpenAI.ChatCompletionChunk = {
                                        id: baseMessage.id,
                                        object: 'chat.completion.chunk',
                                        created: baseMessage.created,
                                        model: baseMessage.model,
                                        service_tier: 'default',
                                        system_fingerprint: '',
                                        choices: [],
                                        usage: convertAnthropicToOpenAI(usage as any),
                                    };
                                    return [chunk];
                                } else {
                                    // 何もしない
                                }

                                // return res;
                                return [];
                            }
                            remapAnthropic(obj).forEach(chunk => {
                                ctx.observer.next(chunk);
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

        return runPromise;
    }
}

export class MyAnthropic extends MyAnthropicBase<Anthropic> {
    constructor(public params: OpenAIConfig[]) {
        super();
        this.clients = params.flatMap(param => param.endpoints.map(endpoint => {
            const baseURL = endpoint.baseURL || 'https://api.anthropic.com';
            const httpAgent = getUndiciHttpProxy(baseURL);
            return new Anthropic({ apiKey: endpoint.apiKey, baseURL, maxRetries: 3, fetchOptions: { dispatcher: httpAgent } });
        }));
    }
}


const { GCP_API_BASE_PATH } = process.env as { GCP_API_BASE_PATH?: string };
export class MyAnthropicVertex extends MyAnthropicBase<AnthropicVertex> {
    constructor(public params: AnthropicVertexAIConfig[]) {
        super();
        this.clients = params.flatMap(param => param.regionList.map(region => {
            const baseDomain = param.baseURL || GCP_API_BASE_PATH || 'aiplatform.googleapis.com';
            const baseURL = region === 'global' ? `https://${baseDomain}/v1` : `https://${region}-${baseDomain}/v1`;
            const httpAgent = getUndiciHttpProxy(baseURL);
            const option = {
                baseURL,
                projectId: param.projectId,
                region,
            } as { baseURL: string; projectId: string; region: string, fetchOptions?: { dispatcher: ProxyAgent } };
            if (httpAgent) {
                option.fetchOptions = { dispatcher: httpAgent };
            } else { }
            return new AnthropicVertex(option);
        }));
    }
}



export function calcCost(usage: Anthropic.Usage, aiPrice: AIModelPricingEntity): { prompt_tokens: number; completion_tokens: number; cost: number } {
    let usageCost = 0;
    const unit = aiPrice.unit === 'USD/1M tokens' ? 1_000_000 : 1_000;

    // 入力トークン
    usageCost += (usage.input_tokens || 0) * aiPrice.inputPricePerUnit / unit;
    // 出力トークン
    usageCost += (usage.output_tokens || 0) * aiPrice.outputPricePerUnit / unit;

    // キャッシュ作成トークン
    if (usage.cache_creation_input_tokens && aiPrice.metadata?.cache_creation_input_tokens > 0) {
        usageCost += usage.cache_creation_input_tokens * aiPrice.metadata?.cache_creation_input_tokens / unit;
    }
    // キャッシュ読み取りトークン
    if (usage.cache_read_input_tokens && aiPrice.metadata && aiPrice.metadata.cache_read_input_tokens > 0) {
        usageCost += usage.cache_read_input_tokens * aiPrice.metadata.cache_read_input_tokens / unit;
    }
    // 1時間キャッシュ保持トークン
    if (usage.cache_creation?.ephemeral_1h_input_tokens && aiPrice.metadata && aiPrice.metadata.cache_creation?.ephemeral_1h_input_tokens > 0) {
        usageCost += usage.cache_creation.ephemeral_1h_input_tokens * aiPrice.metadata.cache_creation.ephemeral_1h_input_tokens / unit;
    }
    // 5分間キャッシュ保持トークン
    if (usage.cache_creation?.ephemeral_5m_input_tokens && aiPrice.metadata && aiPrice.metadata.cache_creation?.ephemeral_5m_input_tokens > 0) {
        usageCost += usage.cache_creation.ephemeral_5m_input_tokens * aiPrice.metadata.cache_creation.ephemeral_5m_input_tokens / unit;
    }
    // Web検索リクエスト
    if (usage.server_tool_use?.web_search_requests && aiPrice.metadata && aiPrice.metadata.server_tool_use?.web_search_requests > 0) {
        usageCost += usage.server_tool_use.web_search_requests * aiPrice.metadata.server_tool_use.web_search_requests / unit;
    }
    return {
        prompt_tokens: (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0),
        completion_tokens: usage.output_tokens || 0,
        cost: usageCost,
    };
}


import { Cohere, CohereClientV2, CohereEnvironment } from 'cohere-ai';

import { V2ChatStreamRequest } from 'cohere-ai/api/index.js';
import { V2 } from 'cohere-ai/api/resources/v2/client/Client.js';
import { OpenAI } from 'openai/index.js';
import { CohereConfig } from '../../../service/entity/ai-model-manager.entity.js';
import fss from '../../fss.js';
import { HISTORY_DIRE } from '../../openai-api-wrapper.js';
import { Utils } from '../../utils.js';
import { ExecutorContext } from '../types.js';

export class MyCohere {
    counter = 0;
    clients: CohereClientV2[];

    constructor(public params: CohereConfig[]) {
        this.clients = params.flatMap(param =>
            param.endpoints.map(endpoint => new CohereClientV2({
                token: endpoint.token,
                environment: endpoint.environment || CohereEnvironment.Production,
            }))
        );
    }

    get client(): CohereClientV2 {
        const client = this.clients[this.counter % this.clients.length];
        this.counter++;
        return client;
    }

    async executor(
        ctx: ExecutorContext,
    ): Promise<void> {
        const { idempotencyKey, ratelimitObj, logObject, observer, attempts } = ctx;
        // 元のargsを破壊してしまうとろくなことにならないので、JSON.stringifyしてからparseしている。
        const args = ctx.commonArgs as V2ChatStreamRequest;
        const options = ctx.options || {};
        const _args = args as OpenAI.ChatCompletionCreateParams;

        const usageMetadata: { [key: string]: any } = {};

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
        const runPromise = this.client.chatStream(args as V2ChatStreamRequest, options as V2.RequestOptions).then(async (response) => {

            // ヘッダー情報を取得
            const headers: { [key: string]: string } = {};
            ((response as any).headers as Headers).forEach((value, key) => headers[key] = value);

            // // レート制限情報の取得
            // headers['x-endpoint-monthly-call-limit'] && (ratelimitObj.limitRequests = Number(headers['x-endpoint-monthly-call-limit']));
            // headers['x-trial-endpoint-call-limit'] && (ratelimitObj.limitTokens = Number(headers['x-trial-endpoint-call-limit']));
            // headers['x-trial-endpoint-call-remaining'] && (ratelimitObj.remainingRequests = Number(headers['x-trial-endpoint-call-remaining']));

            fss.writeFile(`${HISTORY_DIRE}/${idempotencyKey}-${attempts}.response.json`, JSON.stringify({ args, options, response: { headers } }, Utils.genJsonSafer()), {}, (err) => { });

            let tokenBuilder: string = '';
            const baseMessage = { id: '', role: 'assistant', created: 0, model: '' } as { id: string, role: 'system' | 'user' | 'assistant' | 'tool', created: number, model: string };
            let index = 0;
            let toolCallsMap: Map<number, any> = new Map();

            // StreamedChatResponseV2
            function remapCohere(obj: any): OpenAI.ChatCompletionChunk[] {
                if (obj.type === 'message-start') {
                    baseMessage.id = obj.id || '';
                    baseMessage.role = 'assistant';
                    baseMessage.created = Math.floor(Date.now() / 1000);
                    baseMessage.model = args.model || '';

                    const choice: OpenAI.ChatCompletionChunk.Choice = {
                        index: 0,
                        delta: { role: 'assistant', content: '', refusal: null },
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

                    return [chunk];
                } else if (obj.type === 'content-delta') {
                    const text = obj.delta?.message?.content?.text || '';
                    tokenBuilder += text;
                    const choice: OpenAI.ChatCompletionChunk.Choice = {
                        index: 0,
                        delta: { content: text, refusal: null },
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
                    return [chunk];
                } else if (obj.type === 'tool-plan-delta') {
                    // ツール計画のデルタは通常のメッセージと同じように扱う
                    const text = obj.delta?.message?.toolPlan || '';
                    tokenBuilder += text;
                    const choice: OpenAI.ChatCompletionChunk.Choice = {
                        index: 0,
                        delta: { content: text, refusal: null },
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

                    const choice: OpenAI.ChatCompletionChunk.Choice = {
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

                    const chunk: OpenAI.ChatCompletionChunk = {
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

                    const choice: OpenAI.ChatCompletionChunk.Choice = {
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

                    const chunk: OpenAI.ChatCompletionChunk = {
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
                        // tokenCount.prompt_tokens = obj.delta.usage.tokens.inputTokens || 0;
                        // tokenCount.completion_tokens = obj.delta.usage.tokens.outputTokens || 0;

                        const tokenUsage = {
                            prompt_tokens: obj.delta.usage.tokens.inputTokens || 0,
                            completion_tokens: obj.delta.usage.tokens.outputTokens || 0,
                            total_tokens: (obj.delta.usage.tokens.inputTokens || 0) + (obj.delta.usage.tokens.outputTokens || 0)
                        };

                        Object.assign(usageMetadata, tokenUsage);
                    }

                    const choice: OpenAI.ChatCompletionChunk.Choice = {
                        index: 0,
                        delta: { content: null, refusal: null },
                        logprobs: null,
                        finish_reason: finishReason,
                    };

                    const chunk: OpenAI.ChatCompletionChunk = {
                        id: baseMessage.id,
                        object: 'chat.completion.chunk',
                        created: baseMessage.created,
                        model: baseMessage.model,
                        service_tier: 'default',
                        system_fingerprint: '',
                        choices: [choice],
                        // usage: {
                        //     prompt_tokens: tokenCount.prompt_tokens,
                        //     completion_tokens: tokenCount.completion_tokens,
                        //     total_tokens: tokenCount.prompt_tokens + tokenCount.completion_tokens
                        // },
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

            // // ストリームが終了したらループを抜ける
            // tokenCount.cost = tokenCount.calcCost();
            console.log(logObject.output('fine', '', JSON.stringify(usageMetadata)));
            observer.complete();

            // ファイルに書き出す
            const trg = args.responseFormat?.type === 'json_object' ? 'json' : 'md';
            fss.writeFile(`${HISTORY_DIRE}/${idempotencyKey}-${attempts}.result.${trg}`, tokenBuilder || '', {}, () => { });
            // _that.openApiWrapper.fire();
        });
        return runPromise;
    }
}

import * as googleGenerativeAI from '@google/generative-ai';

import { OpenAI } from 'openai/client.js';
import { OpenAIConfig } from '../../../service/entity/ai-model-manager.entity.js';
import fss from '../../fss.js';
import { HISTORY_DIRE } from '../../openai-api-wrapper.js';
import { Utils } from '../../utils.js';
import { ExecutorContext } from '../types.js';
import { GenerateContentRequestExtended, mapForGemini, mapForGeminiExtend } from './vertexai.js';

export class MyGemini {
    counter = 0;
    clients: googleGenerativeAI.GoogleGenerativeAI[] = [];

    constructor(public params: OpenAIConfig[]) {
        this.clients = params.flatMap(param =>
            param.endpoints.map(endpoint => new googleGenerativeAI.GoogleGenerativeAI(endpoint.apiKey))
        );
    }

    get client(): googleGenerativeAI.GoogleGenerativeAI {
        const client = this.clients[this.counter % this.clients.length];
        this.counter++;
        return client;
    }

    async executor(
        ctx: ExecutorContext,
    ): Promise<void> {
        // console.log(generativeModel);
        ctx.commonArgs.messages[0].content = ctx.commonArgs.messages[0].content || '';
        // argsをGemini用に変換
        // TODO anyを外す
        const req: GenerateContentRequestExtended = mapForGeminiExtend(ctx.commonArgs, this as any, mapForGemini(ctx.commonArgs));

        // req は 不要な項目もまとめて保持しているので、実際のリクエスト用にスッキリさせる。
        // TODO anyを外す
        const args: googleGenerativeAI.GenerateContentRequest = { contents: req.contents, tools: req.tools as any || [], systemInstruction: req.systemInstruction };
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
            safetySettings: req.safetySettings as any,
            toolConfig: req.toolConfig as any,
            tools: req.tools as any,
        };

        fss.writeFile(`${HISTORY_DIRE}/${ctx.idempotencyKey}-${ctx.attempts}.request.json`, JSON.stringify({ model: ctx.commonArgs.model, req: reqGemini }, Utils.genJsonSafer()), {}, (err) => { });

        let isOver128 = false;
        // export declare interface ModelParams extends BaseParams {
        //     model: string;
        //     tools?: Tool[];
        //     toolConfig?: ToolConfig;
        //     systemInstruction?: string | Part | Content;
        //     cachedContent?: CachedContent;
        // }

        const usageMetadata: Partial<googleGenerativeAI.UsageMetadata> = {};
        const runPromise = this.client.getGenerativeModel({ model: ctx.commonArgs.model }).generateContentStream(reqGemini).then(async streamingResp => {
            // かつてはModelを使って投げていた。
            // runPromise = vertex_ai.preview.getGenerativeModel({ model: args.model, generationConfig: req.generationConfig, safetySettings: req.safetySettings }).generateContentStream(_req);

            let tokenBuilder: string = '';

            const _that = this;

            // tokenCount.prompt_tokens = promptChars;
            // tokenCount.completion_tokens = 0;
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
                        // tokenCount.cost = tokenCount.calcCost() * (isOver128 ? 2 : 1);
                        console.log(ctx.logObject.output('fine', '', JSON.stringify(usageMetadata)));
                        ctx.observer.complete();

                        // _that.openApiWrapper.fire();

                        // ファイルに書き出す
                        const trg = ctx.commonArgs.response_format?.type === 'json_object' ? 'json' : 'md';
                        fss.writeFile(`${HISTORY_DIRE}/${ctx.idempotencyKey}-${ctx.attempts}.result.${trg}`, tokenBuilder || '', {}, () => { });
                        break;
                    }

                    // 中身を取り出す
                    const content = value;
                    // console.dir(content, { depth: null });

                    // ファイルに書き出す
                    fss.appendFile(`${HISTORY_DIRE}/${ctx.idempotencyKey}-${ctx.attempts}.txt`, (JSON.stringify(content) || '') + '\n', {}, () => { });

                    // 中身がない場合はスキップ
                    if (!content) { continue; }

                    // 
                    if (content.usageMetadata) {
                        // 128k超えてるかどうか判定。
                        if (content.usageMetadata.totalTokenCount) {
                            isOver128 = content.usageMetadata.totalTokenCount > 128000;
                        } else { }
                        Object.assign(usageMetadata, content.usageMetadata);
                        if (ctx.commonArgs.model.startsWith('gemini-2')) {
                            // // gemini-2系からはトークンベースの課金になるので、トークン数を使う。
                            // tokenCount.prompt_tokens = content.usageMetadata.promptTokenCount || tokenCount.prompt_tokens;
                            // tokenCount.completion_tokens = content.usageMetadata.candidatesTokenCount || 0;
                        } else {
                            // それ以外は文字数ベースの課金なのでトークン数は使わない。
                            // tokenCount.prompt_tokens = content.usageMetadata.promptTokenCount || tokenCount.prompt_tokens;
                            // tokenCount.completion_tokens = content.usageMetadata.candidatesTokenCount || 0;
                        }

                        // vertexaiの場合はレスポンスヘッダーが取れない。その代わりストリームの最後にメタデータが飛んでくるのでそれを捕まえる。
                        fss.writeFile(`${HISTORY_DIRE}/${ctx.idempotencyKey}-${ctx.attempts}.response.json`, JSON.stringify({ model: ctx.commonArgs.model, req: reqGemini, response: content }, Utils.genJsonSafer()), {}, (err) => { });
                    } else { }

                    if (content.promptFeedback && content.promptFeedback.blockReason) {
                        // finishReasonが指定されている、かつSTOPではない場合はエラー終了させる。
                        // ストリームが終了したらループを抜ける
                        // tokenCount.cost = tokenCount.calcCost() * (isOver128 ? 2 : 1);
                        throw JSON.stringify({ promptFeedback: content.promptFeedback });
                    } else { }

                    // 中身がない場合はスキップ
                    if (!content.candidates) { continue; }

                    if (content.candidates[0] && content.candidates[0].safetyRatings) {
                        safetyRatings = content.candidates[0] && content.candidates[0].safetyRatings;
                    } else { }


                    function responseRemap(content: googleGenerativeAI.EnhancedGenerateContentResponse): OpenAI.ChatCompletionChunk[] {
                        const remaped: OpenAI.ChatCompletionChunk[] = [];
                        if (content.candidates) {
                            content.candidates.forEach(candidate => {

                                // partsをイテレートする前に、現在のタイプをチェック
                                (candidate.content.parts || []).forEach((c, index) => {
                                    const currentType = c.text ? 'text' : c.functionCall ? 'function' : null;

                                    // 通常のチャンクを作成
                                    const choice: OpenAI.ChatCompletionChunk.Choice = {
                                        delta: {} as OpenAI.ChatCompletionChunk.Choice.Delta,
                                        finish_reason: (candidate.finishReason?.toLocaleLowerCase() || null) as any,
                                        index: candidate.index,
                                        logprobs: null,
                                    };

                                    if (c.text) {
                                        choice.delta = { content: c.text };
                                    } else if (c.functionCall) {
                                        const func: OpenAI.ChatCompletionChunk.Choice.Delta.ToolCall = {
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
                                        if (Object.keys(candidate.groundingMetadata).length > 0) {
                                            (choice as any).groundingMetadata = candidate.groundingMetadata;
                                        } else {
                                            delete (choice as any).groundingMetadata;
                                        }
                                    } else { }

                                    remaped.push({
                                        id: (content as any).responseId,
                                        choices: [choice],
                                        created: 0,
                                        model: (content as any).modelVersion || ctx.commonArgs.model,
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
                        ctx.observer.next(chunk);
                    });

                    if (content.candidates[0] && content.candidates[0].content && content.candidates[0].content.parts && content.candidates[0].content.parts[0]) {
                        if (content.candidates[0].content.parts[0].text) {
                            const text = content.candidates[0].content.parts[0].text || '';
                            tokenBuilder += text;
                            // tokenCount.tokenBuilder = tokenBuilder;
                            // tokenCount.completion_tokens += text.replace(/\s/g, '').length; // 空白文字を除いた文字数
                        } else {
                            // 何もしない
                        }
                    } else { }
                    // [1]   candidates: [ { finishReason: 'OTHER', index: 0, content: [Object] } ],
                    if (content.candidates[0] && content.candidates[0].finishReason && !['STOP', 'MAX_TOKENS'].includes(content.candidates[0].finishReason)) {
                        // finishReasonが指定されている、かつSTOPではない場合はエラー終了させる。
                        // ストリームが終了したらループを抜ける
                        // tokenCount.cost = tokenCount.calcCost() * (isOver128 ? 2 : 1);
                        throw JSON.stringify({ safetyRatings, candidate: content.candidates[0] });
                    } else { }
                    // candidates: [ { finishReason: 'OTHER', index: 0, content: [Object] } ],
                }
                return;
            }
            // ストリームの読み取りを開始
            return await readStream();

        });
        return runPromise;
    }
}

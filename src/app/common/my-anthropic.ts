// 各形式のインターフェース定義
// import { AnthropicVertex } from '@anthropic-ai/vertex-sdk';
import { MessageCreateParams, MessageStreamParams, ContentBlockParam, DocumentBlockParam, ImageBlockParam, MessageParam, TextBlockParam, Tool, ToolChoice, Usage, ThinkingBlockParam, ThinkingConfigParam, } from '@anthropic-ai/sdk/resources';
import { ChatCompletionAssistantMessageParam, ChatCompletionContentPart, ChatCompletionContentPartText, ChatCompletionMessageParam, ChatCompletionSystemMessageParam, ChatCompletionTool, ChatCompletionToolMessageParam, ChatCompletionUserMessageParam, CompletionUsage } from "openai/resources";
import { ChatCompletionCreateParamsBase } from "openai/resources/chat/completions";

// Anthropic 形式から OpenAI 形式へ変換する関数
export function convertAnthropicToOpenAI(anthropic: Usage): CompletionUsage {
    // ここでは input_tokens を prompt_tokens、output_tokens を completion_tokens として扱う例です。
    const prompt_tokens = anthropic.input_tokens;
    const completion_tokens = anthropic.output_tokens;
    const total_tokens = prompt_tokens + completion_tokens;

    // prompt_tokens_details にはここでは cache_read_input_tokens を cached_tokens に流用し、audio_tokens は 0 としています
    const prompt_tokens_details: CompletionUsage.PromptTokensDetails = {
        cached_tokens: anthropic.cache_read_input_tokens === null ? undefined : anthropic.cache_read_input_tokens,
        audio_tokens: 0,
    };

    // completion_tokens_details はすべて 0 としています
    const completion_tokens_details: CompletionUsage.CompletionTokensDetails = {
        reasoning_tokens: 0,
        audio_tokens: 0,
        accepted_prediction_tokens: 0,
        rejected_prediction_tokens: 0,
    };

    return {
        prompt_tokens,
        completion_tokens,
        total_tokens,
        prompt_tokens_details,
        completion_tokens_details,
    };
}

/**
 * OpenAI の ChatCompletionTool を Anthropic の Tool に変換する関数
 *
 * @param chatTool - OpenAI の ChatCompletionTool オブジェクト
 * @returns Anthropic の Tool オブジェクト
 */
function convertChatCompletionToolToTool(chatTool: ChatCompletionTool): Tool {
    const { name, description, parameters } = chatTool.function;

    // parameters が存在する場合は、その内容を input_schema に展開
    // 存在しない場合は、空のオブジェクトスキーマを定義する
    const input_schema: Tool.InputSchema = parameters
        ? { ...parameters, type: 'object' }
        : { type: 'object', properties: {} };

    return {
        name,
        description,
        input_schema,
    };
}

function convertOpenAIToolToAnthropic(openAITool: ChatCompletionTool): Tool {
    // OpenAIのツールはfunctionタイプのみサポートしているため、
    // typeチェックを行う
    if (openAITool.type !== 'function') {
        throw new Error('Unsupported tool type. Only "function" is supported.');
    }

    // parametersがない場合は空のオブジェクトとして扱う
    const parameters = openAITool.function.parameters || {};

    // Anthropicのツール形式に変換
    const anthropicTool: Tool = {
        name: openAITool.function.name,
        description: openAITool.function.description,
        input_schema: parameters as Tool.InputSchema,
    };

    return anthropicTool;
}

export function remapAnthropic(args: ChatCompletionCreateParamsBase): MessageStreamParams {
    // export interface MessageCreateParamsBase {
    //     max_tokens: number;
    //     messages: Array<MessageParam>;
    //     model: Model;
    //     metadata?: Metadata;
    //     stop_sequences?: Array<string>;
    //     stream?: boolean;
    //     system?: string | Array<TextBlockParam>;
    //     temperature?: number;
    //     tool_choice?: ToolChoice;
    //     tools?: Array<Tool>;
    //     top_k?: number;
    //     top_p?: number;
    // }
    // const wot = JSON.parse(JSON.stringify(args));
    // delete wot.tools;
    // console.dir(wot, { depth: null });

    const { max_tokens, messages, model, metadata, stream, temperature, tool_choice, tools, top_p, stop, } = args;

    // stop_sequences, system, top_k,
    const res: MessageStreamParams = {
        messages: [],
        max_tokens: 0, // TODO ちょっと良く分からないけど0でいいなら0にしておこうということ。
        model,
        // metadata,
        stream: stream === null ? undefined : stream,
        temperature: temperature === null ? undefined : temperature,
        // tool_choice: tool_choice === null ? undefined : tool_choice,
        tools: tools === null ? undefined : tools?.map(tool => convertOpenAIToolToAnthropic(tool)),
        top_p: top_p === null ? undefined : top_p,
    } as MessageCreateParams;

    const keys = ['max_tokens', 'messages', 'model', 'metadata', 'stop_sequences', 'stream', 'system', 'temperature', 'tool_choice', 'tools', 'top_k', 'top_p'];
    Object.keys(args).forEach(key => {  // これで全部のプロパティをチェックする
        if ((args as any)[key] === undefined || (args as any)[key] === null) {
            delete (res as any)[key];
        } else { }
    });

    if (args.tools) {
        if (args.tools.length > 0 && !(args.tool_choice && args.tool_choice === 'none')) {
            res.tool_choice = { type: 'auto', disable_parallel_tool_use: false } as ToolChoice;
            // tools使う場合の項目変換
            if (args.tool_choice) {
                // 'none' | 'auto' | 'required' // OpenAIの仕様
                // 'any' | 'auto' | 'tool';  // Anthropicの仕様
                if (args.tool_choice === 'auto') {
                    res.tool_choice.type = 'auto';
                } else if (args.tool_choice === 'required') {
                    res.tool_choice.type = 'any';
                } else {
                    // ここに来ることはないはず
                    res.tool_choice.type = 'auto';
                }
            } else {
                // 指定されていなかったらauto
                res.tool_choice.type = 'auto';
            }
            // 並列ツール使用の有効無効
            if (res.tool_choice.type === 'auto' || res.tool_choice.type === 'any') {
                res.tool_choice.disable_parallel_tool_use = args.parallel_tool_calls;
                res.tool_choice.disable_parallel_tool_use = false;
            } else { }
        } else {
            // 何もしない
            res.tool_choice = undefined;
        }
    } else {
        // 何もしない
        res.tool_choice = undefined;
    }

    // console.log('---------------------------------------------------');
    // console.dir(args.messages, { depth: null });
    // console.log('++++++++++++++++++++++++++++++++++++++++++++++++++++');
    // イメージタグの作り方が微妙に違う。
    res.messages = args.messages.map(m => {
        const newMessage = { role: m.role, content: [] } as MessageParam;
        if (m.content) {
            if (Array.isArray(m.content)) {
                newMessage.content = m.content.map((c, index) => {
                    if (m.content && c.type === 'image_url') {
                        const mediaType = c.image_url.url.substring('data:'.length, c.image_url.url.indexOf(';'));
                        const base64 = c.image_url.url.substring(c.image_url.url.indexOf(',') + 1);
                        const type = mediaType.startsWith('application/pdf') ? 'document' : 'image';
                        (m.content[index] as ContentBlockParam) = { type, source: { type: 'base64', media_type: mediaType, data: base64 } } as ContentBlockParam;
                        return { type, source: { type: 'base64', media_type: mediaType, data: base64 } } as ImageBlockParam | DocumentBlockParam;
                    } else {
                        return c as ContentBlockParam;
                    }
                });
            } else {
                newMessage.content = m.content;
            }
        } else {
            // 何もしない
        }
        if (m.role === 'tool') {
            const newUserMessage = newMessage as ChatCompletionUserMessageParam;
            newUserMessage.role = 'user';
            if (Array.isArray(newUserMessage.content) && m.tool_call_id) {
                // TODO any多用しすぎ気持ち悪い。。。
                // console.dir(newUserMessage);
                const newUserMessageToolResult = newUserMessage.content[0] as any;
                if (newUserMessageToolResult.type === 'tool_result') {
                    // 編集済みのものはそのまま
                } else if (newUserMessageToolResult.type === 'text') {
                    newUserMessageToolResult.type = 'tool_result' as any;
                    newUserMessageToolResult.tool_use_id = m.tool_call_id;
                    newUserMessageToolResult.content = newUserMessageToolResult.text;
                    delete newUserMessageToolResult.text;
                }
            } else { /** error */ }
            // newToolMessage.tool_calls = m.tool_calls;
        }
        if (m.role === 'assistant') {

            const newAssistantMessage = newMessage as ChatCompletionAssistantMessageParam;
            // console.log(`m.tool_calls:${m.tool_calls}++++++++++++++++++++++++++++++++++++++++++++++++++++`);
            // console.log(newAssistantMessage);
            if (Array.isArray(newAssistantMessage.content) && m.tool_calls) {
                // console.dir(m, { depth: null });
                for (const toolCall of m.tool_calls) {
                    // TODO any多用しすぎ気持ち悪い。。。
                    (newAssistantMessage.content as any[]).push({ type: 'tool_use', id: toolCall.id, name: toolCall.function.name, input: JSON.parse(toolCall.function.arguments || '{}') });
                }
            } else {
                /** TODO textの場合も考慮すべきか？ */
            }
            // newAssistantMessage.tool_calls = m.tool_calls;
        } else { }

        if (m.role === 'system') {
            res.system = m.content;  // これはstringでいいのか？
            return null;
        } else {
            return newMessage;
        }
    }).filter(m => !!m) as MessageParam[];

    // 同一のロールが連続する場合は1つのメッセージとして纏める（こうしないとエラーになるんだけど、何も考えずにnormalizeからもってきたから要らない処理も入ってるかもしれない。もっとコンパクト化したい。）
    res.messages = res.messages.reduce((prev, curr) => {
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
            const prevContentArray: ContentBlockParam[] = prev[prev.length - 1].content as ContentBlockParam[];
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
                        } else if (obj.type === 'image' && obj.source) {
                            // 中身があれば追加
                            prevContentArray.push(obj);
                        } else if (obj.type === 'document' && obj.source) {
                            // 中身があれば追加
                            prevContentArray.push(obj);
                        } else if (obj.type === 'tool_result' || obj.type === 'tool_use') {
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
    }, [] as MessageParam[]);

    // thinkingフラグを立てる
    if (res.model.includes('-thinking')) {
        res.model = res.model.replace('-thinking', '');
        // thinkingはtemperature=1じゃないとダメっぽい。
        res.temperature = 1;
        // TODO thinkingの時はトークンの計算がこれじゃダメっぽい。
        res.thinking = { type: 'enabled', budget_tokens: 51200 };
        // (res as any).betas = 'output-128k-2025-02-19';
    } else { }
    // body: MessageStreamParams, options?: Core.RequestOptions
    return res;
}



// AnthropicのToolをOpenAIのツールに変換する
function convertAnthropicToolToOpenAI(anthropicTool: Tool): ChatCompletionTool {
    return {
        type: 'function',
        function: {
            name: anthropicTool.name,
            description: anthropicTool.description,
            parameters: anthropicTool.input_schema
        }
    };
}

export function reverseRemapAnthropic(args: MessageStreamParams): ChatCompletionCreateParamsBase {
    // 基本パラメータの抽出
    const { max_tokens, messages, model, metadata, stream, temperature,
        tool_choice, tools, top_p, stop_sequences, system, thinking } = args;

    // OpenAIパラメータの初期化
    const res: ChatCompletionCreateParamsBase = {
        messages: [],
        model: model,
        max_tokens,
        stream,
        temperature,
        top_p
    };

    // // thinkingモードの処理 (OpenAIには直接対応する機能はない)
    // if (thinking && thinking.type === 'enabled') {
    //     res.model = `${res.model}-thinking`;
    // } else { }

    // stop_sequencesをstopに変換
    if (stop_sequences && stop_sequences.length > 0) {
        res.stop = stop_sequences;
    }

    // ツールの変換
    if (tools && tools.length > 0) {
        res.tools = tools.map(tool => convertAnthropicToolToOpenAI(tool as Tool));

        // tool_choiceの変換
        if (tool_choice) {
            if (tool_choice.type === 'auto') {
                res.tool_choice = 'auto';
            } else if (tool_choice.type === 'any') {
                res.tool_choice = 'required';
            } else if (tool_choice.type === undefined) {
                res.tool_choice = 'none';
            } else if (tool_choice.type === 'tool') {
                // 特定のツールを指定する場合
                const toolChoiceObj = tool_choice as any;
                res.tool_choice = {
                    type: 'function',
                    function: {
                        name: toolChoiceObj.name
                    }
                };
            }

            // parallel_tool_callsの設定
            if ((tool_choice.type === 'auto' || tool_choice.type === 'any') && tool_choice.disable_parallel_tool_use !== undefined) {
                res.parallel_tool_calls = !tool_choice.disable_parallel_tool_use;
            }

        } else {
            // デフォルトはauto
            res.tool_choice = 'auto';
        }
    }

    // システムメッセージの処理
    if (system) {
        const systemMessage: ChatCompletionSystemMessageParam = {
            role: 'system',
            content: typeof system === 'string' ? system :
                Array.isArray(system) ? convertContentBlocksToString(system) :
                    JSON.stringify(system)
        };
        res.messages.push(systemMessage);
    }

    // メッセージの変換
    const convertedMessages = convertAnthropicMessagesToOpenAI(messages);
    res.messages.push(...convertedMessages);

    // 不要なundefinedプロパティを削除
    Object.keys(res).forEach(key => {
        if ((res as any)[key] === undefined || (res as any)[key] === null) {
            delete (res as any)[key];
        }
    });

    return res;
}

// ContentBlockParamの配列を文字列に変換
function convertContentBlocksToString(blocks: ContentBlockParam[]): string {
    if (blocks.every(block => block.type === 'text')) {
        return blocks.map(block => (block as TextBlockParam).text).join('');
    }
    return JSON.stringify(blocks);
}

// AnthropicメッセージをOpenAIメッセージに変換
function convertAnthropicMessagesToOpenAI(messages: MessageParam[]): ChatCompletionMessageParam[] {
    const result: ChatCompletionMessageParam[] = [];

    for (const msg of messages) {
        if (msg.role === 'user') {
            // ユーザーメッセージの処理
            const { userMessages, toolMessages } = processUserMessage(msg);
            result.push(...userMessages, ...toolMessages);
        } else if (msg.role === 'assistant') {
            // アシスタントメッセージの処理
            result.push(processAssistantMessage(msg));
        }
    }

    return result;
}

// ユーザーメッセージの処理
function processUserMessage(msg: MessageParam): {
    userMessages: ChatCompletionUserMessageParam[],
    toolMessages: ChatCompletionToolMessageParam[]
} {
    const userMessages: ChatCompletionUserMessageParam[] = [];
    const toolMessages: ChatCompletionToolMessageParam[] = [];

    // 文字列コンテンツの場合
    if (typeof msg.content === 'string') {
        userMessages.push({
            role: 'user',
            content: msg.content
        });
        return { userMessages, toolMessages };
    }

    // 配列コンテンツの場合
    if (Array.isArray(msg.content)) {
        // ツール結果と通常コンテンツを分離
        const toolResultBlocks: any[] = [];
        const normalBlocks: ContentBlockParam[] = [];

        for (const block of msg.content) {
            if (block.type === 'tool_result') {
                toolResultBlocks.push(block);
            } else {
                normalBlocks.push(block);
            }
        }

        // 通常コンテンツがあれば処理
        if (normalBlocks.length > 0) {
            userMessages.push({
                role: 'user',
                content: convertContentToOpenAI(normalBlocks)
            });
        }

        // ツール結果があれば処理
        for (const toolResult of toolResultBlocks) {
            toolMessages.push({
                role: 'tool',
                tool_call_id: toolResult.tool_use_id,
                content: toolResult.content
            });
        }
    }

    return { userMessages, toolMessages };
}

// アシスタントメッセージの処理
function processAssistantMessage(msg: MessageParam): ChatCompletionAssistantMessageParam {
    const assistantMessage: ChatCompletionAssistantMessageParam = {
        role: 'assistant',
        content: null // ツールのみの応答の場合はnullが必要
    };

    // 文字列コンテンツの場合
    if (typeof msg.content === 'string') {
        assistantMessage.content = msg.content || null;
        return assistantMessage;
    }

    // 配列コンテンツの場合
    if (Array.isArray(msg.content)) {
        const textBlocks: TextBlockParam[] = [];
        const toolUseBlocks: any[] = [];

        // テキストとツール使用を分離
        for (const block of msg.content) {
            if (block.type === 'text') {
                textBlocks.push(block as TextBlockParam);
            } else if (block.type === 'tool_use') {
                toolUseBlocks.push(block);
            }
        }

        // テキストがあれば設定
        if (textBlocks.length > 0) {
            assistantMessage.content = textBlocks.map(b => b.text).join('');
        }

        // ツール使用があれば処理
        if (toolUseBlocks.length > 0) {
            assistantMessage.tool_calls = toolUseBlocks.map(toolUse => ({
                id: toolUse.id,
                type: 'function',
                function: {
                    name: toolUse.name,
                    arguments: JSON.stringify(toolUse.input)
                }
            }));
        }
    }

    return assistantMessage;
}

// コンテンツブロックをOpenAI形式に変換
function convertContentToOpenAI(blocks: ContentBlockParam[]): string | ChatCompletionContentPart[] {
    // テキストのみの場合は文字列に変換
    if (blocks.every(block => block.type === 'text')) {
        return blocks.map(block => (block as TextBlockParam).text).join('');
    }

    // 複合コンテンツの場合は配列に変換
    const openAIContent: ChatCompletionContentPart[] = [];

    for (const block of blocks) {
        if (block.type === 'text') {
            openAIContent.push({
                type: 'text',
                text: (block as TextBlockParam).text
            });
        } else if (block.type === 'image') {
            const imageBlock = block as ImageBlockParam;
            if (imageBlock.source && imageBlock.source.type === 'base64') {
                openAIContent.push({
                    type: 'image_url',
                    image_url: {
                        url: `data:${imageBlock.source.media_type};base64,${imageBlock.source.data}`,
                    },
                });
            }
        } else if (block.type === 'document') {
            // OpenAIにはdocumentタイプがないため、PDFをbase64画像として扱う
            const docBlock = block as DocumentBlockParam;
            if (docBlock.source && docBlock.source.type === 'base64') {
                openAIContent.push({
                    type: 'image_url',
                    image_url: {
                        url: `data:${docBlock.source.media_type};base64,${docBlock.source.data}`,
                    },
                });
            }
        }
    }

    // 単一のテキストコンテンツの場合は文字列として返す
    if (openAIContent.length === 1 && openAIContent[0].type === 'text') {
        return openAIContent[0].text;
    }

    return openAIContent;
}

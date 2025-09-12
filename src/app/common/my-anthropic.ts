// 各形式のインターフェース定義
// import { AnthropicVertex } from '@anthropic-ai/vertex-sdk';
import { Anthropic } from '@anthropic-ai/sdk';
import OpenAI from "openai";

// Anthropic 形式から OpenAI 形式へ変換する関数
export function convertAnthropicToOpenAI(anthropic: Anthropic.Usage): OpenAI.CompletionUsage {
    // ここでは input_tokens を prompt_tokens、output_tokens を completion_tokens として扱う例です。
    const prompt_tokens = anthropic.input_tokens;
    const completion_tokens = anthropic.output_tokens;
    const total_tokens = prompt_tokens + completion_tokens;

    // prompt_tokens_details にはここでは cache_read_input_tokens を cached_tokens に流用し、audio_tokens は 0 としています
    const prompt_tokens_details: OpenAI.CompletionUsage.PromptTokensDetails = {
        cached_tokens: anthropic.cache_read_input_tokens === null ? undefined : anthropic.cache_read_input_tokens,
        audio_tokens: 0,
    };

    // completion_tokens_details はすべて 0 としています
    const completion_tokens_details: OpenAI.CompletionUsage.CompletionTokensDetails = {
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
function convertChatCompletionToolToTool(chatTool: OpenAI.ChatCompletionFunctionTool): Anthropic.Tool {
    const { name, description, parameters } = chatTool.function;

    // parameters が存在する場合は、その内容を input_schema に展開
    // 存在しない場合は、空のオブジェクトスキーマを定義する
    const input_schema: Anthropic.Tool.InputSchema = parameters
        ? { ...parameters, type: 'object' }
        : { type: 'object', properties: {} };

    return {
        name,
        description,
        input_schema,
    };
}

function convertOpenAIToolToAnthropic(openAITool: OpenAI.ChatCompletionTool): Anthropic.Tool {
    // OpenAIのツールはfunctionタイプのみサポートしているため、
    // typeチェックを行う
    if (openAITool.type !== 'function') {
        throw new Error('Unsupported tool type. Only "function" is supported.');
    }

    // parametersがない場合は空のオブジェクトとして扱う
    const parameters = openAITool.function.parameters || {};

    // Anthropicのツール形式に変換
    const anthropicTool: Anthropic.Tool = {
        name: openAITool.function.name,
        description: openAITool.function.description,
        input_schema: parameters as Anthropic.Tool.InputSchema,
    };

    return anthropicTool;
}

export function remapAnthropic(args: OpenAI.ChatCompletionCreateParams): Anthropic.MessageStreamParams {
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
    const res: Anthropic.MessageStreamParams = {
        messages: [],
        max_tokens: 0, // TODO ちょっと良く分からないけど0でいいなら0にしておこうということ。
        model,
        // metadata,
        stream: stream === null ? undefined : stream,
        temperature: temperature === null ? undefined : temperature,
        // tool_choice: tool_choice === null ? undefined : tool_choice,
        tools: tools === null ? undefined : tools?.map(tool => convertOpenAIToolToAnthropic(tool)),
        top_p: top_p === null ? undefined : top_p,
    } as Anthropic.MessageCreateParams;

    const keys = ['max_tokens', 'messages', 'model', 'metadata', 'stop_sequences', 'stream', 'system', 'temperature', 'tool_choice', 'tools', 'top_k', 'top_p'];
    Object.keys(args).forEach(key => {  // これで全部のプロパティをチェックする
        if ((args as any)[key] === undefined || (args as any)[key] === null) {
            delete (res as any)[key];
        } else { }
    });

    if (args.tools) {
        if (args.tools.length > 0 && !(args.tool_choice && args.tool_choice === 'none')) {
            res.tool_choice = { type: 'auto', disable_parallel_tool_use: false } as Anthropic.ToolChoice;
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

        // ツールがある場合は、最後のツールにキャッシュ制御を追加
        if (res.tool_choice && res.tool_choice.type !== 'none' && res.tools && res.tools.length > 0) {
            res.tools[res.tools.length - 1].cache_control = { type: 'ephemeral' };
        } else { }
    } else {
        // 何もしない
        res.tool_choice = undefined;
    }

    // console.log('---------------------------------------------------');
    // console.dir(args.messages, { depth: null });
    // console.log('++++++++++++++++++++++++++++++++++++++++++++++++++++');
    // イメージタグの作り方が微妙に違う。
    let toolResult!: Anthropic.ToolResultBlockParam;
    res.messages = args.messages.map(m => {
        const newMessage = { role: m.role, content: [] } as Anthropic.MessageParam;
        if (m.content) {
            if (Array.isArray(m.content)) {
                newMessage.content = m.content.map((c, index) => {
                    if (m.content && c.type === 'image_url') {
                        const mediaType = c.image_url.url.substring('data:'.length, c.image_url.url.indexOf(';'));
                        const base64 = c.image_url.url.substring(c.image_url.url.indexOf(',') + 1);
                        const type = mediaType.startsWith('application/pdf') ? 'document' : 'image';
                        (m.content[index] as Anthropic.ContentBlockParam) = { type, source: { type: 'base64', media_type: mediaType, data: base64 } } as Anthropic.ContentBlockParam;
                        return { type, source: { type: 'base64', media_type: mediaType, data: base64 } } as Anthropic.ImageBlockParam | Anthropic.DocumentBlockParam;
                    } else {
                        return c as Anthropic.ContentBlockParam;
                    }
                });
            } else {
                newMessage.content = m.content;
            }
        } else {
            // 何もしない
        }

        if (m.role === 'tool') {
            const newUserMessage = newMessage as OpenAI.ChatCompletionUserMessageParam;
            newUserMessage.role = 'user';

            if (m.tool_call_id) {
                // contentがstringの場合、配列に変換
                if (typeof newUserMessage.content === 'string') {
                    toolResult = {
                        type: 'tool_result',
                        tool_use_id: m.tool_call_id,
                        content: newUserMessage.content,
                    };
                    // ツール結果のコンテンツを配列に変換
                    newUserMessage.content = [toolResult as any];
                } else if (Array.isArray(newUserMessage.content)) {
                    const contentItem = newUserMessage.content[0] as any;
                    if (contentItem.type === 'tool_result') {
                        // 編集済みのものはそのまま - キャッシュ制御を追加
                        toolResult = contentItem as Anthropic.ToolResultBlockParam;
                    } else if (contentItem.type === 'text') {
                        // textタイプをtool_resultに変換
                        toolResult = {
                            type: 'tool_result',
                            tool_use_id: m.tool_call_id,
                            content: contentItem.text,
                        };
                        newUserMessage.content[0] = toolResult as any;
                    }
                }
            } else {
                console.error('tool_call_id が見つかりません');
            }
        }

        if (m.role === 'assistant') {
            const newAssistantMessage = newMessage as OpenAI.ChatCompletionAssistantMessageParam;

            if (m.tool_calls && m.tool_calls.length > 0) {
                // contentがstringの場合、配列に変換
                if (typeof newAssistantMessage.content === 'string') {
                    newAssistantMessage.content = [{
                        type: 'text',
                        text: newAssistantMessage.content
                    }];
                } else { }
                // contentが配列であることを確認してからtool_useを追加
                if (Array.isArray(newAssistantMessage.content)) {
                    for (const toolCall of m.tool_calls) {
                        newAssistantMessage.content.push({
                            type: 'tool_use',
                            id: toolCall.id,
                            name: (toolCall as OpenAI.ChatCompletionFunctionTool).function.name,
                            input: (toolCall as OpenAI.ChatCompletionFunctionTool).function.parameters || {}
                        } as any);
                    }
                }
            }
        }
        if (m.role === 'system') {
            res.system = m.content;  // これはstringでいいのか？
            // システムプロンプトにキャッシュ制御を追加
            if (typeof res.system === 'string') {
                res.system = [{ type: 'text', text: res.system, cache_control: { type: 'ephemeral' } }];
            } else if (Array.isArray(res.system)) {
                // 最後のテキストブロックにキャッシュ制御を追加
                const lastBlock = res.system[res.system.length - 1];
                if (lastBlock && lastBlock.type === 'text') {
                    lastBlock.cache_control = { type: 'ephemeral' };
                }
            }
            return null;
        } else {
            return newMessage;
        }
    }).filter(m => !!m) as Anthropic.MessageParam[];

    // ツール結果があれば、キャッシュ制御を追加
    if (toolResult) {
        toolResult.cache_control = { type: 'ephemeral' };
    }

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
            const prevContentArray: Anthropic.ContentBlockParam[] = prev[prev.length - 1].content as Anthropic.ContentBlockParam[];
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
    }, [] as Anthropic.MessageParam[]);

    // TODO 最大のメッセージのところにキャッシュポイントを置きたいけど出来てない。
    // const largest = res.messages.reduce((prev, curr) => {
    //     const prevString = JSON.stringify(prev);
    //     const currString = JSON.stringify(curr);
    //     return prevString.length < currString.length ? curr : prev;
    // }, res.messages[0]);

    // thinkingフラグを立てる
    if (res.model.includes('-thinking')) {
        res.model = res.model.replace('-thinking', '');
        // thinkingはtemperature=1じゃないとダメっぽい。
        res.temperature = 1;
        // TODO thinkingの時はトークンの計算がこれじゃダメっぽい。
        res.thinking = { type: 'enabled', budget_tokens: 51200 };
        res.thinking = { type: 'enabled', budget_tokens: 12800 };
        // (res as any).betas = 'output-128k-2025-02-19';
    } else { }
    // body: MessageStreamParams, options?: Core.RequestOptions
    return res;
}



// AnthropicのToolをOpenAIのツールに変換する
function convertAnthropicToolToOpenAI(anthropicTool: Anthropic.Tool): OpenAI.ChatCompletionTool {
    return {
        type: 'function',
        function: {
            name: anthropicTool.name,
            description: anthropicTool.description,
            parameters: anthropicTool.input_schema
        }
    };
}

export function reverseRemapAnthropic(args: Anthropic.MessageStreamParams): OpenAI.ChatCompletionCreateParams {
    // 基本パラメータの抽出
    const { max_tokens, messages, model, metadata, stream, temperature,
        tool_choice, tools, top_p, stop_sequences, system, thinking } = args;

    // OpenAIパラメータの初期化
    const res: OpenAI.ChatCompletionCreateParams = {
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
        res.tools = tools.map(tool => convertAnthropicToolToOpenAI(tool as Anthropic.Tool));

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
        const systemMessage: OpenAI.ChatCompletionSystemMessageParam = {
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
function convertContentBlocksToString(blocks: Anthropic.ContentBlockParam[]): string {
    if (blocks.every(block => block.type === 'text')) {
        return blocks.map(block => (block as Anthropic.TextBlockParam).text).join('');
    }
    return JSON.stringify(blocks);
}

// AnthropicメッセージをOpenAIメッセージに変換
function convertAnthropicMessagesToOpenAI(messages: Anthropic.MessageParam[]): OpenAI.ChatCompletionMessageParam[] {
    const result: OpenAI.ChatCompletionMessageParam[] = [];

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
function processUserMessage(msg: Anthropic.MessageParam): {
    userMessages: OpenAI.ChatCompletionUserMessageParam[],
    toolMessages: OpenAI.ChatCompletionToolMessageParam[]
} {
    const userMessages: OpenAI.ChatCompletionUserMessageParam[] = [];
    const toolMessages: OpenAI.ChatCompletionToolMessageParam[] = [];

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
        const normalBlocks: Anthropic.ContentBlockParam[] = [];

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
function processAssistantMessage(msg: Anthropic.MessageParam): OpenAI.ChatCompletionAssistantMessageParam {
    const assistantMessage: OpenAI.ChatCompletionAssistantMessageParam = {
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
        const textBlocks: Anthropic.TextBlockParam[] = [];
        const toolUseBlocks: any[] = [];

        // テキストとツール使用を分離
        for (const block of msg.content) {
            if (block.type === 'text') {
                textBlocks.push(block as Anthropic.TextBlockParam);
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
function convertContentToOpenAI(blocks: Anthropic.ContentBlockParam[]): string | OpenAI.ChatCompletionContentPart[] {
    // テキストのみの場合は文字列に変換
    if (blocks.every(block => block.type === 'text')) {
        return blocks.map(block => (block as Anthropic.TextBlockParam).text).join('');
    }

    // 複合コンテンツの場合は配列に変換
    const openAIContent: OpenAI.ChatCompletionContentPart[] = [];

    for (const block of blocks) {
        if (block.type === 'text') {
            openAIContent.push({
                type: 'text',
                text: (block as Anthropic.TextBlockParam).text
            });
        } else if (block.type === 'image') {
            const imageBlock = block as Anthropic.ImageBlockParam;
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
            const docBlock = block as Anthropic.DocumentBlockParam;
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

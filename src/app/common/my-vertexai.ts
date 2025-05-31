import { Content, CountTokensResponse, FunctionCallingMode, FunctionDeclaration, FunctionDeclarationSchema, FunctionDeclarationSchemaType, GenerateContentRequest, HarmBlockThreshold, HarmCategory, Part, SchemaType, Tool, UsageMetadata, VertexAI } from "@google-cloud/vertexai";
import { exec, execSync } from "child_process";
import { promisify } from 'util';
import { detect } from "jschardet";
import { ChatCompletionContentPart, ChatCompletionCreateParamsBase, ChatCompletionFunctionMessageParam, ChatCompletionMessageParam, ChatCompletionRole, ChatCompletionSystemMessageParam, ChatCompletionTool, ChatCompletionToolMessageParam } from "openai/resources/chat/completions";

import { plainMime } from "./openai-api-wrapper.js";
import { CompletionUsage } from "openai/resources/completions.js";
import { VertexAIConfig } from "../service/entity/auth.entity.js";

const execPromise = promisify(exec);
interface CommandResult {
    stdout: string;
    stderr: string;
}
class GCloudAuthError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'GCloudAuthError';
    }
}

const { GCP_PROJECT_ID, GCP_REGION, GCP_CONTEXT_CACHE_LOCATION } = process.env;

export interface CachedContent {
    name: string;
    model: string;
    createTime: string;
    updateTime: string;
    expireTime: string;
}

export interface CountCharsResponse {
    image: number;
    text: number;
    video: number;
    audio: number;
}
export type TokenCharCount = CountCharsResponse & CountTokensResponse;
export interface GenerateContentRequestExtended extends GenerateContentRequest {
    resourcePath: string;
    region: string;
    cached_content?: string;
    tools?: Tool[],
}
export interface GenerateContentRequestForCache {
    ttl?: { seconds: number, nanos: number };
    expire_time?: string; // "expire_time":"2024-06-30T09:00:00.000000Z"
}

export class MyVertexAiClient {

    counter: number = 0;

    private accessToken: string | undefined;
    private expire: number = Date.now();
    private accessTokenStock: string | undefined;

    private clients: VertexAI[] = [];

    constructor(public params: VertexAIConfig[]) {
        // this.client = new VertexAI({ project: this.params.projectId, location: this.params.region, apiEndpoint: this.params.baseURL, httpAgent: this.params.httpAgent });
        this.params.forEach(param => {
            // console.log(`param:${JSON.stringify(param)}`);
            this.clients.push(new VertexAI(param));
        });
    }

    get client(): VertexAI {
        return this.clients[this.counter++ % this.clients.length];
    }

    async getAccessToken(force: boolean = false): Promise<string> {
        const now = Date.now();
        // console.log(`now:${now} expire:${this.expire} accessToken:${this.accessToken}`);
        // console.log(`now:${new Date(now)} expire:${new Date(this.expire)} accessTokenOriginal:${this.accessToken}`);
        // console.log(`now:${new Date(now)} expire:${new Date(this.expire)} accessTokenStock   :${this.accessTokenStock}`);
        if (this.accessToken && !force && now < this.expire && this.accessTokenStock === this.accessToken) {
            return Promise.resolve(this.accessToken);
        } else {
            try {
                console.log(`TokenRefresh:${new Date(now)}`);
                this.expire = Date.now() + 55 * 60 * 1000; // トークン有効時間が1時間なので55分でリフレッシュする。
                const { stdout, stderr }: CommandResult = await execPromise('gcloud auth print-access-token');
                if (stderr) {
                    throw new GCloudAuthError(stderr);
                }
                this.accessToken = stdout.trim();
                this.accessTokenStock = this.accessToken;
                return this.accessToken;
            } catch (error) {
                console
                if (error instanceof GCloudAuthError) {
                    throw error;
                }
                throw new GCloudAuthError(`Failed to execute command: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
    }

    async getAuthorizedHeaders(force: boolean = false): Promise<{ headers: { Authorization: string, 'Content-Type': string } }> {
        return this.getAccessToken(force).then(accessToken => ({
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json',
            },
        }));
    }
}

export function mapForGemini(args: ChatCompletionCreateParamsBase): GenerateContentRequest {
    const req: GenerateContentRequest = {
        contents: [],
        // systemInstruction: undefined,
    };

    // 中身無ければ即返し。
    if (args.messages.length == 0) return req;
    args.messages[0].content = args.messages[0].content || '';
    // argsをGemini用に変換
    const roleMapper: { [key: string]: 'system' | 'model' | 'user' | 'function' } = {
        system: 'system',
        assistant: 'model',
        user: 'user',
        function: 'user',
        tool: 'function',
    };
    // console.log(`mapForGemini: ${args.messages.length}++++++++++++++++++++++++++++++++++++++++++++++++++++++++++`);
    args.messages.forEach(message => {
        const role = roleMapper[message.role] || message.role;
        // 画像ファイルなどが入ってきたとき用の整理
        if (typeof message.content === 'string') {
            if (message.role === 'system') {
                // systemはsystemInstructionに入れる
                req.systemInstruction = { role, parts: [{ text: message.content }] };
            } else {
                if (message.role === 'assistant' && message.tool_calls) {
                    // console.dir(message, { depth: null });
                    const content = { role, parts: [] } as Content;
                    req.contents.push(content);
                    if (message.content) {
                        content.parts.push({ text: message.content });
                    } else {
                        // contentが無ければ入れない
                    }
                    message.tool_calls.forEach(toolCall => {
                        // console.dir(toolCall, { depth: null });
                        // console.log(`tool_call_id:${toolCall.id} function name:${toolCall.function.name} arguments:${toolCall.function.arguments}`);
                        content.parts.push({
                            functionCall: {
                                name: toolCall.function.name,
                                args: JSON.parse(toolCall.function.arguments),
                            }
                        });
                    });
                } else if (message.role === 'tool' && message.tool_call_id) {
                    // tool_call_idがある場合は、functionResponseに変換する。
                    const remappedContent = { role, parts: [{ text: message.content }] } as Content;
                    remappedContent.role = 'function';
                    remappedContent.parts = [{
                        functionResponse: {
                            name: message.tool_call_id,
                            response: {
                                content: JSON.parse(remappedContent.parts[0].text || '{}'),
                            }
                        }
                    }];
                    req.contents.push(remappedContent);
                } else {
                    req.contents.push({ role, parts: [{ text: message.content }] });
                }
            }
        } else if (Array.isArray(message.content)) {
            const remappedContent = {
                role,
                parts:
                    message.content.map(content => {
                        if (content.type === 'image_url') {
                            // TODO URLには対応していない
                            const mimeType = content.image_url.url.substring(5, content.image_url.url.indexOf(';'));
                            if (plainMime.includes(mimeType)) {
                                // encodingがutf-8固定なのは良くないけどどうしようもない。。
                                const base64String = content.image_url.url.substring(content.image_url.url.indexOf(',') + 1) as string;
                                const data = Buffer.from(base64String, 'base64');
                                const detectedEncoding = detect(data);
                                if (detectedEncoding.encoding === 'ISO-8859-2') {
                                    detectedEncoding.encoding = 'SHIFT_JIS'; // 文字コード自動判定でSJISがISO-8859-2ことがあるので
                                } else if (!detectedEncoding.encoding) {
                                }
                                const decoder = new TextDecoder(detectedEncoding.encoding);
                                const decodedString = decoder.decode(data);
                                return { text: decodedString };
                            } else if (content.image_url.url.startsWith('data:video/')) {
                                return { inlineData: { mimeType: content.image_url.url.substring(5, content.image_url.url.indexOf(';')), data: content.image_url.url.substring(content.image_url.url.indexOf(',') + 1) }, video_metadata: {} };
                            } else if (content.image_url.url.startsWith('data:')) {
                                return { inlineData: { mimeType: content.image_url.url.substring(5, content.image_url.url.indexOf(';')), data: content.image_url.url.substring(content.image_url.url.indexOf(',') + 1) }, };
                            } else {
                                console.log(`echo-${content.type}`);
                                return { file_data: { file_uri: content.image_url.url } };
                            }
                        } else if (content.type === 'text') {
                            return { text: content.text as string };
                        } else {
                            console.log(`unknown sub message type ${(content as any).type}`);
                            return null;
                        }
                    }).filter(is => is) as Part[],
            };

            // arrayになることはないと思うので要らないかも。。
            if (message.role === 'assistant' && message.tool_calls) {
                message.tool_calls.forEach(toolCall => {
                    remappedContent.parts.push({
                        functionCall: {
                            name: toolCall.function.name,
                            args: JSON.parse(toolCall.function.arguments),
                        }
                    });
                });
            } else { }
            // arrayになることはないと思うので要らないかも。。
            if (message.role === 'tool' && message.tool_call_id) {
                remappedContent.role = 'function';
                remappedContent.parts = [{
                    functionResponse: {
                        name: message.tool_call_id,
                        response: {
                            content: JSON.parse(remappedContent.parts[0].text || '{}'),
                        }
                    }
                }];
            } else { }


            if (message.role === 'system') {
                // systemはsystemInstructionに入れる
                req.systemInstruction = remappedContent;
            } else {
                req.contents.push(remappedContent);
            }
        } else {
            console.log('unknown message type');
        }
    });

    // 同一のロールが連続する場合は1つのメッセージとして纏める（こうしないとエラーになるんだけど、何も考えずにnormalizeからもってきたから要らない処理も入ってるかもしれない。もっとコンパクト化したい。）
    req.contents = req.contents.reduce((prev, curr) => {
        // TODO tool_call_idが何故anyなのか？？？
        if (prev.length === 0 || prev[prev.length - 1].role !== curr.role) {
            prev.push(curr);
        } else {
            const prevContent = prev[prev.length - 1].parts;
            if (typeof prevContent === 'string') {
                if (prevContent) {
                    console.log(`prevContent:${prevContent}`);
                    // 1個前の同じロールのコンテンツがstring型だと連結できないので構造化配列にしておく。
                    prev[prev.length - 1].parts = [{ text: prevContent }];
                    return prev;
                } else {
                    // 空文字は無視する
                    return prev;
                }
            } else {
                // 元々配列なので何もしない
            }
            // TODO アップデートしたら型合わなくなったので as を入れる
            const prevContentArray: Part[] = prev[prev.length - 1].parts as Part[]
            if (Array.isArray(prevContentArray)) {
                if (typeof curr.parts === 'string') {
                    if (curr.parts) {
                        prevContentArray.push({ text: curr.parts });
                    } else {
                        // 中身がないものは削ってしまう。
                    }
                } else if (curr.parts) {
                    curr.parts.forEach(obj => {
                        prevContentArray.push(obj);
                    });
                } else {
                    // エラー
                }
            }
        }
        return prev;
    }, [] as Content[]);


    if ((args as any).isGoogleSearch) {
        // google検索を使う場合は、google検索のためのプロパティを追加する
        req.tools = req.tools || [];
        if (args.model.startsWith('gemini-2.0') || args.model.startsWith('gemini-exp-1206')) {
            req.tools.push({ googleSearch: {} } as any);
        } else {
            req.tools.push({ googleSearchRetrieval: {} });
        }
        // google検索を使う場合はtoolsは使えない
    } else {
        // tools はGoogle検索を使わない場合のみ使える
        if (args.tools && args.tools.length > 0) {
            req.tools = [{ functionDeclarations: args.tools.map(convertToolDef) }];
            const mode = (args.tool_choice || 'auto').toString().toUpperCase() as FunctionCallingMode;
            req.toolConfig = { functionCallingConfig: { mode } };
            if (mode === 'ANY' && req.toolConfig && req.toolConfig.functionCallingConfig) {
                req.toolConfig.functionCallingConfig.allowedFunctionNames = args.tools.map(tool => tool.function.name);
            } else { }
        } else { }
    }
    delete (args as any).isGoogleSearch;

    // console.dir(req, { depth: null });
    return req;
}

export function mapForGeminiExtend(args: ChatCompletionCreateParamsBase, _req?: GenerateContentRequest): GenerateContentRequestExtended {
    const req: GenerateContentRequestExtended = (_req || mapForGemini(args)) as GenerateContentRequestExtended;
    req.generationConfig = {
        maxOutputTokens: args.max_tokens || undefined,
        temperature: args.temperature || 0.1,
        topP: args.top_p || 0.95,
    };

    req.safetySettings = (args as any).safetySettings || [
        // // ここの指定をするとマルチモーダルの時にエラーになることがあるので何もしないことにした。
        // { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE, },
        // { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE, },
        // { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE, },
        // { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE, }
    ];
    // メディアファイルの有無で分けるようにした。
    if (req.contents.find(content => content.parts.find(part => part.inlineData))) {
        // ここの指定をするとマルチモーダルの時にエラーになることがあるので何もしないことにした。
        req.safetySettings = (args as any).safetySettings || [];
    } else {
        req.safetySettings = (args as any).safetySettings || [
            { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE, },
            { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE, },
            { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE, },
            { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE, }
        ];
    }

    // gemini-2.5-flash-preview-04-17 の場合は、thinking_configを設定する。
    if (args.model === 'gemini-2.5-flash-preview-04-17') {
        (req.generationConfig as any).thinking_config = { thinking_budget: 0 };
    } else if (args.model === 'gemini-2.5-flash-thinking-preview-04-17') {
        args.model = 'gemini-2.5-flash-preview-04-17';
    } else if (args.model === 'gemini-2.5-flash-preview-05-20') {
        (req.generationConfig as any).thinking_config = { thinking_budget: 0 };
    } else if (args.model === 'gemini-2.5-flash-thinking-preview-05-20') {
        args.model = 'gemini-2.5-flash-preview-05-20';
    }

    // コンテンツキャッシュ
    const cachedContent = (args as any).cachedContent as CachedContent;
    delete (args as any).cachedContent;

    // console.dir(cachedContent);
    if (cachedContent) {
        req.region = 'asia-northeast1';
        req.resourcePath = cachedContent.model;
        req.cached_content = cachedContent.name;
        req.safetySettings = []; // TODO コンテキストキャッシュを使うときになんかエラーが出るようになったので外す。エラーが出なかった時期もあるので良く分からない。
    } else if (args.model.startsWith('meta/')) {
        // 何も設定しなくてもいいかも。。
        // req.region = 'us-central1';
        // req.resourcePath = `projects/${GCP_PROJECT_ID}/locations/${req.region}/endpoints/openapi/chat/completions`;
    } else if ((args.model.startsWith('gemini-') && args.model.includes('-exp')) || args.model.startsWith('gemini-2')) { // gemini系のexp（実験版）はus-central1に固定
        // 何も設定しなくてもいいかも。。
        // req.region = 'us-central1';
        // req.resourcePath = `projects/${GCP_PROJECT_ID}/locations/${req.region}/endpoints/openapi/chat/completions`;
        const gcpProjectId = (args as any).gcpProjectId || GCP_PROJECT_ID;
        req.region = 'us-central1'; // experimental は us-central1でしか使えない。
        req.resourcePath = `projects/${gcpProjectId}/locations/${req.region}/publishers/google/models/${args.model}`;
    } else {
        // 無理矢理だけど指定されてたらプロジェクト切替。無理矢理すぎるので直したい。
        const gcpProjectId = (args as any).gcpProjectId || GCP_PROJECT_ID;
        req.region = 'asia-northeast1'; // 国内で固定。
        req.resourcePath = `projects/${gcpProjectId}/locations/${req.region}/publishers/google/models/${args.model}`;
    }
    return req;
}


// Usage を Gemini 形式から OpenAI 形式へ変換する関数。使ってないので動作保証できてない。
function convertGeminiToOpenAI(gemini: UsageMetadata): CompletionUsage {
    // Gemini では promptTokenCount と candidatesTokenCount をそれぞれ prompt_tokens と completion_tokens として扱う例です。
    const prompt_tokens = gemini.promptTokenCount || 0;
    const completion_tokens = gemini.candidatesTokenCount || 0;
    const total_tokens = gemini.totalTokenCount || 0;

    // Gemini の詳細情報は配列になっていますが、OpenAI 形式ではオブジェクトとなるため、ここではデフォルト値（0）を利用
    const prompt_tokens_details: CompletionUsage.PromptTokensDetails = {
        cached_tokens: 0,
        audio_tokens: 0,
    };
    // {"promptTokenCount":70,"candidatesTokenCount":6,"totalTokenCount":76,"promptTokensDetails":[{"modality":"TEXT","tokenCount":70}],"candidatesTokensDetails":[{"modality":"TEXT","tokenCount":6}]}
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
 * ChatCompletionTool の JSON を FunctionDeclaration の形式に変換する関数
 * @param tool ChatCompletionTool の JSON オブジェクト
 * @returns FunctionDeclaration の JSON オブジェクト
 */
export function convertToolDef(tool: ChatCompletionTool): FunctionDeclaration {
    // オブジェクトのコピーを作成
    tool = JSON.parse(JSON.stringify(tool));

    // ChatCompletionTool の型文字列を FunctionDeclaration 用に変換する関数
    function convertTypeString(typeStr: string): SchemaType {
        return typeStr.toUpperCase() as SchemaType;
    }

    // JSON Schema の各ノードを再帰的に変換する関数
    function convertSchema(schema: Record<string, unknown>): FunctionDeclarationSchema {
        // オブジェクトのコピーを作成
        const newSchema: any = { ...schema };

        // type プロパティの変換
        newSchema.type = convertTypeString(newSchema.type);

        // properties の再帰変換
        if (newSchema.properties) {
            if (typeof newSchema.properties === 'object') {
                const newProperties: Record<string, any> = {};
                for (const key of Object.keys(newSchema.properties)) {
                    if (Object.prototype.hasOwnProperty.call(newSchema.properties, key)) {
                        newProperties[key] = convertSchema(newSchema.properties[key]);
                    }
                }
                newSchema.properties = newProperties;
            } else {

            }
        }
        if (newSchema.items) {
            newSchema.items = convertSchema(newSchema.items);
        }

        if (Object.hasOwnProperty.call(newSchema, 'default')) { // defaultがfalseとかだとプロパティがあってもfalse判定されるので、プロパティが指定されているかどうかをちゃんとチェックする。
            // defaultがある場合は、descriptionに追加して消す。
            newSchema.description = `${newSchema.description}\n\ndefault: ${newSchema.default}`;
            delete newSchema.default;
        } else { }
        return newSchema;
    }

    // ChatCompletionTool の JSON から FunctionDeclaration の形式へ変換
    const func: FunctionDeclaration = {
        name: tool.function.name,
        description: tool.function.description,
    };
    if (tool.function.parameters) {
        func.parameters = convertSchema(tool.function.parameters);
    } else { }
    return func;
}


export function countChars(args: ChatCompletionCreateParamsBase): { image: number, text: number, video: number, audio: number } {
    return args.messages.reduce((prev0, curr0) => {
        if (curr0.content) {
            if (typeof curr0.content === 'string') {
                prev0.text += curr0.content.length;
            } else {
                (curr0.content as Array<ChatCompletionContentPart>).reduce((prev1, curr1) => {
                    if (curr1.type === 'text') {
                        prev1.text += curr1.text.replace(/\s/g, '').length; // 空白文字を除いた文字数
                    } else if (curr1.type === 'image_url') {
                        const mediaType = curr1.image_url.url.split(/[/:]/g)[1];
                        switch (mediaType) {
                            case 'audio':
                                prev1.audio += (curr1.image_url as any).second * 0.000125 / 0.00125 * 1000;
                                break;
                            case 'video':
                                prev1.video += (curr1.image_url as any).second * 0.001315 / 0.00125 * 1000;
                                break;
                            case 'image':
                                prev1.image += 0.001315 / 0.00125 * 1000;
                                break;
                            default:
                                const contentUrlType = curr1.image_url.url.split(',')[0];
                                console.log(`unkown type: ${contentUrlType}`);
                                break;
                        }
                    } else {
                        console.log(`unkown obj ${Object.keys(curr1)}`);
                    }
                    return prev1;
                }, prev0);
            }
        } else {
            // null
        }
        return prev0;
    }, { image: 0, text: 0, video: 0, audio: 0 } as { image: number, text: number, video: number, audio: number });
}








/**
 * Vertex AI の関数宣言をOpenAIのツール形式に変換する
 * @param funcDecl Vertex AIの関数宣言
 * @returns OpenAIのツール定義
 */
export function convertFunctionToOpenAITool(funcDecl: FunctionDeclaration): ChatCompletionTool {
    // 型変換の関数
    function convertSchemaType(type: string): string {
        return type.toLowerCase();
    }

    // スキーマの再帰的変換
    function convertSchemaToOpenAI(schema: any): any {
        if (!schema) return {};

        const newSchema: any = { ...schema };

        // 型の変換
        if (newSchema.type) {
            newSchema.type = convertSchemaType(newSchema.type);
        }

        // プロパティの再帰的変換
        if (newSchema.properties && typeof newSchema.properties === 'object') {
            const newProps: Record<string, any> = {};
            for (const key of Object.keys(newSchema.properties)) {
                newProps[key] = convertSchemaToOpenAI(newSchema.properties[key]);
            }
            newSchema.properties = newProps;
        }

        // 配列アイテムの変換
        if (newSchema.items) {
            newSchema.items = convertSchemaToOpenAI(newSchema.items);
        }

        return newSchema;
    }

    return {
        type: 'function',
        function: {
            name: funcDecl.name,
            description: funcDecl.description,
            parameters: convertSchemaToOpenAI(funcDecl.parameters)
        }
    };
}

/**
 * Vertex AI のGenerateContentRequestをOpenAIのChatCompletionCreateParamsBaseに変換する
 * @param request Vertex AIのリクエスト
 * @param modelName OpenAIに渡すモデル名
 * @returns OpenAI形式のパラメータ
 */
export function mapForOpenAI(request: GenerateContentRequest, modelName: string): ChatCompletionCreateParamsBase {
    const openAIParams: ChatCompletionCreateParamsBase = {
        model: modelName,
        messages: [],
    };

    // システムメッセージの処理
    if (request.systemInstruction) {
        (request.systemInstruction as Content).role = 'system';
        const systemText = extractTextFromParts(request.systemInstruction);
        openAIParams.messages.push({
            role: 'system',
            content: systemText
        } as ChatCompletionSystemMessageParam);
    }

    // コンテンツの処理（通常のメッセージ）
    if (request.contents) {
        const openAIMessages = convertVertexContentsToOpenAIMessages(request.contents);
        openAIParams.messages.push(...openAIMessages);
    }

    // ツールの処理
    if (request.tools) {
        // Google Search特別処理
        if (request.tools.some(tool => 'googleSearch' in tool || 'googleSearchRetrieval' in tool)) {
            (openAIParams as any).isGoogleSearch = true;
        }
        // 通常のツール処理
        else {
            const functionDeclarations: FunctionDeclaration[] = [];
            request.tools.forEach(tool => {
                if ('functionDeclarations' in tool) {
                    functionDeclarations.push(...(tool.functionDeclarations || []));
                }
            });

            if (functionDeclarations.length > 0) {
                openAIParams.tools = functionDeclarations.map(convertFunctionToOpenAITool);

                // ツール選択設定の変換
                if (request.toolConfig?.functionCallingConfig) {
                    const mode = request.toolConfig.functionCallingConfig.mode;
                    if (mode) {
                        switch (mode) {
                            case 'AUTO':
                                openAIParams.tool_choice = 'auto';
                                break;
                            case 'ANY':
                                openAIParams.tool_choice = 'required';
                                break;
                            case 'NONE':
                                openAIParams.tool_choice = 'none';
                                break;
                            default:
                                openAIParams.tool_choice = 'auto';
                        }
                    }

                    // // 特定のツールを指定する場合
                    // if (mode === 'MODE_UNSPECIFIED' && request.toolConfig.functionCallingConfig.allowedFunctionNames?.length === 1) {
                    //     openAIParams.tool_choice = {
                    //         type: 'function',
                    //         function: {
                    //             name: request.toolConfig.functionCallingConfig.allowedFunctionNames[0]
                    //         }
                    //     };
                    // }
                }
            }
        }
    }

    // 生成設定の変換
    if (request.generationConfig) {
        if (request.generationConfig.maxOutputTokens) {
            openAIParams.max_tokens = request.generationConfig.maxOutputTokens;
        }
        if (request.generationConfig.temperature !== undefined) {
            openAIParams.temperature = request.generationConfig.temperature;
        }
        if (request.generationConfig.topP !== undefined) {
            openAIParams.top_p = request.generationConfig.topP;
        }
    }

    // 安全設定は特に変換しない（OpenAIはこの部分が異なる構造）

    return openAIParams;
}

/**
 * Vertex AIのメッセージ配列をOpenAIのメッセージ配列に変換
 */
function convertVertexContentsToOpenAIMessages(contents: Content[]): ChatCompletionMessageParam[] {
    const messages: ChatCompletionMessageParam[] = [];

    for (const content of contents) {
        const role = mapVertexRoleToOpenAI(content.role);

        // 関数レスポンスの処理
        if (content.role === 'function' && content.parts && content.parts.length > 0 && 'functionResponse' in content.parts[0]) {
            const functionResponse = content.parts[0].functionResponse!;
            messages.push({
                role: 'tool',
                tool_call_id: functionResponse.name,
                content: JSON.stringify(functionResponse.response || {})
            } as ChatCompletionToolMessageParam);
            continue;
        }

        // 通常のメッセージ処理（テキストとマルチモーダル）
        if (content.parts) {
            const message = createOpenAIMessage(role, content.parts);

            // 関数呼び出しの処理（アシスタントからの）
            if (role === 'assistant' && content.parts.some(part => 'functionCall' in part)) {
                // TODO
                (message as any).tool_calls = content.parts
                    .filter(part => 'functionCall' in part)
                    .map(part => {
                        const functionCall = part.functionCall!;
                        return {
                            id: `call_${Math.random().toString(36).substring(2, 11)}`,
                            type: 'function',
                            function: {
                                name: functionCall.name,
                                arguments: JSON.stringify(functionCall.args || {})
                            }
                        };
                    });
            }

            messages.push(message);
        }
    }

    return messages;
}

/**
 * Vertex AIのロールをOpenAIのロールに変換
 */
function mapVertexRoleToOpenAI(vertexRole: string): string {
    switch (vertexRole) {
        case 'user': return 'user';
        case 'model': return 'assistant';
        case 'function': return 'function'; // 後で'tool'に変換される可能性あり
        default: return vertexRole;
    }
}

/**
 * 与えられたパーツからテキストを抽出
 */
function extractTextFromParts(parts: Content | string | undefined): string {
    if (typeof parts === 'string') {
        return parts;
    } else if (Array.isArray(parts)) {
        return parts.map(extractTextFromParts).join('');
    } else {
        return '';
    }
}

/**
 * OpenAIメッセージを作成
 */
function createOpenAIMessage(role: string, parts: Part[]): ChatCompletionMessageParam {
    // 単純なテキストのみの場合
    const textParts = parts.filter(part => 'text' in part);
    if (parts.length === textParts.length) {
        return {
            role: role as ChatCompletionRole,
            content: textParts.map(part => part.text).join('')
        } as ChatCompletionMessageParam;
    }

    // マルチモーダルコンテンツの場合
    const contentParts: ChatCompletionContentPart[] = [];

    for (const part of parts) {
        if ('text' in part && part.text) {
            contentParts.push({
                type: 'text',
                text: part.text
            });
        }
        else if ('inlineData' in part) {
            const inlineData = part.inlineData!;
            contentParts.push({
                type: 'image_url',
                image_url: {
                    url: `data:${inlineData.mimeType};base64,${inlineData.data}`
                }
            });
        }
        else if ('fileData' in part) {
            contentParts.push({
                type: 'image_url',
                image_url: {
                    url: part.fileData!.fileUri
                }
            });
        }
        // functionCallとfunctionResponseは別途処理
    }

    return {
        role: role as ChatCompletionRole,
        content: contentParts
    } as ChatCompletionMessageParam;
}

/**
 * 拡張された変換関数（追加情報を維持）
 */
export function mapForOpenAIExtended(
    request: GenerateContentRequest & { resourcePath?: string, region?: string, cached_content?: string },
    modelName: string
): ChatCompletionCreateParamsBase & { gcpProjectId?: string, cachedContent?: any } {
    const openAIParams = mapForOpenAI(request, modelName) as ChatCompletionCreateParamsBase & {
        gcpProjectId?: string,
        cachedContent?: any
    };

    // プロジェクトIDの抽出
    if (request.resourcePath) {
        const match = request.resourcePath.match(/projects\/([^\/]+)/);
        if (match && match[1]) {
            openAIParams.gcpProjectId = match[1];
        }
    }

    // キャッシュ情報の維持
    if (request.cached_content) {
        openAIParams.cachedContent = {
            name: request.cached_content,
            model: request.resourcePath,
        };
    }

    return openAIParams;
}

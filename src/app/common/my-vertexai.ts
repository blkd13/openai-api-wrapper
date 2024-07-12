import { GenerateContentRequest, HarmBlockThreshold, HarmCategory, Part } from "@google-cloud/vertexai";
import { execSync } from "child_process";
import { ChatCompletionCreateParamsBase } from "openai/resources/chat/completions";

import * as dotenv from 'dotenv';
dotenv.config();
const { GCP_PROJECT_ID, GCP_REGION } = process.env;

export interface CachedContent {
    name: string;
    model: string;
    createTime: string;
    updateTime: string;
    expireTime: string;
}
export interface GenerateContentRequestExtended extends GenerateContentRequest {
    resourcePath: string;
    region: string;
    cached_content?: string;
}
export interface GenerateContentRequestForCache extends GenerateContentRequest {
    ttl?: { seconds: number, nanos: number };
    expire_time?: string; // "expire_time":"2024-06-30T09:00:00.000000Z"
}

export class MyVertexAiClient {

    private accessToken: string | undefined;
    private expire: number = Date.now();

    async getAccessToken(force: boolean = false): Promise<string> {
        const now = Date.now();
        if (this.accessToken && !force && now < this.expire) {
            return Promise.resolve(this.accessToken);
        } else {
            try {
                this.expire = Date.now() + 60 * 60 * 1000; // 1時間
                this.accessToken = execSync('gcloud auth print-access-token').toString().trim();
                return this.accessToken;
            } catch (error) {
                throw new Error('Failed to get access token. Make sure you are authenticated with gcloud.');
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
    args.messages.forEach(message => {
        // 画像ファイルなどが入ってきたとき用の整理
        if (typeof message.content === 'string') {
            if (message.role === 'system') {
                // systemはsystemInstructionに入れる
                req.systemInstruction = message.content;
            } else {
                req.contents.push({ role: message.role, parts: [{ text: message.content }] });
            }
        } else if (Array.isArray(message.content)) {
            const remappedContent = {
                role: message.role,
                parts:
                    message.content.map(content => {
                        if (content.type === 'image_url') {
                            // TODO URLには対応していない
                            if (content.image_url.url.startsWith('data:video/')) {
                                return { inlineData: { mimeType: content.image_url.url.substring(5, content.image_url.url.indexOf(';')), data: content.image_url.url.substring(content.image_url.url.indexOf(',') + 1) }, video_metadata: {} };
                            } else if (content.image_url.url.startsWith('data:')) {
                                return { inlineData: { mimeType: content.image_url.url.substring(5, content.image_url.url.indexOf(';')), data: content.image_url.url.substring(content.image_url.url.indexOf(',') + 1) }, };
                            } else {
                                return { file_data: { file_uri: content.image_url.url } };
                            }
                        } else if (content.type === 'text') {
                            return { text: content.text as string };
                        } else {
                            console.log('unknown sub message type');
                            return null;
                        }
                    }).filter(is => is) as Part[],
            };
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
    return req;
}


//   {
//     "name": "projects/458302438887/locations/us-central1/cachedContents/6723733506175795200",
//     "model": "projects/gcp-cloud-shosys-ai-002/locations/us-central1/publishers/google/models/gemini-1.5-flash-001",
//     "createTime": "2024-07-10T19:43:13.542566Z",
//     "updateTime": "2024-07-10T19:43:13.542566Z",
//     "expireTime": "2024-07-10T20:43:13.521815Z"
//   }

export function mapForGeminiExtend(args: ChatCompletionCreateParamsBase, _req?: GenerateContentRequest): GenerateContentRequestExtended {
    const req: GenerateContentRequestExtended = (_req || mapForGemini(args)) as GenerateContentRequestExtended;
    req.generationConfig = {
        maxOutputTokens: args.max_tokens || 8192,
        temperature: args.temperature || 0.1,
        topP: args.top_p || 0.95,
    };
    req.safetySettings = [
        // // ここの指定をするとマルチモーダルの時にエラーになることがあるので何もしないことにした。
        // { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE, },
        // { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE, },
        // { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE, },
        // { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE, }
    ];

    const cachedContent = (args as any).cachedContent as CachedContent;
    // console.dir(cachedContent);
    if (cachedContent) {
        req.region = 'us-central1'; // コンテキストキャッシュ機能は us-central1 で固定
        req.resourcePath = cachedContent.model;
        req.cached_content = cachedContent.name;
    } else {
        req.region = GCP_REGION || 'asia-northeast1';
        req.resourcePath = `projects/${GCP_PROJECT_ID}/locations/${req.region}/publishers/google/models/${args.model}`;
    }
    return req;
}

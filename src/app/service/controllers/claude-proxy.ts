import { Usage } from "@anthropic-ai/sdk/resources.js";
import axios, { AxiosResponse } from 'axios';
import * as crypto from 'crypto';
import { Request, Response } from "express";
import { body } from "express-validator/lib/index.js";
import * as fs from 'fs';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { Stream } from "stream";
import { calcCost } from '../../common/ai/providers/anthropic.js';
import { MyVertexAiClient } from '../../common/ai/providers/vertexai.js';
import { TokenCount } from "../../common/ai/token-cost.js";
import fss from '../../common/fss.js';
import { Utils } from "../../common/utils.js";
import { getPredictHistoryLoggerForRequest, logPredictHistoryWithContext, PredictHistoryLogContext, ServicePredictHistoryLogger } from '../common/predict-history-logger.js';
import { validationErrorHandler } from "../middleware/validation.js";
import { UserRequest } from "../models/info.js";
import { PredictHistoryStatus } from "../models/values.js";
import { getAIProviderAndModel } from "./chat-by-project-model.js";

const { GCP_PROJECT_ID, GCP_REGION, GCP_REGION_ANTHROPIC, GCP_API_BASE_PATH } = process.env;

/**
 * UnzipなどのStreamからbody文字列を読み出すユーティリティ関数
 */
export function readBodyFromUnzip(stream: Stream): Promise<string> {
    return new Promise<string>((resolve, reject) => {
        let data = '';
        (stream as any).setEncoding('utf8');
        stream.on('data', chunk => { data += chunk; });
        stream.on('end', () => resolve(data));
        stream.on('error', err => reject(err));
    });
}


// 履歴ディレクトリ
const HISTORY_DIRE = `./history`;

// プロキシ設定
const proxyObj: { [key: string]: any } = {
    httpProxy: process.env['http_proxy'] as string || undefined,
    httpsProxy: process.env['https_proxy'] as string || undefined,
};
const noProxies = process.env['no_proxy']?.split(',') || [];
let host = '';
Object.keys(proxyObj).filter(key => noProxies.includes(host) || !proxyObj[key]).forEach(key => delete proxyObj[key]);
const options = Object.keys(proxyObj).filter(key => proxyObj[key]).length > 0 ? {
    httpAgent: new HttpsProxyAgent(proxyObj.httpsProxy || proxyObj.httpProxy || ''),
} : {};

/**
 * ログ出力用クラス
 */
class LogObject {
    lastTakeMs: number = 0;
    constructor(public baseTime: number, public tokenCount: TokenCount, public idempotencyKey: string, public label: string) { }

    output(stepName: string, error: any = '', message: string = ''): string {
        const _take = Date.now() - this.baseTime;
        this.lastTakeMs = _take;
        const take = _take.toLocaleString().padStart(10, ' ');
        this.baseTime = Date.now();

        const prompt_tokens = this.tokenCount.prompt_tokens.toLocaleString().padStart(6, ' ');
        const completion_tokens = this.tokenCount.completion_tokens.toLocaleString().padStart(6, ' ');

        const logString = `${Utils.formatDate()} ${stepName.padEnd(5, ' ')} 0 ${take} ${prompt_tokens} ${completion_tokens} ${this.tokenCount.model} ${this.label} ${error}`;

        fss.appendFile(`history.log`, `${logString} ${message}\n`, {}, () => { });
        return logString;
    }
}

// 初期化
try { fs.mkdirSync(`${HISTORY_DIRE}`, { recursive: true }); } catch (e) { }
// console.log(`timestamp               step  R time[ms]  prompt comple model    label`);

/**
 * Vertex AI の URL を生成
 */
function buildVertexUrl(project: string, location: string, model: string, method: 'predict' | 'streamRawPredict'): string {
    const baseUrl = location === 'global' ? GCP_API_BASE_PATH : `${location}-${GCP_API_BASE_PATH}`;
    return `https://${baseUrl}/v1/projects/${project}/locations/${location}/publishers/anthropic/models/${model}:${method}`;
}

/**
 * 共通の初期化処理
 */
async function initializeRequest(req: UserRequest, modelName: string, suffix: string) {
    const timestamp = Utils.formatDate(new Date(), 'yyyyMMddHHmmssSSS');
    const argsHash = crypto.createHash('MD5').update(JSON.stringify(req.body)).digest('hex');
    const idempotencyKey = `${timestamp}-${argsHash}-${suffix}`;
    const label = argsHash;

    // const modelObject = await ds.getRepository(AIModelEntity).findOneByOrFail({ name: modelName || 'claude-3-5-sonnet-20241022' });
    // const modelPrice = await ds.getRepository(AIModelPricingEntity).findOneOrFail({ where: { modelId: modelObject.id }, order: { validFrom: 'DESC' } });

    const { aiProvider, aiModel, aiPrice } = await getAIProviderAndModel(req.info.user, modelName);

    const tokenCount = new TokenCount(modelName, 0, 0);
    const logObject = new LogObject(Date.now(), tokenCount, idempotencyKey, label);

    return { idempotencyKey, label, argsHash, tokenCount, aiProvider, aiModel, aiPrice, logObject, modelName };
}

function buildHistoryContext(method: string, params: {
    idempotencyKey: string;
    argsHash: string;
    aiProvider?: { name?: string } | null;
    aiModel?: { name?: string } | null;
    modelName: string;
    tokenCount: TokenCount;
}): PredictHistoryLogContext {
    return {
        idempotencyKey: params.idempotencyKey,
        argsHash: params.argsHash,
        label: `vertexai-claude-proxy-${method}`,
        provider: params.aiProvider?.name || 'anthropic_vertex',
        model: params.aiModel?.name || params.modelName,
        tokenCount: params.tokenCount,
    };
}

/**
 * 共通のエラーハンドリング
 */
async function handleError(
    error: any,
    logObject: LogObject,
    idempotencyKey: string,
    res: Response,
    predictLogger?: ServicePredictHistoryLogger,
    historyContext?: PredictHistoryLogContext,
    status: PredictHistoryStatus = PredictHistoryStatus.Error,
) {
    console.log(logObject.output('error', error.response?.data || error.message));

    fss.writeFile(`${HISTORY_DIRE}/${idempotencyKey}.error.json`, JSON.stringify({
        error: error.message,
        // response: err.response?.data,
        // stack: err.stack,
    }, Utils.genJsonSafer()), {}, () => { });

    const httpStatus = error.response?.status || 500;
    const data = error.response?.data || { error: error.message };

    if (data && typeof data.on === "function") {
        const body = await readBodyFromUnzip(data);
        console.error("status:", httpStatus, "body:", body);
    } else {
        console.error("status:", httpStatus, "data:", data);
    }

    if (predictLogger && historyContext) {
        const serialized = typeof data === 'string' ? data : JSON.stringify(data, Utils.genJsonSafer());
        try {
            await logPredictHistoryWithContext(predictLogger, {
                ...historyContext,
                takeMs: logObject.lastTakeMs,
                tokenCount: {
                    prompt: historyContext.tokenCount?.prompt,
                    completion: historyContext.tokenCount?.completion,
                    cost: historyContext.tokenCount?.cost,
                },
                message: serialized,
            }, status);
        } catch (logError) {
            console.error('Failed to persist predict history', logError);
        }
    }
}

/**
 * 共通のバリデーション
 */
const commonValidation = [
    body('messages').isArray().withMessage('messages must be an array'),
    body('messages.*.role').isIn(['user', 'assistant']).withMessage('messages must contain role "user" or "assistant"'),
    body('anthropic_version').optional().isString().withMessage('anthropic_version must be a string'),
    body('stream').optional().isBoolean().withMessage('stream must be a boolean'),
    body('temperature').optional().isFloat({ min: 0, max: 1 }).withMessage('temperature must be a float between 0 and 1'),
    body('top_p').optional().isFloat({ min: 0, max: 1 }).withMessage('top_p must be a float between 0 and 1'),
    body('max_output_tokens').optional().isInt({ min: 1 }).withMessage('max_output_tokens must be an integer greater than 0'),
    body('top_k').optional().isInt({ min: 0 }).withMessage('top_k must be an integer greater than or equal to 0'),
    body('stop_sequences').optional().isArray().withMessage('stop_sequences must be an array'),
    body('stop_sequences.*').optional().isString().withMessage('stop_sequences must contain strings'),
    validationErrorHandler,
];

/**
 * count-tokens用のバリデーション
 */
const countTokensValidation = [
    body('messages').isArray().withMessage('messages must be an array'),
    body('messages.*.role').isIn(['user', 'assistant']).withMessage('messages must contain role "user" or "assistant"'),
    body('model').isString().withMessage('model must be a string'),
    body('anthropic_version').optional().isString().withMessage('anthropic_version must be a string'),
    body('system').optional().isString().withMessage('system must be a string'),
    body('tools').optional().isArray().withMessage('tools must be an array'),
    validationErrorHandler,
];

const my_vertexai = new MyVertexAiClient([{
    project: GCP_PROJECT_ID || '',
    locationList: [GCP_REGION || 'asia-northeast1'],
    apiEndpoint: `${GCP_REGION}-${GCP_API_BASE_PATH}`,
    httpAgent: options.httpAgent,
}]);

/**
 * 共通の前処理
 */
async function commonPreProcess(req: UserRequest, suffix: string) {
    const { project, location, model } = req.params;
    const modelName = (model || req.body?.model || 'claude-3-5-sonnet-20241022') as string;

    const { idempotencyKey, label, argsHash, aiModel, aiProvider, aiPrice, tokenCount, logObject } = await initializeRequest(req, modelName, suffix);
    console.log(logObject.output('start'));

    const providerConfig = (aiProvider?.config || {}) as { projectId?: string; regionList?: string[] };
    const regionList = (Array.isArray(providerConfig.regionList) && providerConfig.regionList.length > 0)
        ? providerConfig.regionList
        : [GCP_REGION_ANTHROPIC || location || 'us-central1'];
    const targetProject = providerConfig.projectId || GCP_PROJECT_ID || project || 'default-project';
    const targetLocation = regionList[Math.floor(Math.random() * regionList.length)];

    const instance = req.body;
    if (!instance || !Array.isArray(instance.messages)) {
        console.log(logObject.output('error', 'Invalid request: messages が必要です'));
        throw new Error('Invalid request: messages が必要です');
    }

    const vertexUrl = buildVertexUrl(targetProject, targetLocation, modelName, suffix as any);
    const historyContext = buildHistoryContext(suffix, {
        idempotencyKey,
        argsHash,
        aiProvider,
        aiModel,
        modelName,
        tokenCount,
    });

    return { instance, vertexUrl, idempotencyKey, aiProvider, aiModel, aiPrice, tokenCount, logObject, historyContext };
}

/**
 * POST /v1/messages/count_tokens
 */
export const vertexAIByAnthropicAPICountTokens = [
    ...countTokensValidation,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;

        try {
            const { model, messages, system, tools, anthropic_version } = req.body;
            const modelName = model || 'claude-3-5-sonnet-20241022';

            const { idempotencyKey, label, tokenCount, logObject } = await initializeRequest(req, modelName, 'count_tokens');

            // Vertex AI doesn't have a direct count tokens endpoint, so we'll use the token counting logic
            // from the existing token counting service
            const content = [];

            // Add system message if present
            if (system) {
                content.push({ type: 'text', text: system });
            }

            // Add messages
            for (const message of messages) {
                if (message.content) {
                    if (typeof message.content === 'string') {
                        content.push({ type: 'text', text: message.content });
                    } else if (Array.isArray(message.content)) {
                        for (const contentPart of message.content) {
                            if (contentPart.type === 'text') {
                                content.push({ type: 'text', text: contentPart.text });
                            } else if (contentPart.type === 'image') {
                                // For images, we'll estimate token count
                                content.push({ type: 'image', data: contentPart.source?.data || '' });
                            }
                        }
                    }
                }
            }

            // Add tools if present
            if (tools && Array.isArray(tools)) {
                for (const tool of tools) {
                    content.push({ type: 'text', text: JSON.stringify(tool) });
                }
            }

            // Calculate token count using existing logic
            let totalInputTokens = 0;

            for (const contentPart of content) {
                if (contentPart.type === 'text') {
                    // Use simple character-based estimation similar to existing code
                    const textTokens = Math.ceil(contentPart.text.length / 4); // 4 chars per token estimate
                    totalInputTokens += textTokens;
                } else if (contentPart.type === 'image') {
                    // Image token estimation (typical vision model token count)
                    totalInputTokens += 1568; // Standard vision token count for images
                }
            }

            tokenCount.prompt_tokens = totalInputTokens;
            tokenCount.completion_tokens = 0; // Count tokens endpoint doesn't generate completion

            console.log(logObject.output('count', '', JSON.stringify({
                input_tokens: totalInputTokens
            })));

            // Return response in Anthropic format
            const response = {
                input_tokens: totalInputTokens
            };

            res.status(200).json(response);
        } catch (err: any) {
            const { idempotencyKey, logObject } = await initializeRequest(req, 'claude-3-5-sonnet-20241022', 'count_tokens').catch(() => ({
                idempotencyKey: 'error',
                logObject: new LogObject(Date.now(), new TokenCount(req.params.model), 'error', 'error')
            }));
            await handleError(err, logObject, idempotencyKey, res);
        }
    }
];

/**
 * POST /v1/projects/:project/locations/:location/publishers/anthropic/models/:model:predict
 */
export const vertexAIByAnthropicAPI = [
    ...commonValidation,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        const predictLogger = getPredictHistoryLoggerForRequest(req);

        try {
            const { instance, vertexUrl, idempotencyKey, aiModel, aiProvider, aiPrice, tokenCount, logObject, historyContext } =
                await commonPreProcess(req, 'rawPredict');

            // リクエストをファイルに書き出す
            fss.writeFile(`${HISTORY_DIRE}/${idempotencyKey}.request.json`,
                JSON.stringify({ instance, url: vertexUrl }, Utils.genJsonSafer()), {}, () => { });

            console.log(logObject.output('call'));

            let vertexResponse: AxiosResponse | undefined;
            const maxRetries = 2;
            let lastError: any;

            for (let attempt = 1; attempt <= maxRetries; attempt++) {
                try {
                    // 401エラーで再試行する場合はトークンを強制リフレッシュ
                    const forceTokenRefresh = attempt > 1 && lastError?.response?.status === 401;
                    const accessToken = await my_vertexai.getAccessToken(forceTokenRefresh);
                    vertexResponse = await axios.post(vertexUrl, instance, {
                        headers: {
                            Authorization: `Bearer ${accessToken}`,
                            'Content-Type': 'application/json; charset=UTF-8',
                        },
                        responseType: 'json',
                        httpAgent: options.httpAgent,
                    });
                    break; // 成功したらループを抜ける
                } catch (error) {
                    lastError = error;
                    // console.log(`Attempt ${attempt} failed:`, error);
                    // console.log(`Attempt ${attempt} failed: ${(error as any).statusCode} ${(error as any).statusCode}`);

                    if (attempt === maxRetries) {
                        throw lastError; // 最後の試行で失敗したら元のエラーを投げる
                    }
                    // 401エラーの場合は短時間で再試行、それ以外は遅延なし
                    if (lastError?.response?.status === 401) {
                        await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
                    }
                }
            }

            if (!vertexResponse) {
                throw new Error('Vertex AI response is undefined after retries');
            }

            // レスポンスからトークン数を取得
            if (vertexResponse.data?.usage) {
                let usageCost = calcCost(vertexResponse.data, aiPrice);
                tokenCount.prompt_tokens = usageCost.prompt_tokens;
                tokenCount.completion_tokens = usageCost.completion_tokens;
                tokenCount.cost = usageCost?.cost || 0;
            }

            // レスポンステキストを抽出（ログ用）
            if (vertexResponse.data?.content) {
                const responseText = Array.isArray(vertexResponse.data.content)
                    ? vertexResponse.data.content.map((item: any) => item.text || '').join('')
                    : vertexResponse.data.content.toString();
                tokenCount.tokenBuilder = responseText;
            }

            // ファイル書き出し
            fss.writeFile(`${HISTORY_DIRE}/${idempotencyKey}.response.json`,
                JSON.stringify({ instance, url: vertexUrl, headers: vertexResponse.headers, response: vertexResponse.data }, Utils.genJsonSafer()), {}, () => { });
            fss.writeFile(`${HISTORY_DIRE}/${idempotencyKey}.result.md`, tokenCount.tokenBuilder || '', {}, () => { });

            console.log(logObject.output('fine', '', JSON.stringify(vertexResponse.data.usage)));
            await predictLogger.log({
                idempotencyKey,
                argsHash: historyContext.argsHash,
                label: historyContext.label,
                provider: historyContext.provider,
                model: historyContext.model,
                take: logObject.lastTakeMs,
                reqToken: tokenCount.prompt_tokens,
                resToken: tokenCount.completion_tokens,
                cost: tokenCount.cost,
                status: PredictHistoryStatus.Fine,
                message: JSON.stringify(vertexResponse.data.usage || {}, Utils.genJsonSafer()),
            });

            res.status(vertexResponse.status).json(vertexResponse.data);
        } catch (err: any) {
            const { idempotencyKey, logObject, historyContext } = await commonPreProcess(req, 'predict').catch(() => ({
                idempotencyKey: 'error',
                logObject: new LogObject(Date.now(), new TokenCount(req.params.model), 'error', 'error'),
                historyContext: undefined,
            }));
            await handleError(err, logObject, idempotencyKey, res, predictLogger, historyContext);
        }
    }
];

/**
 * POST /v1/projects/:project/locations/:location/publishers/anthropic/models/:model:streamRawPredict
 */
export const vertexAIByAnthropicAPIStream = [
    ...commonValidation,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        const predictLogger = getPredictHistoryLoggerForRequest(req);
        console.log(`Request: ${req.method} ${req.originalUrl}`);

        try {
            const { instance, vertexUrl, idempotencyKey, aiModel, aiProvider, aiPrice, tokenCount, logObject, historyContext } =
                await commonPreProcess(req, 'streamRawPredict');

            let vertexResponse: AxiosResponse | undefined;
            let lastError: any;
            const maxRetries = 2; // リトライ回数

            for (let attempt = 1; attempt <= maxRetries; attempt++) {
                try {

                    instance.stream = true;
                    // console.log(`Forwarding to Vertex AI at ${vertexUrl}`);

                    // リクエストをファイルに書き出す
                    fss.writeFile(`${HISTORY_DIRE}/${idempotencyKey}.request.json`,
                        JSON.stringify({ instance, url: vertexUrl }, Utils.genJsonSafer()), {}, () => { });

                    console.log(logObject.output('call'));

                    // 401エラーで再試行する場合はトークンを強制リフレッシュ
                    const forceTokenRefresh = attempt > 1 && lastError?.response?.status === 401;
                    const accessToken = await my_vertexai.getAccessToken(forceTokenRefresh);
                    vertexResponse = await axios.post(vertexUrl, instance, {
                        headers: {
                            Authorization: `Bearer ${accessToken}`,
                            'Content-Type': 'application/json; charset=UTF-8',
                        },
                        responseType: 'stream',
                        httpAgent: options.httpAgent,
                    });

                    // レスポンスヘッダーをログ
                    const headers: { [key: string]: string } = {};
                    if (vertexResponse) {
                        Object.entries(vertexResponse.headers).forEach(([key, value]) => {
                            headers[key] = Array.isArray(value) ? value.join(', ') : String(value);
                        });
                    } else { }
                    fss.writeFile(`${HISTORY_DIRE}/${idempotencyKey}.response.json`,
                        JSON.stringify({ instance, url: vertexUrl, headers }, Utils.genJsonSafer()), {}, () => { });

                    break; // 成功したらループを抜ける
                } catch (error) {
                    lastError = error;
                    console.log(`Attempt ${attempt} failed: ${(error as any).statusCode} ${(error as any).statusCode}`);

                    // レスポンスヘッダーをログ
                    const headers: { [key: string]: string } = {};
                    if (vertexResponse) {
                        Object.entries(vertexResponse.headers).forEach(([key, value]) => {
                            headers[key] = Array.isArray(value) ? value.join(', ') : String(value);
                        });
                    } else { }
                    fss.writeFile(`${HISTORY_DIRE}/${idempotencyKey}.response.json`,
                        JSON.stringify({ instance, url: vertexUrl, headers }, Utils.genJsonSafer()), {}, () => { });

                    if (attempt === maxRetries) {
                        throw lastError; // 最後の試行で失敗したら元のエラーを投げる
                    }
                    // 401エラーの場合は短時間で再試行、それ以外は遅延なし
                    if (lastError?.response?.status === 401) {
                        await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
                    } else {
                        await new Promise(resolve => setTimeout(resolve, 0 * attempt));
                    }
                }
            }
            if (!vertexResponse) {
                throw new Error('Vertex AI response is undefined after retries');
            }

            res.setHeader('Content-Type', 'text/event-stream;charset=utf-8');

            let tokenBuilder = '';
            let message = '';
            let error: string | undefined;

            // バッファを初期化（関数の外で定義）
            let dataBuffer = '';

            const usage = {
                input_tokens: 0,
                output_tokens: 0,
                cache_creation_input_tokens: 0,
                cache_read_input_tokens: 0,
            };

            // ストリーミングデータの監視
            vertexResponse.data.on('data', (chunk: Buffer) => {
                const chunkStr = chunk.toString();

                // チャンクをバッファに追加
                dataBuffer += chunkStr;

                // 完全な行を処理
                const lines = dataBuffer.split('\n');

                // 最後の要素は未完了の可能性があるので保持
                dataBuffer = lines.pop() || '';

                // 完全な行のみを処理
                for (const line of lines) {
                    if (line.startsWith('data: ')) {
                        try {
                            const jsonString = line.substring(6);
                            fss.appendFile(`${HISTORY_DIRE}/${idempotencyKey}.txt`, jsonString + '\n', {}, () => { });
                            const data = JSON.parse(jsonString);
                            if (data.type === 'content_block_delta' && data.delta?.text) {
                                tokenBuilder += data.delta.text;
                            } else if (data.type === 'message_delta') {
                            } else if (data.type === 'message_start') {
                            }
                            let _usage = data.usage ? data.usage as Usage : (data.message && data.message.usage ? data.message.usage : null);
                            if (_usage) {
                                usage.input_tokens += _usage.input_tokens || 0;
                                usage.output_tokens += _usage.output_tokens || 0;
                                usage.cache_creation_input_tokens += _usage.cache_creation_input_tokens || 0;
                                usage.cache_read_input_tokens += _usage.cache_read_input_tokens || 0;
                                tokenCount.prompt_tokens += _usage.input_tokens || 0;
                                tokenCount.completion_tokens += _usage.output_tokens || 0;
                            }
                        } catch (e) {
                            // JSON parse error - 無効な行をスキップ
                            console.warn('Invalid JSON line:', line);
                        }
                    }
                }
            });

            // ストリーム終了時に残りのバッファを処理
            vertexResponse.data.on('end', async () => {
                // 最後に残ったデータがあれば処理
                if (dataBuffer.trim() && dataBuffer.startsWith('data: ')) {
                    try {
                        const data = JSON.parse(dataBuffer.substring(6));
                        if (data.type === 'content_block_delta' && data.delta?.text) {
                            tokenBuilder += data.delta.text;
                        } else if (data.type === 'message_delta' && data.usage) {
                        }
                        let _usage = data.usage ? data.usage as Usage : (data.message && data.message.usage ? data.message.usage : null);
                        if (_usage) {
                            usage.input_tokens += _usage.input_tokens || 0;
                            usage.output_tokens += _usage.output_tokens || 0;
                            usage.cache_creation_input_tokens += _usage.cache_creation_input_tokens || 0;
                            usage.cache_read_input_tokens += _usage.cache_read_input_tokens || 0;
                            tokenCount.prompt_tokens += _usage.input_tokens || 0;
                            tokenCount.completion_tokens += _usage.output_tokens || 0;
                        }
                    } catch (e) {
                        console.warn('Invalid JSON in final buffer:', dataBuffer);
                    }
                }

                // const aiPrice = TokenCount.COST_TABLE[aiModel.name];
                message = JSON.stringify(usage, Utils.genJsonSafer());
                // tokenCount.cost = 0;
                // tokenCount.cost += usage.input_tokens * aiPrice.prompt / 1_000_000; // 1Mトークンあたりのコストを掛ける
                // tokenCount.cost += usage.output_tokens * aiPrice.completion / 1_000_000; // 1Mトークンあたりのコストを掛ける
                // // args.modelはthinkingが外れてるのでcommonArgsのmodelを使う
                // if (usage.cache_creation_input_tokens && aiPrice && aiPrice.metadata?.cache_creation_input_tokens > 0) {
                //     tokenCount.cost += usage.cache_creation_input_tokens * aiPrice.metadata?.cache_creation_input_tokens / 1_000_000; // 1Mトークンあたりのコストを掛ける
                // } else { }
                // if (usage.cache_read_input_tokens && aiPrice && aiPrice.metadata?.cache_read_input_tokens > 0) {
                //     tokenCount.cost += usage.cache_read_input_tokens * aiPrice.metadata?.cache_read_input_tokens / 1_000_000; // 1Mトークンあたりのコストを掛ける
                // } else { }

                // バッファをクリア
                dataBuffer = '';

                tokenCount.tokenBuilder = tokenBuilder;
                fss.writeFile(`${HISTORY_DIRE}/${idempotencyKey}.result.md`, tokenBuilder || '', {}, () => { });

                console.log(logObject.output('fine', '', JSON.stringify({
                    prompt_tokens: tokenCount.prompt_tokens,
                    completion_tokens: tokenCount.completion_tokens
                })));
                try {
                    await predictLogger.log({
                        idempotencyKey,
                        argsHash: historyContext.argsHash,
                        label: historyContext.label,
                        provider: historyContext.provider,
                        model: historyContext.model,
                        take: logObject.lastTakeMs,
                        reqToken: tokenCount.prompt_tokens,
                        resToken: tokenCount.completion_tokens,
                        cost: tokenCount.cost,
                        status: PredictHistoryStatus.Fine,
                        message,
                    });
                } catch (logError) {
                    console.error('Failed to persist streaming predict history', logError);
                }
            });

            vertexResponse.data.on('error', async (error: Error) => {
                console.log(logObject.output('error', error.message));
                fss.writeFile(`${HISTORY_DIRE}/${idempotencyKey}.error.json`,
                    JSON.stringify({ error: error.message, stack: error.stack }, Utils.genJsonSafer()), {}, () => { });
                try {
                    await predictLogger.log({
                        idempotencyKey,
                        argsHash: historyContext.argsHash,
                        label: historyContext.label,
                        provider: historyContext.provider,
                        model: historyContext.model,
                        take: logObject.lastTakeMs,
                        reqToken: tokenCount.prompt_tokens,
                        resToken: tokenCount.completion_tokens,
                        cost: tokenCount.cost,
                        status: PredictHistoryStatus.Error,
                        message: error.message,
                    });
                } catch (logError) {
                    console.error('Failed to persist streaming error history', logError);
                }
            });

            vertexResponse.data.pipe(res);
        } catch (err: any) {
            const { idempotencyKey, logObject, historyContext } = await commonPreProcess(req, 'streamRawPredict').catch(() => ({
                idempotencyKey: 'error',
                logObject: new LogObject(Date.now(), new TokenCount(req.params.model, 0, 0), 'error', 'error'),
                historyContext: undefined,
            }));
            await handleError(err, logObject, idempotencyKey, res, predictLogger, historyContext);
        }
    }
];

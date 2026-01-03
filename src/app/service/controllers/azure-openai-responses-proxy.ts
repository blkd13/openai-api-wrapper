import axios from 'axios';
import * as crypto from 'crypto';
import { Request, Response } from "express";
import { body } from "express-validator/lib/index.js";
import * as fs from 'fs';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { Stream } from "stream";

import { ResponseUsage } from 'openai/resources/responses/responses.js';
import { TokenCount } from "../../common/ai/token-cost.js";
import fss from '../../common/fss.js';
import { GPTModels } from "../../common/model-definition.js";
import { Utils } from "../../common/utils.js";
import { getPredictHistoryLoggerForRequest, logPredictHistoryWithContext, PredictHistoryLogContext, ServicePredictHistoryLogger } from '../common/predict-history-logger.js';
import { AzureOpenAIConfig } from "../entity/ai-model-manager.entity.js";
import { validationErrorHandler } from "../middleware/validation.js";
import { UserRequest } from "../models/info.js";
import { PredictHistoryStatus } from "../models/values.js";
import { getAIProviderAndModel } from "./chat-by-project-model.js";

const { OPENAI_API_BASE } = process.env;

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

const { AZURE_OPENAI_SOCKS_PROXY } = process.env as { AZURE_OPENAI_SOCKS_PROXY: string };

// axios用のSOCKS5プロキシエージェントを作成
function createAxiosProxyAgent(proxyString: string) {
    if (!proxyString) {
        return undefined;
    }
    if (proxyString.startsWith('socks5://') || proxyString.startsWith('socks://')) {
        return new SocksProxyAgent(proxyString);
    }
    // HTTP/HTTPSプロキシの場合は別のエージェントが必要
    return undefined;
}

const axiosProxyAgent = createAxiosProxyAgent(AZURE_OPENAI_SOCKS_PROXY);

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

/**
 * OpenAI Responses API の URL を生成
 */
function buildOpenAIUrl(apiBase: string, apiVersion: string): string {
    const base = apiBase.replace(/\/+$/, '');
    return `${base}/responses?api-version=${apiVersion}`;
}

/**
 * 共通の初期化処理
 */
async function initializeRequest(req: UserRequest, modelName: string, suffix: string) {
    const timestamp = Utils.formatDate(new Date(), 'yyyyMMddHHmmssSSS');
    const argsHash = crypto.createHash('MD5').update(JSON.stringify(req.body)).digest('hex');
    const idempotencyKey = `${timestamp}-${argsHash}-${suffix}`;
    const label = argsHash;

    const { aiProvider, aiModel, aiPrice } = await getAIProviderAndModel(req.info.user, modelName);

    const tokenCount = new TokenCount(modelName as GPTModels, 0, 0);
    const logObject = new LogObject(Date.now(), tokenCount, idempotencyKey, label);

    return { idempotencyKey, label, argsHash, tokenCount, aiProvider, aiModel, aiPrice, logObject, modelName };
}

function buildHistoryContext(method: string, params: {
    idempotencyKey: string;
    argsHash: string;
    aiProvider?: { name?: string; type?: string } | null;
    aiModel?: { name?: string } | null;
    aiPrice?: { name?: string } | null;
    modelName: string;
    tokenCount: TokenCount;
}): PredictHistoryLogContext {
    return {
        idempotencyKey: params.idempotencyKey,
        argsHash: params.argsHash,
        label: `azure-openai-responses-proxy-${method}`,
        provider: params.aiProvider?.name || 'openai',
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
    const errorMessage = error.message || 'Unknown error';
    console.log(logObject.output('error', errorMessage));

    fss.writeFile(`${HISTORY_DIRE}/${idempotencyKey}.error.json`, JSON.stringify({
        error: errorMessage,
    }, Utils.genJsonSafer()), {}, () => { });

    // axiosの場合、error.responseにレスポンス情報が含まれる
    let httpStatus = 500;
    let data: any = { error: errorMessage };

    if (error.response) {
        // axiosのエラーレスポンスがある場合
        httpStatus = error.response.status || 500;
        data = error.response.data || { error: errorMessage };
    } else {
        // ネットワークエラーなどの場合、エラーメッセージからHTTPステータスを抽出する試み
        const httpStatusMatch = errorMessage.match(/HTTP (\d+):/);
        if (httpStatusMatch) {
            httpStatus = parseInt(httpStatusMatch[1], 10);
        }
    }

    if (data && typeof data.on === "function") {
        const body = await readBodyFromUnzip(data);
        console.error("status:", httpStatus, "body:", body);
    } else {
        console.error("status:", httpStatus, "data:", data);
    }

    // DB logging
    if (predictLogger && historyContext) {
        const serialized = typeof data === 'string' ? data : JSON.stringify(data, Utils.genJsonSafer());
        try {
            await logPredictHistoryWithContext(predictLogger, {
                ...historyContext,
                takeMs: logObject.lastTakeMs,
                tokenCount: {
                    prompt: historyContext.tokenCount?.prompt || 0,
                    completion: historyContext.tokenCount?.completion || 0,
                    cost: historyContext.tokenCount?.cost || 0,
                },
                message: serialized,
            }, status);
        } catch (logError) {
            console.error('Failed to persist predict history', logError);
        }
    }

    // Send HTTP response to client
    if (!res.headersSent) {
        if (data && typeof data.on === "function") {
            const body = await readBodyFromUnzip(data);
            res.status(httpStatus).send(body);
        } else {
            res.status(httpStatus).json(data);
        }
    }
}

/**
 * Responses用の最低限のバリデーション（パススルーのため最小限）
 */
const responsesValidation = [
    body('model').optional().isString().withMessage('model must be a string'),
    body('stream').optional().isBoolean().withMessage('stream must be a boolean'),
    validationErrorHandler,
];

/**
 * 共通の前処理（接続情報の取得のみ）
 */
async function commonPreProcess(req: UserRequest, suffix: string) {
    const modelFromBody = (req.body?.model as string) || 'gpt-4o-mini';
    const { idempotencyKey, label, argsHash, aiModel, aiProvider, aiPrice, tokenCount, logObject, modelName } = await initializeRequest(req, modelFromBody, suffix);
    console.log(logObject.output('start'));

    const instance = req.body || {};
    if (!instance || typeof instance !== 'object') {
        console.log(logObject.output('error', 'Invalid request: body が必要です'));
        throw new Error('Invalid request: body が必要です');
    }

    // APIベースURLはプロバイダの設定か環境変数から取得
    // console.dir(aiProvider, { depth: null });
    const config = aiProvider.config as AzureOpenAIConfig;
    const resource = config.resources[0];
    const baseURL = new URL(resource.baseURL || OPENAI_API_BASE || 'https://api.openai.com/v1');
    let hostname: string | undefined;
    if (baseURL && resource.ipAddress) {
        hostname = baseURL.hostname;
        baseURL.hostname = resource.ipAddress;
    } else { }
    const apiBase = baseURL.toString();
    const apiKey = resource.apiKey;
    const apiVersion = resource.apiVersion;

    const openaiUrl = buildOpenAIUrl(apiBase, apiVersion || '2025-04-01-preview');

    const historyContext = buildHistoryContext(suffix, {
        idempotencyKey,
        argsHash,
        aiProvider,
        aiModel,
        aiPrice,
        modelName,
        tokenCount,
    });

    return { instance, openaiUrl, idempotencyKey, argsHash, aiModel, aiProvider, aiPrice, tokenCount, logObject, apiKey, apiVersion, hostname, historyContext };
}

/**
 * POST /v1/responses
 * OpenAI Responses形式のリクエストをそのまま横流しするプロキシ
 * stream: true の場合はSSEをそのままパイプ
 */
export const azureOpenAIResponseProxy = [
    ...responsesValidation,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        const predictLogger = getPredictHistoryLoggerForRequest(req);

        try {
            console.log(`Request: ${req.ip} ${req.method} ${req.originalUrl}`);

            const suffix = req.body?.stream ? 'responses-stream' : 'responses';
            const { instance, openaiUrl, idempotencyKey, aiModel, aiProvider, aiPrice, tokenCount, logObject, apiKey, apiVersion, hostname, historyContext } =
                await commonPreProcess(req, suffix);

            // クライアントから渡されたIdempotency-Keyがあれば優先し、なければ生成したキーを使用
            const upstreamIdempotencyKey = (req.headers['idempotency-key'] || req.headers['Idempotency-Key'] || '') as string;
            const idempotencyKeyUsed = upstreamIdempotencyKey || idempotencyKey;

            // リクエストをファイルに書き出す（そのまま）
            fss.writeFile(`${HISTORY_DIRE}/${idempotencyKey}.request.json`,
                JSON.stringify({ instance, url: openaiUrl }, Utils.genJsonSafer()), {}, () => { });

            console.log(logObject.output('call'));

            let openaiResponse: any | undefined;
            const maxRetries = 2;
            let lastError: any;

            const axiosConfigBase: any = {
                method: 'POST',
                url: openaiUrl,
                headers: {
                    Authorization: `Bearer ${apiKey}`,
                    'Content-Type': 'application/json; charset=UTF-8',
                    'Idempotency-Key': idempotencyKeyUsed,
                    Host: hostname || '',
                },
                data: instance,
                responseType: 'stream',
            };

            if (axiosProxyAgent) {
                axiosConfigBase.httpAgent = axiosProxyAgent;
                axiosConfigBase.httpsAgent = axiosProxyAgent;
            }

            // console.log(openaiUrl);
            // console.dir(instance, { depth: null });
            // console.log(JSON.stringify(instance));
            // console.dir(axiosConfigBase, { depth: null });
            if (instance.stream) {
                // ストリーミング（SSE）パススルー
                for (let attempt = 1; attempt <= maxRetries; attempt++) {
                    try {
                        openaiResponse = await axios(axiosConfigBase);
                        break;
                    } catch (error) {
                        lastError = error;
                        console.log(`Attempt ${attempt} failed: ${(error as any).response?.status} ${(error as any).message}`);
                        if (attempt === maxRetries) throw lastError;
                        await new Promise(resolve => setTimeout(resolve, 500 * attempt));
                    }
                }
                if (!openaiResponse) {
                    throw new Error('OpenAI response is undefined after retries');
                }

                // レスポンスヘッダーをログ
                const headers: { [key: string]: string } = openaiResponse.headers || {};
                fss.writeFile(`${HISTORY_DIRE}/${idempotencyKey}.response.json`,
                    JSON.stringify({ instance, url: openaiUrl, headers }, Utils.genJsonSafer()), {}, () => { });

                res.setHeader('Content-Type', 'text/event-stream;charset=utf-8');

                let tokenBuilder = '';
                let dataBuffer = '';
                const usage: ResponseUsage = { input_tokens: 0, output_tokens: 0 } as ResponseUsage;
                const usageList: ResponseUsage[] = [];

                // ストリーム解析（ログ・使用量集計用）。クライアントへはそのままパイプ。
                const stream = openaiResponse.data;

                stream.on('data', (chunk: Buffer) => {
                    const chunkStr = chunk.toString('utf8');
                    res.write(chunkStr); // クライアントへそのまま転送
                    // console.log(chunkStr);

                    // ログ用バッファリング
                    dataBuffer += chunkStr;
                    const lines = dataBuffer.split('\n');
                    dataBuffer = lines.pop() || '';

                    for (const line of lines) {
                        if (line.startsWith('data: ')) {
                            const jsonString = line.substring(6);
                            fss.appendFile(`${HISTORY_DIRE}/${idempotencyKey}.txt`, jsonString + '\n', {}, () => { });
                            try {
                                const data = JSON.parse(jsonString);

                                // 出力テキスト抽出（可能な範囲で）
                                if (typeof data.output_text === 'string') {
                                    tokenBuilder += data.output_text;
                                } else if (data.delta?.output_text) {
                                    tokenBuilder += data.delta.output_text;
                                } else if (Array.isArray(data.content)) {
                                    for (const c of data.content) {
                                        if (c?.type === 'output_text' && typeof c?.text === 'string') {
                                            tokenBuilder += c.text;
                                        } else if (c?.delta?.text) {
                                            tokenBuilder += c.delta.text;
                                        }
                                    }
                                }

                                // usage集計
                                const u: ResponseUsage = data.response?.usage || data.usage;
                                if (u) {
                                    usageList.push(u);
                                }
                            } catch (e) {
                                // JSON parse error - 無効な行をスキップ
                                console.warn('Invalid JSON line:', line);
                            }
                        }
                    }
                });

                await new Promise<void>((resolve, reject) => {
                    stream.on('end', () => {
                        // 残りのバッファ処理
                        if (dataBuffer.trim().startsWith('data: ')) {
                            try {
                                const data = JSON.parse(dataBuffer.substring(6));
                                if (typeof data.output_text === 'string') {
                                    tokenBuilder += data.output_text;
                                } else if (data.delta?.output_text) {
                                    tokenBuilder += data.delta.output_text;
                                }

                                const u: ResponseUsage = data.response?.usage || data.usage;
                                if (u) {
                                    usageList.push(u);
                                }
                            } catch (e) {
                                console.warn('Invalid JSON in final buffer:', dataBuffer);
                            }
                        }
                        dataBuffer = '';
                        resolve();
                    });
                    stream.on('error', reject);
                });

                // コスト計算
                tokenCount.prompt_tokens = usage.input_tokens || 0;
                tokenCount.completion_tokens = usage.output_tokens || 0;
                tokenCount.cost = 0;
                if (aiPrice && usageList.length > 0) {
                    if (usageList.length === 1) {
                        Object.assign(usage, usageList[0]);
                    } else {
                        usage.input_tokens = 0;
                        usage.output_tokens = 0;
                        usage.total_tokens = 0;
                        for (const u of usageList) {
                            usage.input_tokens = (usage.input_tokens || 0) + (u.input_tokens || 0);
                            usage.output_tokens = (usage.output_tokens || 0) + (u.output_tokens || 0);

                            if (u.input_tokens_details) {
                                if (usage.input_tokens_details) {
                                    usage.input_tokens_details.cached_tokens = 0;
                                } else {
                                    usage.input_tokens_details = { cached_tokens: 0 };
                                }
                            } else { }

                            if (usage.output_tokens_details) {
                                if (usage.output_tokens_details) {
                                    usage.output_tokens_details.reasoning_tokens = 0;
                                } else {
                                    usage.output_tokens_details = { reasoning_tokens: 0 };
                                }
                            } else { }
                        }
                    }
                    if (usage.input_tokens_details && usage.input_tokens_details.cached_tokens && usage.input_tokens_details.cached_tokens > 0 && aiPrice.metadata && aiPrice.metadata.cached_tokens) {
                        const billableInputTokens = usage.input_tokens - usage.input_tokens_details.cached_tokens;
                        tokenCount.cost += usage.input_tokens_details.cached_tokens * (aiPrice.metadata.cached_tokens || 0) / 1_000_000;
                        tokenCount.cost += billableInputTokens * (aiPrice.inputPricePerUnit || 0) / 1_000_000;
                        tokenCount.cost += usage.output_tokens * (aiPrice.outputPricePerUnit || 0) / 1_000_000;
                    } else {
                        tokenCount.cost += usage.input_tokens * (aiPrice.inputPricePerUnit || 0) / 1_000_000;
                        tokenCount.cost += usage.output_tokens * (aiPrice.outputPricePerUnit || 0) / 1_000_000;
                    }
                } else { }

                tokenCount.tokenBuilder = tokenBuilder;
                fss.writeFile(`${HISTORY_DIRE}/${idempotencyKey}.result.md`, tokenBuilder || '', {}, () => { });

                console.log(logObject.output('fine', '', JSON.stringify({ usage })));
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
                    message: JSON.stringify(usage, Utils.genJsonSafer()),
                });

                // SSE終了
                try { res.end(); } catch (e) { /* ignore */ }
            } else {
                // 非ストリーミング（JSON）
                const axiosConfigNonStream = { ...axiosConfigBase, responseType: 'json' };
                for (let attempt = 1; attempt <= maxRetries; attempt++) {
                    try {
                        openaiResponse = await axios(axiosConfigNonStream);
                        break;
                    } catch (error) {
                        lastError = error;
                        console.log(`Attempt ${attempt} failed: ${(error as any).response?.status} ${(error as any).message}`);
                        if (attempt === maxRetries) throw lastError;
                        await new Promise(resolve => setTimeout(resolve, 500 * attempt));
                    }
                }

                if (!openaiResponse) {
                    throw new Error('OpenAI response is undefined after retries');
                }

                const responseData = openaiResponse.data;

                // usage
                const usage: ResponseUsage | undefined = responseData?.usage;
                if (usage) {
                    tokenCount.prompt_tokens = usage.input_tokens || 0;
                    tokenCount.completion_tokens = usage.output_tokens || 0;
                    tokenCount.cost = 0;
                    if (aiPrice) {
                        if (usage.input_tokens_details && usage.input_tokens_details.cached_tokens && usage.input_tokens_details.cached_tokens > 0 && aiPrice.metadata && aiPrice.metadata.cached_tokens) {
                            const billableInputTokens = usage.input_tokens - usage.input_tokens_details.cached_tokens;
                            tokenCount.cost += usage.input_tokens_details.cached_tokens * (aiPrice.metadata.cached_tokens || 0) / 1_000_000;
                            tokenCount.cost += billableInputTokens * (aiPrice.inputPricePerUnit || 0) / 1_000_000;
                            tokenCount.cost += usage.output_tokens * (aiPrice.outputPricePerUnit || 0) / 1_000_000;
                        } else {
                            tokenCount.cost += usage.input_tokens * (aiPrice.inputPricePerUnit || 0) / 1_000_000;
                            tokenCount.cost += usage.output_tokens * (aiPrice.outputPricePerUnit || 0) / 1_000_000;
                        }
                    }
                } else { }

                // レスポンステキスト抽出（可能な範囲で）
                let responseText = '';
                const out = responseData?.output;
                if (Array.isArray(out) && out.length > 0) {
                    const contentArr = out[0]?.content || [];
                    for (const c of contentArr) {
                        if (c?.type === 'output_text' && typeof c?.text === 'string') {
                            responseText += c.text;
                        } else if (c?.type === 'message' && Array.isArray(c?.content)) {
                            for (const cc of c.content) {
                                if (cc?.type === 'output_text' && typeof cc?.text === 'string') {
                                    responseText += cc.text;
                                }
                            }
                        }
                    }
                } else if (typeof responseData?.output_text === 'string') {
                    responseText = responseData.output_text;
                }
                tokenCount.tokenBuilder = responseText;

                // レスポンスヘッダー
                const headers: { [key: string]: string } = openaiResponse.headers || {};

                // ファイル書き出し
                fss.writeFile(`${HISTORY_DIRE}/${idempotencyKey}.response.json`,
                    JSON.stringify({ instance, url: openaiUrl, headers, response: responseData }, Utils.genJsonSafer()), {}, () => { });
                fss.writeFile(`${HISTORY_DIRE}/${idempotencyKey}.result.md`, tokenCount.tokenBuilder || '', {}, () => { });

                console.log(logObject.output('fine', '', JSON.stringify(responseData?.usage || {})));
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
                    message: JSON.stringify(responseData?.usage || {}, Utils.genJsonSafer()),
                });

                res.status(openaiResponse.status || 200).json(responseData);
            }
        } catch (err: any) {
            const { idempotencyKey, logObject, historyContext } = await commonPreProcess(_req as UserRequest, (_req as any).body?.stream ? 'responses-stream' : 'responses').catch(() => ({
                idempotencyKey: 'error',
                logObject: new LogObject(Date.now(), new TokenCount(((_req as any).body?.model || 'gpt-4o-mini') as GPTModels, 0, 0), 'error', 'error'),
                historyContext: undefined,
            }));
            await handleError(err, logObject, idempotencyKey, res, predictLogger, historyContext);
        }
    }
];

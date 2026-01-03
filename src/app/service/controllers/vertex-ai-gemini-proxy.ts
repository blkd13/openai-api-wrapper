import axios, { AxiosResponse } from 'axios';
import * as crypto from 'crypto';
import { Request, Response } from 'express';
import * as fs from 'fs';

import { validationErrorHandler } from '../middleware/validation.js';
import { UserRequest } from '../models/info.js';

import { UsageMetadata } from '@google-cloud/vertexai';
import { body, param } from 'express-validator/lib/index.js';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { calcCost, MyVertexAiClient } from '../../common/ai/providers/vertexai.js';

import { TokenCount } from '../../common/ai/token-cost.js';
import fss from '../../common/fss.js';
import { Utils } from '../../common/utils.js';
import { getPredictHistoryLoggerForRequest, logPredictHistoryWithContext, PredictHistoryLogContext, ServicePredictHistoryLogger } from '../common/predict-history-logger.js';
import { PredictHistoryStatus } from '../models/values.js';
import { getAIProvider } from './chat-by-project-model.js';

import { Stream } from 'stream';
import { AIModelEntity, AIModelPricingEntity, AIProviderEntity } from '../entity/ai-model-manager.entity.js';

const { GCP_PROJECT_ID, GCP_REGION, GCP_REGION_GEMINI, GCP_API_BASE_PATH } = process.env;
const baseApiPath = GCP_API_BASE_PATH || 'aiplatform.googleapis.com';
const defaultGeminiRegion = GCP_REGION_GEMINI || GCP_REGION || 'us-central1';

/**
 * UnzipなどのStreamからbodyデータを読み出すユーティリティ関数
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

// History directory
const HISTORY_DIR = './history';

// Proxy configuration
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

        fss.appendFile('history.log', `${logString} ${message}\n`, {}, () => { });
        return logString;
    }
}

// Ensure history directory exists
try { fs.mkdirSync(HISTORY_DIR, { recursive: true }); } catch (e) { }

type GeminiMethod = 'generateContent' | 'streamGenerateContent' | 'countTokens';

/**
 * Vertex AI Gemini の URL を生成
 */
// https://aiplatform.googleapis.com/v1beta1/projects/${PROJECT}/locations/${LOCATION}/publishers/google/models/gemini-2.5-pro:streamGenerateContent?alt=sse
function buildVertexUrl(baseApiPath: string, project: string, location: string, originalUrl: string): string {
    // TODO 無理矢理すぎるか。。。
    originalUrl = originalUrl.replace('/vertexai-gemini-proxy/', '/');
    const baseUrl = location === 'global' ? baseApiPath : `${location}-${baseApiPath}`;
    // console.log(`originalUrl: ${originalUrl}`);
    // console.log(`baseUrl: ${baseUrl}`);
    const url = new URL(`https://${baseUrl}${originalUrl}`);
    url.hostname = baseUrl;
    const paths = url.pathname.split('/');
    paths.splice(2, 0, `projects/${project}`);
    paths.splice(3, 0, `locations/${location}`);
    url.pathname = paths.join('/');
    // console.log(`modifiedUrl: ${url.toString()}`);
    return url.toString();
}

/**
 * 共通初期化処理
 */
async function initializeRequest(req: UserRequest, modelName: string, suffix: string) {
    const timestamp = Utils.formatDate(new Date(), 'yyyyMMddHHmmssSSS');
    const argsHash = crypto.createHash('MD5').update(JSON.stringify(req.body)).digest('hex');
    const idempotencyKey = `${timestamp}-${argsHash}-${suffix}`;

    const aiProviderClient = (await getAIProvider(req.info.user, modelName));

    const tokenCount = new TokenCount(modelName, 0, 0);
    const logObject = new LogObject(Date.now(), tokenCount, idempotencyKey, argsHash);

    return { idempotencyKey, argsHash, tokenCount, aiProviderClient, logObject, modelName };
}

function buildHistoryContext(method: GeminiMethod, params: {
    idempotencyKey: string;
    argsHash: string;
    aiProvider: AIProviderEntity;
    modelName: string;
    tokenCount: TokenCount;
}): PredictHistoryLogContext {

    return {
        idempotencyKey: params.idempotencyKey,
        argsHash: params.argsHash,
        label: `vertexai-gemini-proxy-${method}`,
        provider: params.aiProvider.name || 'gemini_vertex',
        model: params.modelName,
        tokenCount: params.tokenCount,
    };
}

/**
 * 共通エラーハンドリング
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

    fss.writeFile(`${HISTORY_DIR}/${idempotencyKey}.error.json`, JSON.stringify({
        error: error.message,
    }, Utils.genJsonSafer()), {}, () => { });

    const httpStatus = error.response?.status || 500;
    const data = error.response?.data || { error: error.message };

    if (data && typeof data.on === 'function') {
        const body = await readBodyFromUnzip(data);
        console.error('status:', httpStatus, 'body:', body);
    } else {
        console.error('status:', httpStatus, 'data:', data);
    }

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
        if (data && typeof data.on === 'function') {
            const body = await readBodyFromUnzip(data);
            res.status(httpStatus).send(body);
        } else {
            res.status(httpStatus).json(data);
        }
    }
}

/**
 * 共通バリデーション
 */
const commonValidation = [
    param('version').notEmpty().withMessage('version is required'),
    param('model').notEmpty().withMessage('model is required'),
    body('contents').isArray().withMessage('contents must be an array'),
    validationErrorHandler,
];

/**
 * countTokens 用のバリデーション
 */
const countTokensValidation = [
    body('contents').isArray().withMessage('contents must be an array'),
    validationErrorHandler,
];

const my_vertexai = new MyVertexAiClient([{
    project: GCP_PROJECT_ID || '',
    locationList: [defaultGeminiRegion],
    apiEndpoint: `${defaultGeminiRegion}-${baseApiPath}`,
    httpAgent: options.httpAgent,
}]);

function applyUsageMetadata(tokenCount: TokenCount, aiModel: AIModelEntity, aiPrice: AIModelPricingEntity, usage?: UsageMetadata | null) {
    if (!usage) {
        return;
    }
    tokenCount.prompt_tokens = usage.promptTokenCount ?? tokenCount.prompt_tokens;
    tokenCount.completion_tokens = usage.candidatesTokenCount ?? tokenCount.completion_tokens;
    tokenCount.cost = calcCost(tokenCount, aiModel, aiPrice, usage);
}

function appendCandidateText(candidates: any[] | undefined, builder: string): string {
    if (!Array.isArray(candidates)) {
        return builder;
    }
    for (const candidate of candidates) {
        const parts = candidate?.content?.parts;
        if (!Array.isArray(parts)) {
            continue;
        }
        for (const part of parts) {
            if (typeof part?.text === 'string') {
                builder += part.text;
            }
        }
    }
    return builder;
}

/**
 * 共通前処理
 */
async function commonPreProcess(req: UserRequest, method: Exclude<GeminiMethod, 'countTokens'>) {
    const { project, location, model } = req.params;
    const modelName = (model || req.body?.model || 'gemini-2.5-pro') as string;

    const { idempotencyKey, argsHash, aiProviderClient, tokenCount, logObject } =
        await initializeRequest(req, modelName, method);
    console.log(logObject.output('start'));

    // const { targetProject, targetLocation } = resolveProjectAndLocation(aiProvider, project, location);
    // console.log(`Using project: ${targetProject}, location: ${targetLocation}`);

    const instance = req.body;
    if (!instance || !Array.isArray(instance.contents)) {
        console.log(logObject.output('error', 'Invalid request: contents が空です'));
        throw new Error('Invalid request: contents が空です');
    }
    const client = aiProviderClient.aiProviderClient.client as MyVertexAiClient;
    console.log(`Using project: ${client.clientParam.project}, location: ${client.clientParam.location}`);
    const vertexUrl = buildVertexUrl(client.clientParam.apiEndpoint, client.clientParam.project, client.clientParam.location, req.url);

    const historyContext = buildHistoryContext(method, {
        idempotencyKey,
        argsHash,
        aiProvider: aiProviderClient.aiProvider,
        modelName,
        tokenCount,
    });

    return { instance, vertexUrl, idempotencyKey, aiProviderClient, tokenCount, logObject, modelName, historyContext };
}

/**
 * POST /v1/models/:model:countTokens
 */
export const vertexAIGeminiCountTokens = [
    ...countTokensValidation,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;

        try {
            const bodyModel = req.body?.model as string | undefined;
            const pathModel = req.params?.model as string | undefined;
            const modelName = (pathModel || bodyModel || 'gemini-2.5-pro') as string;

            const { idempotencyKey, aiProviderClient, tokenCount, logObject } =
                await initializeRequest(req, modelName, 'countTokens');

            const clientParam = my_vertexai.clientParam;
            const vertexUrl = buildVertexUrl(clientParam.apiEndpoint, clientParam.project, clientParam.location, req.url);

            const instance = req.body;
            if (!instance || !Array.isArray(instance.contents)) {
                console.log(logObject.output('error', 'Invalid request: contents が空です'));
                throw new Error('Invalid request: contents が空です');
            }

            fss.writeFile(`${HISTORY_DIR}/${idempotencyKey}.request.json`,
                JSON.stringify({ instance, url: vertexUrl }, Utils.genJsonSafer()), {}, () => { });

            console.log(logObject.output('call'));

            let vertexResponse: AxiosResponse | undefined;
            const maxRetries = 2;
            let lastError: any;

            for (let attempt = 1; attempt <= maxRetries; attempt++) {
                try {
                    const forceTokenRefresh = attempt > 1 && lastError?.response?.status === 401;
                    const accessToken = await my_vertexai.getAccessToken(forceTokenRefresh);
                    console.log(`vertexUrl: ${vertexUrl}`);
                    vertexResponse = await axios.post(vertexUrl, instance, {
                        headers: {
                            Authorization: `Bearer ${accessToken}`,
                            'Content-Type': 'application/json; charset=UTF-8',
                        },
                        responseType: 'json',
                        httpAgent: options.httpAgent,
                    });
                    break;
                } catch (error) {
                    lastError = error;
                    if (attempt === maxRetries) {
                        throw lastError;
                    }
                    if (lastError?.response?.status === 401) {
                        await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
                    }
                }
            }

            if (!vertexResponse) {
                throw new Error('Vertex AI response is undefined after retries');
            }

            const usage = vertexResponse.data;
            const totalTokens = usage?.totalTokens ?? usage?.totalTokenCount ?? 0;
            tokenCount.prompt_tokens = typeof totalTokens === 'number' ? totalTokens : 0;
            tokenCount.completion_tokens = 0;
            // tokenCount.cost = calcCost(tokenCount, aiModel, aiPrice, usage);

            console.log(logObject.output('count', '', JSON.stringify(usage)));

            fss.writeFile(`${HISTORY_DIR}/${idempotencyKey}.response.json`,
                JSON.stringify({ instance, url: vertexUrl, response: usage }, Utils.genJsonSafer()), {}, () => { });

            res.status(vertexResponse.status).json(usage);
        } catch (err: any) {
            const fallback = await initializeRequest(
                req,
                ((req.params?.model || req.body?.model || 'gemini-1.5-pro') as string),
                'countTokens',
            ).catch(() => ({
                idempotencyKey: 'error',
                logObject: new LogObject(Date.now(), new TokenCount('gemini-1.5-pro', 0, 0), 'error', 'error'),
            }));
            await handleError(err, fallback.logObject, fallback.idempotencyKey, res);
        }
    }
];

/**
 * POST /v1/projects/:project/locations/:location/publishers/google/models/:model:generateContent
 */
export const vertexAIGeminiAPI = [
    ...commonValidation,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        const predictLogger = getPredictHistoryLoggerForRequest(req);

        try {
            const { instance, vertexUrl, idempotencyKey, aiProviderClient, tokenCount, logObject, modelName, historyContext } =
                await commonPreProcess(req, 'generateContent');

            fss.writeFile(`${HISTORY_DIR}/${idempotencyKey}.request.json`,
                JSON.stringify({ instance, url: vertexUrl }, Utils.genJsonSafer()), {}, () => { });

            console.log(logObject.output('call'));

            let vertexResponse: AxiosResponse | undefined;
            const maxRetries = 2;
            let lastError: any;

            for (let attempt = 1; attempt <= maxRetries; attempt++) {
                try {
                    const forceTokenRefresh = attempt > 1 && lastError?.response?.status === 401;
                    const accessToken = await my_vertexai.getAccessToken(forceTokenRefresh);
                    console.log(`vertexUrl: ${vertexUrl}`);
                    vertexResponse = await axios.post(vertexUrl, instance, {
                        headers: {
                            Authorization: `Bearer ${accessToken}`,
                            'Content-Type': 'application/json; charset=UTF-8',
                        },
                        responseType: 'json',
                        httpAgent: options.httpAgent,
                    });
                    break;
                } catch (error) {
                    lastError = error;
                    if (attempt === maxRetries) {
                        throw lastError;
                    }
                    if (lastError?.response?.status === 401) {
                        await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
                    }
                }
            }

            if (!vertexResponse) {
                throw new Error('Vertex AI response is undefined after retries');
            }

            const usageMetadata = vertexResponse.data?.usageMetadata as UsageMetadata | undefined;
            applyUsageMetadata(tokenCount, aiProviderClient.aiModel, aiProviderClient.aiPrice, usageMetadata);

            let tokenBuilder = '';
            tokenBuilder = appendCandidateText(vertexResponse.data?.candidates, tokenBuilder);

            fss.writeFile(`${HISTORY_DIR}/${idempotencyKey}.response.json`,
                JSON.stringify({ instance, url: vertexUrl, headers: vertexResponse.headers, response: vertexResponse.data }, Utils.genJsonSafer()), {}, () => { });
            fss.writeFile(`${HISTORY_DIR}/${idempotencyKey}.result.md`, tokenBuilder || '', {}, () => { });

            console.log(logObject.output('fine', '', JSON.stringify(usageMetadata || {})));
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
                message: JSON.stringify(usageMetadata || {}, Utils.genJsonSafer()),
            });

            res.status(vertexResponse.status).json(vertexResponse.data);
        } catch (err: any) {
            const fallback = await commonPreProcess(req, 'generateContent').catch(() => ({
                idempotencyKey: 'error',
                logObject: new LogObject(Date.now(), new TokenCount((req.params.model || 'gemini-1.5-pro'), 0, 0), 'error', 'error'),
                historyContext: undefined,
            }));
            await handleError(err, fallback.logObject, fallback.idempotencyKey, res, predictLogger, fallback.historyContext);
        }
    }
];

/**
 * POST /v1/projects/:project/locations/:location/publishers/google/models/:model:streamGenerateContent
 */
export const vertexAIGeminiAPIStream = [
    ...commonValidation,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        const predictLogger = getPredictHistoryLoggerForRequest(req);
        console.log(`Request: ${req.method} ${req.originalUrl}`);

        try {
            const { instance, vertexUrl, idempotencyKey, aiProviderClient, tokenCount, logObject, modelName, historyContext } =
                await commonPreProcess(req, 'streamGenerateContent');

            let vertexResponse: AxiosResponse | undefined;
            let lastError: any;
            const maxRetries = 2;

            for (let attempt = 1; attempt <= maxRetries; attempt++) {
                try {
                    fss.writeFile(`${HISTORY_DIR}/${idempotencyKey}.request.json`,
                        JSON.stringify({ instance, url: vertexUrl }, Utils.genJsonSafer()), {}, () => { });

                    console.log(logObject.output('call'));

                    const forceTokenRefresh = attempt > 1 && lastError?.response?.status === 401;
                    const accessToken = await my_vertexai.getAccessToken(forceTokenRefresh);
                    console.log(`vertexUrl: ${vertexUrl}`);
                    vertexResponse = await axios.post(vertexUrl, instance, {
                        headers: {
                            Authorization: `Bearer ${accessToken}`,
                            'Content-Type': 'application/json; charset=UTF-8',
                        },
                        responseType: 'stream',
                        httpAgent: options.httpAgent,
                    });

                    if (vertexResponse) {
                    } else {
                        throw new Error('Vertex AI response is undefined');
                    }

                    const headers: { [key: string]: string } = {};
                    Object.entries((vertexResponse as any).headers || {}).forEach(([key, value]) => {
                        headers[key] = Array.isArray(value) ? value.join(', ') : String(value);
                    });
                    fss.writeFile(`${HISTORY_DIR}/${idempotencyKey}.response.json`,
                        JSON.stringify({ instance, url: vertexUrl, headers }, Utils.genJsonSafer()), {}, () => { });

                    break;
                } catch (error) {
                    lastError = error;

                    const headers: { [key: string]: string } = {};
                    if (vertexResponse) {
                        Object.entries(vertexResponse.headers || {}).forEach(([key, value]) => {
                            headers[key] = Array.isArray(value) ? value.join(', ') : String(value);
                        });
                    }
                    fss.writeFile(`${HISTORY_DIR}/${idempotencyKey}.response.json`,
                        JSON.stringify({ instance, url: vertexUrl, headers }, Utils.genJsonSafer()), {}, () => { });

                    if (attempt === maxRetries) {
                        throw lastError;
                    }
                    if (lastError?.response?.status === 401) {
                        await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
                    } else {
                        await new Promise(resolve => setTimeout(resolve, 0));
                    }
                }
            }

            if (!vertexResponse) {
                throw new Error('Vertex AI response is undefined after retries');
            }

            res.setHeader('Content-Type', 'text/event-stream;charset=utf-8');

            let tokenBuilder = '';
            const usageList: UsageMetadata[] = [];
            let dataBuffer = '';

            vertexResponse.data.on('data', (chunk: Buffer) => {
                const chunkStr = chunk.toString();
                dataBuffer += chunkStr;

                const lines = dataBuffer.split('\n');
                dataBuffer = lines.pop() || '';

                for (const line of lines) {
                    if (!line.startsWith('data: ')) {
                        continue;
                    }
                    try {
                        const jsonString = line.substring(6);
                        fss.appendFile(`${HISTORY_DIR}/${idempotencyKey}.txt`, jsonString + '\n', {}, () => { });
                        const data = JSON.parse(jsonString);
                        tokenBuilder = appendCandidateText(data.candidates, tokenBuilder);
                        if (data.usageMetadata && JSON.stringify(data.usageMetadata) !== '{"trafficType":"ON_DEMAND"}') {
                            usageList.push(data.usageMetadata as UsageMetadata);
                        } else {
                            // console.log('Skipping usageMetadata with only trafficType ON_DEMAND' + JSON.stringify(data.usageMetadata));
                        }
                    } catch (e) {
                        console.warn('Invalid JSON line:', line);
                    }
                }
            });

            vertexResponse.data.on('end', async () => {
                if (dataBuffer.trim().startsWith('data: ')) {
                    try {
                        const data = JSON.parse(dataBuffer.substring(6));
                        tokenBuilder = appendCandidateText(data.candidates, tokenBuilder);
                        if (data.usageMetadata && JSON.stringify(data.usageMetadata) !== '{"trafficType":"ON_DEMAND"}') {
                            usageList.push(data.usageMetadata as UsageMetadata);
                        } else {

                        }
                    } catch (e) {
                        console.warn('Invalid JSON in final buffer:', dataBuffer);
                    }
                }

                const usage: UsageMetadata = {};
                if (usageList.length === 0) {
                    // console.log('No usage metadata received in stream.');
                    Object.assign(usage, { cachedContentTokenCount: 0, promptTokenCount: 0, candidatesTokenCount: 0, totalTokenCount: 0 });
                } else if (usageList.length === 1) {
                    // console.log('Single usage metadata received in stream.');
                    Object.assign(usage, usageList[0]);
                } else {
                    for (const usageItem of usageList) {
                        if (usageItem.cachedContentTokenCount) {
                            usage.cachedContentTokenCount = (usage.cachedContentTokenCount || 0) + (usageItem.cachedContentTokenCount || 0);
                        }
                        if (usageItem.promptTokenCount) {
                            usage.promptTokenCount = (usage.promptTokenCount || 0) + (usageItem.promptTokenCount || 0);
                        }
                        if (usageItem.candidatesTokenCount) {
                            usage.candidatesTokenCount = (usage.candidatesTokenCount || 0) + (usageItem.candidatesTokenCount || 0);
                        }
                        if (usageItem.totalTokenCount) {
                            usage.totalTokenCount = (usage.totalTokenCount || 0) + (usageItem.totalTokenCount || 0);
                        }
                        Object.keys(usageItem).forEach(key => {
                            if (['cachedContentTokenCount', 'promptTokenCount', 'candidatesTokenCount', 'totalTokenCount'].includes(key)) {
                                return;
                            } else {
                                (usage as any)[key] = (usageItem as any)[key];
                            }
                        });
                    }
                }

                // console.dir(usage, { depth: null });
                applyUsageMetadata(tokenCount, aiProviderClient.aiModel, aiProviderClient.aiPrice, usage);

                tokenCount.tokenBuilder = tokenBuilder;
                fss.writeFile(`${HISTORY_DIR}/${idempotencyKey}.result.md`, tokenBuilder || '', {}, () => { });

                console.log(logObject.output('fine', '', JSON.stringify(usage, Utils.genJsonSafer())));
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
                        message: JSON.stringify(usage, Utils.genJsonSafer()),
                    });
                } catch (logError) {
                    console.error('Failed to persist streaming predict history', logError);
                }
            });

            vertexResponse.data.on('error', async (error: Error) => {
                console.log(logObject.output('error', error.message));
                fss.writeFile(`${HISTORY_DIR}/${idempotencyKey}.error.json`,
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
            const fallback = await commonPreProcess(req, 'streamGenerateContent').catch(() => ({
                idempotencyKey: 'error',
                logObject: new LogObject(Date.now(), new TokenCount((req.params.model || 'gemini-1.5-pro'), 0, 0), 'error', 'error'),
                historyContext: undefined,
            }));
            await handleError(err, fallback.logObject, fallback.idempotencyKey, res, predictLogger, fallback.historyContext);
        }
    }
];


import axios, { AxiosResponse } from 'axios';
import * as crypto from 'crypto';
import { Request, Response } from 'express';
import * as fs from 'fs';

import { validationErrorHandler } from '../middleware/validation.js';
import { UserRequest } from '../models/info.js';

import { UsageMetadata } from '@google-cloud/vertexai';
import { body } from 'express-validator/lib/index.js';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { MyVertexAiClient } from '../../common/my-vertexai.js';

import fss from '../../common/fss.js';
import { GPTModels } from '../../common/model-definition.js';
import { TokenCount } from '../../common/openai-api-wrapper.js';
import { Utils } from '../../common/utils.js';
import { ds } from '../db.js';
import { PredictHistoryEntity } from '../entity/project-models.entity.js';
import { PredictHistoryStatus } from '../models/values.js';
import { getAIProviderAndModel } from './chat-by-project-model.js';

import { Stream } from 'stream';

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
    constructor(public baseTime: number, public tokenCount: TokenCount, public idempotencyKey: string, public label: string) { }

    output(stepName: string, error: any = '', message: string = ''): string {
        const _take = Date.now() - this.baseTime;
        const take = _take.toLocaleString().padStart(10, ' ');
        this.baseTime = Date.now();

        const prompt_tokens = this.tokenCount.prompt_tokens.toLocaleString().padStart(6, ' ');
        const completion_tokens = this.tokenCount.completion_tokens.toLocaleString().padStart(6, ' ');

        const logString = `${Utils.formatDate()} ${stepName.padEnd(5, ' ')} 0 ${take} ${prompt_tokens} ${completion_tokens} ${this.tokenCount.modelShort} ${this.label} ${error}`;

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
function buildVertexUrl(project: string, location: string, model: string, method: GeminiMethod): string {
    const baseUrl = location === 'global' ? baseApiPath : `${location}-${baseApiPath}`;
    return `https://${baseUrl}/v1/projects/${project}/locations/${location}/publishers/google/models/${model}:${method}`;
}

/**
 * 共通初期化処理
 */
async function initializeRequest(req: UserRequest, modelName: string, suffix: string) {
    const timestamp = Utils.formatDate(new Date(), 'yyyyMMddHHmmssSSS');
    const argsHash = crypto.createHash('MD5').update(JSON.stringify(req.body)).digest('hex');
    const idempotencyKey = `${timestamp}-${argsHash}-${suffix}`;
    const label = argsHash;

    const { aiProvider, aiModel } = await getAIProviderAndModel(req.info.user, modelName);

    const tokenCount = new TokenCount(modelName as GPTModels, 0, 0);
    const logObject = new LogObject(Date.now(), tokenCount, idempotencyKey, label);

    return { idempotencyKey, label, tokenCount, aiProvider, aiModel, logObject };
}

/**
 * 共通エラーハンドリング
 */
async function handleError(error: any, logObject: LogObject, idempotencyKey: string, res: Response) {
    console.log(logObject.output('error', error.response?.data || error.message));

    fss.writeFile(`${HISTORY_DIR}/${idempotencyKey}.error.json`, JSON.stringify({
        error: error.message,
    }, Utils.genJsonSafer()), {}, () => { });

    const status = error.response?.status || 500;
    const data = error.response?.data || { error: error.message };

    if (data && typeof data.on === 'function') {
        const body = await readBodyFromUnzip(data);
        console.error('status:', status, 'body:', body);
    } else {
        console.error('status:', status, 'data:', data);
    }
}

/**
 * 共通バリデーション
 */
const commonValidation = [
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

function resolveProjectAndLocation(aiProvider: { config?: { projectId?: string; regionList?: string[] } } | null | undefined, project?: string, location?: string) {
    const config = (aiProvider?.config || {}) as { projectId?: string; regionList?: string[] };
    const regionList = Array.isArray(config.regionList) ? config.regionList : [];
    const targetProject = config.projectId || GCP_PROJECT_ID || project || 'default-project';
    const targetLocation = regionList.length > 0
        ? regionList[Math.floor(Math.random() * regionList.length)]
        : (location || defaultGeminiRegion);
    return { targetProject, targetLocation };
}

function applyUsageMetadata(tokenCount: TokenCount, usage?: UsageMetadata | null) {
    if (!usage) {
        return;
    }
    tokenCount.prompt_tokens = usage.promptTokenCount ?? tokenCount.prompt_tokens;
    tokenCount.completion_tokens = usage.candidatesTokenCount ?? tokenCount.completion_tokens;
    tokenCount.cost = tokenCount.calcCost();
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
    const modelName = (model || req.body?.model || 'gemini-1.5-pro') as string;

    const { idempotencyKey, aiModel, aiProvider, tokenCount, logObject } =
        await initializeRequest(req, modelName, method);
    console.log(logObject.output('start'));

    const { targetProject, targetLocation } = resolveProjectAndLocation(aiProvider as any, project, location);

    const instance = req.body;
    if (!instance || !Array.isArray(instance.contents)) {
        console.log(logObject.output('error', 'Invalid request: contents が空です'));
        throw new Error('Invalid request: contents が空です');
    }

    const vertexUrl = buildVertexUrl(targetProject, targetLocation, modelName, method);

    return { instance, vertexUrl, idempotencyKey, aiModel, aiProvider, tokenCount, logObject, modelName };
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
            const modelName = (pathModel || bodyModel || 'gemini-1.5-pro') as string;

            const { idempotencyKey, aiProvider, tokenCount, logObject } =
                await initializeRequest(req, modelName, 'countTokens');

            const { targetProject, targetLocation } = resolveProjectAndLocation(aiProvider as any, req.params.project, req.params.location);
            const vertexUrl = buildVertexUrl(targetProject, targetLocation, modelName, 'countTokens');

            const instance = req.body;
            if (!instance || !Array.isArray(instance.contents)) {
                console.log(logObject.output('error', 'Invalid request: contents が空です'));
                throw new Error('Invalid request: contents が空です');
            }

            fss.writeFile(`${HISTORY_DIR}/${idempotencyKey}.request.json`,
                JSON.stringify({ instance, url: vertexUrl }, Utils.genJsonSafer()), {}, () => { });

            console.log(logObject.output('call'));

            const accessToken = await my_vertexai.getAccessToken();
            const vertexResponse = await axios.post(vertexUrl, instance, {
                headers: {
                    Authorization: `Bearer ${accessToken}`,
                    'Content-Type': 'application/json; charset=UTF-8',
                },
                responseType: 'json',
                httpAgent: options.httpAgent,
            });

            const usage = vertexResponse.data;
            const totalTokens = usage?.totalTokens ?? usage?.totalTokenCount ?? 0;
            tokenCount.prompt_tokens = typeof totalTokens === 'number' ? totalTokens : 0;
            tokenCount.completion_tokens = 0;
            tokenCount.cost = tokenCount.calcCost();

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
                logObject: new LogObject(Date.now(), new TokenCount('gemini-1.5-pro' as GPTModels, 0, 0), 'error', 'error'),
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

        try {
            const { instance, vertexUrl, idempotencyKey, aiModel, aiProvider, tokenCount, logObject, modelName } =
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
            applyUsageMetadata(tokenCount, usageMetadata);

            let tokenBuilder = '';
            tokenBuilder = appendCandidateText(vertexResponse.data?.candidates, tokenBuilder);

            fss.writeFile(`${HISTORY_DIR}/${idempotencyKey}.response.json`,
                JSON.stringify({ instance, url: vertexUrl, headers: vertexResponse.headers, response: vertexResponse.data }, Utils.genJsonSafer()), {}, () => { });
            fss.writeFile(`${HISTORY_DIR}/${idempotencyKey}.result.md`, tokenBuilder || '', {}, () => { });

            const entity = new PredictHistoryEntity();
            entity.idempotencyKey = idempotencyKey;
            entity.argsHash = idempotencyKey.split('-')[1];
            entity.label = `vertexai-gemini-proxy-${idempotencyKey.split('-')[2]}`;
            entity.provider = aiProvider?.name || 'gemini_vertex';
            entity.model = aiModel?.name || modelName;
            entity.take = Date.now() - logObject.baseTime;
            entity.reqToken = tokenCount.prompt_tokens;
            entity.resToken = tokenCount.completion_tokens;
            entity.cost = tokenCount.cost;
            entity.status = PredictHistoryStatus.Fine;
            entity.message = JSON.stringify(usageMetadata || {}, Utils.genJsonSafer());
            entity.orgKey = req.info.user.orgKey;
            entity.createdBy = req.info.user.id;
            entity.updatedBy = req.info.user.id;
            if (req.info.ip) {
                entity.createdIp = req.info.ip;
                entity.updatedIp = req.info.ip;
            }

            console.log(logObject.output('fine', '', JSON.stringify(usageMetadata || {})));
            await ds.getRepository(PredictHistoryEntity).save(entity);

            res.status(vertexResponse.status).json(vertexResponse.data);
        } catch (err: any) {
            const fallback = await commonPreProcess(req, 'generateContent').catch(() => ({
                idempotencyKey: 'error',
                logObject: new LogObject(Date.now(), new TokenCount((req.params.model || 'gemini-1.5-pro') as GPTModels, 0, 0), 'error', 'error'),
            }));
            await handleError(err, fallback.logObject, fallback.idempotencyKey, res);
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
        console.log(`Request: ${req.method} ${req.originalUrl}`);

        try {
            const { instance, vertexUrl, idempotencyKey, aiModel, aiProvider, tokenCount, logObject, modelName } =
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
                    vertexResponse = await axios.post(vertexUrl, instance, {
                        headers: {
                            Authorization: `Bearer ${accessToken}`,
                            'Content-Type': 'application/json; charset=UTF-8',
                        },
                        responseType: 'stream',
                        httpAgent: options.httpAgent,
                    });

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
            let latestUsage: UsageMetadata | undefined;
            let dataBuffer = '';

            const usageSummary = {
                prompt_tokens: 0,
                completion_tokens: 0,
            };

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
                        if (data.usageMetadata) {
                            latestUsage = data.usageMetadata as UsageMetadata;
                            usageSummary.prompt_tokens = latestUsage.promptTokenCount || usageSummary.prompt_tokens;
                            usageSummary.completion_tokens = latestUsage.candidatesTokenCount || usageSummary.completion_tokens;
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
                        if (data.usageMetadata) {
                            latestUsage = data.usageMetadata as UsageMetadata;
                            usageSummary.prompt_tokens = latestUsage.promptTokenCount || usageSummary.prompt_tokens;
                            usageSummary.completion_tokens = latestUsage.candidatesTokenCount || usageSummary.completion_tokens;
                        }
                    } catch (e) {
                        console.warn('Invalid JSON in final buffer:', dataBuffer);
                    }
                }

                applyUsageMetadata(tokenCount, latestUsage);
                if (!latestUsage) {
                    tokenCount.prompt_tokens = usageSummary.prompt_tokens || tokenCount.prompt_tokens;
                    tokenCount.completion_tokens = usageSummary.completion_tokens || tokenCount.completion_tokens;
                    tokenCount.cost = tokenCount.calcCost();
                }

                tokenCount.tokenBuilder = tokenBuilder;
                fss.writeFile(`${HISTORY_DIR}/${idempotencyKey}.result.md`, tokenBuilder || '', {}, () => { });

                const entity = new PredictHistoryEntity();
                entity.idempotencyKey = idempotencyKey;
                entity.argsHash = idempotencyKey.split('-')[1];
                entity.label = `vertexai-gemini-proxy-${idempotencyKey.split('-')[2]}`;
                entity.provider = aiProvider?.name || 'gemini_vertex';
                entity.model = aiModel?.name || modelName;
                entity.take = Date.now() - logObject.baseTime;
                entity.reqToken = tokenCount.prompt_tokens;
                entity.resToken = tokenCount.completion_tokens;
                entity.cost = tokenCount.cost;
                entity.status = PredictHistoryStatus.Fine;
                entity.message = JSON.stringify(latestUsage || usageSummary, Utils.genJsonSafer());
                entity.orgKey = req.info.user.orgKey;
                entity.createdBy = req.info.user.id;
                entity.updatedBy = req.info.user.id;
                if (req.info.ip) {
                    entity.createdIp = req.info.ip;
                    entity.updatedIp = req.info.ip;
                }

                console.log(logObject.output('fine', '', JSON.stringify(latestUsage || usageSummary)));
                await ds.getRepository(PredictHistoryEntity).save(entity);
            });

            vertexResponse.data.on('error', (error: Error) => {
                console.log(logObject.output('error', error.message));
                fss.writeFile(`${HISTORY_DIR}/${idempotencyKey}.error.json`,
                    JSON.stringify({ error: error.message, stack: error.stack }, Utils.genJsonSafer()), {}, () => { });
            });

            vertexResponse.data.pipe(res);
        } catch (err: any) {
            const fallback = await commonPreProcess(req, 'streamGenerateContent').catch(() => ({
                idempotencyKey: 'error',
                logObject: new LogObject(Date.now(), new TokenCount((req.params.model || 'gemini-1.5-pro') as GPTModels, 0, 0), 'error', 'error'),
            }));
            await handleError(err, fallback.logObject, fallback.idempotencyKey, res);
        }
    }
];


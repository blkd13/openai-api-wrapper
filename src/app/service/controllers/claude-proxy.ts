import e, { Request, Response } from "express";
import axios, { AxiosResponse } from 'axios';
import * as crypto from 'crypto';
import * as fs from 'fs';

import { validationErrorHandler } from "../middleware/validation.js";
import { UserRequest } from "../models/info.js";

import { HttpsProxyAgent } from 'https-proxy-agent';
const { GCP_PROJECT_ID, GCP_REGION, GCP_REGION_ANTHROPIC, GCP_API_BASE_PATH } = process.env;

import { MyVertexAiClient } from '../../common/my-vertexai.js';
import { body, param } from "express-validator/lib/index.js";

// ファイルシステム関連のimport
import fss from '../../common/fss.js';
import { Utils } from "../../common/utils.js";
import { Message } from "@anthropic-ai/sdk/resources.js";
import { PredictHistoryEntity } from "../entity/project-models.entity.js";
import { ds } from "../db.js";
import { PredictHistoryStatus } from "../models/values.js";
import { DepartmentEntity, DepartmentMemberEntity } from "../entity/auth.entity.js";
import { AIModelEntity, AIModelPricingEntity, } from '../entity/ai-model-manager.entity.js';

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
 * トークン数を管理するクラス
 */
class TokenCount {
    public modelShort: string;

    constructor(
        public model?: AIModelEntity,
        public modelPrice?: AIModelPricingEntity,
        public prompt_tokens: number = 0,
        public completion_tokens: number = 0,
        public tokenBuilder: string = '',
        public cost: number = 0
    ) {
        if (model) {
            this.modelShort = model.shortName || model.name;
        } else {
            this.modelShort = 'unknown';
        }
        if (modelPrice) {
            this.cost = (this.prompt_tokens / 1_000_000) * modelPrice.inputPricePerUnit + (this.completion_tokens / 1_000_000) * modelPrice.outputPricePerUnit;
        }
    }

    add(obj: TokenCount): TokenCount {
        this.prompt_tokens += obj.prompt_tokens;
        this.completion_tokens += obj.completion_tokens;
        this.cost += obj.cost;
        return this;
    }

    calcCost(): number {
        if (this.modelPrice) {
            return (this.prompt_tokens / 1_000_000) * this.modelPrice.inputPricePerUnit +
                (this.completion_tokens / 1_000_000) * this.modelPrice.outputPricePerUnit;
        }
        return 0;
    }

    toString(): string {
        return `${this.modelShort.padEnd(8)} ${this.prompt_tokens.toLocaleString().padStart(6, ' ')} ${this.completion_tokens.toLocaleString().padStart(6, ' ')}`;
    }
}

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

        fss.appendFile(`history.log`, `${logString}\n`, {}, () => { });
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
    return `https://${location}-${GCP_API_BASE_PATH}/v1/projects/${project}/locations/${location}/publishers/anthropic/models/${model}:${method}`;
}

/**
 * 共通の初期化処理
 */
async function initializeRequest(req: UserRequest, modelName: string, suffix: string) {
    const timestamp = Utils.formatDate(new Date(), 'yyyyMMddHHmmssSSS');
    const argsHash = crypto.createHash('MD5').update(JSON.stringify(req.body)).digest('hex');
    const idempotencyKey = `${timestamp}-${argsHash}-${suffix}`;
    const label = argsHash;

    const modelObject = await ds.getRepository(AIModelEntity).findOneByOrFail({ name: modelName || 'claude-3-5-sonnet-20241022' });
    const modelPrice = await ds.getRepository(AIModelPricingEntity).findOneOrFail({ where: { modelId: modelObject.id }, order: { validFrom: 'DESC' } });

    const tokenCount = new TokenCount(modelObject, modelPrice);
    const logObject = new LogObject(Date.now(), tokenCount, idempotencyKey, label);

    return { idempotencyKey, label, tokenCount, logObject };
}

/**
 * 共通のエラーハンドリング
 */
function handleError(err: any, logObject: LogObject, idempotencyKey: string, res: Response) {
    console.error(err.response?.data || err.message);
    console.log(logObject.output('error', err.response?.data || err.message));

    fss.writeFile(`${HISTORY_DIRE}/${idempotencyKey}.error.json`, JSON.stringify({
        error: err.message,
        response: err.response?.data,
        stack: err.stack,
    }, Utils.genJsonSafer()), {}, () => { });

    const status = err.response?.status || 500;
    const data = err.response?.data || { error: err.message };
    res.status(status).json(data);
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

    let gcpProjectId;
    const depmen = await ds.getRepository(DepartmentMemberEntity).findOneBy({
        orgKey: req.info.user.orgKey,
        name: req.info.user.name,
    });
    if (!depmen) {
    } else {
        const dep = await ds.getRepository(DepartmentEntity).findOneByOrFail({ orgKey: req.info.user.orgKey, id: depmen.departmentId });
        gcpProjectId = dep.gcpProjectId;
    }

    const targetProject = gcpProjectId || GCP_PROJECT_ID || project || 'default-project';
    const targetLocation = GCP_REGION_ANTHROPIC || location || 'us-central1';

    const { idempotencyKey, label, tokenCount, logObject } = await initializeRequest(req, model, suffix);
    console.log(logObject.output('start'));

    const instance = req.body;
    if (!instance || !Array.isArray(instance.messages)) {
        console.log(logObject.output('error', 'Invalid request: messages が必要です'));
        throw new Error('Invalid request: messages が必要です');
    }

    const vertexUrl = buildVertexUrl(targetProject, targetLocation, model, suffix as any);

    return { instance, vertexUrl, idempotencyKey, tokenCount, logObject };
}

/**
 * POST /v1/projects/:project/locations/:location/publishers/anthropic/models/:model:predict
 */
export const vertexAIByAnthropicAPI = [
    ...commonValidation,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;

        try {
            const { instance, vertexUrl, idempotencyKey, tokenCount, logObject } =
                await commonPreProcess(req, 'rawPredict');

            // リクエストをファイルに書き出す
            fss.writeFile(`${HISTORY_DIRE}/${idempotencyKey}.request.json`,
                JSON.stringify({ instance, url: vertexUrl }, Utils.genJsonSafer()), {}, () => { });

            console.log(logObject.output('call'));

            const accessToken = await my_vertexai.getAccessToken();
            const vertexResponse: AxiosResponse = await axios.post(vertexUrl, instance, {
                headers: {
                    Authorization: `Bearer ${accessToken}`,
                    'Content-Type': 'application/json; charset=UTF-8',
                },
                responseType: 'json',
                httpAgent: options.httpAgent,
            });

            // レスポンスからトークン数を取得
            if (vertexResponse.data?.usage) {
                tokenCount.prompt_tokens = vertexResponse.data.usage.input_tokens || 0;
                tokenCount.completion_tokens = vertexResponse.data.usage.output_tokens || 0;
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
            fss.writeFile(`${HISTORY_DIRE}/${idempotencyKey}.result.json`,
                tokenCount.tokenBuilder || JSON.stringify(vertexResponse.data), {}, () => { });

            console.log(logObject.output('fine', '', JSON.stringify({
                prompt_tokens: tokenCount.prompt_tokens,
                completion_tokens: tokenCount.completion_tokens
            })));

            res.status(vertexResponse.status).json(vertexResponse.data);
        } catch (err: any) {
            const { idempotencyKey, logObject } = await commonPreProcess(req, 'predict').catch(() => ({
                idempotencyKey: 'error',
                logObject: new LogObject(Date.now(), new TokenCount(), 'error', 'error')
            }));
            handleError(err, logObject, idempotencyKey, res);
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

        try {
            const { instance, vertexUrl, idempotencyKey, tokenCount, logObject } =
                await commonPreProcess(req, 'streamRawPredict');

            let vertexResponse: AxiosResponse | undefined;
            let lastError: any;
            const maxRetries = 2; // リトライ回数

            for (let attempt = 1; attempt <= maxRetries; attempt++) {
                try {

                    instance.stream = true;
                    console.log(`Forwarding to Vertex AI at ${vertexUrl}`);

                    // リクエストをファイルに書き出す
                    fss.writeFile(`${HISTORY_DIRE}/${idempotencyKey}.request.json`,
                        JSON.stringify({ instance, url: vertexUrl }, Utils.genJsonSafer()), {}, () => { });

                    console.log(logObject.output('call'));

                    const accessToken = await my_vertexai.getAccessToken();
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
                    console.log(`Attempt ${attempt} failed:`, error);

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
                    await new Promise(resolve => setTimeout(resolve, 0 * attempt));
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

            const usage = {};

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
                            fss.appendFile(`${HISTORY_DIRE}/${idempotencyKey}.txt`, jsonString, {}, () => { });
                            const data = JSON.parse(jsonString);
                            if (data.type === 'content_block_delta' && data.delta?.text) {
                                tokenBuilder += data.delta.text;
                            } else if (data.type === 'message_delta') {
                                if (data.usage) {
                                    tokenCount.prompt_tokens = data.usage.input_tokens || tokenCount.prompt_tokens || 0;
                                    tokenCount.completion_tokens = data.usage.output_tokens || tokenCount.completion_tokens || 0;
                                    Object.assign(usage, data.usage);
                                }
                            } else if (data.type === 'message_start') {
                                if (data.message && data.message.usage) {
                                    tokenCount.prompt_tokens = data.message.usage.input_tokens || tokenCount.prompt_tokens || 0;
                                    tokenCount.completion_tokens = data.message.usage.output_tokens || tokenCount.completion_tokens || 0;
                                    Object.assign(usage, data.message.usage);
                                }
                            }
                            if (data.usage) {
                                Object.assign(usage, data.usage);
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
                            message = JSON.stringify(data.usage, Utils.genJsonSafer());
                            tokenCount.prompt_tokens = data.usage.input_tokens || 0;
                            tokenCount.completion_tokens = data.usage.output_tokens || 0;
                        }
                    } catch (e) {
                        console.warn('Invalid JSON in final buffer:', dataBuffer);
                    }
                }
                // バッファをクリア
                dataBuffer = '';

                tokenCount.tokenBuilder = tokenBuilder;
                fss.writeFile(`${HISTORY_DIRE}/${idempotencyKey}.result.md`, tokenBuilder || '', {}, () => { });
                console.log(logObject.output('fine', '', JSON.stringify({
                    prompt_tokens: tokenCount.prompt_tokens,
                    completion_tokens: tokenCount.completion_tokens
                })));

                const entity = new PredictHistoryEntity();
                entity.idempotencyKey = idempotencyKey;
                entity.argsHash = idempotencyKey.split('-')[1];
                entity.label = `vertexai-claude-proxy-${idempotencyKey.split('-')[2]}`;
                entity.provider = tokenCount.model?.providerNameList[0] || 'anthropic_vertex';
                entity.model = tokenCount.model?.name || 'claude-3-5-sonnet-20241022';
                entity.take = Date.now() - logObject.baseTime;
                entity.reqToken = tokenCount.prompt_tokens;
                entity.resToken = tokenCount.completion_tokens;
                entity.cost = tokenCount.calcCost();
                entity.status = PredictHistoryStatus.Fine;
                entity.message = JSON.stringify(usage); // 追加メッセージがあれば書く。
                entity.orgKey = req.info.user.orgKey; // ここでは利用者不明
                entity.createdBy = req.info.user.id; // ここでは利用者不明
                entity.updatedBy = req.info.user.id; // ここでは利用者不明
                if (req.info.ip) {
                    entity.createdIp = req.info.ip; // ここでは利用者不明
                    entity.updatedIp = req.info.ip; // ここでは利用者不明
                } else { }
                await ds.getRepository(PredictHistoryEntity).save(entity);
            });

            vertexResponse.data.on('error', (error: Error) => {
                console.log(logObject.output('error', error.message));
                fss.writeFile(`${HISTORY_DIRE}/${idempotencyKey}.error.json`,
                    JSON.stringify({ error: error.message, stack: error.stack }, Utils.genJsonSafer()), {}, () => { });
            });

            vertexResponse.data.pipe(res);
        } catch (err: any) {
            const { idempotencyKey, logObject } = await commonPreProcess(req, 'streamRawPredict').catch(() => ({
                idempotencyKey: 'error',
                logObject: new LogObject(Date.now(), new TokenCount(), 'error', 'error')
            }));
            handleError(err, logObject, idempotencyKey, res);
        }
    }
];
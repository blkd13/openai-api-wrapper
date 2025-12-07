import axios from 'axios';
import * as crypto from 'crypto';
import { Request, Response } from "express";
import * as fs from 'fs';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { Stream } from "stream";
import fss from '../../common/fss.js';
import { Utils } from "../../common/utils.js";
import { getPredictHistoryLoggerForRequest, logPredictHistoryWithContext, PredictHistoryLogContext, ServicePredictHistoryLogger } from '../common/predict-history-logger.js';
import { ScopedEntityService } from "../common/scoped-entity-service.js";
import { ds } from "../db.js";
import { AIProviderEntity, AzureOpenAIConfig } from "../entity/ai-model-manager.entity.js";
import { UserRoleType } from "../entity/auth.entity.js";
import { validationErrorHandler } from "../middleware/validation.js";
import { UserRequest } from "../models/info.js";
import { PredictHistoryStatus } from "../models/values.js";

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
 * ログ出力用クラス（Speech専用簡易版）
 */
class LogObject {
    lastTakeMs: number = 0;
    constructor(public baseTime: number, public idempotencyKey: string, public label: string) { }

    output(stepName: string, error: any = '', message: string = ''): string {
        const _take = Date.now() - this.baseTime;
        this.lastTakeMs = _take;
        const take = _take.toLocaleString().padStart(10, ' ');
        this.baseTime = Date.now();

        const logString = `${Utils.formatDate()} ${stepName.padEnd(5, ' ')} 0 ${take} speech ${this.label} ${error}`;

        fss.appendFile(`history.log`, `${logString} ${message}\n`, {}, () => { });
        return logString;
    }
}

// 初期化
try { fs.mkdirSync(`${HISTORY_DIRE}`, { recursive: true }); } catch (e) { }

/**
 * 共通の初期化処理
 */
async function initializeRequest(req: UserRequest, suffix: string) {
    const timestamp = Utils.formatDate(new Date(), 'yyyyMMddHHmmssSSS');
    const bodyContent = Buffer.isBuffer(req.body)
        ? req.body.toString('base64')
        : req.body ? JSON.stringify(req.body) : '';
    const argsHash = crypto.createHash('MD5').update(bodyContent).digest('hex');
    const idempotencyKey = `${timestamp}-${argsHash}-${suffix}`;
    const label = argsHash;

    const aiProvider = await ScopedEntityService.findByNameWithScope(
        ds.getRepository(AIProviderEntity),
        suffix,
        req.info.user.orgKey,
        req.info.user.roleList.filter(r => r.role === UserRoleType.User), // ユーザロールで絞る
    );
    if (!aiProvider) {
        throw new Error(`AI Provider not found: ${suffix}`);
    }
    const logObject = new LogObject(Date.now(), idempotencyKey, label);

    return { idempotencyKey, label, argsHash, aiProvider, logObject };
}

function buildHistoryContext(suffix: string, params: {
    idempotencyKey: string;
    argsHash: string;
    aiProvider?: { name?: string; type?: string } | null;
    path: string;
}): PredictHistoryLogContext {
    return {
        idempotencyKey: params.idempotencyKey,
        argsHash: params.argsHash,
        label: `azure-speech-proxy-${suffix}`,
        provider: params.aiProvider?.type || 'azure-speech',
        model: params.path,
        tokenCount: undefined, // Speechはトークンカウントなし
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
                tokenCount: undefined,
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
 * Speech用の最低限のバリデーション
 * パスによって必要なデータが異なるため、バリデーションは最小限
 */
const speechValidation = [
    validationErrorHandler,
];

/**
 * 共通の前処理（接続情報の取得のみ）
 */
async function commonPreProcess(req: UserRequest, suffix: string) {
    const { idempotencyKey, label, argsHash, aiProvider, logObject } = await initializeRequest(req, suffix);
    console.log(logObject.output('start'));

    const instance = req.body;

    // APIベースURLはプロバイダの設定から取得（Cognitive Services Speech API）
    const config = aiProvider.config as AzureOpenAIConfig;
    const resource = config.resources[0];
    const baseURL = new URL(resource.baseURL || 'https://japaneast.api.cognitive.microsoft.com/');
    let hostname: string | undefined;
    if (baseURL && resource.ipAddress) {
        hostname = baseURL.hostname;
        baseURL.hostname = resource.ipAddress;
    }

    // リクエストパスをそのまま使用（/v1/audio/speech → 実際のAzure Speech APIパスへ）
    // 例: /cognitiveservices/v1, /speechtotext/v3.2/recognize など
    // プレフィックス /azure-speech-proxy を除去
    const pathWithoutPrefix = req.path.split('/').slice(2).join('/');
    const queryString = req.url.includes('?') ? req.url.substring(req.url.indexOf('?')) : '';

    let apiPath = pathWithoutPrefix;
    // /v1/audio/speech を /cognitiveservices/v1 に変換（OpenAI互換パス）
    if (apiPath === 'v1/audio/speech') {
        apiPath = 'cognitiveservices/v1';
    }

    const speechUrl = `${baseURL.origin}/${apiPath}${queryString}`;
    const apiKey = resource.apiKey;

    const historyContext = buildHistoryContext(suffix, {
        idempotencyKey,
        argsHash,
        aiProvider,
        path: req.path,
    });

    return { instance, speechUrl, idempotencyKey, argsHash, aiProvider, logObject, apiKey, hostname, historyContext };
}

/**
 * POST /v1/audio/speech (OpenAI互換)
 * POST /cognitiveservices/v1 (TTS)
 * POST /speechtotext/v3.2/recognize (STT - Short Audio)
 * POST /speechtotext/v3.2/transcriptions (STT - Batch)
 * GET  /cognitiveservices/voices/list (Voice一覧)
 * など、Azure Speech Service の各種エンドポイントに対応するプロキシ
 */
export const azureOpenAISpeechProxy = [
    ...speechValidation,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        const predictLogger = getPredictHistoryLoggerForRequest(req);

        try {
            console.log(`Request: ${req.ip} ${req.method} ${req.originalUrl}`);

            const suffix = 'azure_speech:japan-east';
            const { instance, speechUrl, idempotencyKey, aiProvider, logObject, apiKey, hostname, historyContext } =
                await commonPreProcess(req, suffix);

            // リクエストをファイルに書き出す
            fss.writeFile(`${HISTORY_DIRE}/${idempotencyKey}.request.json`,
                JSON.stringify({ instance, url: speechUrl, method: req.method }, Utils.genJsonSafer()), {}, () => { });

            console.log(logObject.output('call'));

            let openaiResponse: any | undefined;
            const maxRetries = 2;
            let lastError: any;

            // リクエストボディの処理
            // - JSON形式の場合: instanceをそのまま送信
            // - SSML/XML形式の場合: instance.input または instance をそのまま送信
            // - バイナリ（音声ファイル）の場合: req.body（Buffer）をそのまま送信
            let requestData = instance;
            const requestContentType = req.get('Content-Type') || 'application/json';

            if (requestContentType.includes('application/json') && instance && typeof instance === 'object') {
                // JSONリクエストの場合、OpenAI形式なら input プロパティを使用
                if (instance.input && typeof instance.input === 'string') {
                    // TTS用: SSML/テキストを直接送信する場合
                    if (requestContentType.includes('ssml') || instance.input.includes('<speak>')) {
                        requestData = instance.input;
                    }
                }
            } else if (requestContentType.includes('audio/') || requestContentType.includes('multipart/')) {
                // STT用: 音声ファイルをアップロードする場合
                requestData = req.body;
            }
            console.log(`Proxying request to Azure Speech Service: ${speechUrl}`);

            const axiosConfigBase: any = {
                method: req.method,
                url: speechUrl,
                headers: {
                    'Ocp-Apim-Subscription-Key': apiKey,
                    'Content-Type': requestContentType,
                    Host: hostname || '',
                },
                data: requestData,
                responseType: 'arraybuffer', // バイナリ・JSON両方に対応
            };

            if (axiosProxyAgent) {
                axiosConfigBase.httpAgent = axiosProxyAgent;
                axiosConfigBase.httpsAgent = axiosProxyAgent;
            }

            // APIリクエスト（リトライあり）
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
                throw new Error('Speech API response is undefined after retries');
            }

            // レスポンスヘッダーをログ
            const headers: { [key: string]: string } = openaiResponse.headers || {};
            fss.writeFile(`${HISTORY_DIRE}/${idempotencyKey}.response.json`,
                JSON.stringify({ instance, url: speechUrl, headers, status: openaiResponse.status }, Utils.genJsonSafer()), {}, () => { });

            // レスポンスデータ
            const responseData = openaiResponse.data;
            const responseContentType = headers['content-type'] || '';

            // レスポンスタイプに応じてファイル保存
            if (responseContentType.includes('audio/')) {
                // 音声データの場合
                const audioFormat = responseContentType.includes('wav') ? 'wav' :
                    responseContentType.includes('mp3') ? 'mp3' :
                        responseContentType.includes('ogg') ? 'ogg' : 'bin';
                fss.writeFile(`${HISTORY_DIRE}/${idempotencyKey}.${audioFormat}`, responseData, {}, () => { });
            } else if (responseContentType.includes('application/json')) {
                // JSONレスポンスの場合（STT結果など）
                const jsonText = responseData.toString('utf-8');
                fss.writeFile(`${HISTORY_DIRE}/${idempotencyKey}.result.json`, jsonText, {}, () => { });
            } else {
                // その他のデータ
                fss.writeFile(`${HISTORY_DIRE}/${idempotencyKey}.response.bin`, responseData, {}, () => { });
            }

            // 入力データサイズを記録
            const inputSize = instance ? JSON.stringify(instance).length : 0;

            console.log(logObject.output('fine', '', JSON.stringify({
                path: req.path,
                method: req.method,
                status: openaiResponse.status
            })));
            await predictLogger.log({
                idempotencyKey,
                argsHash: historyContext.argsHash,
                label: historyContext.label,
                provider: historyContext.provider,
                model: historyContext.model,
                take: logObject.lastTakeMs,
                reqToken: 0,
                resToken: 0,
                cost: 0,
                status: PredictHistoryStatus.Fine,
                message: JSON.stringify({
                    path: req.path,
                    method: req.method,
                    inputSize: inputSize,
                    responseType: responseContentType
                }, Utils.genJsonSafer()),
            });

            // レスポンスをクライアントに返す
            const returnContentType = headers['content-type'] || 'application/octet-stream';
            res.setHeader('Content-Type', returnContentType);
            if (headers['content-length']) {
                res.setHeader('Content-Length', headers['content-length']);
            }

            // JSONレスポンスの場合はテキストとして返す
            if (responseContentType.includes('application/json')) {
                const jsonText = responseData.toString('utf-8');
                res.status(openaiResponse.status || 200).send(jsonText);
            } else {
                // バイナリデータ（音声など）はそのまま返す
                res.status(openaiResponse.status || 200).send(responseData);
            }
        } catch (err: any) {
            const { idempotencyKey, logObject, historyContext } = await commonPreProcess(_req as UserRequest, 'speech').catch(() => ({
                idempotencyKey: 'error',
                logObject: new LogObject(Date.now(), 'error', 'error'),
                historyContext: undefined,
            }));
            await handleError(err, logObject, idempotencyKey, res, predictLogger, historyContext);
        }
    }
];

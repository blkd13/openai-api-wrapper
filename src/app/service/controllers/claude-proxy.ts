import { Request, Response } from "express";
import axios, { AxiosResponse } from 'axios';

import { validationErrorHandler } from "../middleware/validation.js";
import { UserRequest } from "../models/info.js";

import { HttpsProxyAgent } from 'https-proxy-agent';
const { GCP_PROJECT_ID, GCP_REGION, GCP_REGION_ANTHROPIC, GCP_API_BASE_PATH } = process.env;


import { countChars, GenerateContentRequestForCache, mapForGemini, MyVertexAiClient } from '../../common/my-vertexai.js';
import { AnthropicVertex } from '@anthropic-ai/vertex-sdk/client.js';
import { body, param } from "express-validator/lib/index.js";


// TODO プロキシは環境変数から取得するように変更したい。
// proxy設定判定用オブジェクト
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
export const anthropicVertex = new AnthropicVertex({ projectId: GCP_PROJECT_ID || '', region: GCP_REGION_ANTHROPIC || 'europe-west1', baseURL: `https://${GCP_REGION_ANTHROPIC}-${GCP_API_BASE_PATH}/v1`, httpAgent: options.httpAgent }); //TODO 他で使えるようになったら変える。
export const my_vertexai = new MyVertexAiClient([{
    project: GCP_PROJECT_ID || '',
    location: GCP_REGION || 'asia-northeast1',
    apiEndpoint: `${GCP_REGION}-${GCP_API_BASE_PATH}`,
    httpAgent: options.httpAgent, // HttpsProxyAgent
}]);

/**
 * ヘルパー: Vertex AI の「裏側の」完全な URL を生成する。
 * クライアントはホスト名を含まないパスだけで投げてくる想定なので、
 * ここで https://${location}-aiplatform.googleapis.com を付与します。
 */
function buildVertexUrl(
    project: string,
    location: string,
    model: string,
    method: 'predict' | 'streamRawPredict'
): string {
    return `https://${location}-aiplatform.googleapis.com/v1/projects/${project}/locations/${location}/publishers/anthropic/models/${model}:${method}`;
}


/**
 * POST /v1/projects/:project/locations/:location/publishers/anthropic/models/:model:predict
 * のリクエストを受け取って、Vertex AI にアクセストークンを付与してフォワードするルート。
 *
 * 注意点:
 * - express のルート定義では、":predict" を文字列リテラルとして扱うために "\\:predict" とエスケープしている。
 */
export const vertexAIByAnthropicAPI = [
    // param('project').optional().isString().withMessage('project must be a string'),
    // param('location').optional().isString().withMessage('location must be a string'),
    // param('model').isString().withMessage('model must be a string'),
    // リクエストボディのバリデーション
    // body('instances').isArray().withMessage('instances must be an array'),
    body('messages').isArray().withMessage('messages must be an array'),
    body('messages.*.role').isIn(['user', 'assistant']).withMessage('messages must contain role "user" or "assistant"'),
    // body('messages.*.content').withMessage('messages must contain content as a string'),
    body('anthropic_version').optional().isString().withMessage('anthropic_version must be a string'),
    body('stream').optional().isBoolean().withMessage('stream must be a boolean'),
    body('temperature').optional().isFloat({ min: 0, max: 1 }).withMessage('temperature must be a float between 0 and 1'),
    body('top_p').optional().isFloat({ min: 0, max: 1 }).withMessage('top_p must be a float between 0 and 1'),
    body('max_output_tokens').optional().isInt({ min: 1 }).withMessage('max_output_tokens must be an integer greater than 0'),
    body('top_k').optional().isInt({ min: 0 }).withMessage('top_k must be an integer greater than or equal to 0'),
    body('stop_sequences').optional().isArray().withMessage('stop_sequences must be an array'),
    body('stop_sequences.*').optional().isString().withMessage('stop_sequences must contain strings'),
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        const { project, location, model } = req.params;
        // クライアントが project/location を省略してくる場合は、DEFAULT にフォールバックできます。
        const targetProject = GCP_PROJECT_ID || project || 'default-project';
        const targetLocation = GCP_REGION_ANTHROPIC || location || 'us-central1';

        try {
            const accessToken = await my_vertexai.getAccessToken();

            // 2) リクエストボディはそのまま Vertex AI に渡す。
            //    ただし、Anthropic Claude を呼ぶには必須で `"anthropic_version": "vertex-YYYY-MM-DD"` を追加する必要がある。 
            //    もしクライアント側で付与済みであれば重複しても構わないが、存在しなければここで自動追加する。
            const incoming: any = req.body;
            const instance = incoming || null;
            if (!instance || !Array.isArray(instance.messages)) {
                return res.status(400).json({ error: 'Invalid request: messages が必要です' });
            }

            // // anthropic_version の既定値
            // const DEFAULT_ANTHROPIC_VERSION = 'vertex-2023-10-16';
            // if (!instance.anthropic_version) {
            //     instance.anthropic_version = DEFAULT_ANTHROPIC_VERSION;
            // }

            // フォワード先エンドポイントを構築
            const vertexUrl = buildVertexUrl(targetProject, targetLocation, model, 'predict');

            // 3) Vertex AI に投げる
            const vertexResponse: AxiosResponse = await axios.post(
                vertexUrl,
                instance,
                {
                    headers: {
                        Authorization: `Bearer ${accessToken}`,
                        'Content-Type': 'application/json; charset=UTF-8',
                    },
                    responseType: 'json',
                }
            );

            // 4) そのままクライアントにレスポンスを返す
            res.status(vertexResponse.status).json(vertexResponse.data);
        } catch (err: any) {
            // console.error('Error forwarding to Vertex AI:', err);
            console.error(err.response.data);
            console.dir(err.response.data, { depth: null });
            // console.error('Error details:', {
            //     message: err.message,
            //     response: err.response ? {
            //         status: err.response.status,
            //         data: err.response.data,
            //     } : null,
            //     stack: err.stack,
            // });
            const status = err.response?.status || 500;
            const data = err.response?.data || { error: err.message };
            res.status(status).json(data);
        }
    }
];

/**
 * POST /v1/projects/:project/locations/:location/publishers/anthropic/models/:model:streamRawPredict
 * ストリーミング版も同様にハンドル。クライアントが `stream: true` を付けて呼び出す想定。
 */
// app.post(
//     '/v1/projects/:project/locations/:location/publishers/anthropic/models/:model\\:streamRawPredict',
export const vertexAIByAnthropicAPIStream = [
    // param('project').optional().isString().withMessage('project must be a string'),
    // param('location').optional().isString().withMessage('location must be a string'),
    // param('model').isString().withMessage('model must be a string'),
    // リクエストボディのバリデーション
    // body('instances').isArray().withMessage('instances must be an array'),
    body('messages').isArray().withMessage('instances[0].messages must be an array'),
    body('messages.*.role').isIn(['user', 'assistant']).withMessage('messages must contain role "user" or "assistant"'),
    // body('messages.*.content').withMessage('messages must contain content as a string'),
    body('anthropic_version').optional().isString().withMessage('anthropic_version must be a string'),
    body('stream').optional().isBoolean().withMessage('stream must be a boolean'),
    body('temperature').optional().isFloat({ min: 0, max: 1 }).withMessage('temperature must be a float between 0 and 1'),
    body('top_p').optional().isFloat({ min: 0, max: 1 }).withMessage('top_p must be a float between 0 and 1'),
    body('max_output_tokens').optional().isInt({ min: 1 }).withMessage('max_output_tokens must be an integer greater than 0'),
    body('top_k').optional().isInt({ min: 0 }).withMessage('top_k must be an integer greater than or equal to 0'),
    body('stop_sequences').optional().isArray().withMessage('stop_sequences must be an array'),
    body('stop_sequences.*').optional().isString().withMessage('stop_sequences must contain strings'),
    validationErrorHandler,
    async (req: Request, res: Response) => {
        const { project, location, model } = req.params;
        const targetProject = GCP_PROJECT_ID || project || 'default-project';
        const targetLocation = GCP_REGION_ANTHROPIC || location || 'us-central1';

        try {
            const accessToken = await my_vertexai.getAccessToken();

            const incoming: any = req.body;
            const instance = incoming || null;
            if (!instance || !Array.isArray(instance.messages)) {
                return res.status(400).json({ error: 'Invalid request: messages が必要です' });
            }
            // // anthropic_version の自動付与
            // const DEFAULT_ANTHROPIC_VERSION = 'vertex-2023-10-16';
            // if (!instance.anthropic_version) {
            //     instance.anthropic_version = DEFAULT_ANTHROPIC_VERSION;
            // }
            // // streamRawPredict 用に必須のフィールドを確認すると、Vertex AI 側では「stream: true」をボディに含めると SSE で返してくれます。
            instance.stream = true;

            // フォワード先エンドポイント
            const vertexUrl = buildVertexUrl(targetProject, targetLocation, model, 'streamRawPredict');
            console.log(`Forwarding to Vertex AI at ${vertexUrl}`);
            console.log(`Request body: ${model}`);

            // Stream 用に responseType: 'stream' を指定
            const vertexResponse: AxiosResponse = await axios.post(
                vertexUrl,
                instance,
                {
                    headers: {
                        Authorization: `Bearer ${accessToken}`,
                        'Content-Type': 'application/json; charset=UTF-8',
                    },
                    responseType: 'stream',
                }
            );

            // クライアントには EventStream としてそのままブロックせずに返す
            res.setHeader('Content-Type', 'text/event-stream;charset=utf-8');
            // @ts-ignore 型の都合で ignore
            vertexResponse.data.pipe(res);
        } catch (err: any) {
            console.error('Error forwarding to Vertex AI (stream):', err);
            const status = err.response?.status || 500;
            const data = err.response?.data || { error: err.message };
            res.status(status).json(data);
        }
    }
];
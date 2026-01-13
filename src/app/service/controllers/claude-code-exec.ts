import { spawn } from 'child_process';
import { Request, Response } from 'express';
import { body, query } from 'express-validator';
import * as http from 'http';
import { validationErrorHandler } from '../middleware/validation.js';
import { UserRequest } from '../models/info.js';
import { clients } from './chat.js';

// PTY Manager API Port
const PTY_MANAGER_PORT = 9999;

// アクティブなSSE転送を管理（streamId -> AbortController）
const activeStreams: Map<string, AbortController> = new Map();

/**
 * コンテナの状態を確認し、停止していれば起動する
 */
async function ensureContainerRunning(containerName: string): Promise<{ success: boolean; error?: string }> {
    return new Promise((resolve) => {
        const inspect = spawn('docker', ['inspect', '--format', '{{.State.Running}}', containerName]);
        let output = '';
        let errorOutput = '';

        inspect.stdout.on('data', (data: Buffer) => {
            output += data.toString();
        });

        inspect.stderr.on('data', (data: Buffer) => {
            errorOutput += data.toString();
        });

        inspect.on('close', (code) => {
            const isRunning = output.trim() === 'true';
            console.log(`[ClaudeCode] Container ${containerName} running: ${isRunning}`);

            if (isRunning) {
                resolve({ success: true });
                return;
            }

            if (code !== 0 || errorOutput.includes('No such object')) {
                console.error(`[ClaudeCode] Container ${containerName} does not exist`);
                resolve({ success: false, error: `Container ${containerName} does not exist` });
                return;
            }

            console.log(`[ClaudeCode] Starting container ${containerName}...`);
            const start = spawn('docker', ['start', containerName]);
            let startError = '';

            start.stderr.on('data', (data: Buffer) => {
                startError += data.toString();
            });

            start.on('close', (startCode) => {
                if (startCode === 0) {
                    console.log(`[ClaudeCode] Container ${containerName} started successfully`);
                    setTimeout(() => {
                        resolve({ success: true });
                    }, 2000); // PTY Managerの起動を待つ
                } else {
                    console.error(`[ClaudeCode] Failed to start container ${containerName}: ${startError}`);
                    resolve({ success: false, error: `Failed to start container: ${startError}` });
                }
            });
        });
    });
}

/**
 * コンテナのIPアドレスを取得
 */
async function getContainerIP(containerName: string): Promise<string | null> {
    return new Promise((resolve) => {
        const inspect = spawn('docker', [
            'inspect',
            '--format',
            '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}',
            containerName
        ]);
        let output = '';

        inspect.stdout.on('data', (data: Buffer) => {
            output += data.toString();
        });

        inspect.on('close', (code) => {
            if (code === 0 && output.trim()) {
                resolve(output.trim());
            } else {
                resolve(null);
            }
        });
    });
}

/**
 * PTY Manager APIにリクエストを送信
 */
async function ptyManagerRequest(
    containerIP: string,
    method: string,
    path: string,
    body?: object
): Promise<{ status: number; data: any }> {
    return new Promise((resolve, reject) => {
        const options = {
            hostname: containerIP,
            port: PTY_MANAGER_PORT,
            path: path,
            method: method,
            headers: {
                'Content-Type': 'application/json',
            },
        };

        const req = http.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => {
                data += chunk;
            });
            res.on('end', () => {
                try {
                    const parsed = data ? JSON.parse(data) : {};
                    resolve({ status: res.statusCode || 500, data: parsed });
                } catch {
                    resolve({ status: res.statusCode || 500, data: { raw: data } });
                }
            });
        });

        req.on('error', (error) => {
            reject(error);
        });

        if (body) {
            req.write(JSON.stringify(body));
        }
        req.end();
    });
}

/**
 * PTY ManagerのSSEストリームをクライアントに転送
 */
function forwardSSEStream(
    containerIP: string,
    sessionId: string,
    streamId: string,
    clientResponse: http.ServerResponse,
    abortController: AbortController
): void {
    const options = {
        hostname: containerIP,
        port: PTY_MANAGER_PORT,
        path: `/sessions/${sessionId}/output`,
        method: 'GET',
        headers: {
            'Accept': 'text/event-stream',
        },
    };

    const req = http.request(options, (res) => {
        console.log(`[ClaudeCode] SSE stream connected for session ${sessionId}`);

        res.on('data', (chunk: Buffer) => {
            const data = chunk.toString();
            // PTY Managerからの出力をクライアントに転送
            // フォーマット: data: {"type": "stdout", "content": "..."}
            const lines = data.split('\n');
            for (const line of lines) {
                if (line.startsWith('data: ')) {
                    try {
                        const payload = JSON.parse(line.slice(6));
                        const clientChunk = {
                            streamId,
                            type: payload.type || 'pty',  // jsonl, exit, error等をそのまま使用
                            content: payload.content || payload,
                        };
                        clientResponse.write(`data: ${JSON.stringify({ data: clientChunk })}\n\n`);

                        // exitイベントの場合はDONEを送信
                        if (payload.type === 'exit') {
                            clientResponse.write(`data: [DONE] ${streamId}\n\n`);
                            activeStreams.delete(streamId);
                        }
                    } catch {
                        // JSON解析失敗は無視
                    }
                }
            }
        });

        res.on('end', () => {
            console.log(`[ClaudeCode] SSE stream ended for session ${sessionId}`);
            clientResponse.write(`data: [DONE] ${streamId}\n\n`);
            activeStreams.delete(streamId);
        });

        res.on('error', (error) => {
            console.error(`[ClaudeCode] SSE stream error for session ${sessionId}:`, error);
            const errorChunk = {
                streamId,
                type: 'error',
                content: `Stream error: ${error.message}`,
            };
            clientResponse.write(`data: ${JSON.stringify({ data: errorChunk })}\n\n`);
            clientResponse.write(`data: [DONE] ${streamId}\n\n`);
            activeStreams.delete(streamId);
        });
    });

    req.on('error', (error) => {
        console.error(`[ClaudeCode] Failed to connect SSE stream:`, error);
        const errorChunk = {
            streamId,
            type: 'error',
            content: `Failed to connect: ${error.message}`,
        };
        clientResponse.write(`data: ${JSON.stringify({ data: errorChunk })}\n\n`);
        clientResponse.write(`data: [DONE] ${streamId}\n\n`);
        activeStreams.delete(streamId);
    });

    // AbortControllerでキャンセル可能に
    abortController.signal.addEventListener('abort', () => {
        req.destroy();
    });

    req.end();
}

/**
 * ClaudeCode実行エンドポイント（PTY Manager経由）
 */
export const executeClaudeCode = [
    query('connectionId').isString().notEmpty(),
    query('streamId').isString().notEmpty(),
    body('projectId').isUUID(),
    body('prompt').isString().notEmpty(),
    body('sessionId').optional().isUUID(),
    body('resume').optional().isBoolean(),
    body('forkFromSessionId').optional().isUUID(),
    body('allowAllTools').optional().isBoolean(),
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        const { connectionId, streamId } = req.query as { connectionId: string; streamId: string };
        const { projectId, prompt, sessionId, resume } = req.body;

        console.log(`[ClaudeCode] ========== executeClaudeCode called ==========`);
        console.log(`[ClaudeCode] projectId: ${projectId}, sessionId: ${sessionId || '(auto)'}`);

        // SSEクライアント確認
        const clientId = `${req.info.user.id}-${connectionId}`;
        const client = clients[clientId];
        if (!client) {
            return res.status(400).json({
                error: 'SSE connection not found',
                clientId,
            });
        }

        const containerName = `container-project-${projectId}-1`;

        try {
            // コンテナ起動確認
            const containerStatus = await ensureContainerRunning(containerName);
            if (!containerStatus.success) {
                return res.status(503).json({
                    error: 'Container not available',
                    detail: containerStatus.error,
                });
            }

            // コンテナIPを取得
            const containerIP = await getContainerIP(containerName);
            if (!containerIP) {
                return res.status(503).json({
                    error: 'Failed to get container IP',
                });
            }
            console.log(`[ClaudeCode] Container IP: ${containerIP}`);

            // PTY Managerにセッション作成リクエスト
            const createResponse = await ptyManagerRequest(containerIP, 'POST', '/sessions', {
                sessionId,
                prompt,
                resume: resume || false,
            });

            if (createResponse.status >= 400) {
                return res.status(createResponse.status).json({
                    error: 'Failed to create session',
                    detail: createResponse.data,
                });
            }

            const ptySessionId = createResponse.data.sessionId;
            console.log(`[ClaudeCode] PTY session created: ${ptySessionId}`);

            // SSEストリーム転送開始
            const abortController = new AbortController();
            activeStreams.set(streamId, abortController);
            forwardSSEStream(containerIP, ptySessionId, streamId, client.response, abortController);

            res.json({ streamId, sessionId: ptySessionId, status: 'started' });

        } catch (error) {
            console.error('Failed to execute claude code:', error);
            res.status(500).json({ error: 'Failed to execute claude code' });
        }
    }
];

/**
 * ClaudeCode対話モード実行エンドポイント（PTY Manager経由）
 * 現在はexecuteClaudeCodeと同じ実装（PTY Managerが対話を処理）
 */
export const executeClaudeCodeInteractive = [
    query('connectionId').isString().notEmpty(),
    query('streamId').isString().notEmpty(),
    body('projectId').isUUID(),
    body('prompt').isString().notEmpty(),
    body('sessionId').optional().isUUID(),
    body('resume').optional().isBoolean(),
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        const { connectionId, streamId } = req.query as { connectionId: string; streamId: string };
        const { projectId, prompt, sessionId, resume } = req.body;

        console.log(`[ClaudeCode Interactive] ========== executeClaudeCodeInteractive called ==========`);
        console.log(`[ClaudeCode Interactive] projectId: ${projectId}, sessionId: ${sessionId || '(auto)'}`);

        // SSEクライアント確認
        const clientId = `${req.info.user.id}-${connectionId}`;
        const client = clients[clientId];
        if (!client) {
            return res.status(400).json({
                error: 'SSE connection not found',
                clientId,
            });
        }

        const containerName = `container-project-${projectId}-1`;

        try {
            // コンテナ起動確認
            const containerStatus = await ensureContainerRunning(containerName);
            if (!containerStatus.success) {
                return res.status(503).json({
                    error: 'Container not available',
                    detail: containerStatus.error,
                });
            }

            // コンテナIPを取得
            const containerIP = await getContainerIP(containerName);
            if (!containerIP) {
                return res.status(503).json({
                    error: 'Failed to get container IP',
                });
            }
            console.log(`[ClaudeCode Interactive] Container IP: ${containerIP}`);

            // PTY Managerにセッション作成リクエスト
            const createResponse = await ptyManagerRequest(containerIP, 'POST', '/sessions', {
                sessionId,
                prompt,
                resume: resume || false,
            });

            if (createResponse.status >= 400) {
                return res.status(createResponse.status).json({
                    error: 'Failed to create session',
                    detail: createResponse.data,
                });
            }

            const ptySessionId = createResponse.data.sessionId;
            console.log(`[ClaudeCode Interactive] PTY session created: ${ptySessionId}`);

            // SSEストリーム転送開始
            const abortController = new AbortController();
            activeStreams.set(streamId, abortController);

            // containerIPとptySessionIdをstreamIdに紐付けて保存（後でinput送信に使う）
            streamContexts.set(streamId, { containerIP, sessionId: ptySessionId });

            forwardSSEStream(containerIP, ptySessionId, streamId, client.response, abortController);

            res.json({ streamId, sessionId: ptySessionId, status: 'started', mode: 'interactive' });

        } catch (error) {
            console.error('Failed to execute claude code interactive:', error);
            res.status(500).json({ error: 'Failed to execute claude code interactive' });
        }
    }
];

// streamIdとコンテナ情報のマッピング
const streamContexts: Map<string, { containerIP: string; sessionId: string }> = new Map();

/**
 * 対話モードでユーザー応答を送信
 */
export const respondToClaudeCode = [
    body('streamId').isString().notEmpty(),
    body('response').isString().notEmpty(),
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        const { streamId, response } = req.body;

        console.log(`[ClaudeCode] respondToClaudeCode: streamId=${streamId}, response=${response}`);

        const context = streamContexts.get(streamId);
        if (!context) {
            return res.status(404).json({ error: 'Session not found' });
        }

        try {
            // PTY Managerに入力送信
            const inputResponse = await ptyManagerRequest(
                context.containerIP,
                'POST',
                `/sessions/${context.sessionId}/input`,
                { input: response }
            );

            if (inputResponse.status >= 400) {
                return res.status(inputResponse.status).json({
                    error: 'Failed to send input',
                    detail: inputResponse.data,
                });
            }

            res.json({ streamId, status: 'sent' });

        } catch (error) {
            console.error('Failed to send response:', error);
            res.status(500).json({ error: 'Failed to send response' });
        }
    }
];

/**
 * 実行中のClaudeCodeをキャンセル
 */
export const cancelClaudeCode = [
    body('streamId').isString().notEmpty(),
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        const { streamId } = req.body;

        console.log(`[ClaudeCode] cancelClaudeCode: streamId=${streamId}`);

        // SSEストリームを中断
        const abortController = activeStreams.get(streamId);
        if (abortController) {
            abortController.abort();
            activeStreams.delete(streamId);
        }

        // PTY Managerのセッションを終了
        const context = streamContexts.get(streamId);
        if (context) {
            try {
                await ptyManagerRequest(
                    context.containerIP,
                    'DELETE',
                    `/sessions/${context.sessionId}`
                );
            } catch (error) {
                console.error('Failed to delete session:', error);
            }
            streamContexts.delete(streamId);
        }

        res.json({ streamId, status: 'cancelled' });
    }
];

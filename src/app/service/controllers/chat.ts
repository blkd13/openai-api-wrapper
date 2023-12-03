import * as http from 'http';
import { Request, Response } from "express";
import { body, query } from "express-validator";

import { OpenAIApiWrapper } from '../../common/openai-api-wrapper.js';
import { validationErrorHandler } from "../middleware/validation.js";
import { UserRequest } from "../models/info.js";
import { ChatCompletionCreateParamsStreaming } from "openai/resources/index.js";

// Eventクライアントリスト
export const clients: Record<string, { id: string; response: http.ServerResponse; }> = {};

// OpenAI APIラッパー
export const aiApi = new OpenAIApiWrapper();

/**
 * [user認証] イベントの初期化
 */
export const initEvent = [
    query('connectionId').trim().notEmpty(),
    validationErrorHandler,
    (_req: Request, res: Response) => {
        const req = _req as UserRequest;

        // クライアントIDを取得
        const clientId = `${req.info.user.id}-${req.query.connectionId}` as string;

        // TODO 再接続の場合もありうる？
        // // クライアントが存在していればID重複なので400エラー
        // if (clients[reqUrl.query['id'] as string]) {
        //     res.writeHead(400);
        //     res.end();
        //     return;
        // } else { /** do nothing */ }

        // クライアントIDを登録
        clients[clientId] = { id: clientId, response: res };

        req.on('close', () => {
            delete clients[clientId]; // クライアントが切断した場合、リストから削除
            console.log(`${req.method} ${req.url} req.on(close)`)
        });

        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders(); // flushHeaders()がないとヘッダーが飛ばない

        // // 開始イベントを送信する。こうするとクライアント側でonOpenが呼ばれる
        // clients[clientId]?.response.write('event: chatCompletionStream\n\n');
    }
];

/**
 * [user認証] チャットの送信
 */
export const chatCompletion = [
    query('connectionId').trim().notEmpty(),
    query('threadId').trim().notEmpty(),
    body('args').notEmpty(),
    validationErrorHandler,
    (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        const clientId = `${req.info.user.id}-${req.query.connectionId}` as string;

        const inDto = req.body as { args: ChatCompletionCreateParamsStreaming, options?: { idempotencyKey?: string }, };

        // inDto.args.model = inDto.args.model || 'gpt-4-1106-preview';

        let text = '';
        aiApi.chatCompletionObservableStream(
            inDto.args, {
            label: `chat-${clientId}-${req.query.threadId}`,
        }).subscribe({
            next: next => {
                const resObj = {
                    data: { threadId: req.query.threadId, content: next },
                    event: 'message',
                };
                clients[clientId]?.response.write(`data: ${JSON.stringify(resObj)}\n\n`);
                text += next;
            },
            error: error => {
                console.log(error);
                clients[clientId]?.response.end(error);
            },
            complete: () => {
                clients[clientId]?.response.write(`data: [DONE] ${req.query.threadId}\n\n`);
                // console.log(text);
            },
        });


        // clients[clientId]?.response.write(`data: ${JSON.stringify(resObj)}\n\n`);
        res.end(JSON.stringify({ status: 'ok' }));
    }
];

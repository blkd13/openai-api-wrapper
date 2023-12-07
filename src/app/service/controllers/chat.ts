import * as http from 'http';
import { Request, Response } from "express";
import { body, query } from "express-validator";

import { OpenAIApiWrapper } from '../../common/openai-api-wrapper.js';
import { validationErrorHandler } from "../middleware/validation.js";
import { UserRequest } from "../models/info.js";
import { ChatCompletionCreateParamsStreaming } from "openai/resources/index.js";
import { ds } from '../db.js';
import { DiscussionEntity, TaskEntity, StatementEntity } from '../entity/project-models.entity.js';

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

        // 開始イベントを送信する。本来はflushHeadersだけでも十分のはずだが、
        // プロキシが挟まっていたりするとヘッダーだけだと詰まることもあるので、データ部を送ることで詰まらないようにする。
        clients[clientId]?.response.write('event: chatCompletionStream\n\n');
    }
];

/**
 * [user認証] チャットの送信
 */
export const chatCompletion = [
    // 雑に作ってしまった。。
    // query -> connectionId, threadId
    // body  -> args, options?, taskId?, type?, subType?, topic? ：taskId以降はdiscussionを作成するための情報。discussionを作成しない場合は不要。
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
        const label = req.body.options?.idempotencyKey || `chat-${clientId}-${req.query.threadId}`;
        aiApi.chatCompletionObservableStream(
            inDto.args, {
            label: label,
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

                if (req.body.taskId) {
                    // project-modelsのtaskに議事録を追加する
                    ds.getRepository(TaskEntity).findOne({ where: { id: req.body.taskId }, relations: ['discussions'] }).then(task => {
                        if (!task) throw new Error(`task not found. id=${req.body.taskId}`);
                        const discussion = new DiscussionEntity();
                        discussion.logLabel = label;
                        discussion.type = req.body.type || '';
                        discussion.subType = req.body.subType || '';
                        discussion.topic = req.body.topic || 'chat';
                        discussion.statements = discussion.statements || [];

                        // promiseできちんと順番に処理しないと変なことになる。
                        Promise.all(inDto.args.messages.map((message, index) => {
                            const statement = new StatementEntity();
                            statement.sequence = index;
                            statement.discussion = discussion;
                            statement.speaker = message.role === 'user' ? `user-${req.info.user.id}` : message.role;
                            statement.content = String(message.content);
                            discussion.statements.push(statement);
                            // statementの更新
                            return statement.save();
                        })).then(() => {
                            // ChatCompletionの最後のstatementを追加
                            const statement = new StatementEntity();
                            statement.sequence = inDto.args.messages.length;
                            statement.discussion = discussion;
                            statement.speaker = inDto.args.model;
                            statement.content = text;
                            discussion.statements.push(statement);
                            // statementの更新
                            return statement.save();
                        }).then(() => {
                            // discussionの更新
                            return discussion.save();
                        }).then(() => {
                            // taskの更新
                            task.discussions = task.discussions || [];
                            task.discussions.push(discussion);
                            return task.save();
                        }).finally(() => {
                            // DB更新が終わってから終了イベントを送信する
                            clients[clientId]?.response.write(`data: [DONE] ${req.query.threadId}\n\n`);
                        });
                    });
                } else {
                    // 通常モードは素直に終了
                    clients[clientId]?.response.write(`data: [DONE] ${req.query.threadId}\n\n`);
                }
                // console.log(text);
            },
        });


        // clients[clientId]?.response.write(`data: ${JSON.stringify(resObj)}\n\n`);
        res.end(JSON.stringify({ status: 'ok' }));
    }
];

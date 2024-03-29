import * as http from 'http';
import { Request, Response } from "express";
import { body, query } from "express-validator";

import { OpenAIApiWrapper } from '../../common/openai-api-wrapper.js';
import { validationErrorHandler } from "../middleware/validation.js";
import { UserRequest } from "../models/info.js";
import { ChatCompletionCreateParamsStreaming, ChatCompletionMessageParam } from "openai/resources/index.js";
import { ds } from '../db.js';
import { DiscussionEntity, TaskEntity, StatementEntity } from '../entity/project-models.entity.js';
import { enqueueGenerator, qSubject } from './project-models.js';

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
                text += next;
                const resObj = {
                    data: { threadId: req.query.threadId, content: next },
                    event: 'message',
                };
                clients[clientId]?.response.write(`data: ${JSON.stringify(resObj)}\n\n`);
            },
            error: error => {
                console.log(error);
                clients[clientId]?.response.end(error);
            },
            complete: () => {
                if (req.body.taskId) {

                    // 並列実行
                    const func = enqueueGenerator(['task', 'statement', 'discussion']);
                    const d1 = { body: {} } as any;
                    const d2 = {} as any;
                    func(d1, d2, function () {
                        (function (d1: { body: any }) {
                            // console.log();
                            // console.log(`d1=${JSON.stringify(d1)}`);
                            // console.log();
                            // taskIdが指定されている場合は議事録を作成する
                            const discussion = new DiscussionEntity();
                            discussion.logLabel = label;
                            discussion.type = req.body.type || '';
                            discussion.subType = req.body.subType || '';
                            discussion.topic = req.body.topic || 'chat';
                            discussion.statements = [];

                            const queryRunner = ds.createQueryRunner();
                            queryRunner.connect().then(() => {
                                queryRunner.startTransaction().then(() => {
                                    queryRunner.manager.getRepository(TaskEntity).findOneOrFail({ where: { id: req.body.taskId }, relations: ['discussions'] }).then(task => {
                                        // 並列実行
                                        return Promise.all(inDto.args.messages.map((message, index) => {
                                            const statement = new StatementEntity();
                                            statement.sequence = index;
                                            statement.discussion = discussion;
                                            statement.speaker = message.role === 'user' ? `user-${req.info.user.id}` : message.role;
                                            statement.content = String(message.content);
                                            // statementの更新
                                            return queryRunner.manager.save(StatementEntity, statement);
                                        })).then((statements) => {
                                            // 保存したstatementsをdiscussionに追加
                                            discussion.statements.push(...statements);
                                            // ChatCompletion からの返事を末尾に追加
                                            const statement = new StatementEntity();
                                            statement.sequence = inDto.args.messages.length;
                                            statement.discussion = discussion;
                                            statement.speaker = inDto.args.model;
                                            statement.content = text;
                                            discussion.statements.push(statement);
                                            // statementの更新
                                            return queryRunner.manager.save(StatementEntity, statement);
                                        }).then((statement) => {
                                            // 保存したstatementsをdiscussionに追加
                                            discussion.statements.push(statement);
                                            // discussionの更新
                                            return queryRunner.manager.save(DiscussionEntity, discussion);
                                        }).then((discussion) => {
                                            // 保存したdiscussionをtaskに追加
                                            // taskの更新
                                            task.discussions = task.discussions || [];
                                            task.discussions.push(discussion);
                                            return queryRunner.manager.save(TaskEntity, task);
                                        }).then((task) => {
                                            queryRunner.commitTransaction().then(() => {
                                            }).catch(err => {
                                                queryRunner.rollbackTransaction();
                                                throw err;
                                            }).finally(() => {
                                                queryRunner.release();
                                            });
                                        }).catch(err => {
                                            queryRunner.rollbackTransaction();
                                            throw err;
                                        });
                                        // });
                                    }).catch(err => {
                                        queryRunner.rollbackTransaction();
                                        queryRunner.release();
                                    }).finally(() => {
                                        // DB更新が終わってから終了イベントを送信する
                                        clients[clientId]?.response.write(`data: [DONE] ${req.query.threadId}\n\n`);
                                        qSubject.next(d1.body.myQueue);
                                    });
                                });
                            });
                        })(d1)
                    } as any);

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

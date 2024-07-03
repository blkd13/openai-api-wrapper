import * as http from 'http';
import { Request, Response } from "express";
import { body, query } from "express-validator";
import { detect } from 'jschardet';

import { OpenAIApiWrapper, vertex_ai } from '../../common/openai-api-wrapper.js';
import { validationErrorHandler } from "../middleware/validation.js";
import { UserRequest } from "../models/info.js";
import { ChatCompletionCreateParamsStreaming, ChatCompletionMessageParam } from "openai/resources/index.js";
import { ds } from '../db.js';
import { DiscussionEntity, TaskEntity, StatementEntity } from '../entity/project-models.entity.js';
import { enqueueGenerator, qSubject } from './project-models.js';
import { GenerateContentRequest, HarmBlockThreshold, HarmCategory, Part } from '@google-cloud/vertexai';

// Eventクライアントリスト
export const clients: Record<string, { id: string; response: http.ServerResponse; }> = {};

// OpenAI APIラッパー
export const aiApi = new OpenAIApiWrapper();
aiApi.wrapperOptions.provider = 'vertexai';

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
                clients[clientId]?.response.end(`error: ${req.query.threadId} ${error}\n\n`);
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

/**
 * [認証不要] トークンカウント
 */
export const geminiCountTokens = [
    // 雑に作ってしまった。。
    body('args').notEmpty(),
    validationErrorHandler,
    (_req: Request, res: Response) => {
        const inDto = _req.body as { args: ChatCompletionCreateParamsStreaming, options?: { idempotencyKey?: string }, };
        const args = inDto.args;
        const generativeModel = vertex_ai.preview.getGenerativeModel({
            model: args.model,
            generationConfig: {
                maxOutputTokens: args.max_tokens || 8192,
                temperature: args.top_p || 0.1,
                topP: args.temperature || 0,
            },
            safetySettings: [
                { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE, },
                { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE, },
                { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE, },
                { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE, }
            ],
        });
        args.messages[0].content = args.messages[0].content || '';
        const req: GenerateContentRequest = {
            contents: [
                // {
                //     role: 'user', parts: [
                //         { text: `konnichiha` },
                //         {
                //             inlineData: {
                //                 mimeType: 'image/jpeg',
                //                 data: fs.readFileSync('./sample.jpg').toString('base64')
                //             }
                //         }
                //     ]
                // }
            ],
        };
        args.messages.forEach(message => {
            if (typeof message.content === 'string') {
                if (message.role === 'system') {
                    // countTokensにsystemは入れてはいけない。  
                    // req.systemInstruction = message.content;
                } else {
                    req.contents.push({ role: message.role, parts: [{ text: message.content }] });
                }
            } else if (Array.isArray(message.content)) {
                req.contents.push({
                    role: message.role,
                    parts: message.content.map(content => {
                        if (content.type === 'image_url') {
                            // データURLからデータを取り出してサイズを判定する。
                            const data = Buffer.from(content.image_url.url.substring(content.image_url.url.indexOf(',') + 1), 'base64');
                            const label = (content.image_url as any)['label'] as string;
                            const trg = label.toLocaleLowerCase().replace(/.*\./g, '');
                            const textTrgList = ['java', 'md', 'csh', 'sh', 'pl', 'php', 'rs', 'py', 'ipynb', 'cob', 'cbl', 'pco', 'copy', 'cpy', 'c', 'pc', 'h', 'cpp', 'hpp', 'yaml', 'yml', 'xml', 'properties', 'kt', 'sql', 'ddl', 'awk'];
                            if (content.image_url.url.startsWith('data:text/') || content.image_url.url.startsWith('data:application/octet-stream;base64,') || textTrgList.includes(trg)) {
                                // テキストファイルの場合はデコードしてテキストにしてしまう。
                                const detectedEncoding = detect(data);
                                if (detectedEncoding.encoding === 'ISO-8859-2') {
                                    detectedEncoding.encoding = 'SHIFT_JIS';
                                }
                                const decoder = new TextDecoder(detectedEncoding.encoding);
                                const decodedString = decoder.decode(data);
                                if ('label' in (content.image_url as any) && !trg.endsWith('.md')) {
                                    // label項目でファイル名が来ているときはmarkdownとして埋め込む。
                                    const label = (content.image_url as any).label as string;
                                    const trg = label.replace(/.*\./g, '');
                                    return { text: '```' + trg + ' ' + label + '\n' + decodedString + '\n```' };
                                } else {
                                    return { text: decodedString };
                                }
                            } else if (content.image_url.url.startsWith('data:')) {
                                // TODO URLには対応していない
                                return { inlineData: { mimeType: content.image_url.url.substring(5, content.image_url.url.indexOf(';')), data: content.image_url.url.substring(content.image_url.url.indexOf(',') + 1) }, };
                            } else {
                                return { file_data: { file_uri: content.image_url.url } };
                            }
                        } else if (content.type === 'text') {
                            return { text: content.text as string };
                        } else {
                            console.log('unknown sub message type');
                            return null;
                        }
                    }).filter(is => is) as Part[],
                });
            } else {
                console.log('unknown message type');
            }
        });

        const countChars = req.contents.reduce((prev0, curr0) =>
            Object.assign(prev0, curr0.parts.reduce((prev1, curr1) => {
                if (curr1.text) {
                    prev1.text += curr1.text.length;
                } else if (curr1.inlineData) {
                    const mediaType = curr1.inlineData.mimeType.split('/')[0];
                    switch (mediaType) {
                        case 'audio':
                            // TODO audioの長さから測定する
                            prev1.audio += 0;
                            break;
                        case 'video':
                            // TODO videoの長さから測定する
                            prev1.video += 0;
                            break;
                        case 'image':
                            prev1.image += 1000;
                            break;
                        default:
                            const contentUrlType = curr1.inlineData.data.split(',')[0];
                            console.log(`unkown type: ${contentUrlType}`);
                            break;
                    }
                } else {
                    console.log(`unkown obj ${Object.keys(curr1)}`);
                }
                return prev1;
            }, prev0)), { image: 0, text: 0, video: 0, audio: 0 }
        );

        // console.dir(req, { depth: null });
        generativeModel.countTokens(req).then(tokenObject => {
            res.end(JSON.stringify(Object.assign(tokenObject, countChars)));
        });
    }
];
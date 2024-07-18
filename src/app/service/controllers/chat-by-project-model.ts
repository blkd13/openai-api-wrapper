import { promises as fs } from 'fs';
import { Request, Response } from "express";
import { body, query } from "express-validator";
import axios from 'axios';

import { OpenAIApiWrapper, my_vertexai, normalizeMessage, vertex_ai } from '../../common/openai-api-wrapper.js';
import { validationErrorHandler } from "../middleware/validation.js";
import { UserRequest } from "../models/info.js";
import { ChatCompletionContentPart, ChatCompletionContentPartImage, ChatCompletionContentPartText, ChatCompletionCreateParamsStreaming, ChatCompletionMessageParam } from "openai/resources/index.js";
import { ds } from '../db.js';
import { GenerateContentRequest, HarmBlockThreshold, HarmCategory } from '@google-cloud/vertexai';

import * as dotenv from 'dotenv';
import { HttpsProxyAgent } from 'https-proxy-agent';
dotenv.config();
const { GCP_PROJECT_ID, GCP_CONTEXT_CACHE_LOCATION } = process.env;

const proxyObj: { [key: string]: string | undefined } = {
    httpProxy: process.env['http_proxy'] as string || undefined,
    httpsProxy: process.env['https_proxy'] as string || undefined,
};
if (proxyObj.httpsProxy || proxyObj.httpProxy) {
    const httpsAgent = new HttpsProxyAgent(proxyObj.httpsProxy || proxyObj.httpProxy || '');
    axios.defaults.httpsAgent = httpsAgent;
} else { }

import { countChars, GenerateContentRequestForCache, mapForGemini } from '../../common/my-vertexai.js';
import { ContentPartEntity, MessageEntity, MessageGroupEntity, ProjectEntity, TeamMemberEntity, ThreadEntity } from '../entity/project-models.entity.js';
import { ContentPartType, MessageGroupType, TeamMemberRoleType, ThreadStatus } from '../models/values.js';
import { FileBodyEntity, FileEntity } from '../entity/file-models.entity.js';
import { In, Not } from 'typeorm';
import { clients } from './chat.js';


async function buildDataUrlMap(contentPartList: (ContentPartEntity | { type: 'text', text: string } | { type: 'file', text: string, fileId: string })[]): Promise<Record<string, { file: FileEntity, fileBody: FileBodyEntity, base64: string }>> {
    // コンテンツの内容がファイルの時用
    const fileIdList = contentPartList.filter(contentPart => contentPart.type === 'file').map(contentPart => (contentPart as any).fileId);
    const fileList = await ds.getRepository(FileEntity).find({
        where: { id: In(fileIdList) }
    });
    // コンテンツの内容がファイルの時のファイルの実体用
    const fileBodyIdList = fileList.map(file => file.fileBodyId);
    const fileBodyList = await ds.getRepository(FileBodyEntity).find({
        where: { id: In(fileBodyIdList) }
    });
    // ファイルIDとファイル内容のdataURL形式文字列のマップを作る。
    const fileBodyIdMap = fileBodyList.reduce((prev, curr) => {
        prev[curr.id] = curr;
        return prev;
    }, {} as Record<string, FileBodyEntity>);
    const fileIdMap = fileList.reduce((prev, curr) => {
        prev[curr.id] = { file: curr, fileBody: fileBodyIdMap[curr.fileBodyId] };
        return prev;
    }, {} as Record<string, { file: FileEntity, fileBody: FileBodyEntity }>);
    const dataList = await Promise.all(Object.keys(fileIdMap).map(async key => await fs.readFile(fileIdMap[key].fileBody.innerPath))).then(dataList => {
        const fileIdList = Object.keys(fileIdMap);
        return dataList.map((data, index) => ({
            id: fileIdMap[fileIdList[index]].file.id,
            type: fileIdMap[fileIdList[index]].fileBody.fileType,
            base64: data.toString('base64'),
        }));
    });
    const dataUrlMap = dataList.reduce((prev, curr) => {
        prev[curr.id] = {
            file: fileIdMap[curr.id].file,
            fileBody: fileIdMap[curr.id].fileBody,
            base64: `data:${curr.type};base64,${curr.base64}`
        };
        return prev;
    }, {} as Record<string, { file: FileEntity, fileBody: FileBodyEntity, base64: string }>);
    return dataUrlMap;
}

/**
 * ProjectModelからAIに投げる用のinDtoを組み立てる。
 * @param userId 
 * @param messageId 
 * @returns 
 */
async function buildArgs(userId: string, messageId: string): Promise<{ args: ChatCompletionCreateParamsStreaming, options?: { idempotencyKey?: string }, }> {
    // メッセージの存在確認
    const message = await ds.getRepository(MessageEntity).findOneOrFail({
        where: { id: messageId }
    });

    // メッセージグループの存在確認
    const messageGroup = await ds.getRepository(MessageGroupEntity).findOneOrFail({
        where: { id: message.messageGroupId }
    });

    // スレッドの存在確認
    const thread = await ds.getRepository(ThreadEntity).findOneOrFail({
        where: { id: messageGroup.threadId, status: Not(ThreadStatus.Deleted) }
    });

    // プロジェクトの取得と権限チェック
    const project = await ds.getRepository(ProjectEntity).findOneOrFail({
        where: { id: thread.projectId }
    });

    // メンバーチェック
    const teamMember = await ds.getRepository(TeamMemberEntity).findOne({
        where: { teamId: project.teamId, userId: userId }
    });

    // 権限チェック
    if (!teamMember || (teamMember.role !== TeamMemberRoleType.Owner && teamMember.role !== TeamMemberRoleType.Member)) {
        throw new Error('このスレッドにメッセージを作成または更新する権限がありません');
    }

    // メッセージグループ全量取得
    const messageGroupList = await ds.getRepository(MessageGroupEntity).find({
        where: { threadId: thread.id }
    });
    // メッセージグループマップ
    const messageGroupMap = messageGroupList.reduce((prev, curr) => { prev[curr.id] = curr; return prev }, {} as Record<string, MessageGroupEntity>);

    // メッセージ全量マップ取得
    const messageMap = await Promise.all(messageGroupList.map(async messageGroup =>
        await ds.getRepository(MessageEntity).find({
            where: { messageGroupId: messageGroup.id }
        })
    )).then(listList => {
        return listList.reduce((prev, curr) => {
            curr.forEach(obj => {
                prev[obj.id] = obj;
            });
            return prev;
        }, {} as Record<string, MessageEntity>);
    });

    // トリガーを引かれたメッセージIDから一番先頭まで遡ると関係するメッセージだけの一直線のリストが作れる。
    let lastMessage = messageMap[messageId];
    const messageSetList = [] as { messageGroup: MessageGroupEntity, message: MessageEntity }[];
    while (lastMessage) {
        const lastMessageGroup = messageGroupMap[lastMessage.messageGroupId];
        messageSetList.push({ messageGroup: lastMessageGroup, message: lastMessage });
        lastMessage = messageMap[lastMessageGroup.parentMessageId || ''];
    }
    messageSetList.reverse();

    // 対象メッセージID全部についてコンテンツを取得
    const messageIdList = messageSetList.map(messageSet => messageSet.message.id);
    const contentPartList = await ds.getRepository(ContentPartEntity).find({
        where: { messageId: In(messageIdList) }
    });

    // コンテンツIDリストからDataURLのマップを作成しておく。
    const dataUrlMap = await buildDataUrlMap(contentPartList);

    // ここからInDto組み立て
    const contentPartMap = contentPartList.reduce((prev, curr) => {
        if (curr.messageId in prev) {
        } else {
            prev[curr.messageId] = [];
        }
        prev[curr.messageId].push(curr);
        return prev;
    }, {} as Record<string, ContentPartEntity[]>);
    // 内容をソート
    Object.keys(contentPartMap).forEach(key => contentPartMap[key].sort((a, b) => b.seq - a.seq));

    // argsを組み立てる
    const inDto = JSON.parse(thread.inDtoJson) as { args: ChatCompletionCreateParamsStreaming, options?: { idempotencyKey?: string }, };
    inDto.args.messages = messageSetList.map(messageSet => ({
        role: messageSet.messageGroup.role,
        content: contentPartMap[messageSet.message.id].map(content => {
            if (content.type === 'text') {
                return { type: 'text', text: content.text };
            } else {
                return {
                    type: 'image_url',
                    image_url: {
                        url: dataUrlMap[content.fileId || ''].base64,
                        label: dataUrlMap[content.fileId || ''].file.fileName,
                    },
                } as ChatCompletionContentPartImage;
            }
        }),
    })) as ChatCompletionMessageParam[];
    return inDto;
}

/**
 * [user認証] チャットの送信
 */
export const chatCompletionByProjectModel = [
    query('connectionId').trim().notEmpty(),
    query('threadId').trim().notEmpty(),
    query('messageId').trim().notEmpty(),
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        const { connectionId, threadId, messageId } = req.query as { connectionId: string, threadId: string, messageId: string };
        const clientId = `${req.info.user.id}-${connectionId}` as string;
        try {
            // メッセージの存在確認
            const message = await ds.getRepository(MessageEntity).findOneOrFail({
                where: { id: messageId }
            });

            // メッセージグループの存在確認
            const messageGroup = await ds.getRepository(MessageGroupEntity).findOneOrFail({
                where: { id: message.messageGroupId }
            });

            // スレッドの存在確認
            const thread = await ds.getRepository(ThreadEntity).findOneOrFail({
                where: { id: messageGroup.threadId, status: Not(ThreadStatus.Deleted) }
            });

            const inDto = await buildArgs(req.info.user.id, messageId);
            const result = await ds.transaction(async transactionalEntityManager => {
                let text = '';
                const label = req.body.options?.idempotencyKey || `chat-${clientId}-${threadId}-${messageId}`;
                const aiApi = new OpenAIApiWrapper();
                if (inDto.args.model.startsWith('gemini-')) {
                    aiApi.wrapperOptions.provider = 'vertexai';
                } else if (inDto.args.model.startsWith('claude-')) {
                    aiApi.wrapperOptions.provider = 'anthropic_vertexai';
                }
                // 難しくなってきたのであきらめてPromise×２に分岐する。
                await Promise.all([
                    new Promise<string>((resolve, reject) => {
                        aiApi.chatCompletionObservableStream(
                            inDto.args, { label }
                        ).subscribe({
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
                                reject();
                                clients[clientId]?.response.end(`error: ${req.query.threadId} ${error}\n\n`);
                            },
                            complete: () => {
                                // 通常モードは素直に終了
                                clients[clientId]?.response.write(`data: [DONE] ${req.query.threadId}\n\n`);
                                resolve(text);
                                // console.log(text);
                            },
                        });
                    }),
                    new Promise<{
                        messageGroup: MessageGroupEntity,
                        message: MessageEntity,
                        contentParts: ContentPartEntity[],
                    }>(async (resolve, reject) => {
                        try {
                            // 新しいメッセージグループを登録
                            const newMessageGroup = new MessageGroupEntity();
                            newMessageGroup.threadId = thread.id;
                            newMessageGroup.type = MessageGroupType.Single;
                            newMessageGroup.role = 'assistant';
                            newMessageGroup.label = '';
                            newMessageGroup.parentMessageId = messageId;
                            newMessageGroup.createdBy = req.info.user.id;
                            newMessageGroup.updatedBy = req.info.user.id;
                            const savedMessageGroup = await transactionalEntityManager.save(MessageGroupEntity, newMessageGroup);

                            // 新しいメッセージを登録
                            const newMessage = new MessageEntity();
                            newMessage.cacheId = undefined;
                            newMessage.label = '';
                            newMessage.createdBy = req.info.user.id;
                            newMessage.updatedBy = req.info.user.id;
                            newMessage.messageGroupId = savedMessageGroup.id;
                            const savedMessage = await transactionalEntityManager.save(MessageEntity, newMessage);

                            // 新しいContentPartを作成
                            const newContentPart = new ContentPartEntity();
                            newContentPart.messageId = savedMessage.id;
                            newContentPart.type = ContentPartType.TEXT;
                            newContentPart.text = '';
                            newContentPart.seq = 0;
                            newContentPart.createdBy = req.info.user.id;
                            newContentPart.updatedBy = req.info.user.id;
                            const savedContentPart = await transactionalEntityManager.save(ContentPartEntity, newContentPart);
                            // ガラを構築して返却
                            const resObj = { messageGroup: savedMessageGroup, message: savedMessage, contentParts: [savedContentPart], status: 'ok' };

                            // 強制的にコミットを実行
                            await transactionalEntityManager.queryRunner!.commitTransaction();

                            // 新しいトランザクションを開始（エラーハンドリングのため）
                            await transactionalEntityManager.queryRunner!.startTransaction();

                            res.end(JSON.stringify(resObj));
                            resolve(resObj);
                        } catch (error) {
                            reject(error);
                        }
                    })
                ]).then(async res => {
                    // メッセージ完了
                    res[1].contentParts[0].text = res[0];
                    await transactionalEntityManager.save(ContentPartEntity, res[1].contentParts[0]);

                    // ラベルを更新（ラベルはコンテンツの最初の方だけ）
                    res[1].messageGroup.label = res[0].substring(0, 250);
                    res[1].message.label = res[0].substring(0, 250);
                    await transactionalEntityManager.save(MessageGroupEntity, res[1].messageGroup);
                    await transactionalEntityManager.save(MessageEntity, res[1].message);
                });
            });
        } catch (error) {
            res.status(503).end(errorFormat(error));
        }
    }
];

export interface ChatInputArea {
    role: 'user' | 'system' | 'assistant';
    content: ChatContent[];
    parentMessageId: string;
}
export type ChatContent = ({ type: 'text', text: string } | { type: 'file', text: string, fileId: string });

/**
 * [認証不要] トークンカウント
 */
export const geminiCountTokensByProjectModel = [
    query('messageId').optional().isUUID(),
    body('*.content').isArray(),
    body('*.content.*.type').isIn(Object.values(ContentPartType)),
    body('*.content.*.text').isString(),
    body('*.content.*.fileId').optional().isUUID(),
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        const { messageId } = req.query as { messageId: string };
        try {
            let inDto;
            if (messageId) {
                inDto = await buildArgs(req.info.user.id, messageId);
            } else { }

            // カウントしたいだけだからパラメータは適当でOK。
            const args = inDto ? inDto.args : { messages: [], model: 'gemini-1.5-flash', temperature: 0.7, top_p: 1, max_tokens: 1024, stream: true, } as ChatCompletionCreateParamsStreaming;
            normalizeMessage(args, false).subscribe({
                next: next => {
                    const args = next.args;
                    const req: GenerateContentRequest = mapForGemini(args);
                    const countCharsObj = countChars(args);
                    // console.log(countCharsObj);
                    // console.dir(req, { depth: null });
                    const generativeModel = vertex_ai.preview.getGenerativeModel({
                        model: 'gemini-1.5-flash',
                        safetySettings: [],
                    });
                    generativeModel.countTokens(req).then(tokenObject => {
                        res.end(JSON.stringify(Object.assign(tokenObject, countCharsObj)));
                    });
                },
                // complete: () => {
                //     console.log('complete');
                // },
            });
        } catch (error) {
            res.status(503).end(errorFormat(error));
        }
    }
];

const CONTEXT_CACHE_API_ENDPOINT = `https://${GCP_CONTEXT_CACHE_LOCATION}-aiplatform.googleapis.com/v1beta1`;

function errorFormat(error: any): string {
    console.error(error);
    delete error['config'];
    delete error['stack'];
    return JSON.stringify(error);
}

/**
 * [ユーザー認証] コンテキストキャッシュ作成
 */
export const geminiCreateContextCacheByProjectModel = [
    query('messageId').optional().isUUID(),
    body('*.content').isArray(),
    body('*.content.*.type').isIn(Object.values(ContentPartType)),
    body('*.content.*.text').isString(),
    body('*.content.*.fileId').optional().isUUID(),
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        const { messageId } = req.query as { messageId: string };
        try {
            let inDto;
            if (messageId) {
                inDto = await buildArgs(req.info.user.id, messageId);
            } else { }

            // カウントしたいだけだからパラメータは適当でOK。
            const args = inDto ? inDto.args : { messages: [], model: 'gemini-1.5-flash', temperature: 0.7, top_p: 1, max_tokens: 1024, stream: true, } as ChatCompletionCreateParamsStreaming;
            const projectId: string = GCP_PROJECT_ID || 'dummy';
            const modelId: 'gemini-1.5-flash-001' | 'gemini-1.5-pro-001' = 'gemini-1.5-flash-001';
            const url = `${CONTEXT_CACHE_API_ENDPOINT}/projects/${projectId}/locations/${GCP_CONTEXT_CACHE_LOCATION}/cachedContents`;
            normalizeMessage(args, false).subscribe({
                next: next => {
                    const args = next.args;
                    const req: GenerateContentRequest = mapForGemini(args);

                    // モデルの説明文を書いておく？？
                    // req.contents.push({ role: 'model', parts: [{ text: 'これはキャッシュ機能のサンプルです。' }] });

                    // // システムプロンプトを先頭に戻しておく
                    // if (req.systemInstruction && typeof req.systemInstruction !== 'string') {
                    //     req.contents.unshift(req.systemInstruction);
                    // } else { }

                    // リクエストボディ
                    const requestBody = {
                        model: `projects/${projectId}/locations/${location}/publishers/google/models/${modelId}`,
                        contents: req.contents,
                    };
                    const reqCache: GenerateContentRequestForCache = req as GenerateContentRequestForCache;
                    if (reqCache.expire_time || reqCache.ttl) {
                        // 期限設定されていれば何もしない。
                    } else {
                        // 期限設定されていなければデフォルト15分を設定する。
                        reqCache.expire_time = new Date(new Date().getTime() + 15 * 60 * 1000).toISOString();
                    }
                    // fs.writeFileSync('requestBody.json', JSON.stringify(requestBody, null, 2));

                    // アクセストークンを取得してリクエスト
                    my_vertexai.getAuthorizedHeaders().then(headers =>
                        axios.post(url, requestBody, headers)
                    ).then(response => {
                        res.end(JSON.stringify(response.data));
                        // console.log(response.headers);
                        // console.log(response.data);
                    }).catch(error => {
                        res.status(503).end(errorFormat(error));
                    });
                },
            });
        } catch (error) {
            res.status(503).end(errorFormat(error));
        }
    }
];

/**
 * [ユーザー認証] コンテキストキャッシュ時間変更
 */
export const geminiUpdateContextCache = [
    body('expire_time').notEmpty(),
    body('cache_name').notEmpty(),
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const inDto = _req.body as { expire_time: string, cache_name: string };
        try {
            my_vertexai.getAuthorizedHeaders().then(headers =>
                axios.patch(`${CONTEXT_CACHE_API_ENDPOINT}/${inDto.cache_name}`, { expire_time: inDto.expire_time }, headers)
            ).then(response => {
                res.end(JSON.stringify(response.data));
            }).catch(error => {
                res.status(503).end(errorFormat(error));
            });
        } catch (error) {
            res.status(503).end(errorFormat(error));
        }
    }
];

/**
 * [ユーザー認証] コンテキストキャッシュ削除
 */
export const geminiDeleteContextCache = [
    body('cache_name').notEmpty(),
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const inDto = _req.body as { cache_name: string };
        try {
            my_vertexai.getAuthorizedHeaders().then(headers =>
                axios.delete(`${CONTEXT_CACHE_API_ENDPOINT}/${inDto.cache_name}`, headers)
            ).then(response => {
                res.end(JSON.stringify(response.data));
            }).catch(error => {
                res.status(503).end(errorFormat(error));
            });
        } catch (error) {
            res.status(503).end(errorFormat(error));
        }
    }
];

/**
 * [ユーザー認証] コンテキストキャッシュ一覧
 */
export const geminiGetContextCache = [
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        try {
            my_vertexai.getAuthorizedHeaders().then(headers =>
                axios.get(`${CONTEXT_CACHE_API_ENDPOINT}/projects/${GCP_PROJECT_ID}/locations/${GCP_CONTEXT_CACHE_LOCATION}/cachedContents`, headers)
            ).then(response => {
                res.end(JSON.stringify(response.data));
            }).catch(error => {
                res.status(503).end(errorFormat(error));
            });
        } catch (error) {
            res.status(503).end(errorFormat(error));
        }
    }
];

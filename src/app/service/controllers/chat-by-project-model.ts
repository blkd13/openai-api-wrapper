import * as dotenv from 'dotenv';
dotenv.config({ override: true });

import { promises as fs } from 'fs';
import { Request, Response } from "express";
import { body, query } from "express-validator";
import axios from 'axios';

import { OpenAIApiWrapper, my_vertexai, normalizeMessage, vertex_ai } from '../../common/openai-api-wrapper.js';
import { validationErrorHandler } from "../middleware/validation.js";
import { UserRequest } from "../models/info.js";
import { ChatCompletionContentPart, ChatCompletionContentPartImage, ChatCompletionContentPartText, ChatCompletionCreateParams, ChatCompletionCreateParamsStreaming, ChatCompletionMessageParam } from "openai/resources/index.js";
import { ds } from '../db.js';
import { GenerateContentRequest, HarmBlockThreshold, HarmCategory } from '@google-cloud/vertexai';

import { HttpsProxyAgent } from 'https-proxy-agent';
const { GCP_PROJECT_ID, GCP_CONTEXT_CACHE_LOCATION } = process.env;

const proxyObj: { [key: string]: string | undefined } = {
    httpProxy: process.env['http_proxy'] as string || undefined,
    httpsProxy: process.env['https_proxy'] as string || undefined,
};
if (proxyObj.httpsProxy || proxyObj.httpProxy) {
    const httpsAgent = new HttpsProxyAgent(proxyObj.httpsProxy || proxyObj.httpProxy || '');
    axios.defaults.httpsAgent = httpsAgent;
} else { }

import { countChars, GenerateContentRequestForCache, mapForGemini, TokenCharCount, CachedContent } from '../../common/my-vertexai.js';
import { ContentPartEntity, MessageEntity, MessageGroupEntity, PredictHistoryWrapperEntity, ProjectEntity, TeamMemberEntity, ThreadEntity } from '../entity/project-models.entity.js';
import { ContentPartType, MessageGroupType, PredictHistoryStatus, TeamMemberRoleType, ThreadStatus } from '../models/values.js';
import { FileBodyEntity, FileEntity } from '../entity/file-models.entity.js';
import { In, Not } from 'typeorm';
import { clients } from './chat.js';
import { VertexCachedContentEntity } from '../entity/gemini-models.entity.js';


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
async function buildArgs(userId: string, messageId: string): Promise<{
    project: ProjectEntity,
    thread: ThreadEntity,
    messageSetList: { messageGroup: MessageGroupEntity, message: MessageEntity }[],
    message: MessageEntity,
    messageGroup: MessageGroupEntity,
    inDto: { args: ChatCompletionCreateParamsStreaming, options?: { idempotencyKey?: string }, }
}> {
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
    let messageSetList = [] as { messageGroup: MessageGroupEntity, message: MessageEntity }[];
    while (lastMessage) {
        const lastMessageGroup = messageGroupMap[lastMessage.messageGroupId];
        messageSetList.push({ messageGroup: lastMessageGroup, message: lastMessage });
        lastMessage = messageMap[lastMessageGroup.previousMessageId || ''];
    }
    messageSetList.reverse();

    const inDto = JSON.parse(thread.inDtoJson) as { args: ChatCompletionCreateParamsStreaming, options?: { idempotencyKey?: string }, };

    // contextCacheが効いている場合はキャッシュ文のメッセージを外す。
    if (inDto.args && (inDto.args as any).cachedContent) {
        const cache = (inDto.args as any).cachedContent as CachedContent;
        if (new Date(cache.expireTime) > new Date()) {
            // live キャッシュが有効なのでキャッシュ済みメッセージを排除する。
            messageSetList = messageSetList.filter(obj => !obj.message.cacheId);
        } else { /* Cache is expired */ }
    } else { /* thread is not initialized */ }

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
    return { project, thread, messageSetList, inDto, message, messageGroup };
}

/**
 * [user認証] チャットの送信
 */
export const chatCompletionByProjectModel = [
    query('connectionId').trim().notEmpty(),
    query('streamId').trim().notEmpty(),
    query('messageId').trim().notEmpty(),
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        const { connectionId, streamId, messageId } = req.query as { connectionId: string, streamId: string, messageId: string };
        // connectionIdはクライアントで発番しているので、万が一にも混ざらないようにユーザーIDを付与。
        const clientId = `${req.info.user.id}-${connectionId}` as string;
        try {
            const { thread, inDto, messageSetList, message, messageGroup } = await buildArgs(req.info.user.id, messageId);
            const result = await ds.transaction(async transactionalEntityManager => {
                let text = '';
                const label = req.body.options?.idempotencyKey || `chat-${clientId}-${streamId}-${messageId}`;
                const aiApi = new OpenAIApiWrapper();
                if (inDto.args.model.startsWith('gemini-')) {
                    aiApi.wrapperOptions.provider = 'vertexai';
                } else if (inDto.args.model.startsWith('meta/llama3-')) {
                    aiApi.wrapperOptions.provider = 'openapi_vertexai';
                } else if (inDto.args.model.startsWith('claude-')) {
                    aiApi.wrapperOptions.provider = 'anthropic_vertexai';
                }

                // TODO コンテンツキャッシュはIDさえ合っていれば誰でも使える状態。権限付けなくていいか悩み中。
                const cachedContent = (inDto.args as any).cachedContent as VertexCachedContentEntity;
                if (cachedContent) {
                    // console.log(`cachedContent=${cachedContent.id}`, JSON.stringify(cachedContent));
                    transactionalEntityManager.createQueryBuilder()
                        .update(VertexCachedContentEntity)
                        .set({ usage: () => "usage + 1" }) // カウント回数は登り電文を信用しない。
                        .where('id = :cacheId', { cacheId: cachedContent.id })
                        .execute();
                    // 重要項目じゃないのであえて更新完了を待たない。
                } else { }

                // 難しくなってきたのでObservable系だけで処理するのを諦めてPromise×２に分岐する。
                await Promise.all([
                    new Promise<string>((resolve, reject) => {
                        aiApi.chatCompletionObservableStream(
                            inDto.args, { label }
                        ).subscribe({
                            next: next => {
                                text += next;
                                const resObj = {
                                    data: { streamId: req.query.streamId, content: next },
                                    event: 'message',
                                };
                                clients[clientId]?.response.write(`data: ${JSON.stringify(resObj)}\n\n`);
                            },
                            error: error => {
                                console.log(error);
                                reject();
                                clients[clientId]?.response.end(`error: ${req.query.streamId} ${error}\n\n`);
                            },
                            complete: () => {
                                // 通常モードは素直に終了
                                clients[clientId]?.response.write(`data: [DONE] ${req.query.streamId}\n\n`);
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

                            let newMessageGroup = await transactionalEntityManager.findOne(MessageGroupEntity, {
                                where: { previousMessageId: messageId }
                            });
                            if (newMessageGroup) {
                                // 既存のメッセージグループを使う
                            } else {
                                // 新しいメッセージグループを登録
                                newMessageGroup = new MessageGroupEntity();
                                newMessageGroup.threadId = thread.id;
                                newMessageGroup.type = MessageGroupType.Single;
                                newMessageGroup.role = 'assistant';
                                newMessageGroup.label = '';
                                newMessageGroup.previousMessageId = messageId;
                                newMessageGroup.createdBy = req.info.user.id;
                            }
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

                            // 新しいトランザクションを開始。メッセー全て処理後に更新するため。
                            await transactionalEntityManager.queryRunner!.startTransaction();

                            // メッセージのガラだけ返す。
                            res.end(JSON.stringify(resObj));

                            // レスポンス返した後にゆるりとヒストリーを更新しておく。
                            const history = new PredictHistoryWrapperEntity();
                            history.connectionId = connectionId;
                            history.streamId = streamId;
                            history.messageId = messageId;
                            history.label = label;
                            history.model = inDto.args.model;
                            history.provider = aiApi.wrapperOptions.provider;
                            history.createdBy = req.info.user.id;
                            history.updatedBy = req.info.user.id;
                            await transactionalEntityManager.save(PredictHistoryWrapperEntity, history);

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
    previousMessageId: string;
}
export type ChatContent = ({ type: 'text', text: string } | { type: 'file', text: string, fileId: string });

/**
 * [認証不要] トークンカウント
 * トークンカウントは呼び出し回数が多いので、
 * DB未保存分のメッセージを未保存のまま処理するようにひと手間かける。
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
            // カウントしたいだけだからパラメータは適当でOK。
            const args = { messages: [], model: 'gemini-1.5-flash', temperature: 0.7, top_p: 1, max_tokens: 1024, stream: true, } as ChatCompletionCreateParamsStreaming;

            // メッセージIDが指定されていたらまずそれらを読み込む
            if (messageId) {
                const { inDto } = await buildArgs(req.info.user.id, messageId);
                // 反映するのはメッセージだけでよい。
                args.messages.push(...inDto.args.messages);
            } else { }

            // DB未登録のメッセージ部分の組み立てをする。
            const messageList = req.body as { role: 'user', content: ContentPartEntity[] }[];
            // コンテンツIDリストからDataURLのマップを作成しておく。
            const dataUrlMap = await buildDataUrlMap(messageList.map(message => message.content).reduce((prev, curr) => { curr.forEach(obj => prev.push(obj)); return prev; }, [] as ContentPartEntity[]));
            args.messages.push(...messageList.map(message => {
                return {
                    role: message.role, content: message.content.map(content => {
                        if (content.type === 'text') {
                            return { type: 'text', text: content.text };
                        } else {
                            return {
                                type: 'image_url', image_url: {
                                    url: dataUrlMap[content.fileId || ''].base64,
                                    label: dataUrlMap[content.fileId || ''].file.fileName,
                                }
                            };
                        }
                    })
                };
            }) as any); // TODO 無理矢理なので後で型を直す。

            // console.dir(args, { depth: null });
            normalizeMessage(args, false).subscribe({
                next: next => {
                    const args = next.args;
                    // console.dir(args, { depth: null });
                    const req: GenerateContentRequest = mapForGemini(args);
                    const countCharsObj = countChars(args);
                    // console.log(countCharsObj);
                    // console.dir(req, { depth: null });
                    const generativeModel = vertex_ai.preview.getGenerativeModel({
                        model: 'gemini-1.5-flash',
                        safetySettings: [],
                    });
                    generativeModel.countTokens(req).then(tokenObject => {
                        // console.log('====================');
                        // console.dir(req, { depth: null });
                        // console.log('--------------------');
                        // console.dir(tokenObject, { depth: null });
                        // console.log('||||||||||||||||||||');
                        res.end(JSON.stringify(Object.assign(tokenObject, countCharsObj)));
                    });
                },
            });
        } catch (error) {
            res.status(503).end(errorFormat(error));
        }
    }
];

const CONTEXT_CACHE_API_ENDPOINT = `https://${GCP_CONTEXT_CACHE_LOCATION}-aiplatform.googleapis.com/v1beta1`;

function errorFormat(error: any): string {
    console.error(error);
    // console.error(Object.keys(error));
    error && 'config' in error && delete error['config'];
    error && 'stack' in error && delete error['stack'];
    if (error && error.response && error.response.data && error.response.data.error) {
        console.log(error.response.data.error);
        return JSON.stringify(error.response.data.error);
    } else {
        return JSON.stringify(error);
    }
}

/**
 * [ユーザー認証] コンテキストキャッシュ作成
 */
export const geminiCreateContextCacheByProjectModel = [
    query('messageId').optional().isUUID(),
    query('model').trim().notEmpty(),
    body('ttl').optional({ nullable: true }).isObject(), // ttl が null でもオブジェクトでも良い
    body('ttl.seconds').if(body('ttl').exists()).isFloat(), // ttl が存在する場合のみ seconds をバリデーション
    body('ttl.nanos').if(body('ttl').exists()).isFloat(), // ttl が存在する場合のみ nanos をバリデーション
    body('expire_time').optional().isDate(), // ISODateString
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        const userId = req.info.user.id as string;
        const { messageId, model } = req.query as { messageId: string, model: string };
        const { ttl, expire_time } = req.body as GenerateContentRequestForCache;
        try {
            const { thread, messageSetList, inDto } = await buildArgs(req.info.user.id, messageId);
            const projectId: string = GCP_PROJECT_ID || 'dummy';
            // const modelId: 'gemini-1.5-flash-001' | 'gemini-1.5-pro-001' = 'gemini-1.5-flash-001';
            // https://us-central1-aiplatform.googleapis.com/v1beta1/projects/gcp-cloud-shosys-ai-002/locations/us-central1/cachedContents
            const url = `${CONTEXT_CACHE_API_ENDPOINT}/projects/${projectId}/locations/${GCP_CONTEXT_CACHE_LOCATION}/cachedContents`;
            normalizeMessage(inDto.args, false).subscribe({
                next: async next => {
                    try {
                        const args = next.args;
                        const req: GenerateContentRequest = mapForGemini(args);

                        // モデルの説明文を書いておく？？
                        // req.contents.push({ role: 'model', parts: [{ text: 'これはキャッシュ機能のサンプルです。' }] });

                        // // システムプロンプトを先頭に戻しておく
                        // if (req.systemInstruction && typeof req.systemInstruction !== 'string') {
                        //     req.contents.unshift(req.systemInstruction);
                        // } else { }

                        const countCharsObj = countChars(args);
                        const generativeModel = vertex_ai.preview.getGenerativeModel({
                            model: 'gemini-1.5-flash',
                            safetySettings: [],
                        });
                        const countObj: TokenCharCount = await generativeModel.countTokens(req).then(tokenObject => Object.assign(tokenObject, countCharsObj));

                        // リクエストボディ
                        const requestBody = {
                            model: `projects/${projectId}/locations/${GCP_CONTEXT_CACHE_LOCATION}/publishers/google/models/${model}`,
                            contents: req.contents,
                            ttl, expire_time // キャッシュ保持期間の設定
                        };

                        // fs.writeFileSync('requestBody.json', JSON.stringify(requestBody, null, 2));
                        let savedCachedContent: VertexCachedContentEntity | undefined;
                        savedCachedContent = undefined;
                        await my_vertexai.getAuthorizedHeaders().then(async headers =>
                            axios.post(url, requestBody, headers)
                        ).then(async response => {
                            const cache = response.data as CachedContent;
                            // console.log(response.headers);
                            // console.log(response.data);
                            const result = await ds.transaction(async transactionalEntityManager => {
                                const entity = new VertexCachedContentEntity();
                                // 独自定義
                                entity.modelAlias = model;
                                entity.location = GCP_CONTEXT_CACHE_LOCATION || '';
                                entity.projectId = thread.projectId;
                                entity.title = thread.title;

                                // コンテンツキャッシュの応答
                                entity.name = cache.name;
                                entity.model = cache.model;
                                entity.createTime = new Date(cache.createTime);
                                entity.expireTime = new Date(cache.expireTime);
                                entity.updateTime = new Date(cache.updateTime);

                                // トークンカウント
                                entity.totalBillableCharacters = countObj.totalBillableCharacters;
                                entity.totalTokens = countObj.totalTokens;

                                // 独自トークンカウント
                                entity.audio = countObj.audio;
                                entity.image = countObj.image;
                                entity.text = countObj.text;
                                entity.video = countObj.video;

                                // // メッセージ結果（ここは取れないのでずっと0になる）
                                // entity.candidatesTokenCount = 0;
                                // entity.totalTokenCount = 0;
                                // entity.promptTokenCount = 0;

                                // 使用回数
                                entity.usage = 0;

                                entity.createdBy = userId;
                                entity.updatedBy = userId;

                                savedCachedContent = await transactionalEntityManager.save(VertexCachedContentEntity, entity);

                                await Promise.all(messageSetList.map(messageSet => {
                                    if (savedCachedContent) {
                                        messageSet.message.cacheId = savedCachedContent.id;
                                    }
                                    return transactionalEntityManager.save(MessageEntity, messageSet.message);
                                }));
                            });
                        });
                        res.status(200).json(savedCachedContent);
                    } catch (error) {
                        res.status(503).end(errorFormat(error));
                    }
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
export const geminiUpdateContextCacheByProjectModel = [
    query('threadId').notEmpty(),
    body('ttl').optional({ nullable: true }).isObject(), // ttl が null でもオブジェクトでも良い
    body('ttl.seconds').if(body('ttl').exists()).isFloat(), // ttl が存在する場合のみ seconds をバリデーション
    body('ttl.nanos').if(body('ttl').exists()).isFloat(), // ttl が存在する場合のみ nanos をバリデーション
    body('expire_time').optional().isDate(), // ISODateString
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        const userId = req.info.user.id as string;
        const { threadId } = req.query as { threadId: string };
        const { ttl } = _req.body as { ttl: { seconds: number, nanos: number } };
        // const { expire_time } = _req.body as { expire_time: string };
        try {

            // メッセージの存在確認
            const thread = await ds.getRepository(ThreadEntity).findOneOrFail({
                where: { id: threadId }
            });

            const inDto = JSON.parse(thread.inDtoJson);
            const cachedContent: VertexCachedContentEntity = inDto.args.cachedContent;
            const cacheName = cachedContent.name;

            // キャッシュの存在確認
            const cacheEntity = await ds.getRepository(VertexCachedContentEntity).findOneOrFail({
                where: { name: cacheName }
            });

            let savedCachedContent: VertexCachedContentEntity | undefined;
            savedCachedContent = undefined; my_vertexai.getAuthorizedHeaders().then(headers =>
                axios.patch(`${CONTEXT_CACHE_API_ENDPOINT}/${cachedContent.name}`, { ttl }, headers)
            ).then(async response => {
                const cache = response.data as CachedContent;
                // console.log(response.headers);
                // console.log(response.data);
                const result = await ds.transaction(async transactionalEntityManager => {
                    // 独自定義
                    // コンテンツキャッシュの応答
                    cacheEntity.name = cache.name;
                    cacheEntity.model = cache.model;
                    cacheEntity.createTime = new Date(cache.createTime);
                    cacheEntity.expireTime = new Date(cache.expireTime);
                    cacheEntity.updateTime = new Date(cache.updateTime);

                    cacheEntity.updatedBy = userId;

                    savedCachedContent = await transactionalEntityManager.save(VertexCachedContentEntity, cacheEntity);
                });
                // 
                res.end(JSON.stringify(savedCachedContent));
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
export const geminiDeleteContextCacheByProjectModel = [
    query('threadId').notEmpty(),
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const { threadId } = _req.query as { threadId: string };
        try {
            // メッセージの存在確認
            const thread = await ds.getRepository(ThreadEntity).findOneOrFail({
                where: { id: threadId }
            });
            const inDto = JSON.parse(thread.inDtoJson);
            const cachedContent: VertexCachedContentEntity = inDto.args.cachedContent;

            const result = await ds.transaction(async transactionalEntityManager => {
                // cachedContentを消して更新
                delete inDto.args.cachedContent;
                thread.inDtoJson = JSON.stringify(inDto);
                const savedThread = await transactionalEntityManager.save(ThreadEntity, thread);

                await transactionalEntityManager.createQueryBuilder()
                    .update(MessageEntity)
                    .set({ cacheId: () => "''" })
                    .where('cache_id = :cacheId', { cacheId: cachedContent.id })
                    .execute();
            });
            // TODO googleに投げる前にDBコミットすることにした。こうすることで通信エラーを無視できるけどキャッシュが残っちゃったときどうするんだろう。。
            await my_vertexai.getAuthorizedHeaders().then(headers =>
                axios.delete(`${CONTEXT_CACHE_API_ENDPOINT}/${cachedContent.name}`, headers)
            ).then(async response => {
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

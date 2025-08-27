import axios from 'axios';
import { Request, Response } from "express";
import { body, query } from "express-validator";
import { promises as fs } from 'fs';
import { ChatCompletionAssistantMessageParam, ChatCompletionChunk, ChatCompletionContentPart, ChatCompletionContentPartImage, ChatCompletionMessageParam, ChatCompletionMessageToolCall, ChatCompletionToolMessageParam } from "openai/resources";
import { concatMap, from } from 'rxjs';

import { CountTokensResponse, GenerateContentRequest } from '@google-cloud/vertexai';
import { aiApi, AIProviderClient, calculateTokenCost, getTiktokenEncoder, invalidMimeList, MyAnthropic, MyAnthropicVertex, MyAzureOpenAI, MyChatCompletionCreateParamsStreaming, MyCohere, MyGemini, MyOpenAI, MyToolType, normalizeMessage, providerInstances, providerPrediction, TokenCount } from '../../common/openai-api-wrapper.js';
import { ds } from '../db.js';
import { validationErrorHandler } from "../middleware/validation.js";
import { UserRequest } from "../models/info.js";

import { HttpsProxyAgent } from 'https-proxy-agent';
const { GCP_PROJECT_ID, GCP_CONTEXT_CACHE_LOCATION, GCP_API_BASE_PATH } = process.env;

const proxyObj: { [key: string]: string | undefined } = {
    httpProxy: process.env['http_proxy'] as string || undefined,
    httpsProxy: process.env['https_proxy'] as string || undefined,
};
if (proxyObj.httpsProxy || proxyObj.httpProxy) {
    const httpsAgent = new HttpsProxyAgent(proxyObj.httpsProxy || proxyObj.httpProxy || '');
    axios.defaults.httpsAgent = httpsAgent;
    axios.defaults.proxy = false; // httpsAgentを使ってプロキシするので、axiosの元々のproxyはoffにしておかないと変なことになる。
} else { }

import { EntityManager, In, IsNull, Not } from 'typeorm';
import { CachedContent, countChars, GenerateContentRequestForCache, mapForGemini, MyVertexAiClient, TokenCharCount } from '../../common/my-vertexai.js';
import { convertToPdfMimeList, convertToPdfMimeMap, PdfMetaData } from '../../common/pdf-funcs.js';
import { EnhancedRequestLimiter, Utils } from '../../common/utils.js';
import { ScopedEntityService } from '../common/scoped-entity-service.js';
import { AIModelEntity, AIModelPricingEntity, AIProviderEntity, AIProviderType, getAIProviderConfig } from '../entity/ai-model-manager.entity.js';
import { DepartmentEntity, DepartmentMemberEntity, DepartmentRoleType, OAuthAccountEntity, OAuthAccountStatus, ScopeType, UserEntity, UserStatus } from '../entity/auth.entity.js';
import { safeWhere } from '../entity/base.js';
import { FileBodyEntity, FileEntity } from '../entity/file-models.entity.js';
import { VertexCachedContentEntity } from '../entity/gemini-models.entity.js';
import { ContentPartEntity, MessageEntity, MessageGroupEntity, PredictHistoryWrapperEntity, ProjectEntity, TeamMemberEntity, ThreadEntity, ThreadGroupEntity } from '../entity/project-models.entity.js';
import { ToolCallGroupEntity, ToolCallPart, ToolCallPartCall, ToolCallPartCallBody, ToolCallPartCommand, ToolCallPartEntity, ToolCallPartInfo, ToolCallPartResult, ToolCallPartResultBody, ToolCallPartType } from '../entity/tool-call.entity.js';
import { UserTokenPayloadWithRole } from '../middleware/authenticate.js';
import { ContentPartStatus, ContentPartType, MessageGroupType, TeamMemberRoleType, ThreadGroupStatus, ThreadStatus } from '../models/values.js';
import { functionDefinitions } from '../tool/_index.js';
import { clients } from './chat.js';
import { appendToolCallPart } from './tool-call.js';

export const COUNT_TOKEN_MODEL = 'gemini-2.5-flash' as const;
export const COUNT_TOKEN_OPENAI_MODEL = 'gpt-5' as const;

export const tokenCountRequestLimitation = new EnhancedRequestLimiter(300);

async function buildFileGroupBodyMap(
    orgKey: string,
    contentPartList: (ContentPartEntity | { type: 'text', text: string } | { type: 'file', text: string, fileGroupId: string })[],
    // fileGroupBodyMap: { [fileGroupId: string]: { file: FileEntity, fileBody: FileBodyEntity, base64: string }[] } = {},
    fileGroupIdChatCompletionContentPartImageMap: { [fileGroupId: string]: ChatCompletionContentPartImage[][] } = {},
): Promise<{ [fileGroupId: string]: ChatCompletionContentPartImage[][] }> {
    // コンテンツの内容がファイルの時用
    const fileGroupIdList = contentPartList.filter(contentPart => contentPart.type === 'file').map(contentPart => (contentPart as { linkId: string }).linkId || (contentPart as { fileGroupId: string }).fileGroupId);
    const fileList = await ds.getRepository(FileEntity).find({
        where: { orgKey, fileGroupId: In(fileGroupIdList) }
    });
    // コンテンツの内容がファイルの時のファイルの実体用
    const fileBodyIdList = fileList.map(file => file.fileBodyId);
    const fileBodyList = await ds.getRepository(FileBodyEntity).find({
        where: { orgKey, id: In(fileBodyIdList) }
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
    const dataList = await Promise.all(Object.keys(fileIdMap).map(async key => {
        const fileBody = fileIdMap[key].fileBody;
        // console.log(fileIdMap[key].fileBody.innerPath, fileIdMap[key].file.filePath);
        // TODO powerpoint,wordはPDFに変換してあるので、それを無理やりここで突っ込む。無理矢理すぎるので後で直したい。
        if (['application/pdf', ...convertToPdfMimeList].includes(fileBody.fileType)) {
            const splitted = fileBody.innerPath.split('.');
            fileBody.fileType = 'application/pdf';
            splitted[splitted.length - 1] = '';
            const basename = splitted.join('.');
            // console.log(splitted.join('.'));
            if (fileBody.metaJson?.isEnable && fileBody.metaJson?.numPages) {
                const numPages = fileBody.metaJson?.numPages;
                const fileAry = [];
                // 1個目はPDFを読み込む
                fileAry.push(await fs.readFile(`${basename}pdf`));
                // 2個目はメタ情報jsonを読み込む
                fileAry.push(await fs.readFile(`${basename}json`));
                // 3個目以降は各ページの画像と抽出したテキストを読み込む
                for (let iPage = 1; iPage <= numPages; iPage++) {
                    fileAry.push(await fs.readFile(`${basename}${iPage}.png`));
                }
                return fileAry;
            } else {
                // 無効なPDFの場合はスキップ
                // TODO 本当はエラーとか出したい
                return [];
            }
        } else {
            return [await fs.readFile(fileBody.innerPath)];
        }
    })).then(dataList => {
        const fileIdList = Object.keys(fileIdMap);
        return dataList.map((data, index) => ({
            fileGroupId: fileIdMap[fileIdList[index]].file.fileGroupId,
            id: fileIdMap[fileIdList[index]].file.id,
            type: fileIdMap[fileIdList[index]].fileBody.fileType,
            base64List: data.map(d => d.toString('base64')),
        }));
    });
    const fileGroupBodyMap = dataList.reduce((prev, curr) => {
        if (prev[curr.fileGroupId]) {
        } else {
            prev[curr.fileGroupId] = [];
        }
        prev[curr.fileGroupId].push({
            file: fileIdMap[curr.id].file,
            fileBody: fileIdMap[curr.id].fileBody,
            base64List: curr.base64List.map(base64 => `data:${curr.type};base64,${base64}`)
        });
        return prev;
    }, {} as { [fileGroupId: string]: { file: FileEntity, fileBody: FileBodyEntity, base64List: string[] }[] });

    Object.entries(fileGroupBodyMap).forEach(([fileGroupId, value]) => {
        fileGroupIdChatCompletionContentPartImageMap[fileGroupId] = value.filter(file => file.file.isActive && !invalidMimeList.includes(file.fileBody.fileType)).map(file => {
            return file.base64List.map(base64 => ({ type: 'image_url', image_url: { url: base64, label: file.file.fileName } })) as ChatCompletionContentPartImage[];
        });
    });

    return fileGroupIdChatCompletionContentPartImageMap;
}

/**
 * ProjectModelからAIに投げる用のinDtoを組み立てる。
 * @param userId 
 * @param messageId 
 * @returns 
 */
export type ArgsBuildType = 'threadGroup' | 'thread' | 'messageGroup' | 'message' | 'contentPart';
export type MessageSet = { threadGroup: ThreadGroupEntity, thread: ThreadEntity, messageGroup: MessageGroupEntity, message: MessageEntity, contentPartList: ContentPartEntity[] };
export type MessageArgsSet = MessageSet & { args: MyChatCompletionCreateParamsStreaming, options?: { idempotencyKey?: string }, } & { totalTokens?: number, totalBillableCharacters?: number } & { aiProviderClient: AIProviderClient };
async function buildArgs(
    user: UserTokenPayloadWithRole,
    type: ArgsBuildType,
    idList: string[],
    mode: 'countOnly' | 'createCache' | undefined = undefined,
    // dataUrlMap: Record<string, { file: FileEntity, fileBody: FileBodyEntity, base64: string }> = {},
    // fileGroupBodyMap: { [fileGroupId: string]: { file: FileEntity, fileBody: FileBodyEntity, base64: string }[] } = {},
    fileGroupIdChatCompletionContentPartImageMap: { [fileGroupId: string]: ChatCompletionContentPartImage[][] } = {},
): Promise<{
    messageArgsSetList: MessageArgsSet[],
}> {
    // 万が一にもwhere句の中の条件に対してundefinedが入ってはいけないので強制的に||''を足しておく。
    // where句の条件項目に対してundefinedが入ってしまうと、条件自体が消えるので、結果的に適当に選ばれたやつが選択される。

    // 指定されたIDから末尾（トリガー）となるメッセージを取得する。
    // 共通のクエリヘルパー関数
    const getLatestMessagesByMessageGroupIds = async (messageGroupIds: string[]): Promise<MessageEntity[]> => {
        const activeMessage = await ds.getRepository(MessageEntity)
            .createQueryBuilder("t")
            .select("t.*") // ここは性能が悪化してきたら絞った方がいいかもしれない。少なくともlabelは要らないので。
            .addSelect("ROW_NUMBER() OVER (PARTITION BY COALESCE(t.edited_root_message_id, t.id) ORDER BY t.last_update DESC)", "rn")
            .where("t.org_key =:orgKey AND t.message_group_id IN (:...ids)", { orgKey: user.orgKey, ids: messageGroupIds })
            .getRawMany()
            .then(rawData => rawData.filter(row => row.rn === '1')); // フィルタリングをアプリケーション側で実施;
        return convertKeysToCamelCase(activeMessage);
    };
    const getLatestMessageGroupsByThreadIds = async (threadIds: string[]): Promise<MessageGroupEntity[]> => {
        const subQuery = ds.getRepository(MessageGroupEntity)
            .createQueryBuilder("t")
            .select([
                "t.*",
                "ROW_NUMBER() OVER (PARTITION BY COALESCE(t.thread_id, t.id) ORDER BY t.last_update DESC) AS rn"
            ])
            .where("t.org_key = :orgKey AND t.thread_id IN (:...ids)", { orgKey: user.orgKey, ids: threadIds });

        const activeGroups = await ds.createQueryBuilder()
            .select("*")
            .from("(" + subQuery.getQuery() + ")", "sub")
            .setParameters(subQuery.getParameters())
            .where("sub.rn = :rn", { rn: 1 })
            .getRawMany();

        const previousIds = new Set(activeGroups.map(g => g.previousMessageGroupId).filter(Boolean));
        return convertKeysToCamelCase(activeGroups.filter(group => !previousIds.has(group.id)));
    };
    const getActiveMessageGroupsByMessageGroupIds = async (ids: string[]): Promise<MessageGroupEntity[]> => {
        return ds.getRepository(MessageGroupEntity).find({
            where: { orgKey: user.orgKey, id: In(ids) }
        });
    };
    const getActiveThreadsByThreadIds = async (ids: string[]): Promise<ThreadEntity[]> => {
        return ds.getRepository(ThreadEntity).find({
            where: { orgKey: user.orgKey, id: In(ids), status: Not(ThreadStatus.Deleted) }
        });
    };
    const getActiveThreadGroupsByThreadGroupIds = async (ids: string[]): Promise<ThreadGroupEntity[]> => {
        return ds.getRepository(ThreadGroupEntity).find({
            where: { orgKey: user.orgKey, id: In(ids), status: Not(ThreadGroupStatus.Deleted) }
        });
    };

    function convertKeysToCamelCase(rows: any[]): any[] {
        return rows.map(row => {
            const converted: any = {};
            Object.keys(row).forEach(key => {
                converted[Utils.toCamelCase(key)] = row[key];
            });
            return converted;
        });
    }

    // メインの処理関数
    const getTailMessages = async (type: ArgsBuildType, idList: string[]): Promise<{
        tailMessageSetList: MessageSet[], // トリガーとなるメッセージ
        messageGroupList: MessageGroupEntity[], // 参照権限チェック用
        threadList: ThreadEntity[], // 対象メッセージ全量を取得するためのスレッドリスト
        threadGroupList: ThreadGroupEntity[], // 参照権限チェック用
    }> => {
        let tailMessageList: MessageEntity[] = [];
        let messageGroupList: MessageGroupEntity[] = [];
        let threadList: ThreadEntity[] = [];
        let threadGroupList: ThreadGroupEntity[] = [];
        if (type === 'contentPart') {
            // console.log('contentPart');
            // console.log(idList);
            const contentpartList = await ds.getRepository(ContentPartEntity).find({
                where: { orgKey: user.orgKey, id: In(idList), status: Not(ContentPartStatus.Deleted) },
            })
            // console.log(contentpartList);
            tailMessageList = await ds.getRepository(MessageEntity).find({
                where: { orgKey: user.orgKey, id: In(contentpartList.map(cp => cp.messageId)) },
            });
            messageGroupList = await getActiveMessageGroupsByMessageGroupIds(tailMessageList.map(m => m.messageGroupId));
            threadList = await getActiveThreadsByThreadIds(messageGroupList.map(mg => mg.threadId));
            threadGroupList = await getActiveThreadGroupsByThreadGroupIds(threadList.map(t => t.threadGroupId));
        } else if (type === 'message') {
            tailMessageList = await ds.getRepository(MessageEntity).find({
                where: { orgKey: user.orgKey, id: In(idList) },
            });
            messageGroupList = await getActiveMessageGroupsByMessageGroupIds(tailMessageList.map(m => m.messageGroupId));
            threadList = await getActiveThreadsByThreadIds(messageGroupList.map(mg => mg.threadId));
            threadGroupList = await getActiveThreadGroupsByThreadGroupIds(threadList.map(t => t.threadGroupId));
        } else if (type === 'messageGroup') {
            messageGroupList = await getActiveMessageGroupsByMessageGroupIds(idList);
            tailMessageList = await getLatestMessagesByMessageGroupIds(messageGroupList.map(mg => mg.id));
            threadList = await getActiveThreadsByThreadIds(messageGroupList.map(mg => mg.threadId));
            threadGroupList = await getActiveThreadGroupsByThreadGroupIds(threadList.map(t => t.threadGroupId));
        } else if (type === 'thread') {
            threadList = await getActiveThreadsByThreadIds(idList);
            messageGroupList = await getLatestMessageGroupsByThreadIds(threadList.map(t => t.id));
            // // threadListのIDと同じ順にmessageGroupListを並び替え
            // messageGroupList = threadList.map(thread =>
            //     messageGroupList.find(mg => mg.threadId === thread.id)
            // ).filter((mg): mg is MessageGroupEntity => mg !== undefined);
            // console.log(messageGroupList);
            tailMessageList = await getLatestMessagesByMessageGroupIds(messageGroupList.map(mg => mg.id));
            // console.log(tailMessageList);
            threadGroupList = await getActiveThreadGroupsByThreadGroupIds(threadList.map(t => t.threadGroupId));
            // console.log(threadGroupList);
        } else if (type === 'threadGroup') {
            threadGroupList = await getActiveThreadGroupsByThreadGroupIds(idList);
            threadList = await ds.getRepository(ThreadEntity).find({
                where: { orgKey: user.orgKey, threadGroupId: In(threadGroupList.map(tg => tg.id)), status: Not(ThreadStatus.Deleted) }
            });
            messageGroupList = await getLatestMessageGroupsByThreadIds(threadList.map(t => t.id));
            tailMessageList = await getLatestMessagesByMessageGroupIds(messageGroupList.map(mg => mg.id));
        } else { }

        const threadGroupMas = threadGroupList.reduce((prev, curr) => {
            prev[curr.id] = curr; return prev;
        }, {} as { [threadGroupId: string]: ThreadGroupEntity });
        const threadMas = threadList.reduce((prev, curr) => {
            prev[curr.id] = curr; return prev;
        }, {} as { [threadId: string]: ThreadEntity });
        const messageGroupMas = messageGroupList.reduce((prev, curr) => {
            prev[curr.id] = curr; return prev;
        }, {} as { [messageGroupId: string]: MessageGroupEntity });

        const tailMessageSetList: MessageSet[] = tailMessageList.map(message => ({
            contentPartList: [],
            message,
            messageGroup: messageGroupMas[message.messageGroupId],
            thread: threadMas[messageGroupMas[message.messageGroupId].threadId],
            threadGroup: threadGroupMas[threadMas[messageGroupMas[message.messageGroupId].threadId].threadGroupId],
        }));
        return { tailMessageSetList, messageGroupList, threadList, threadGroupList };
    };

    const { tailMessageSetList, messageGroupList, threadList, threadGroupList } = await getTailMessages(type, idList);
    if (tailMessageSetList.length === 0) {
        throw new Error('メッセージが見つかりませんでした');
    } else { }

    // プロジェクトの取得と権限チェック
    const projectList = await ds.getRepository(ProjectEntity).find({
        where: { orgKey: user.orgKey, id: In(threadGroupList.map(message => message.projectId)) }
    });

    // メンバーチェック
    const teamMemberList = await ds.getRepository(TeamMemberEntity).find({
        where: { orgKey: user.orgKey, teamId: In(projectList.map(project => project.teamId)), userId: user.id || '' }
    });

    // 権限チェック
    teamMemberList.forEach(teamMember => {
        if (mode !== 'countOnly' && (!teamMember || (teamMember.role !== TeamMemberRoleType.Owner && teamMember.role !== TeamMemberRoleType.Member))) {
            throw new Error('このスレッドにメッセージを作成または更新する権限がありません');
        } else { }
    });

    // メッセージグループ全量取得->マップ化
    const messageGroupListAll = await ds.getRepository(MessageGroupEntity).find({
        where: { orgKey: user.orgKey, threadId: In(threadList.map(thread => thread.id)) },
        order: { updatedAt: 'ASC' }
    });
    const messageGroupMap = Object.fromEntries(messageGroupListAll.map(messageGroup => [messageGroup.id, messageGroup]));

    // メッセージ全量マップ取得->マップ化
    const messageListAll = await ds.getRepository(MessageEntity).find({
        where: { orgKey: user.orgKey, messageGroupId: In(Object.keys(messageGroupMap)) },
    });
    const messageMap = Object.fromEntries(messageListAll.map(message => [message.id, message]));
    const messageMapByMessageGroupId = messageListAll.reduce((prev, curr) => {
        if (curr.messageGroupId in prev) {
            prev[curr.messageGroupId].push(curr);
        } else {
            prev[curr.messageGroupId] = [curr];
        }
        return prev;
    }, {} as Record<string, MessageEntity[]>);

    const messageArgsSetList: MessageArgsSet[] = [];
    let index = 0;
    for (const messageSet of tailMessageSetList) {
        // トリガーを引かれたメッセージIDから一番先頭まで遡ると関係するメッセージだけの一直線のリストが作れる。
        let messageSetList = [] as { messageGroup: MessageGroupEntity, message: MessageEntity, conentPartList: ContentPartEntity[] }[];
        let lastMessageGroup = messageSet.messageGroup;
        const lastMessage = messageMap[messageSet.message.id];
        let currMessage = messageMap[messageSet.message.id];
        while (lastMessageGroup) {
            // subSeqで絞り込んでupdatedAtの降順>seqの降順でソートしておく。なお、systemのように1メッセージしかもっていないやつの場合はsubSeqが0とする。こうしないと広がらない。
            const subSeq = messageMapByMessageGroupId[lastMessageGroup.id].length === 1 ? 0 : lastMessage.subSeq;
            currMessage = messageMapByMessageGroupId[lastMessageGroup.id].filter(message => message.subSeq === subSeq).sort((a, b) => {
                if (a.updatedAt > b.updatedAt) return -1;
                if (a.updatedAt < b.updatedAt) return 1;
                return a.seq - b.seq;
            })[0];
            messageSetList.push({ messageGroup: lastMessageGroup, message: currMessage, conentPartList: [] });
            lastMessageGroup = messageGroupMap[lastMessageGroup.previousMessageGroupId || ''];
        }
        messageSetList.reverse();
        // console.log(messageSetList.map(messageSet => messageSet.message.id));
        // console.log(messageSet.thread.inDto)

        const inDto = messageSet.thread.inDto as { args: MyChatCompletionCreateParamsStreaming, options?: { idempotencyKey?: string }, };

        if (mode === 'createCache') {
            // キャッシュ作成の時はゴミが残ってても上から更新する。
        } else {
            // contextCacheが効いている場合はキャッシュ文のメッセージを外す。
            if (inDto.args && (inDto.args as any).cachedContent) {
                const cache = (inDto.args as any).cachedContent as CachedContent;
                if (new Date(cache.expireTime) > new Date()) {
                    // live キャッシュが有効なのでキャッシュ済みメッセージを排除する。
                    messageSetList = messageSetList.filter(obj => !obj.message.cacheId);
                } else { /* Cache is expired */ }
            } else { /* thread is not initialized */ }
        }

        // 対象メッセージID全部についてコンテンツを取得
        // console.log('messageSetList=', messageSetList.map(messageSet => messageSet));
        // console.dir(messageSetList);
        // console.log('messageSetList=', messageSetList.map(messageSet => messageSet));
        const messageIdList = messageSetList.map(messageSet => messageSet.message.id);
        const contentPartList = await ds.getRepository(ContentPartEntity).find({
            where: { orgKey: user.orgKey, messageId: In(messageIdList), status: Not(ContentPartStatus.Deleted) },
            order: { seq: 'ASC' },
        });

        const contentPartMap = contentPartList.reduce((map, part) => {
            (map[part.messageId] ??= []).push(part);
            return map;
        }, {} as Record<string, ContentPartEntity[]>);

        // contentpartの内容を取得
        messageSet.contentPartList = contentPartMap[messageSet.message.id] || [];
        // // この後切り詰められてもいいように配列を別オブジェクトとしてコピーしておく。
        // messageSet.contentPartList = [...contentPartList];
        // // if (type === 'contentPart') {
        // //     // contentPart指定の場合は指定されたIDを末尾とする。
        // //     const targetIndex = contentPartList.findIndex(contentPart => contentPart.id === idList[index]);
        // //     // TODO 末尾以降のコンテンツは削除フラグを立てておく。ここではtransactionを持っていないので実際に消すのはメソッドの外。超スパゲティ感があるので何とかしたい。
        // //     for (let i = targetIndex + 1; i < contentPartList.length; i++) {
        // //         const contentPart = contentPartList[i];
        // //         contentPart.status = ContentPartStatus.Deleted;
        // //     }
        // //     contentPartList.length = targetIndex + 1;
        // // } else { }

        if (mode === 'countOnly') {
            // TODO カウントのみの場合はトークン数だけ返す。超絶無理矢理なので何とかしたい。
            const textContentList = contentPartList.filter(contentPart => contentPart.type === 'text').filter(contentPart => contentPart.tokenCount).map(contentPart => contentPart.tokenCount) as { [model: string]: CountTokensResponse }[];
            const fileGroupIdList = contentPartList.filter(contentPart => contentPart.type === 'file').map(contentPart => contentPart.linkId).filter(Boolean) as string[];
            const toolGroupIdList = contentPartList.filter(contentPart => contentPart.type === 'tool').map(contentPart => contentPart.linkId).filter(Boolean) as string[];

            const fileTokenCountList = await getCountTokenListByFileGroupIdList(user.orgKey, fileGroupIdList);
            const toolTokenCountList = await getCountTokenListByToolGroupIdList(user.orgKey, toolGroupIdList);
            const tokenCountSummary: { [model: string]: { totalTokens: number, totalBillableCharacters?: number } } = {};
            for (const tokenCount of textContentList.concat(fileTokenCountList).concat(toolTokenCountList)) {
                for (const model of Object.keys(tokenCount)) {
                    if (tokenCountSummary[model]) {
                        tokenCountSummary[model].totalTokens += tokenCount[model].totalTokens;
                        tokenCountSummary[model].totalBillableCharacters = (tokenCountSummary[model].totalBillableCharacters || 0) + (tokenCount[model].totalBillableCharacters || 0);
                    } else {
                        tokenCountSummary[model] = { totalTokens: tokenCount[model].totalTokens, totalBillableCharacters: tokenCount[model].totalBillableCharacters || 0 };
                    }
                }
            }
            messageArgsSetList.push({
                ...messageSet,
                tokenCountSummary,
            } as any); // 面倒なので無理矢理トークン数だけ返す
            continue;
        } else { }

        // コンテンツIDリストからDataURLのマップを作成しておく。
        fileGroupIdChatCompletionContentPartImageMap = await buildFileGroupBodyMap(user.orgKey, contentPartList, fileGroupIdChatCompletionContentPartImageMap);
        // console.log(Object.keys(fileGroupIdChatCompletionContentPartImageMap));

        // console.log(`\n\ncontentPartList.length = ${contentPartList.length}\n`);
        // argsを組み立てる
        inDto.args.messages = [];
        for (const messageSet of messageSetList) {
            let message = {
                role: messageSet.messageGroup.role,
                content: [] as ChatCompletionContentPart[],
            } as { role: string, content: ChatCompletionContentPart[] };
            for (const content of contentPartMap[messageSet.message.id]) {
                // contentPartMap[messageSet.message.id].forEach(content => {
                if (content.type === 'text') {
                    // console.log(content.text);
                    message.content.push({ type: 'text', text: content.text || '' });
                } else if (content.type === 'error') {
                    message.content.push({ type: 'error' as any, text: content.text || '' });
                } else if (content.type === 'file' && content.linkId) {
                    // console.log('content.fileGroupId=', content.linkId, content);
                    // console.log(Object.keys(fileGroupIdChatCompletionContentPartImageMap));
                    fileGroupIdChatCompletionContentPartImageMap[content.linkId].forEach(imageAry => {
                        const image = imageAry[0];
                        const mime = image.image_url.url.substring(5, image.image_url.url.indexOf(';'));
                        if (['application/pdf', ...convertToPdfMimeList].includes(mime)) {
                            const provider = providerPrediction(inDto.args.model)
                            if (inDto.args.model.startsWith('gemini-')) {
                                // gemini系はPDFのまま突っ込むだけ
                                message.content.push(image);
                            } else if (provider === 'openai') {
                                // gpt系はPDFを画像化して突っ込む。
                                message.content.push({ type: 'file', file: { file_data: image.image_url.url, filename: content.text } } as ChatCompletionContentPart.File);
                            } else {
                                // gemini系以外は画像化したものとテキスト抽出したものを組合せる。
                                const jsonString = Utils.dataUrlToData(imageAry[1].image_url.url);
                                const pdfMetaData = JSON.parse(jsonString) as PdfMetaData;
                                let metaText = `---\n${(image.image_url as any).label} start\n\n`;
                                if (pdfMetaData.info) {
                                    metaText += `## Info\n\n`;
                                    metaText += ['CreationDate', 'ModDate', 'Title', 'Creator', 'Author'].map(tag => `- ${tag}: ${pdfMetaData.info[tag]}\n`);
                                } else { }
                                if (pdfMetaData.outline) {
                                    metaText += `## Outline\n\n ${JSON.stringify(pdfMetaData.outline)}\n`;
                                } else { }
                                // console.dir(imageAry);
                                // console.log(pdfMetaData.textPages);
                                // メタ情報をJSON形式のまま突っ込む（整形してもいいかもしれない）
                                message.content.push({ type: 'text', text: metaText });
                                // 画像とテキストを組合せる（画像は3個目からなので前二つを落としておく）
                                imageAry.slice(2).forEach((image, iPage) => {
                                    // mimeがapplication/pdfになってしまっているのでimage/pngに直す
                                    const [mimeType, base64String] = Utils.dataUrlSplit(image.image_url.url);
                                    message.content.push({ type: 'image_url', image_url: { url: `data:image/png;base64,${base64String}`, label: (image.image_url as any).label } } as ChatCompletionContentPartImage);
                                    message.content.push({ type: 'text', text: pdfMetaData.textPages[iPage] });
                                });
                                message.content.push({ type: 'text', text: `${(image.image_url as any).label} end\n---\n` });
                            }
                        } else {
                            // PDF以外は普通に一個のファイルを突っ込むだけ
                            message.content.push(image);
                        }
                    });
                } else if (content.type === 'tool') {

                    // toolCallGroupIdがある場合はtoolCallを取得して組み立てる
                    const toolCallList = await ds.getRepository(ToolCallPartEntity).find({
                        where: { orgKey: user.orgKey, toolCallGroupId: content.linkId || '' },
                        order: { seq: 'ASC' },
                    });
                    const tollCallObjectKeyListSequencial: string[] = [];
                    const toolCallObjectMap = toolCallList.filter(toolCall => [ToolCallPartType.CALL, ToolCallPartType.RESULT].includes(toolCall.type)).reduce((prev, curr) => {
                        if (prev[curr.toolCallId]) {
                        } else {
                            prev[curr.toolCallId] = { tool_call_id: curr.id, call: curr.body as ToolCallPartCallBody as ChatCompletionMessageToolCall };
                            tollCallObjectKeyListSequencial.push(curr.toolCallId);
                        }
                        // 
                        if (curr.type === ToolCallPartType.CALL) {
                            prev[curr.toolCallId].call = curr.body as ToolCallPartCallBody as ChatCompletionMessageToolCall;
                        } else if (curr.type === ToolCallPartType.RESULT) {
                            prev[curr.toolCallId].result = curr.body as ToolCallPartResultBody as ChatCompletionToolMessageParam;
                        }
                        return prev;
                    }, {} as { [tool_call_id: string]: { tool_call_id: string, call: ChatCompletionMessageToolCall, result?: ChatCompletionToolMessageParam } });

                    for (const toolCallId of tollCallObjectKeyListSequencial) {
                        const toolCall = toolCallObjectMap[toolCallId];
                        // ### callの設定
                        // toolはresultなので外して考える。toolを外したうえで直前のassistantがtool_callsを持っているのであれば、その中に追加する。
                        // const before = inDto.args.messages.filter(message => message.role !== 'tool').at(-1);
                        // console.log(`\n\nbefore=${JSON.stringify(before)}`);
                        let isAppend = false;
                        if (message.role === 'assistant') {
                            // 一個前のやつに追加するパsターン
                            const beforeAssistant = message as ChatCompletionAssistantMessageParam;
                            if (beforeAssistant.tool_calls) {
                            } else {
                                beforeAssistant.tool_calls = [];
                            }
                            beforeAssistant.tool_calls.push(toolCall.call);
                            // console.log(`-------------------BeforeAssistant-------------------`);
                            // console.dir(beforeAssistant);
                            isAppend = true;
                        } else { }
                        if (!isAppend) {
                            // 新規のtoolの場合は messageレベルでブレイクする
                            if (message.content.length > 0 || (message as ChatCompletionAssistantMessageParam).tool_calls) {
                                // 現在のmessageが空でない場合はargsに追加して新しいmessageを作る
                                inDto.args.messages.push(message as ChatCompletionMessageParam);
                            } else {
                                // 現在のmessageがの場合は現在のmessageは破棄する
                            }
                            message = {
                                role: 'assistant', content: [], tool_calls: [toolCall.call],
                            } as { role: string, content: ChatCompletionContentPart[], tool_calls: ChatCompletionMessageToolCall[] };
                            inDto.args.messages.push(message as ChatCompletionMessageParam);
                            // console.log(`-------------------isNotAppend-------------------`);
                            // console.dir(inDto.args.messages, { depth: null });
                            // 次サイクル用のmessageを初期化
                            message = {
                                role: messageSet.messageGroup.role,
                                content: [] as ChatCompletionContentPart[],
                            } as { role: string, content: ChatCompletionContentPart[] };
                        } else { }

                        // ### resultの設定
                        if (toolCall.result) {
                            const result = toolCall.result;
                            // resultがあればmessageレベルでブレイクする
                            if (message.content.length > 0 || (message as ChatCompletionAssistantMessageParam).tool_calls) {
                                // 現在のmessageが空でない場合はargsに追加して新しいmessageを作る
                                inDto.args.messages.push(message as ChatCompletionMessageParam);
                            } else {
                                // 現在のmessageがの場合は現在のmessageは破棄する
                            }
                            // roleは実際はtoolが入ってくる。
                            message = {
                                role: result.role, content: [{ type: 'text', text: result.content }], tool_call_id: result.tool_call_id,
                            } as { role: string, content: ChatCompletionContentPart[] };
                            inDto.args.messages.push(message as ChatCompletionMessageParam);
                            // 次サイクル用のmessageを初期化
                            message = {
                                role: messageSet.messageGroup.role,
                                content: [] as ChatCompletionContentPart[],
                            } as { role: string, content: ChatCompletionContentPart[] };
                        } else {
                            // 実行前の状態
                        }
                    }
                } else if (content.type === `meta`) {
                    try {
                        const meta = JSON.parse(content.text || '{}') as { thinking: string, signature: string };
                        if (meta.thinking && inDto.args.model.includes('-sonnet-thinking')) {
                            message.content.push({ type: 'thinking' as 'text', thinking: meta.thinking || '', signature: meta.signature || '' } as any);
                        } else {
                            console.log(`\n\nskip content=${JSON.stringify(content)}`);
                        }
                    } catch (error) {
                        console.log(`\n\nskip meta parse error ${content.text}`);
                    }
                } else {
                    console.log(`\n\nskip content=${JSON.stringify(content)}`);
                }
            }
            // console.log('message=', message);
            // console.dir(message);
            inDto.args.messages.push(message as ChatCompletionMessageParam);
        }
        inDto.args.messages = inDto.args.messages.filter(message => {
            const contents = (message.content as ChatCompletionContentPart[] || [])
            message.content = contents.filter(content => !(content.type === 'text' && !content.text));
            return contents.length > 0 || ((message as ChatCompletionAssistantMessageParam).tool_calls || []).length > 0
        });

        // AIプロバイダクライアントを取得
        const aiProviderClient = await getAIProvider(user, inDto.args.model || 'default-model');

        messageArgsSetList.push({ ...messageSet, args: inDto.args, options: inDto.options, aiProviderClient });

        // 無理矢理だが、o系のモデルは出力が苦手なので調整しておく。
        if (inDto.args.model.startsWith('o1') || inDto.args.model.startsWith('o3') || inDto.args.model.startsWith('o4')) {
            inDto.args.messages.forEach(message => {
                // if (message.role === 'system') {
                //     // o系は出力が苦手なので調整しておく。
                //     const additionPrompt = Utils.trimLines(`

                //         ## 標準的な出力フォーマット

                //         この後、特に指示がない限り以下のフォーマットで出力してください。

                //         - markdown形式
                //         - 数式を書く際はkatexが反応する形式で書いてください（例：$...$）。
                //         - ファイル出力する際はブロックの先頭にファイル名をフルパスで埋め込んでください（例：\`\`\`typescript src/app/filename.ts\n...\n\`\`\` ）
                //     `);
                //     if (typeof message.content === 'string') {
                //         message.content = message.content + additionPrompt;
                //     } else if (Array.isArray(message.content)) {
                //         message.content.push({ type: 'text', text: additionPrompt });
                //     }
                // } else { }
            });
        } else { }

        index++;
    }
    // console.dir(messageArgsSetList, { depth: null });
    return { messageArgsSetList };
}


export async function getAIProviderAndModel(user: UserTokenPayloadWithRole, modelName: string): Promise<{ aiProvider: AIProviderEntity, aiModel: AIModelEntity }> {
    const model = await ScopedEntityService.findByNameWithScope(
        ds.getRepository(AIModelEntity),
        modelName,
        user
    );

    if (!model) {
        throw new Error(`モデル ${modelName} が見つかりません。`);
    }

    if (!TokenCount.COST_TABLE[modelName]) {
        // TODO 本来はidじゃなくてnameで当ててscopeの優先順位計算をすべきだが一旦手抜き
        const price = await ds.getRepository(AIModelPricingEntity).findOne({
            where: safeWhere({ orgKey: user.orgKey, modelId: model.id, isActive: true }),
        }) || {} as AIModelPricingEntity;
        if (!price.id) {
            // console.log(`モデル ${modelName} の価格情報が見つからないので、デフォルトの価格を設定します。`);
            // errorでもよかったが一応、、
            // throw new Error(`モデル ${modelName} の価格情報が見つかりません。`);
            Object.assign(price, {
                id: '',
                orgKey: user.orgKey,
                modelId: model.id,
                scopeInfo: {
                    scopeType: ScopeType.ORGANIZATION,
                    scopeId: user.orgKey,
                },
                name: modelName,
                inputPricePerUnit: 0,
                outputPricePerUnit: 0,
                unit: '',
                validFrom: new Date(),
                isActive: true,
            });
        } else { }

        // CONST_TABLEに無理やり追加。本当はこんなやり方はしたくない。
        TokenCount.COST_TABLE[modelName] = {
            prompt: price.inputPricePerUnit,
            completion: price.outputPricePerUnit,
            metadata: price.metadata,
        } as { prompt: number, completion: number, metadata?: any };
        // console.log(`モデル ${modelName} の価格情報をデフォルト値で設定しました。`, TokenCount.COST_TABLE[modelName]);
    } else { }

    const providerList = await Promise.all(
        model.providerNameList.map(async providerName => {
            // プロバイダを取得
            const provider = await ScopedEntityService.findByNameWithScope(
                ds.getRepository(AIProviderEntity),
                providerName,
                user
            );
            if (!provider) {
                throw new Error(`プロバイダ ${providerName} が見つかりません。`);
            }
            return provider;
        }).filter(provider => !!provider)
    ) as AIProviderEntity[];

    // console.log(`\n\nproviderSetMap=${JSON.stringify(providerSetMap, null, 2)}`);
    // providerSetMapのキーをプロバイダIDにして最初のプロバイダ名を使用
    return {
        aiProvider: providerList[Math.floor(Math.random() * providerList.length)],
        aiModel: model, // 最優先のモデルを使用
    };
}

export async function getAIProvider(user: UserTokenPayloadWithRole, modelName: string): Promise<AIProviderClient> {
    const { aiProvider, aiModel } = await getAIProviderAndModel(user, modelName);

    if (providerInstances[aiProvider.id] && providerInstances[aiProvider.id].updatedAt.getTime() === aiProvider.updatedAt.getTime()) {
        // 既にクライアントが生成されている場合はそれを返す
        return providerInstances[aiProvider.id].client;
    } else { }

    console.log(`Using AI provider: ${aiProvider.name} (${aiProvider.type}) ${aiProvider.id})`);

    let aiProviderClient: AIProviderClient;

    // プロバイダのクライアントを生成
    switch (aiProvider.type) {
        case AIProviderType.OPENAI:
            aiProviderClient = { name: aiProvider.name, type: aiProvider.type, client: new MyOpenAI([getAIProviderConfig(aiProvider, aiProvider.type)]) };
            break;
        case AIProviderType.AZURE_OPENAI:
            aiProviderClient = { name: aiProvider.name, type: aiProvider.type, client: new MyAzureOpenAI([getAIProviderConfig(aiProvider, aiProvider.type)]) };
            break;
        case AIProviderType.ANTHROPIC:
            aiProviderClient = { name: aiProvider.name, type: aiProvider.type, client: new MyAnthropic([getAIProviderConfig(aiProvider, aiProvider.type)]) };
            break;
        case AIProviderType.CEREBRAS:
            const cerebrasConfig = [getAIProviderConfig(aiProvider, aiProvider.type)];
            cerebrasConfig.forEach(obj => obj.endpoints ? obj.endpoints.forEach(endpoint => endpoint.baseURL = endpoint.baseURL || 'https://api.cerebras.ai/v1') : null);
            aiProviderClient = { name: aiProvider.name, type: aiProvider.type, client: new MyOpenAI(cerebrasConfig) };
            break;
        case AIProviderType.GROQ:
            const groqConfig = [getAIProviderConfig(aiProvider, aiProvider.type)];
            groqConfig.forEach(obj => obj.endpoints ? obj.endpoints.forEach(endpoint => endpoint.baseURL = endpoint.baseURL || 'https://api.groq.com/openai/v1') : null);
            aiProviderClient = { name: aiProvider.name, type: aiProvider.type, client: new MyOpenAI(groqConfig) };
            break;
        case AIProviderType.MISTRAL:
            const mistralConfig = [getAIProviderConfig(aiProvider, aiProvider.type)];
            mistralConfig.forEach(obj => obj.endpoints ? obj.endpoints.forEach(endpoint => endpoint.baseURL = endpoint.baseURL || 'https://api.mistral.com/v1') : null);
            aiProviderClient = { name: aiProvider.name, type: aiProvider.type, client: new MyOpenAI(mistralConfig) };
            break;
        case AIProviderType.DEEPSEEK:
            const deepSeekConfig = [getAIProviderConfig(aiProvider, aiProvider.type)];
            deepSeekConfig.forEach(obj => obj.endpoints ? obj.endpoints.forEach(endpoint => endpoint.baseURL = endpoint.baseURL || 'https://api.deepseek.com/v1') : null);
            aiProviderClient = { name: aiProvider.name, type: aiProvider.type, client: new MyOpenAI(deepSeekConfig) };
            break;
        case AIProviderType.LOCAL:
            aiProviderClient = { name: aiProvider.name, type: aiProvider.type, client: new MyOpenAI([getAIProviderConfig(aiProvider, aiProvider.type)]) };
            break;
        case AIProviderType.OPENAI_COMPATIBLE:
            aiProviderClient = { name: aiProvider.name, type: aiProvider.type, client: new MyOpenAI([getAIProviderConfig(aiProvider, aiProvider.type)]) };
            break;
        case AIProviderType.VERTEXAI:
            aiProviderClient = { name: aiProvider.name, type: aiProvider.type, client: new MyVertexAiClient([getAIProviderConfig(aiProvider, aiProvider.type)]) };
            break;
        case AIProviderType.ANTHROPIC_VERTEXAI:
            aiProviderClient = { name: aiProvider.name, type: aiProvider.type, client: new MyAnthropicVertex([getAIProviderConfig(aiProvider, aiProvider.type)]) };
            break;
        case AIProviderType.OPENAPI_VERTEXAI:
            aiProviderClient = { name: aiProvider.name, type: aiProvider.type, client: new MyVertexAiClient([getAIProviderConfig(aiProvider, aiProvider.type)]) };
            break;
        case AIProviderType.COHERE:
            aiProviderClient = { name: aiProvider.name, type: aiProvider.type, client: new MyCohere([getAIProviderConfig(aiProvider, aiProvider.type)]) };
            break;
        case AIProviderType.GEMINI:
            // .map(obj => ({ apiKey: obj.apiKey }))
            aiProviderClient = { name: aiProvider.name, type: aiProvider.type, client: new MyGemini([getAIProviderConfig(aiProvider, aiProvider.type)]) };
            break;
        default:
            throw new Error(`Unknown provider type: ${aiProvider.type}`);
    }

    // クライアントをキャッシュに保存
    providerInstances[aiProvider.id] = { client: aiProviderClient, updatedAt: aiProvider.updatedAt };
    return aiProviderClient;
}

/**
 * [user認証] チャットの送信
 */
export const chatCompletionByProjectModel = [
    query('connectionId').trim().notEmpty(),
    query('streamId').trim().notEmpty(),
    query('type').isIn(['threadGroup', 'thread', 'messageGroup', 'message', 'contentPart']).notEmpty(),
    query('id').trim().notEmpty(),
    // body('args').notEmpty(),
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        const { connectionId, streamId, type, id } = req.query as { connectionId: string, streamId: string, type: ArgsBuildType, id: string };
        // const { args } = req.body as { args: MyChatCompletionCreateParamsStreaming };
        const { toolCallPartCommandList } = req.body as { toolCallPartCommandList: ToolCallPartCommand[] };
        // connectionIdはクライアントで発番しているので、万が一にも混ざらないようにユーザーIDを付与。
        const clientId = `${req.info.user.id}-${connectionId}` as string;
        const stockList: {
            text: string,
            savedMessageId: string,
            transaction: { type: ContentPartType, text: string, body: any }[],
            toolTransaction: ToolCallPart[],
            toolMaster: { [tool_call_id: string]: { toolCallGroupId: string } },
        }[] = [];
        try {

            const my_vertexai = ((await getAIProvider(req.info.user, COUNT_TOKEN_MODEL)).client as MyVertexAiClient);
            const client = my_vertexai.client;
            const generativeModel = client.preview.getGenerativeModel({ model: COUNT_TOKEN_MODEL, safetySettings: [], });

            const idList = id.split('|');
            const { messageArgsSetList } = await buildArgs(req.info.user, type, idList);
            // console.dir(messageArgsSetList[0].args.messages, { depth: null });

            // 重複無しのメッセージグループリスト
            const messageGroupMas = Object.fromEntries(messageArgsSetList.map(({ messageGroup }) => [messageGroup.id, messageGroup]));

            type ResponseObject = { messageGroup: MessageGroupEntity, message: MessageEntity, contentParts: ContentPartEntity[], status: 'ok' };
            const responseObjectStack: (ResponseObject | { status: 'error', error: Error })[] = [];
            function endResponse(resObj: ResponseObject | undefined, error?: Error) {
                if (resObj) {
                    responseObjectStack.push(resObj);
                } else if (error) {
                    responseObjectStack.push({ status: 'error', error });
                }
                if (responseObjectStack.length === messageArgsSetList.length) {
                    // responseObjectStack.forEach(resObj => {
                    //     if (resObj.status === 'ok') {
                    //         resObj.messageGroup;
                    //     } else { }
                    // });
                    // 全部溜まったらメッセージグループに組み立て直して返却
                    const messageGroupMas = responseObjectStack.reduce((prev, curr) => {
                        if (curr.status === 'ok') {
                            // console.log('--------------------------------------------');
                            // console.log(`curr.messageGroup.id=${curr.messageGroup.id}, curr.message.id=${curr.message.id}`);
                            if (prev[curr.messageGroup.id]) {
                            } else {
                                prev[curr.messageGroup.id] = curr.messageGroup;
                                (prev[curr.messageGroup.id] as any).messages = [];
                            }
                            (prev[curr.messageGroup.id] as any).messages.push(curr.message);
                            (curr.message as any).contents = curr.contentParts;
                        } else { }
                        return prev;
                    }, {} as { [messageGroupId: string]: MessageGroupEntity });
                    const messageGroupList = Object.keys(messageGroupMas).map(key => {
                        ((messageGroupMas[key] as any).messages as MessageEntity[]).sort((a, b) => a.seq - b.seq);
                        return messageGroupMas[key];
                    });
                    // すべてのメッセージが処理されたら終了
                    res.end(JSON.stringify(messageGroupList));
                } else { }
            }

            // stockListを作っておく
            messageArgsSetList.forEach(inDto => {
                const stock = { text: '', savedMessageId: '', transaction: [], toolTransaction: [], toolMaster: {} };
                stockList.push(stock);
            });

            const responseObjectList = await ds.transaction(async transactionalEntityManager => {
                if (toolCallPartCommandList && toolCallPartCommandList.length > 0) {
                    // toolCallCommandがある場合はツール実行から＝つまり既存メッセージに対するcontent追加＝つまり新規ではなくて更新なので、inDtoの値をそのまま使う。
                    return Promise.all(messageArgsSetList.map(async (inDto, index) => {
                        stockList[index].savedMessageId = inDto.message.id;

                        // 新しいContentPartを作成（メッセージの末尾に追加する）
                        const newContentPart = new ContentPartEntity();
                        newContentPart.messageId = inDto.message.id;
                        newContentPart.type = ContentPartType.TEXT;
                        newContentPart.text = '';
                        newContentPart.seq = 0;
                        newContentPart.orgKey = req.info.user.orgKey;
                        newContentPart.createdBy = req.info.user.id;
                        newContentPart.updatedBy = req.info.user.id;
                        newContentPart.createdIp = req.info.ip;
                        newContentPart.updatedIp = req.info.ip;
                        const savedContentPart = await transactionalEntityManager.save(ContentPartEntity, newContentPart);
                        // ガラを構築して返却
                        const resObj: ResponseObject = { messageGroup: inDto.messageGroup, message: inDto.message, contentParts: [...inDto.contentPartList, savedContentPart], status: 'ok' };
                        endResponse(resObj);
                        return { inDto, messageSet: resObj };
                    }));
                } else { /** toolCallCommandじゃない場合は新規メッセージのガラを作って返す。 */ }

                const savedMessageGroupMasFunc = async () => {
                    const results: { [messageGroupId: string]: MessageGroupEntity } = {};

                    for (const messageGroupId of Object.keys(messageGroupMas)) {
                        const newMessageGroup = new MessageGroupEntity();
                        newMessageGroup.threadId = messageGroupMas[messageGroupId].threadId;
                        newMessageGroup.type = MessageGroupType.Single;
                        newMessageGroup.role = 'assistant';
                        newMessageGroup.source = messageArgsSetList.find(inDto => inDto.messageGroup.id === messageGroupId)?.args.model;
                        newMessageGroup.orgKey = req.info.user.orgKey;
                        newMessageGroup.createdBy = req.info.user.id;
                        newMessageGroup.createdIp = req.info.ip;
                        newMessageGroup.updatedBy = req.info.user.id;
                        newMessageGroup.updatedIp = req.info.ip;
                        newMessageGroup.previousMessageGroupId = messageGroupId;

                        const savedMessageGroup = await transactionalEntityManager.save(MessageGroupEntity, newMessageGroup);
                        results[messageGroupId] = savedMessageGroup;
                    }

                    return results;
                };

                const savedMessageGroupMas: { [messageGroupId: string]: MessageGroupEntity } = await savedMessageGroupMasFunc();
                return await Promise.all(
                    messageArgsSetList.map(async (inDto, index) => {
                        const stock = stockList[index];
                        const { thread, message } = inDto;
                        const messageGroup = savedMessageGroupMas[message.messageGroupId];
                        // console.log(aiApi.wrapperOptions.provider);

                        // TODO コンテンツキャッシュはIDさえ合っていれば誰でも使える状態。権限付けなくていいか悩み中。
                        const cachedContent = (inDto.args as any).cachedContent as VertexCachedContentEntity;

                        // // 課金用にプロジェクト振り分ける。当たらなかったら当たらなかったでよい。
                        // const departmentMember = await transactionalEntityManager.getRepository(DepartmentMemberEntity).findOne({
                        //     where: safeWhere({
                        //         orgKey: req.info.user.orgKey,
                        //         name: req.info.user.name || '',
                        //         departmentRole: DepartmentRoleType.Member
                        //     })
                        // });
                        // // console.log(departmentMember);
                        // if (departmentMember) {
                        //     const department = await transactionalEntityManager.getRepository(DepartmentEntity).findOne({
                        //         where: safeWhere({
                        //             orgKey: req.info.user.orgKey,
                        //             id: departmentMember.departmentId
                        //         })
                        //     });
                        //     (inDto.args as any).gcpProjectId = department?.gcpProjectId || GCP_PROJECT_ID;
                        //     // console.log(department?.gcpProjectId);
                        // } else {
                        //     // 未設定なら未設定で良しとする。（その場合はAI部課金）
                        // }

                        // chatCompletionObservableStreamがDB登録より先に帰ってきたらバグるので直列にしているが、本来は並列で投げてDB登録が先に終わったらその後の処理をするようにしたい。
                        return await new Promise<{
                            inDto: MessageArgsSet,
                            messageSet: {
                                messageGroup: MessageGroupEntity,
                                message: MessageEntity,
                                contentParts: ContentPartEntity[],
                            }
                        }>(async (resolve, reject) => {
                            try {

                                let savedMessageGroup: MessageGroupEntity;
                                if (type === 'message') {
                                    // 実行単位がmessageの場合は既存のメッセージグループのままでいい。
                                    savedMessageGroup = messageGroup;
                                } else if (type === 'messageGroup') {
                                    // 
                                    savedMessageGroup = messageGroup;
                                } else {
                                    throw new Error('未対応の実行単位です');
                                }

                                // 新しいメッセージを登録
                                const newMessage = new MessageEntity();
                                newMessage.cacheId = undefined;
                                newMessage.label = '';
                                newMessage.subSeq = message.subSeq; // 先行メッセージのサブシーケンスと同じにする
                                newMessage.orgKey = req.info.user.orgKey;
                                newMessage.createdBy = req.info.user.id;
                                newMessage.updatedBy = req.info.user.id;
                                newMessage.createdIp = req.info.ip;
                                newMessage.updatedIp = req.info.ip;
                                newMessage.messageGroupId = savedMessageGroup.id;
                                // 実行単位がmessageの場合はメッセージでバージョン管理する
                                if (type === 'message' && messageGroup.role === 'assistant') {
                                    // 再ランの時は前のメッセージの引き継いでバージョンを上げる。
                                    newMessage.editedRootMessageId = message.editedRootMessageId || message.id;
                                } else {
                                    // 新規メッセージの場合は新規作成
                                }

                                let savedMessage = await transactionalEntityManager.save(MessageEntity, newMessage);
                                // console.log(`savedMessage=${savedMessage.id}`, JSON.stringify(savedMessage));

                                if (type === 'message' && messageGroup.role === 'assistant') {
                                    // 何もしない
                                } else {
                                    // 実行単位がmessageの場合、かつ新規メッセージの場合は編集元IDが空になってしまっているので自分のIDを設定する。
                                    savedMessage.editedRootMessageId = savedMessage.id;
                                    savedMessage = await transactionalEntityManager.save(MessageEntity, savedMessage);
                                }

                                stock.savedMessageId = savedMessage.id;

                                // 新しいContentPartを作成
                                const newContentPart = new ContentPartEntity();
                                newContentPart.messageId = savedMessage.id;
                                newContentPart.type = ContentPartType.TEXT;
                                newContentPart.text = '';
                                newContentPart.seq = 0;
                                newContentPart.orgKey = req.info.user.orgKey;
                                newContentPart.createdBy = req.info.user.id;
                                newContentPart.updatedBy = req.info.user.id;
                                newContentPart.createdIp = req.info.ip;
                                newContentPart.updatedIp = req.info.ip;
                                const savedContentPart = await transactionalEntityManager.save(ContentPartEntity, newContentPart);
                                // ガラを構築して返却
                                const resObj: ResponseObject = { messageGroup: savedMessageGroup, message: savedMessage, contentParts: [savedContentPart], status: 'ok' };

                                // コンテキストキャッシュの利用回数を更新
                                if (cachedContent) {
                                    // console.log(`cachedContent=${cachedContent.id}`, JSON.stringify(cachedContent));
                                    const chacedEntity = await transactionalEntityManager.getRepository(VertexCachedContentEntity).findOne({
                                        where: safeWhere({ orgKey: req.info.user.orgKey, id: cachedContent.id })
                                    })
                                    if (chacedEntity) {
                                        // カウント回数は登り電文を信用しない。
                                        chacedEntity.usage += 1;
                                        chacedEntity.updatedBy = req.info.user.id;
                                        chacedEntity.updatedIp = req.info.ip;
                                        await transactionalEntityManager.save(VertexCachedContentEntity, chacedEntity);
                                    } else {
                                    }
                                } else { }

                                // メッセージのガラだけ返す。
                                // res.end(JSON.stringify(resObj));
                                endResponse(resObj);

                                resolve({ inDto, messageSet: resObj });
                            } catch (error) {
                                endResponse(undefined, error as Error);
                                reject(error);
                            }
                        })

                    })
                );
            });

            // 本来は分けてなかったけど、参照と更新が混在するのでトランザクションで処理しておきたくて分離したブロック
            const providerAndToolCallCallListAry = await ds.transaction(async transactionalEntityManager => {
                return await Promise.all(responseObjectList.map(async (obj, index) => {
                    const inDto = obj.inDto;
                    const messageSet = obj.messageSet;
                    const message = messageSet.message;
                    const stock = stockList[index];
                    const label = req.body.options?.idempotencyKey || `chat-${clientId}-${streamId}-${id}`;
                    // const aiApi = new OpenAIApiWrapper();
                    // console.dir(inDto.args, { depth: null });

                    // レスポンス返した後にゆるりとヒストリーを更新しておく。
                    const history = new PredictHistoryWrapperEntity();
                    history.connectionId = connectionId;
                    history.streamId = streamId;
                    history.messageId = message.id;
                    history.label = label;
                    history.model = inDto.args.model;
                    history.provider = obj.inDto.aiProviderClient.type;
                    history.orgKey = req.info.user.orgKey;
                    history.createdBy = req.info.user.id;
                    history.updatedBy = req.info.user.id;
                    history.createdIp = req.info.ip;
                    history.updatedIp = req.info.ip;
                    await transactionalEntityManager.save(PredictHistoryWrapperEntity, history);

                    // 入力でtoolCallCommandがある場合はツール実行指示からなので、末尾のメッセージID内の全コンテンツのfunctionを実行する
                    const toolCallCallList = [] as ChatCompletionChunk.Choice.Delta.ToolCall[];
                    if (toolCallPartCommandList && toolCallPartCommandList.length > 0) {
                        // console.log(`toolCallCommand=${toolCallCommand} inDto.contentPartList.length=${inDto.contentPartList.length}`);
                        // console.dir(inDto, { depth: null });
                        const targetMessageId = inDto.contentPartList[inDto.contentPartList.length - 1].messageId;
                        const toolCallGroupIdList = inDto.contentPartList.filter(contentPart => contentPart.messageId === targetMessageId && contentPart.type === ContentPartType.TOOL).map(contentPart => contentPart.linkId);
                        const toolCallGroupList = await transactionalEntityManager.find(ToolCallGroupEntity, { where: { id: In(toolCallGroupIdList) } });

                        // 最後のtoolCallGroupを取得（必ず末尾を動かす。つまり再ランとは末尾前までを消したコピーを作ってコールすると再ラン扱い、ということ）
                        const last = toolCallGroupList.sort((a, b) => a.seq - b.seq).reverse()[0];
                        const toolCallList = await transactionalEntityManager.find(ToolCallPartEntity, {
                            where: { toolCallGroupId: last.id },
                            order: { seq: 'ASC' }, // seq順大事
                        });
                        // console.dir(toolCallList, { depth: null });
                        // 途中からの再開の場合ようにstockにtoolCallを登録しておく
                        toolCallList.filter(toolCall => toolCall.type === ToolCallPartType.INFO).forEach(toolCall => {
                            stock.toolMaster[toolCall.toolCallId] = { toolCallGroupId: toolCall.toolCallGroupId };
                        });

                        // toolCallPartCommandList
                        const contentPart = inDto.contentPartList.find(contentPart => contentPart.messageId === targetMessageId && contentPart.type === ContentPartType.TOOL && contentPart.linkId === last.id)!;
                        toolCallPartCommandList.forEach(toolCall => {
                            const ary = JSON.parse(contentPart.text || '[]');
                            contentPart.text = JSON.stringify(appendToolCallPart(ary, toolCall));
                        });

                        contentPart.updatedBy = req.info.user.id;
                        contentPart.updatedIp = req.info.ip;
                        await transactionalEntityManager.save(ContentPartEntity, contentPart);

                        // commandの処理。
                        await Promise.all(toolCallList
                            .filter(toolCall => toolCall.type === ToolCallPartType.CALL)
                            .map(async (toolCall, index) => {
                                // argumentsが指定されていたら呼び出しにそれを使う。
                                if (toolCallPartCommandList[index] && toolCallPartCommandList[index].body.arguments) {
                                    (toolCall as ToolCallPartCall).body.function.arguments = toolCallPartCommandList[index].body.arguments;
                                } else { }
                                toolCallCallList.push(toolCall.body as ChatCompletionChunk.Choice.Delta.ToolCall);

                                // toolCallCommandを登録する
                                const toolCallCommandEntity = new ToolCallPartEntity();
                                toolCallCommandEntity.toolCallGroupId = last.id;
                                toolCallCommandEntity.toolCallId = toolCall.toolCallId;
                                toolCallCommandEntity.type = ToolCallPartType.COMMAND;
                                toolCallCommandEntity.body = toolCallPartCommandList[index].body || {};
                                toolCallCommandEntity.orgKey = req.info.user.orgKey;
                                toolCallCommandEntity.createdBy = req.info.user.id;
                                toolCallCommandEntity.updatedBy = req.info.user.id;
                                toolCallCommandEntity.createdIp = req.info.ip;
                                toolCallCommandEntity.updatedIp = req.info.ip;
                                return await transactionalEntityManager.save(ToolCallPartEntity, toolCallCommandEntity);
                            })
                        );
                    } else { }
                    return { provider: obj.inDto.aiProviderClient, toolCallCallList };
                }))
            });

            // toolCall用の関数定義
            const toolCallFunctions = await Promise.all(responseObjectList.map(async (obj, index) => {
                const inDto = obj.inDto;
                const messageSet = obj.messageSet;
                const message = messageSet.message;
                const label = req.body.options?.idempotencyKey || `chat-${clientId}-${streamId}-${id}`;
                const functions = (await functionDefinitions(
                    obj, req, aiApi, connectionId, streamId, message, label
                )).reduce((prev, curr) => {
                    prev[curr.definition.function.name] = curr;
                    curr.info.name = curr.definition.function.name;
                    return prev;
                }, {} as { [functionName: string]: MyToolType });
                return { inDto, messageSet, functions };
            }));

            // ここは1本のトランザクションで囲ってしまうとツールコールの時に呼出の繰り返し毎にコミットが出来なくなるのでこのようにした。save(inser/update)のみなので競合は起きないはず、、
            await Promise.all(responseObjectList.map(async (obj, index) => {
                const inDto = obj.inDto;
                const messageSet = obj.messageSet;
                const message = messageSet.message;
                const stock = stockList[index];
                const label = req.body.options?.idempotencyKey || `chat-${clientId}-${streamId}-${id}`;
                const provider = providerAndToolCallCallListAry[index].provider;

                const functions = toolCallFunctions[index].functions;
                if (inDto.args.tool_choice && inDto.args.tool_choice !== 'none' && inDto.args.tools && inDto.args.tools.length > 0) {
                    // 直近のfunctions定義を当てる。
                    const dupCheck: Set<string> = new Set();
                    inDto.args.tools = inDto.args.tools.filter(tool => functions[tool.function.name]).map(tool => functions[tool.function.name].definition).filter(tool => dupCheck.has(tool.function.name) ? false : dupCheck.add(tool.function.name));

                    // toolを使うのであればprovider毎のユーザー情報をシステムプロンプトに付与しておく。
                    const providerSet: Set<string> = new Set();
                    inDto.args.tools.map(tool => tool.function.name).forEach(functionName => providerSet.add(functions[functionName].info.group));
                    const savedToolCallGroup = await ds.getRepository(OAuthAccountEntity).find({
                        where: {
                            orgKey: req.info.user.orgKey,
                            userId: req.info.user.id,
                            provider: In(Array.from(providerSet)),
                            status: OAuthAccountStatus.ACTIVE,
                        }
                    });
                    const oAuthUserInfo = savedToolCallGroup.map(oAuthAccount => ({ provider: oAuthAccount.provider, userInfo: oAuthAccount.userInfo }));
                    const oAuthUserInfoString = `\n\n## My OAuthAccount\n\n${JSON.stringify(oAuthUserInfo)}`;
                    if (inDto.args.messages[0].role === 'system') {
                        if (typeof inDto.args.messages[0].content === 'string') {
                            inDto.args.messages[0].content += oAuthUserInfoString;
                        } else {
                            inDto.args.messages[0].content[0].text += oAuthUserInfoString;
                        }
                    } else { }
                } else {
                    // tool_choiceがnoneだったらツールを使わない
                    inDto.args.tools = [];
                }

                // システムプロンプトは文字列にしておく。
                inDto.args.messages.forEach(message => {
                    if (message.role === 'system' || message.role === 'assistant' || message.role === 'tool') {
                        if (typeof message.content === 'string') {
                        } else if (Array.isArray(message.content)) {
                            message.content = message.content.filter(content => content.type === 'text').map(content => content.type === 'text' ? content.text : '').join('');
                        } else { }
                    } else { }
                    // 変数を代入しておく
                    if (message.role === 'system' && typeof message.content === 'string') {
                        message.content = message.content.replaceAll(/\$\{user_name\}/g, JSON.stringify(req.info.user));
                        message.content = message.content.replaceAll(/\$\{current_datetime\}/g, new Date().toISOString());
                    } else { }
                });

                // sockにためてたまったら更新する方式にしないとチャンクの追い越しとかが面倒になるので。。
                async function saveStock() {
                    await ds.transaction(async transactionalEntityManager => {
                        // awaitを使うのでchunkに追い越されてもいいようにstockを空にしておく
                        const savedMessageId = stock.savedMessageId;
                        const transanctionList = [...stock.transaction];
                        stock.transaction.length = 0; // 使い終わったらクリア
                        const toolTransanctionList = [...stock.toolTransaction];
                        stock.toolTransaction.length = 0; // 使い終わったらクリア
                        // ここまででstockはこのブロックの変数として吸出し済みなのでもう使わない。

                        // console.dir(stock, { depth: null });
                        // console.dir(transanctionList, { depth: null });
                        // console.log(toolTransanctionList, { depth: null });

                        // 先頭のtoolCallInfoを取得してtoolCallGroupを登録する
                        const infoList = toolTransanctionList.filter(toolTransaction => toolTransaction.type === ToolCallPartType.INFO);
                        if (infoList && infoList.length > 0) {
                            const info = infoList[0];
                            // toolCallGroupを登録する
                            // console.log(`SAVE_BLOCK:INFO:toolCallGroupId=${info.toolCallId}`);
                            const toolCallGroup = new ToolCallGroupEntity();
                            toolCallGroup.projectId = messageArgsSetList[index].threadGroup.projectId;
                            toolCallGroup.orgKey = req.info.user.orgKey;
                            toolCallGroup.createdBy = req.info.user.id;
                            toolCallGroup.updatedBy = req.info.user.id;
                            toolCallGroup.createdIp = req.info.ip;
                            toolCallGroup.updatedIp = req.info.ip;
                            const savedToolCallGroup = await transactionalEntityManager.save(ToolCallGroupEntity, toolCallGroup);
                            stock.toolMaster[info.toolCallId].toolCallGroupId = savedToolCallGroup.id;

                            infoList.forEach(info => stock.toolMaster[info.toolCallId].toolCallGroupId = savedToolCallGroup.id);
                        } else { }

                        // toolTransactionを保存
                        for (const toolTransaction of toolTransanctionList) {
                            // console.log(`SAVE_BLOCK:TRAN:toolCallGroupId=${toolTransaction.toolCallId} type=${JSON.stringify(toolTransaction)}`);
                            const toolCallEntity = new ToolCallPartEntity();
                            toolCallEntity.toolCallGroupId = stock.toolMaster[toolTransaction.toolCallId].toolCallGroupId;
                            toolCallEntity.toolCallId = toolTransaction.toolCallId;
                            toolCallEntity.type = toolTransaction.type;
                            toolCallEntity.body = toolTransaction.body;
                            toolCallEntity.orgKey = req.info.user.orgKey;
                            toolCallEntity.createdBy = req.info.user.id;
                            toolCallEntity.updatedBy = req.info.user.id;
                            toolCallEntity.createdIp = req.info.ip;
                            toolCallEntity.updatedIp = req.info.ip;
                            if ([ToolCallPartType.CALL, ToolCallPartType.COMMAND, ToolCallPartType.RESULT].includes(toolTransaction.type)) {
                                const contentParts = { contents: [{ role: 'model', parts: [{ text: '' }] }] };
                                if (toolTransaction.type === ToolCallPartType.CALL) {
                                    contentParts.contents[0].parts[0].text = toolTransaction.body.function.arguments;
                                } else if (toolTransaction.type === ToolCallPartType.COMMAND) {
                                    contentParts.contents[0].parts[0].text = toolTransaction.body.command;
                                } else if (toolTransaction.type === ToolCallPartType.RESULT) {
                                    contentParts.contents[0].role = 'tool';
                                    contentParts.contents[0].parts[0].text = toolTransaction.body.content;
                                }
                                if (typeof contentParts.contents[0].parts[0].text === 'string') {
                                    // 何もしない
                                } else {
                                    // stringじゃない場合はJSON.stringifyしておく。
                                    contentParts.contents[0].parts[0].text = JSON.stringify(contentParts.contents[0].parts[0].text);
                                }
                                const tokenResPromise = generativeModel.countTokens(contentParts);

                                toolCallEntity.tokenCount = toolCallEntity.tokenCount || {};

                                const openaiTokenCount = { totalTokens: getTiktokenEncoder(COUNT_TOKEN_OPENAI_MODEL).encode(contentParts.contents[0].parts[0].text).length };
                                toolCallEntity.tokenCount[COUNT_TOKEN_OPENAI_MODEL] = openaiTokenCount;

                                toolCallEntity.tokenCount[COUNT_TOKEN_MODEL] = await tokenResPromise;
                            } else { }
                            await transactionalEntityManager.save(ToolCallPartEntity, toolCallEntity);
                        }

                        // transactionを保存
                        for (const transaction of transanctionList) {
                            // console.log(`${savedMessageId} ${transaction.type} ${transaction.text.substring(0, 50).replaceAll('\n', '')}`);
                            const targetContentPart = messageSet.contentParts[messageSet.contentParts.length - 1];
                            targetContentPart.type = transaction.type;
                            targetContentPart.text = transaction.text;
                            if (transaction.type === ContentPartType.TOOL) {
                                targetContentPart.linkId = stock.toolMaster[transaction.body.tool_call_id].toolCallGroupId;
                            } else { }
                            const contentPart = await transactionalEntityManager.save(ContentPartEntity, targetContentPart);
                            messageSet.contentParts[messageSet.contentParts.indexOf(targetContentPart)] = contentPart;
                            // chunk.contentPart = contentPart; // クライアント側にContentPartのIDを返すためにDB保存後のオブジェクトを取る必要がある

                            // ContentPartは画面側でストリーム表示するために先に箱作っておくスタイルなので新しいContentPartを作成
                            const newContentPart = new ContentPartEntity();
                            newContentPart.messageId = messageSet.message.id;
                            newContentPart.type = ContentPartType.TEXT;
                            newContentPart.text = '';
                            newContentPart.seq = 0;
                            newContentPart.orgKey = req.info.user.orgKey;
                            newContentPart.createdBy = req.info.user.id;
                            newContentPart.updatedBy = req.info.user.id;
                            newContentPart.createdIp = req.info.ip;
                            newContentPart.updatedIp = req.info.ip;
                            messageSet.contentParts.push(newContentPart); // pushだけして保存はしない。finish_reasonを検知したタイミングで保存する。
                        }
                    });
                };
                return await new Promise<{
                    messageSet: {
                        messageGroup: MessageGroupEntity,
                        message: MessageEntity,
                        contentParts: ContentPartEntity[],
                    },
                }>((resolve, reject) => {
                    ( // toolCallCommandがある場合はツール実行指示なのでtoolCallObservableStreamを使う
                        (toolCallPartCommandList && toolCallPartCommandList.length > 0)
                            ? aiApi.toolCallObservableStream(inDto.args, { label, functions }, provider, providerAndToolCallCallListAry[index].toolCallCallList, toolCallPartCommandList)
                            : aiApi.chatCompletionObservableStream(inDto.args, { label, functions }, provider)
                    ).pipe(
                        // DB更新があるので async/await をする必要があるのでfromでObservable化してconcatMapで纏めて待つ
                        // こうしないとcompleteが先に走ってしまう可能性がある。
                        concatMap(next => from((async _chunk => {
                            const chunk = _chunk as ChatCompletionChunk & { contentPart?: ContentPartEntity };
                            if (chunk.choices[0]) { } else { return; }
                            // toolCallGroupを登録することがあるのでawait書けておかないと抜けちゃう。
                            chunk.choices.map(choice => {
                                if (choice.delta) {
                                    // roleはまだ扱いきれてないので無視。
                                    // if (choice.delta.role) {
                                    //     messageSet.messageGroup.role = choice.delta.role;
                                    // }

                                    // 通常の中身
                                    if (choice.delta.content && !['info', 'command', 'tool'].includes(choice.delta.role || '')) {
                                        // console.log(`content=${JSON.stringify(choice)}`);
                                        const content = stock.transaction.at(-1);
                                        if (content && content.type === ContentPartType.TEXT) {
                                            // 末尾がtextだったら積み上げ
                                            content.text += choice.delta.content;
                                        } else {
                                            // 末尾がテキストじゃない場合は場合は新規作成
                                            stock.transaction.push({ type: ContentPartType.TEXT, text: choice.delta.content, body: choice.delta });
                                        }
                                    } else { }

                                    // tool_info
                                    if (choice.delta.role === 'info' as any) {
                                        // console.log('tool_info', choice.delta);
                                        const body = JSON.parse(choice.delta.content || '{}');
                                        // tool_infoはtool系の最初のchunkなのでtransactionでcontentPartを作りに行く。
                                        const toolCallId = (choice.delta as { tool_call_id: string }).tool_call_id;
                                        const toolCall: ToolCallPartInfo = { type: ToolCallPartType.INFO, body, toolCallId };
                                        const tool = stock.transaction.findLast(transaction => transaction.type === ContentPartType.TOOL);

                                        const ary = JSON.parse(tool?.text || '[]');
                                        const text = JSON.stringify(appendToolCallPart(ary, toolCall));
                                        if (tool) {
                                            // 面倒だがテキスト化されたJSONを戻して末尾に追加してまたテキスト化。
                                            tool.text = text;
                                        } else {
                                            stock.transaction.push({ type: ContentPartType.TOOL, text, body: choice.delta });
                                        }
                                        // 後続で使えるようにtoolMasterに登録しておく。
                                        stock.toolMaster[toolCallId] = { toolCallGroupId: '' };
                                        // toolCallEntityに登録する用
                                        stock.toolTransaction.push(toolCall);
                                        // console.log(`toolCallId=${toolCallId} ${toolCallObject.toolCall.type}=${JSON.stringify(toolCallObject.toolCall.body)}`);
                                    } else { }

                                    // tool_calls
                                    if (choice.delta.tool_calls && choice.delta.tool_calls.length > 0) {
                                        // console.log(`tool_calls: ${choice.delta.tool_calls.length}`);
                                        choice.delta.tool_calls.forEach(tool_call => {
                                            if (tool_call.id) {
                                                // 最初の1行のみidが振られているので、それを使ってtoolCallを作る。
                                                const toolCallId = tool_call.id;
                                                // マスターからtoolCallGroupIdを取得
                                                const toolCall: ToolCallPartCall = { type: ToolCallPartType.CALL, body: tool_call as ToolCallPartCallBody, toolCallId };
                                                // toolCall登録用にtransactionに積む
                                                stock.toolTransaction.push(toolCall);
                                                // console.log(`toolCallId=${toolCallId} ${toolCall.type}=${JSON.stringify(toolCall.body)}`);

                                                // functionが無いことはないはずだけど一応初期化しておく
                                                tool_call.function = tool_call.function || { name: '', arguments: '' };
                                            } else {
                                                // 二行目以降はargmentsの積み上げ
                                                const toolCall = stock.toolTransaction.findLast(tool => tool.type === ToolCallPartType.CALL);
                                                // 何も考えずに末尾取ってくるって複数の時混ざりそうでなんかちょっと怖い気はしているが、、tool_call_idが無いのでこうするしかない。。
                                                if (toolCall && tool_call.function) {
                                                    (toolCall.body as ToolCallPartCallBody).function.arguments += tool_call.function.arguments || '';
                                                } else { /** functionが無いことはないはず */ }
                                            }
                                        });
                                    } else { /** tool_callsが無ければ何もしない */ }

                                    // tool_commandは投げる前に登録することにした。
                                    // // tool_command
                                    // if (choice.delta.role === 'command' as any) {
                                    //     // console.log('tool_command', choice.delta);
                                    //     // マスターからtoolCallGroupIdを取得
                                    //     const toolCall: ToolCallCommand = { type: ToolCallType.COMMAND, body: choice.delta as ToolCallCommandBody };
                                    //     const toolCallId = (choice.delta as { tool_call_id: string }).tool_call_id;
                                    //     stock.toolTransaction.push({ toolCallId, toolCall });
                                    //     // console.log(`toolCallId=${toolCallId} ${toolCall.type}=${JSON.stringify(toolCall.body)}`);
                                    // } else { }

                                    // tool_result
                                    if (choice.delta.role === 'tool') {
                                        // console.log('tool_result', choice.delta);
                                        // マスターからtoolCallGroupIdを取得
                                        const toolCallId = (choice.delta as { tool_call_id: string }).tool_call_id;
                                        const toolCall: ToolCallPartResult = { type: ToolCallPartType.RESULT, body: choice.delta as ToolCallPartResultBody, toolCallId };
                                        stock.toolTransaction.push(toolCall);
                                        // console.log(`toolCallId=${toolCallId} ${toolCall.type}=${JSON.stringify(toolCall.body.role)}`);
                                    } else { }
                                } else {
                                    // deltaが無くてもfinish_reasonがあったりするので注意
                                }

                                // thinking
                                const thinking = (choice as any).thinking;
                                if (thinking) {
                                    // console.log(`thinking=${JSON.stringify(thinking)}`);
                                    const before = stock.transaction.at(-1);
                                    if (before && before.type === ContentPartType.META && before.text) {
                                        const thinkObject = JSON.parse(before.text) as { thinking: string };
                                        before.text = `${JSON.stringify({ thinking: thinkObject.thinking + thinking })}`;
                                    } else {
                                        stock.transaction.push({ type: ContentPartType.META, text: JSON.stringify({ thinking }), body: { thinking } });
                                    }
                                } else { }
                                const signature = (choice as any).signature;
                                if (signature) {
                                    // console.log(`thinking=${JSON.stringify(thinking)}`);
                                    const before = stock.transaction.at(-1);
                                    if (before && before.type === ContentPartType.META && before.text) {
                                        const thinkObject = JSON.parse(before.text) as { thinking: string };
                                        before.text = `${JSON.stringify({ thinking: thinkObject.thinking, signature })}`;
                                    } else {
                                        console.log(`ERROR:SKIP:signature=${JSON.stringify(signature)}`);
                                    }
                                } else { }

                                // Google検索
                                const groundingMetadata = (choice as any).groundingMetadata;
                                if (groundingMetadata) {
                                    // console.log(groundingMetadata);
                                    stock.transaction.push({ type: ContentPartType.META, text: JSON.stringify({ groundingMetadata }), body: { groundingMetadata } });
                                } else { }
                            });

                            // 保存
                            // console.log(`========================contents======================== ${chunk.choices[0].finish_reason}`);
                            // console.dir(stock.contents, { depth: null });
                            // console.log('chunk=' + chunk.choices[0].finish_reason + ':' + JSON.stringify(chunk.choices[0]));
                            // finish_reasonがある場合はstockしたtoransactionを全て保存していく
                            // これをstockを溜めるめるループの中でやろうとするとawaitの追い越しでぶっ壊れるのでこの位置でやる。実はこの位置でも追い越しは発生するような気がしてならないが、とりあえずこれでいく。
                            if (chunk.choices.find(choice => choice.finish_reason) || chunk.choices[0].delta.role === 'info' as any) { // infoはすぐcommitしておきたいので先だしする。
                                // console.log('--------========================contents========================--------');
                                // console.dir(stock.transaction, { depth: null });
                                // for (const toolTransaction of stock.toolTransaction) {
                                //     console.log(`toolCallGroupId=${toolTransaction.toolCall.type}`);
                                // }
                                // console.log('tool.length', stock.toolTransaction.length);
                                // console.log('\n\n\n\n');
                                await saveStock();
                            } else { }

                            // console.log(`${stock.savedMessageId},${clientId},${text.replaceAll('\n', '')}`);
                            const resObj = {
                                data: { streamId: `${req.query.streamId}|${stock.savedMessageId}`, messageId: stock.savedMessageId, content: chunk },
                                event: 'message',
                            };
                            // console.dir(resObj, { depth: null });
                            clients[clientId]?.response.write(`data: ${JSON.stringify(resObj)}\n\n`);
                        })(next))),
                    ).subscribe({
                        // next: ,
                        error: error => {
                            console.log(`stream error: ${req.query.streamId}|${JSON.stringify(stock)} ${error}--------------------------------------`);
                            console.error(error);
                            reject(error);
                            // コネクションは切らない（クライアント側で切るはずなので）
                            clients[clientId]?.response.write(`error: ${req.query.streamId}|${stock.savedMessageId} ${error}\n\n`);
                        },
                        complete: () => {
                            // console.log(`stream complete: ${req.query.streamId}|${stock.savedMessageId}--------------------------------------`);
                            // 通常モードは素直に終了
                            clients[clientId]?.response.write(`data: [DONE] ${req.query.streamId}|${stock.savedMessageId}\n\n`);
                            resolve({ messageSet });
                        },
                    });
                }).catch(async error => {
                    await saveStock();
                    // // DB側の更新を待つ必要は無い。
                    // endResponse(undefined as any, error);
                    await ds.transaction(async transactionalEntityManager => {
                        await Promise.all(stockList.map(async stock => {
                            if (stock.savedMessageId) {
                                const savedMessage = await transactionalEntityManager.findOne(MessageEntity, {
                                    where: { id: stock.savedMessageId }
                                });
                                if (savedMessage) {
                                    const savedMessageGroup = await transactionalEntityManager.findOne(MessageGroupEntity, {
                                        where: { id: savedMessage.messageGroupId }
                                    });
                                    const contentPart = await transactionalEntityManager.findOne(ContentPartEntity, {
                                        where: { messageId: stock.savedMessageId }
                                    });
                                    if (savedMessageGroup && contentPart) {
                                        contentPart.text = stock.text;
                                        await transactionalEntityManager.save(ContentPartEntity, contentPart);

                                        // ラベルを更新（ラベルはコンテンツの最初の方だけ）
                                        savedMessage.label = stock.text.substring(0, 250);
                                        await transactionalEntityManager.save(MessageGroupEntity, savedMessageGroup);
                                        await transactionalEntityManager.save(MessageEntity, savedMessage);
                                        // console.error('error', error);
                                        // 新しいContentPartを作成
                                        const newContentPart = new ContentPartEntity();
                                        newContentPart.messageId = savedMessage.id;
                                        newContentPart.type = ContentPartType.ERROR;
                                        newContentPart.text = Utils.errorFormat(error, false);
                                        newContentPart.seq = 1;
                                        newContentPart.orgKey = req.info.user.orgKey;
                                        newContentPart.createdBy = req.info.user.id;
                                        newContentPart.updatedBy = req.info.user.id;
                                        newContentPart.createdIp = req.info.ip;
                                        newContentPart.updatedIp = req.info.ip;
                                        const savedContentPart = await transactionalEntityManager.save(ContentPartEntity, newContentPart);

                                        // トークンカウントを更新
                                        await geminiCountTokensByContentPart(transactionalEntityManager, [savedContentPart], req.info.user);
                                    } else { }
                                }
                            } else { }
                        }));
                    });
                    return null;
                }).then(async (res: {
                    messageSet: {
                        messageGroup: MessageGroupEntity,
                        message: MessageEntity,
                        contentParts: ContentPartEntity[],
                    },
                } | null) => {
                    if (!res) { return; }
                    // // メッセージ完了
                    // res.messageSet.contentParts[0].text = res.text;
                    // await transactionalEntityManager.save(ContentPartEntity, res.messageSet.contentParts[0]);
                    // console.log('res.messageSet.messageGroup', res.messageSet.messageGroup);
                    // console.log('res.messageSet.message', res.messageSet.message);
                    // console.log('res.messageSet.contentParts', res.messageSet.contentParts);
                    // for (const toolTransaction of stock.toolTransaction) {
                    //     console.log(`toolCallGroupId=${toolTransaction.toolCall.type}`);
                    // }
                    // console.log('tool.length', stock.toolTransaction.length);
                    // console.dir(res, { depth: null });

                    // if (!!chunk.choices[0].finish_reason) {
                    // } else { }
                    await saveStock();
                    await ds.transaction(async transactionalEntityManager => {
                        const text = res.messageSet.contentParts.find(contentPart => contentPart.type === ContentPartType.TEXT)!.text || '';

                        // ラベルを更新（ラベルはコンテンツの最初の方だけ）
                        res.messageSet.message.label = text.substring(0, 250);
                        await transactionalEntityManager.save(MessageGroupEntity, res.messageSet.messageGroup);
                        await transactionalEntityManager.save(MessageEntity, res.messageSet.message);

                        // コンテンツ内容が無いものは保存する意味ないので削除しておかないと geminiCountTokensByContentPart の中で保存されてしまう。
                        res.messageSet.contentParts = res.messageSet.contentParts.filter(contentPart => contentPart.text && contentPart.text.length > 0);
                        // トークンカウントを更新
                        await geminiCountTokensByContentPart(transactionalEntityManager, res.messageSet.contentParts, req.info.user);
                    });
                }).catch(async error => {
                    await saveStock();
                    // // DB側の更新を待つ必要は無い。
                    // endResponse(undefined as any, error);
                    ds.transaction(async transactionalEntityManager => {
                        await Promise.all(stockList.map(async stock => {
                            if (stock.savedMessageId) {
                                const savedMessage = await transactionalEntityManager.findOne(MessageEntity, {
                                    where: { id: stock.savedMessageId }
                                });
                                if (savedMessage) {
                                    const savedMessageGroup = await transactionalEntityManager.findOne(MessageGroupEntity, {
                                        where: { id: savedMessage.messageGroupId }
                                    });
                                    const contentPart = await transactionalEntityManager.findOne(ContentPartEntity, {
                                        where: { messageId: stock.savedMessageId }
                                    });
                                    if (savedMessageGroup && contentPart) {
                                        contentPart.text = stock.text;
                                        await transactionalEntityManager.save(ContentPartEntity, contentPart);

                                        // ラベルを更新（ラベルはコンテンツの最初の方だけ）
                                        savedMessage.label = stock.text.substring(0, 250);
                                        await transactionalEntityManager.save(MessageGroupEntity, savedMessageGroup);
                                        await transactionalEntityManager.save(MessageEntity, savedMessage);
                                        // console.error('error', error);
                                        // 新しいContentPartを作成
                                        const newContentPart = new ContentPartEntity();
                                        newContentPart.messageId = savedMessage.id;
                                        newContentPart.type = ContentPartType.ERROR;
                                        newContentPart.text = Utils.errorFormat(error, false);
                                        newContentPart.seq = 1;
                                        newContentPart.orgKey = req.info.user.orgKey;
                                        newContentPart.createdBy = req.info.user.id;
                                        newContentPart.updatedBy = req.info.user.id;
                                        newContentPart.createdIp = req.info.ip;
                                        newContentPart.updatedIp = req.info.ip;
                                        const savedContentPart = await transactionalEntityManager.save(ContentPartEntity, newContentPart);

                                        // トークンカウントを更新
                                        await geminiCountTokensByContentPart(transactionalEntityManager, [savedContentPart], req.info.user);
                                    } else { }
                                }
                            } else { }
                        }));
                    });
                });
            }))
            //     }));
            // })
        } catch (error) {
            res.status(503).set('Content-Type', 'text/plain; charset=utf-8').set('Content-Type', 'text/plain; charset=utf-8').end(Utils.errorFormat(error));
        }
    }
];

async function getCountTokenListByFileGroupIdList(orgKey: string, fileGroupIdList: string[]): Promise<{ [modelId: string]: CountTokensResponse }[]> {
    // 0件の場合は0件で返す
    if (fileGroupIdList.length === 0) { return Promise.resolve([]) }
    // TODO subqueryじゃなくてJOINにすべきと思う。
    const qb = ds.createQueryBuilder(FileBodyEntity, 'fileBody')
        // .select('fileBody.tokenCount') // tokenCountしか使わないから絞ってみたけど、べつに指定しなくてもよい。
        .where(qb => {
            const subQuery = qb
                .subQuery()
                .select('file.fileBodyId')
                .from(FileEntity, 'file')
                .where('file.fileGroupId IN (:...fileGroupIds) AND file.isActive = true')
                .getQuery();
            return 'fileBody.id IN ' + subQuery +
                ' AND fileBody.fileType NOT IN (:...invalidMimeList) AND fileBody.orgKey = :orgKey AND fileBody.tokenCount IS NOT NULL';
        })
        .setParameter('orgKey', orgKey)
        .setParameter('fileGroupIds', fileGroupIdList)
        .setParameter('invalidMimeList', invalidMimeList);

    // console.log(qb.getSql());
    const fileTokenCountList = await qb.getMany();
    return fileTokenCountList.map(fileTokenCount => {
        return fileTokenCount.tokenCount;
    }).filter(tokenCount => tokenCount && tokenCount[COUNT_TOKEN_MODEL]) as { [modelId: string]: CountTokensResponse }[];
}

async function getCountTokenListByToolGroupIdList(orgKey: string, toolGroupIdList: string[]): Promise<{ [modelId: string]: CountTokensResponse }[]> {
    // 0件の場合は0件で返す
    if (toolGroupIdList.length === 0) { return Promise.resolve([]) }
    // console.log(qb.getSql());
    const toolTokenCountList = await ds.getRepository(ToolCallPartEntity).find({
        select: ['tokenCount'],
        where: {
            orgKey: orgKey,
            toolCallGroupId: In(toolGroupIdList),
            tokenCount: Not(IsNull()),
        },
    });
    return toolTokenCountList.map(toolTokenCount => {
        return toolTokenCount.tokenCount;
    }).filter(tokenCount => tokenCount && tokenCount[COUNT_TOKEN_MODEL]) as { [modelId: string]: CountTokensResponse }[];
}

export interface ChatInputArea {
    role: 'user' | 'system' | 'assistant';
    content: ChatContent[];
    previousMessageId: string;
}
export type ChatContent = ({ type: 'text', text: string } | { type: 'file', text: string, fileGroupId: string });

/**
 * [認証不要] トークンカウント
 * トークンカウントは呼び出し回数が多いので、
 * DB未保存分のメッセージを未保存のまま処理するようにひと手間かける。
 */
export const geminiCountTokensByProjectModel = [
    query('type').isIn(['threadGroup', 'thread', 'messageGroup', 'message', 'contentPart']).notEmpty(),
    query('id').trim(),
    body('*.content').isArray(),
    body('*.content.*.type').isIn(Object.values(ContentPartType)),
    body('*.content.*.text').isString(),
    body('*.content.*.fileId').optional(),
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        const { type, id } = req.query as { type: ArgsBuildType, id: string };
        try {
            // カウントしたいだけだからパラメータは適当でOK。
            const args = { messages: [], model: COUNT_TOKEN_MODEL, temperature: 0.7, top_p: 1, max_tokens: 1024, stream: true, providerName: 'vertex_ai' } as MyChatCompletionCreateParamsStreaming;
            const client = (await getAIProvider(req.info.user, COUNT_TOKEN_MODEL)).client as MyVertexAiClient;

            // const preTokenCount = { totalTokens: 0, totalBillableCharacters: 0 };
            const tokenCountSummaryList: { [model: string]: { totalTokens: number, totalBillableCharacters?: number } }[] = [];
            if (id) {
                // メッセージIDが指定されていたらまずそれらを読み込む
                const { messageArgsSetList } = await buildArgs(req.info.user, type, [id], 'countOnly');

                // const tokenCountSummary: { [model: string]: { totalTokens: number, totalBillableCharacters: number } } = {};
                // 実体はトークン数だけが返ってくる
                (messageArgsSetList as any as { tokenCountSummary: { [model: string]: { totalTokens: number, totalBillableCharacters?: number } } }[]).forEach(messageArgsSet => {
                    tokenCountSummaryList.push(messageArgsSet.tokenCountSummary);
                });
            } else {
                // メッセージIDが指定されていない場合は、トークン数を取得するための空のオブジェクトを作成
                tokenCountSummaryList.push({
                    [COUNT_TOKEN_MODEL]: { totalTokens: 0, totalBillableCharacters: 0 },
                    [COUNT_TOKEN_OPENAI_MODEL]: { totalTokens: 0 }
                });
            }

            // DB未登録のメッセージ部分の組み立てをする。
            const messageList = req.body as { role: 'user', content: ContentPartEntity[] }[];

            const fileGroupIdList: string[] = [];
            const toolGroupIdList: string[] = [];
            let inputCounter = 0; // トークン計測をする必要があるものが何個あるのか。
            // argsを組み立てる
            args.messages = messageList.map(message => {
                message.role = 'user'; // systemだとトークン計上されないので
                const _message = {
                    role: message.role,
                    content: [] as ChatCompletionContentPart[],
                } as { role: string, content: ChatCompletionContentPart[] };
                message.content.forEach(content => {
                    if (content.type === 'text' && content.text) {
                        _message.content.push({ type: 'text', text: content.text });
                        inputCounter += content.text.length;
                    } else if (content.type === 'error') {
                        _message.content.push({ type: 'text' as any, text: content.text || '' });
                        inputCounter += (content.text || '').length;
                    } else if (content.type === 'file' && content.linkId) {
                        fileGroupIdList.push(content.linkId);
                    } else if (content.type === 'tool' && content.linkId) {
                        toolGroupIdList.push(content.linkId);
                    }
                });
                return _message;
            }).filter(bit => bit && bit.content && bit.content.length > 0) as ChatCompletionMessageParam[];

            // ファイルのトークン数を取得
            const fileTokenCountList = await getCountTokenListByFileGroupIdList(req.info.user.orgKey, fileGroupIdList);
            // ツールのトークン数を取得
            const toolTokenCountList = await getCountTokenListByToolGroupIdList(req.info.user.orgKey, toolGroupIdList);

            // 取得したトークン数をまとめる
            tokenCountSummaryList.forEach(tokenCountSummary => {
                [...fileTokenCountList, ...toolTokenCountList].forEach(tokenCount => {
                    Object.keys(tokenCount).forEach(modelId => {
                        if (tokenCountSummary[modelId]) {
                            tokenCountSummary[modelId].totalTokens += tokenCount[modelId].totalTokens || 0;
                            if (tokenCount[modelId].totalBillableCharacters) {
                                tokenCountSummary[modelId].totalBillableCharacters = (tokenCountSummary[modelId].totalBillableCharacters || 0) + (tokenCount[modelId].totalBillableCharacters || 0);
                            } else { }
                        } else {
                            tokenCountSummary[modelId] = {
                                totalTokens: tokenCount[modelId].totalTokens || 0,
                            };
                            if (tokenCount[modelId].totalBillableCharacters) {
                                tokenCountSummary[modelId].totalBillableCharacters = tokenCount[modelId].totalBillableCharacters || 0;
                            } else { }
                        }
                    });
                });
            });
            // console.dir(tokenCountSummaryList, { depth: null });

            if (inputCounter > 0) {
                // console.dir(args, { depth: null });
                normalizeMessage(args, false).subscribe({
                    next: next => {
                        try {
                            const args = next.args;
                            const req: GenerateContentRequest = mapForGemini(args);
                            const countCharsObj = countChars(args);
                            // console.dir(req, { depth: null });
                            const generativeModel = client.client.preview.getGenerativeModel({
                                model: COUNT_TOKEN_MODEL,
                                safetySettings: [],
                            });
                            // console.dir(req, { depth: null });
                            generativeModel.countTokens(req).then(tokenObject => {
                                // // console.dir(req, { depth: null });
                                // // console.dir(tokenObject, { depth: null });
                                // tokenObject = tokenObject || { totalTokens: 0, totalBillableCharacters: 0 };
                                // tokenObject.totalTokens = (tokenObject.totalTokens || 0) + preTokenCount.totalTokens;
                                // tokenObject.totalBillableCharacters = (tokenObject.totalBillableCharacters || 0) + preTokenCount.totalBillableCharacters;
                                // countCharsObj.text = (countCharsObj.text || 0) + tokenObject.totalBillableCharacters || 0;

                                const prompt = `${args.messages.map(message => ((message.content || []) as ChatCompletionContentPart[]).map(content => content.type === 'text' ? content.text : '').join('\n')).join('\n')}`;
                                const openaiTokenCount = { totalTokens: getTiktokenEncoder(COUNT_TOKEN_OPENAI_MODEL).encode(prompt).length, totalBillableCharacters: 0 };

                                const tokenObjMap = {
                                    [COUNT_TOKEN_MODEL]: {
                                        totalTokens: tokenObject.totalTokens || 0,
                                        totalBillableCharacters: tokenObject.totalBillableCharacters || 0,
                                    },
                                    [COUNT_TOKEN_OPENAI_MODEL]: {
                                        totalTokens: openaiTokenCount.totalTokens || 0,
                                        totalBillableCharacters: openaiTokenCount.totalBillableCharacters || 0,
                                    },
                                };
                                // console.dir(tokenObjMap, { depth: null });
                                tokenCountSummaryList.forEach(tokenCountSummary => {
                                    ([COUNT_TOKEN_OPENAI_MODEL, COUNT_TOKEN_MODEL]).forEach(modelId => {
                                        if (tokenCountSummary[modelId]) {
                                            tokenCountSummary[modelId].totalTokens += tokenObjMap[modelId].totalTokens || 0;
                                            if (tokenObjMap[modelId].totalBillableCharacters) {
                                                tokenCountSummary[modelId].totalBillableCharacters = (tokenCountSummary[modelId].totalBillableCharacters || 0) + (tokenObjMap[modelId].totalBillableCharacters || 0);
                                            } else { }
                                        } else {
                                            tokenCountSummary[modelId] = {
                                                totalTokens: tokenObjMap[modelId].totalTokens || 0,
                                            };
                                            if (tokenObjMap[modelId].totalBillableCharacters) {
                                                tokenCountSummary[modelId].totalBillableCharacters = tokenObjMap[modelId].totalBillableCharacters || 0;
                                            } else { }
                                        }
                                    });
                                });
                                // console.dir(tokenCountSummaryList, { depth: null });
                                res.end(JSON.stringify(tokenCountSummaryList));
                            }).catch(error => {
                                res.status(503).set('Content-Type', 'text/plain; charset=utf-8').end(Utils.errorFormat(error));
                            });
                        } catch (error) {
                            res.status(503).set('Content-Type', 'text/plain; charset=utf-8').end(Utils.errorFormat(error));
                        }
                    },
                });
            } else {
                // inputCounterが0の場合は元々計算済みのものを返却するだけ
                res.end(JSON.stringify(tokenCountSummaryList));
            }
        } catch (error) {
            res.status(503).set('Content-Type', 'text/plain; charset=utf-8').end(Utils.errorFormat(error));
        }
    }
];

/**
 * 失敗作
 * [認証不要] トークンカウント
 * トークンカウントは呼び出し回数が多いので、
 * DB未保存分のメッセージを未保存のまま処理するようにひと手間かける。
 */
export const geminiCountTokensByThread = [
    body('ids').isArray(),
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        const ids = req.body.ids as string[];
        try {
            const result: { id: string, totalTokens: number, totalBillableCharacters: number }[] = [];
            if (ids.length > 0) {
                // メッセージIDが指定されていたらまずそれらを読み込む
                const { messageArgsSetList } = await buildArgs(req.info.user, 'thread', ids, 'countOnly');
                // 指定されたIDの順番に並び替え
                const messageArgsSetListSorted = ids.map(id => messageArgsSetList.find(m => m.thread.id === id) as MessageArgsSet);
                // 実体はトークン数だけが返ってくる
                messageArgsSetListSorted.map(messageArgsSet => {
                    result.push({
                        ...messageArgsSet,
                        id: messageArgsSet.thread.id,
                        totalTokens: messageArgsSet.totalTokens || 0,
                        totalBillableCharacters: messageArgsSet.totalBillableCharacters || 0,
                    });
                });
            } else { }

            // inputCounterが0の場合は元々計算済みのものを返却するだけ
            res.end(JSON.stringify(result));
        } catch (error) {
            res.status(503).set('Content-Type', 'text/plain; charset=utf-8').end(Utils.errorFormat(error));
        }
    }
];

export async function geminiCountTokensByContentPart(transactionalEntityManager: EntityManager, contents: ContentPartEntity[], user: UserTokenPayloadWithRole, model: string = COUNT_TOKEN_MODEL): Promise<ContentPartEntity[]> {
    const client = ((await getAIProvider(user, model)).client as MyVertexAiClient).client;
    // console.dir(contents, { depth: null });
    const generativeModel = client.preview.getGenerativeModel({
        model, safetySettings: [],
    });

    const requests = contents.map(async (content, index) =>
        // 本来流量制御に掛けるのはgenerativeModelだけでいいはずだが、resolveは軽いので面倒なのでここでやる。
        tokenCountRequestLimitation.executeWithRetry(async () => {
            switch (content.type) {
                case ContentPartType.TEXT:
                case ContentPartType.ERROR:
                    content.tokenCount = content.tokenCount || {};
                    if (content.text) {
                        // console.log(`countTokens: ${content.text.substring(0, 10).replace(/\n/g, '')}`);
                        // const time = new Date().getTime();
                        // console.log(`index=${index} :      countTokens: ${content.text.substring(0, 10000).replace(/\n/g, '')}`);
                        const tokenResPromise = generativeModel.countTokens({ contents: [{ role: 'user', parts: [{ text: content.text }] }] });

                        // GPT-4oでのトークン数を計算する
                        // const prompt = `<im_start>user\n${content.text}<im_end>`;
                        const prompt = `${content.text}`;
                        content.tokenCount[COUNT_TOKEN_OPENAI_MODEL] = { totalTokens: getTiktokenEncoder(COUNT_TOKEN_OPENAI_MODEL).encode(prompt).length };

                        const tokenRes = await tokenResPromise;
                        // console.log(`index=${index} : ${new Date().getTime() - time}ms : countTokens: ${content.text.substring(0, 10).replace(/\n/g, '')} : ${tokenRes.totalTokens}`);
                        // content.tokenCount[model] = { totalTokens: tokenRes.totalTokens, totalBillableCharacters: tokenRes.totalBillableCharacters };
                        content.tokenCount[model] = tokenRes;
                    } else {
                        // 何もしない
                        content.tokenCount[model] = { totalTokens: 0, totalBillableCharacters: 0 };
                        content.tokenCount[COUNT_TOKEN_OPENAI_MODEL] = { totalTokens: 0 };
                    }
                    break;
                case ContentPartType.BASE64:
                    // base64のまま来てしまうのはおかしい。事前に登録されているべき。
                    break;
                case ContentPartType.URL:
                    // TODO インターネットからコンテンツ取ってくる。後回し
                    break;
                case ContentPartType.STORE:
                    // gs:// のファイル。
                    break;
                case ContentPartType.FILE:
                    // fileは登録済みなので無視
                    break;
            }
            return Promise.resolve(content);
        })
    );
    try {
        const results = await Promise.allSettled(requests);

        // 整形
        const mappedResults = results.map((content, index) => {
            if (content.status === 'fulfilled') {
                return content.value;
            } else {
                console.error(content.reason);
                return { error: content.reason } as any;
            }
        });

        // 保存
        const forSaveList = mappedResults.filter(content => !content.error && content.tokenCount && content.tokenCount[model]);
        await transactionalEntityManager.getRepository(ContentPartEntity).save(forSaveList);

        // 成功・失敗の結果を集計
        const successful = results.filter(r => r.status === 'fulfilled').length;
        const failed = results.filter(r => r.status === 'rejected').length;

        console.log(`Count tokens by contentPart completed: ${successful}, Failed: ${failed}`);

        return mappedResults;
    } catch (error) {
        console.error('Fatal error occurred:', error);
        throw error;
    }
}

export async function geminiCountTokensByFile(transactionalEntityManager: EntityManager, fileList: { base64Data?: string, buffer?: Buffer | string, fileBodyEntity: FileBodyEntity }[], user: UserTokenPayloadWithRole, model: string = COUNT_TOKEN_MODEL): Promise<FileBodyEntity[]> {
    const my_vertexai = ((await getAIProvider(user, model)).client as MyVertexAiClient);
    const client = my_vertexai.client;
    const generativeModel = client.preview.getGenerativeModel({
        model, safetySettings: [],
    });

    tokenCountRequestLimitation.setErrorHandler(async (error) => {
        const errStr = Utils.errorFormat(error);
        console.error('geminiCountTokensByFile error', error);
        if (errStr.includes('got status: 400 Bad Request.')) {
            return { shouldRetry: false };
        } else if (errStr.includes('got status: 429 Too Many Requests.')) {
            console.log('retry 429');
            return { shouldRetry: true };
        } else if (errStr.includes('got status: 401 Unauthorized.')) {
            // 認証エラーは再認証してからretry
            console.log('retry 401');
            await my_vertexai.getAccessToken();
            return { shouldRetry: true };
        }
        // その他のエラーは再試行しない
        return { shouldRetry: false };
    });

    const vertexGemini = fileList.map(async file =>
        tokenCountRequestLimitation.executeWithRetry(async () =>
            generativeModel.countTokens({
                contents: [{
                    role: 'user', parts: [
                        file.buffer
                            ? { text: file.buffer.toString() } // bufferがあればそれはテキスト
                            : file.base64Data // base64があればそれはファイル
                                ? {
                                    inlineData: {
                                        mimeType: convertToPdfMimeMap[file.fileBodyEntity.fileType] || file.fileBodyEntity.fileType,
                                        data: file.base64Data.substring(file.base64Data.indexOf(',') + 1),
                                    },
                                } :
                                { text: '' }, // これはありえない。エラー。
                    ]
                }]
            })
        )
    );

    const openaiTokenCountList = fileList.map(async file => {
        const openaiTokenCount = { totalTokens: 0 } as CountTokensResponse;
        if (file.fileBodyEntity.fileType.startsWith('image/') && file.base64Data) {
            const metaJson = file.fileBodyEntity.metaJson || {};
            const imageTokens = calculateTokenCost(metaJson.width || 0, metaJson.height || 0);
            openaiTokenCount.totalTokens = imageTokens;
        } else if (file.buffer !== undefined) {
            openaiTokenCount.totalTokens = getTiktokenEncoder(COUNT_TOKEN_OPENAI_MODEL).encode(file.buffer.toString()).length;
        } else if ([...convertToPdfMimeList, 'application/pdf'].includes(file.fileBodyEntity.fileType)) {
            const pdfPath = file.fileBodyEntity.innerPath;
            const basePath = pdfPath.substring(0, pdfPath.lastIndexOf('.'));
            const numPages = file.fileBodyEntity.metaJson?.numPages || 0;
            // console.log(`numPages=${numPages}`);
            if (numPages > 0) {
                // gemini系以外は画像化したものとテキスト抽出したものを組合せる。
                const jsonString = await fs.readFile(`${basePath}.json`, 'utf-8').catch(() => {
                    console.error(`Error: PDF file has no pages: ${file.fileBodyEntity.fileType} ${file.fileBodyEntity.innerPath} ${JSON.stringify(file.fileBodyEntity.metaJson)}`);
                    return '{"pdfMetaData":{"textPages":[""]}}';
                });
                const pdfMetaData = JSON.parse(jsonString) as PdfMetaData;
                let metaText = '';
                // `---\n${(image.image_url as any).label} start\n\n`;
                if (pdfMetaData.info) {
                    metaText += `## Info\n\n`;
                    metaText += ['CreationDate', 'ModDate', 'Title', 'Creator', 'Author'].map(tag => `- ${tag}: ${pdfMetaData.info[tag]}\n`).join('');
                } else { }
                if (pdfMetaData.outline) {
                    metaText += `## Outline\n\n ${JSON.stringify(pdfMetaData.outline)}\n`;
                } else { }
                const textTokens = getTiktokenEncoder(COUNT_TOKEN_OPENAI_MODEL).encode(metaText + pdfMetaData.textPages.join('')).length;

                // https://platform.openai.com/docs/guides/images-vision?api-mode=chat#calculating-costs
                // OpenAIのトークン数計算式 
                // imageTokens = 85 + 170 * numPages * 4; 
                const imageTokens = 85 + 170 * numPages * 2 * 2;
                openaiTokenCount.totalTokens = imageTokens + textTokens;
                (openaiTokenCount as any).prompt_tokens_details = { image_tokens: imageTokens, text_tokens: textTokens, };
            } else {
                // TODO 何も無い場合はどうするか？
                console.error(`Error: PDF file has no pages: ${file.fileBodyEntity.fileType} ${file.fileBodyEntity.innerPath} ${JSON.stringify(file.fileBodyEntity.metaJson)}`);
                // 何も無い場合はトークン数を0にする
                openaiTokenCount.totalTokens = 0;
            }
        } else {
            // 何もしない
            console.error(`Error: fileType is not supported: ${file.fileBodyEntity.fileType} ${file.fileBodyEntity.innerPath}`);
        }
        return openaiTokenCount;
    });

    try {
        const geminiResults = await Promise.allSettled(vertexGemini);
        const openaiResults = await Promise.allSettled(openaiTokenCountList);

        // 整形
        const mappedResults: FileBodyEntity[] = geminiResults.map((r, index) => {
            if (fileList[index].fileBodyEntity.tokenCount) {
            } else {
                fileList[index].fileBodyEntity.tokenCount = {};
            }
            const tokenCount = fileList[index].fileBodyEntity.tokenCount || {};
            if (r.status === 'fulfilled') {
                tokenCount[COUNT_TOKEN_MODEL] = r.value;;
            } else {
                // console.error(r.reason);
                tokenCount[COUNT_TOKEN_MODEL] = { totalTokens: 0, totalBillableCharacters: 0 };
            }
            const openaiResult = openaiResults[index];
            if (openaiResult.status === 'fulfilled') {
                tokenCount[COUNT_TOKEN_OPENAI_MODEL] = openaiResult.value;
            } else {
                // console.error(openaiResults[index].reason);
                tokenCount[COUNT_TOKEN_OPENAI_MODEL] = { totalTokens: 0 };
            }
            return fileList[index].fileBodyEntity;
        });

        // 保存
        const forSaveList = mappedResults.filter(content => !(content as any).error && content.tokenCount && content.tokenCount[model]);
        // console.dir(forSave, { depth: null });
        await transactionalEntityManager.getRepository(FileBodyEntity).save(forSaveList);
        // 成功・失敗の結果を集計
        const successful = geminiResults.filter(r => r.status === 'fulfilled').length;
        const failed = geminiResults.filter(r => r.status === 'rejected').length;

        console.log(`Count tokens by files completed: ${successful}, Failed: ${failed}`);

        return mappedResults;
    } catch (error) {
        console.error('Fatal error occurred:', error);
        throw error;
    }
}


// const CONTEXT_CACHE_API_ENDPOINT = `https://${GCP_CONTEXT_CACHE_LOCATION}-aiplatform.googleapis.com/v1beta1`;
const CONTEXT_CACHE_API_ENDPOINT = `https://${GCP_CONTEXT_CACHE_LOCATION}-${GCP_API_BASE_PATH}/v1beta1`;

/**
 * [ユーザー認証] コンテキストキャッシュ作成
 * // TODO 複数スレッドに対応していない。
 */
export const geminiCreateContextCacheByProjectModel = [
    query('type').isIn(['threadGroup', 'thread', 'messageGroup', 'message', 'contentPart']).notEmpty(),
    query('id').trim().notEmpty(),
    // query('messageId').optional().isUUID(),
    query('model').trim().notEmpty(),
    body('ttl').optional({ nullable: true }).isObject(), // ttl が null でもオブジェクトでも良い
    body('ttl.seconds').if(body('ttl').exists()).isFloat(), // ttl が存在する場合のみ seconds をバリデーション
    body('ttl.nanos').if(body('ttl').exists()).isFloat(), // ttl が存在する場合のみ nanos をバリデーション
    body('expire_time').optional().isDate(), // ISODateString
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        const userId = req.info.user.id as string;
        const orgKey = req.info.user.orgKey;
        const { type, id, model } = req.query as { type: ArgsBuildType, id: string, model: string };
        const { ttl, expire_time } = req.body as GenerateContentRequestForCache;
        try {
            const { messageArgsSetList } = await buildArgs(req.info.user, type, [id], 'createCache');
            // const modelId: 'gemini-1.5-flash-001' | 'gemini-1.5-pro-001' = 'gemini-1.5-flash-001';

            const user = await ds.getRepository(UserEntity).findOneOrFail({ where: { id: userId, orgKey, status: UserStatus.Active } });

            // 課金用にプロジェクト振り分ける。当たらなかったら当たらなかったでよい。
            const departmentMember = await ds.getRepository(DepartmentMemberEntity).findOne({ where: { orgKey, name: user.name || '', departmentRole: DepartmentRoleType.Member } });
            // console.log(departmentMember);
            if (departmentMember) {
                const department = await ds.getRepository(DepartmentEntity).findOne({ where: { orgKey, id: departmentMember.departmentId } });
                messageArgsSetList.forEach(messageSet => {
                    (messageSet.args as any).gcpProjectId = department?.gcpProjectId || GCP_PROJECT_ID;
                });
                // console.log(department?.gcpProjectId);
            } else {
                // 未設定なら未設定で良しとする。（その場合はAI部課金）
            }
            const gcpProjectId = (messageArgsSetList[0].args as any).gcpProjectId || GCP_PROJECT_ID;
            const url = `${CONTEXT_CACHE_API_ENDPOINT}/projects/${gcpProjectId}/locations/${GCP_CONTEXT_CACHE_LOCATION}/cachedContents`;
            normalizeMessage(messageArgsSetList[0].args, false).subscribe({
                next: async next => {
                    try {
                        const args = next.args;
                        const gemMapped: GenerateContentRequest = mapForGemini(args);

                        // モデルの説明文を書いておく？？
                        // gemMapped.contents.push({ role: 'model', parts: [{ text: 'これはキャッシュ機能のサンプルです。' }] });

                        // // システムプロンプトを先頭に戻しておく
                        // if (gemMapped.systemInstruction && typeof gemMapped.systemInstruction !== 'string') {
                        //     gemMapped.contents.unshift(gemMapped.systemInstruction);
                        // } else { }

                        const countCharsObj = countChars(args);
                        const my_vertexai = (await getAIProvider(req.info.user, model)).client as MyVertexAiClient;
                        const client = my_vertexai.client;
                        const generativeModel = client.preview.getGenerativeModel({
                            model: COUNT_TOKEN_MODEL,
                            safetySettings: [],
                        });
                        const countObj: TokenCharCount = await generativeModel.countTokens(gemMapped).then(tokenObject => Object.assign(tokenObject, countCharsObj));

                        // リクエストボディ
                        const requestBody = {
                            model: `projects/${gcpProjectId}/locations/${GCP_CONTEXT_CACHE_LOCATION}/publishers/google/models/${model}`,
                            contents: gemMapped.contents,
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
                                entity.projectId = messageArgsSetList[0].threadGroup.projectId;
                                entity.title = messageArgsSetList[0].threadGroup.title;

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

                                entity.orgKey = req.info.user.orgKey;
                                entity.createdBy = userId;
                                entity.updatedBy = userId;
                                entity.createdIp = req.info.ip;
                                entity.updatedIp = req.info.ip;

                                savedCachedContent = await transactionalEntityManager.save(VertexCachedContentEntity, entity);

                                await Promise.all(messageArgsSetList.map(messageSet => {
                                    if (savedCachedContent) {
                                        messageSet.message.cacheId = savedCachedContent.id;
                                        messageSet.message.updatedBy = userId;
                                        messageSet.message.updatedIp = req.info.ip;
                                    }
                                    return transactionalEntityManager.save(MessageEntity, messageSet.message);
                                }));
                            });
                        });
                        res.status(200).json(savedCachedContent);
                    } catch (error) {
                        res.status(503).set('Content-Type', 'text/plain; charset=utf-8').end(Utils.errorFormat(error));
                    }
                },
            });
        } catch (error) {
            res.status(503).set('Content-Type', 'text/plain; charset=utf-8').end(Utils.errorFormat(error));
        }
    }
];

/**
 * [ユーザー認証] コンテキストキャッシュ時間変更
 */
export const geminiUpdateContextCacheByProjectModel = [
    query('threadGroupId').notEmpty(),
    body('ttl').optional({ nullable: true }).isObject(), // ttl が null でもオブジェクトでも良い
    body('ttl.seconds').if(body('ttl').exists()).isFloat(), // ttl が存在する場合のみ seconds をバリデーション
    body('ttl.nanos').if(body('ttl').exists()).isFloat(), // ttl が存在する場合のみ nanos をバリデーション
    body('expire_time').optional().isDate(), // ISODateString
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        const userId = req.info.user.id as string;
        const { threadGroupId } = req.query as { threadGroupId: string };
        const { ttl } = _req.body as { ttl: { seconds: number, nanos: number } };
        // const { expire_time } = _req.body as { expire_time: string };
        try {

            // メッセージの存在確認
            const threadGroup = await ds.getRepository(ThreadGroupEntity).findOneOrFail({
                where: { orgKey: req.info.user.orgKey, id: threadGroupId }
            });
            const threads = await ds.getRepository(ThreadEntity).find({
                where: { orgKey: req.info.user.orgKey, threadGroupId: threadGroup.id }
            });

            // TODO 本来は複数のコンテキストキャッシュに対応すべき。
            const inDto = threads[0].inDto;
            const cachedContent: VertexCachedContentEntity = (inDto.args as any).cachedContent;
            const cacheName = cachedContent.name;

            // キャッシュの存在確認
            let cacheEntity = await ds.getRepository(VertexCachedContentEntity).findOneOrFail({
                where: { orgKey: req.info.user.orgKey, name: cacheName }
            });

            let savedCachedContent: VertexCachedContentEntity | undefined;

            const my_vertexai = (await getAIProvider(req.info.user, inDto.args.model)).client as MyVertexAiClient;
            my_vertexai.getAuthorizedHeaders().then(headers =>
                axios.patch(`${CONTEXT_CACHE_API_ENDPOINT}/${cachedContent.name}`, { ttl }, headers)
            ).then(async response => {
                const cache = response.data as CachedContent;
                // console.log(response.headers);
                // console.log(response.data);
                const result = await ds.transaction(async transactionalEntityManager => {

                    // トランザクションの中で再度取得してこないと変になる。
                    cacheEntity = await transactionalEntityManager.getRepository(VertexCachedContentEntity).findOneOrFail({
                        where: { orgKey: req.info.user.orgKey, id: cacheEntity.id }
                    });

                    // 独自定義
                    // コンテンツキャッシュの応答
                    cacheEntity.name = cache.name;
                    cacheEntity.model = cache.model;
                    cacheEntity.createTime = new Date(cache.createTime);
                    cacheEntity.expireTime = new Date(cache.expireTime);
                    cacheEntity.updateTime = new Date(cache.updateTime);

                    cacheEntity.updatedBy = userId;
                    cacheEntity.updatedIp = req.info.ip;

                    savedCachedContent = await transactionalEntityManager.save(VertexCachedContentEntity, cacheEntity);
                });
                // 
                res.end(JSON.stringify(savedCachedContent));
            }).catch(error => {
                res.status(503).set('Content-Type', 'text/plain; charset=utf-8').end(Utils.errorFormat(error));
            });
        } catch (error) {
            res.status(503).set('Content-Type', 'text/plain; charset=utf-8').end(Utils.errorFormat(error));
        }
    }
];

/**
 * [ユーザー認証] コンテキストキャッシュ削除
 */
export const geminiDeleteContextCacheByProjectModel = [
    query('threadGroupId').notEmpty().isUUID(),
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        const { threadGroupId } = _req.query as { threadGroupId: string };
        try {
            // スレッドグループの存在確認
            const threadGroup = await ds.getRepository(ThreadGroupEntity).findOneOrFail({
                where: { orgKey: req.info.user.orgKey, id: threadGroupId, status: Not(ThreadGroupStatus.Deleted) }
            });

            // メッセージの存在確認
            const threadList = await ds.getRepository(ThreadEntity).find({
                where: { orgKey: req.info.user.orgKey, threadGroupId: threadGroup.id, status: Not(ThreadStatus.Deleted) }
            });
            const result = await ds.transaction(async transactionalEntityManager => {
                for (const thread of threadList) {
                    // TODO for文で書いては見たものの最後axios投げるところが複数スレッド対応していないので注意。
                    const inDto = thread.inDto;
                    const cachedContent: VertexCachedContentEntity = (inDto.args as any).cachedContent;

                    const my_vertexai = (await getAIProvider(req.info.user, inDto.args.model)).client as MyVertexAiClient;
                    // cachedContentを消して更新
                    delete (inDto.args as any).cachedContent;
                    thread.inDto = inDto;
                    thread.updatedBy = req.info.user.id;
                    thread.updatedIp = req.info.ip;
                    const savedThread = await transactionalEntityManager.save(ThreadEntity, thread);

                    // updatedAtを更新するため。
                    await transactionalEntityManager.save(ThreadGroupEntity, threadGroup);

                    await transactionalEntityManager.createQueryBuilder()
                        .update(MessageEntity)
                        .set({
                            cacheId: () => "''",
                            updatedBy: () => `:updatedBy`,
                            updatedIp: () => `:updatedIp`,
                        })
                        .where('org_key = :orgKey AND cache_id = :cacheId', { orgKey: req.info.user.orgKey, cacheId: cachedContent.id })
                        .setParameters({
                            updatedBy: req.info.user.id,
                            updatedIp: req.info.ip
                        })
                        .execute();

                    // TODO googleに投げる前にDBコミットすることにした。こうすることで通信エラーを無視できるけどキャッシュが残っちゃったときどうするんだろう。。
                    await my_vertexai.getAuthorizedHeaders().then(headers =>
                        axios.delete(`${CONTEXT_CACHE_API_ENDPOINT}/${cachedContent.name}`, headers)
                    ).then(async response => {
                        res.end(JSON.stringify(response.data));
                    }).catch(error => {
                        res.status(503).set('Content-Type', 'text/plain; charset=utf-8').end(Utils.errorFormat(error));
                    });
                }
            });
        } catch (error) {
            res.status(503).set('Content-Type', 'text/plain; charset=utf-8').end(Utils.errorFormat(error));
        }
    }
];

/**
 * [ユーザー認証] コンテキストキャッシュ一覧
 */
export const geminiGetContextCache = [
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        try {
            const my_vertexai = (await getAIProvider(req.info.user, COUNT_TOKEN_MODEL)).client as MyVertexAiClient;
            my_vertexai.getAuthorizedHeaders().then(headers =>
                axios.get(`${CONTEXT_CACHE_API_ENDPOINT}/projects/${GCP_PROJECT_ID}/locations/${GCP_CONTEXT_CACHE_LOCATION}/cachedContents`, headers)
            ).then(response => {
                res.end(JSON.stringify(response.data));
            }).catch(error => {
                res.status(503).set('Content-Type', 'text/plain; charset=utf-8').end(Utils.errorFormat(error));
            });
        } catch (error) {
            res.status(503).set('Content-Type', 'text/plain; charset=utf-8').end(Utils.errorFormat(error));
        }
    }
];


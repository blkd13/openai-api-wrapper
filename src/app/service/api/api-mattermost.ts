import { Request, Response } from 'express';
import { body, param, query } from "express-validator";
import { In, Not } from 'typeorm';

import { Axios } from 'axios';
import { ChatModel } from 'openai/resources.js';
import { MattermostChannel, MattermostEmoji, Post } from '../../agent/api-mattermost/api.js';
import { getAxios } from '../../common/http-client.js';
import { plainExtensions, plainMime } from '../../common/openai-api-wrapper.js';
import { Utils } from '../../common/utils.js';
import { ExtApiClient, getExtApiClient } from '../controllers/auth.js';
import { geminiCountTokensByContentPart, geminiCountTokensByFile } from '../controllers/chat-by-project-model.js';
import { convertToMapSet, handleFileUpload } from '../controllers/file-manager.js';
import { ds } from '../db.js';
import { MmTimelineChannelEntity, MmTimelineEntity, MmTimelineStatus, MmUserEntity, MmUserGroupEntity, MmUserGroupScope, MmUserGroupStatus } from '../entity/api-mattermost.entity.js';
import { FileAccessEntity, FileEntity, FileGroupEntity } from '../entity/file-models.entity.js';
import { ContentPartEntity, MessageEntity, MessageGroupEntity, ProjectEntity, TeamMemberEntity, ThreadEntity, ThreadGroupEntity } from '../entity/project-models.entity.js';
import { validationErrorHandler } from "../middleware/validation.js";
import { UserRequest } from "../models/info.js";
import { ContentPartType, FileGroupType, MessageGroupType, ProjectVisibility, ThreadGroupVisibility, ThreadStatus } from '../models/values.js';

export const getMmUsers = [
    param('providerName').isString().notEmpty(),
    body('ids').optional().trim(),
    body('names').optional().trim(),
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        // const ids = (req.body.ids as string || '').split(',').filter(id => id !== '');
        // const names = (req.body.names as string || '').split(',').filter(name => name !== '');
        const { ids, names } = req.body as { ids: string[], names: string[] };
        const { providerName } = req.params as { providerName: string };

        if (ids.length === 0 && names.length === 0) {
            return res.status(400).json({ error: 'Either ids or names must be provided' });
        }

        const userRepository = ds.getRepository(MmUserEntity);
        const whereConditions = [];
        whereConditions.push({ orgKey: req.info.user.orgKey });

        if (ids.length > 0) {
            whereConditions.push({ id: In(ids) });
        }
        if (names.length > 0) {
            whereConditions.push({ username: In(names) });
        }
        // console.log(names);

        try {
            const users = await userRepository.find({
                where: whereConditions,
                select: ['id', 'username', 'nickname'],
                order: { username: 'ASC' },
            });
            res.json(users);
        } catch (error) {
            console.error(error);
            res.status((error as any).status || 500).json({ error: (error as any).message || 'Internal Server Error' });
        }
    }
];

// Timeline CRUD operations
export const getTimelines = [
    param('providerName').isString().notEmpty(),
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        const userId = req.info.user.id;
        const { providerName } = req.params as { providerName: string };
        try {
            const timelines = await ds.getRepository(MmTimelineEntity).find({
                where: { orgKey: req.info.user.orgKey, userId, status: MmTimelineStatus.Normal },
                order: { sortOrder: 'ASC', createdAt: 'DESC' },
            });
            // channelsを埋めておく
            timelines.forEach(tl => (tl as any).channels = []);
            const timelineChannel = await ds.getRepository(MmTimelineChannelEntity).find({
                where: { orgKey: req.info.user.orgKey, timelineId: In(timelines.map(timeline => timeline.id)) },
                order: { sortOrder: 'ASC', createdAt: 'ASC' },
            })
            const tlMas = timelines.reduce((mas, curr) => {
                mas[curr.id] = curr;
                return mas;
            }, {} as { [key: string]: MmTimelineEntity });
            timelineChannel.forEach(ch => {
                const tl = tlMas[ch.timelineId] as any as { channels: MmTimelineChannelEntity[] };
                tl.channels.push(ch);
            });
            res.json(timelines);
        } catch (error) {
            console.error(error);
            res.status((error as any).status || 500).json({ error: (error as any).message || 'Internal Server Error' });
        }
    }
];
export const createTimeline = [
    param('providerName').isString().notEmpty(),
    body('title').isString().notEmpty(),
    body('description').optional().isString(),
    body('channelIds').optional().isArray(),
    body('sortOrder').optional().isInt({ min: 0 }),
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        const { title, description, channelIds, sortOrder } = req.body as { title: string, description: string, channelIds: string[], sortOrder?: number };
        const { providerName } = req.params as { providerName: string };
        try {
            const savedTl = await ds.transaction(async em => {
                // sortOrderが指定されていない場合は最後尾に追加
                let finalSortOrder = sortOrder;
                if (finalSortOrder === undefined || finalSortOrder === null) {
                    const maxSortOrderResult = await em.getRepository(MmTimelineEntity)
                        .createQueryBuilder('timeline')
                        .select('MAX(timeline.sortOrder)', 'maxSortOrder')
                        .where('timeline.orgKey = :orgKey', { orgKey: req.info.user.orgKey })
                        .andWhere('timeline.userId = :userId', { userId: req.info.user.id })
                        .andWhere('timeline.status = :status', { status: MmTimelineStatus.Normal })
                        .getRawOne();
                    finalSortOrder = (maxSortOrderResult?.maxSortOrder ?? -1) + 1;
                }
                const timeline = { orgKey: req.info.user.orgKey, userId: req.info.user.id, title, description, sortOrder: finalSortOrder, createdBy: req.info.user.id, updatedBy: req.info.user.id, createdIp: req.info.ip, updatedIp: req.info.ip };
                const savedTl = await em.getRepository(MmTimelineEntity).save(timeline);
                channelIds.forEach(async (channelId, index) => {
                    await em.getRepository(MmTimelineChannelEntity).save({ orgKey: req.info.user.orgKey, channelId, timelineId: savedTl.id, isMute: false, sortOrder: index, createdBy: req.info.user.id, updatedBy: req.info.user.id, createdIp: req.info.ip, updatedIp: req.info.ip, lastViewedAt: new Date() });
                });
                return savedTl;
            });
            res.status(201).json(savedTl);
        } catch (error) {
            console.error(error);
            res.status((error as any).status || 500).json({ error: (error as any).message || 'Internal Server Error' });
        }
    }
];
export const updateTimeline = [
    param('providerName').isString().notEmpty(),
    param('id').isUUID().notEmpty(),
    body('title').isString().notEmpty(),
    body('description').optional(),
    body('channelIds').optional().isArray(),
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        const { id, providerName } = req.params as { id: string, providerName: string };
        const { title, description, channelIds } = req.body as { title: string, description?: string, channelIds: string[] };
        try {
            const savedTl = await ds.transaction(async em => {
                const timeline = await em.getRepository(MmTimelineEntity).findOne({ where: { orgKey: req.info.user.orgKey, id, userId: req.info.user.id } });
                if (!timeline) {
                    return res.status(404).json({ error: 'Timeline not found' });
                }

                if (title) {
                    timeline.title = title;
                }
                if (description) {
                    timeline.description = description;
                }

                // 以下は追加された部分です
                if (channelIds) {
                    const existingChannels = await em.getRepository(MmTimelineChannelEntity).find({
                        where: { orgKey: req.info.user.orgKey, timelineId: id }
                    });

                    const existingChannelIdMap = existingChannels.reduce((map, ch) => {
                        map[ch.channelId] = ch;
                        return map;
                    }, {} as { [channelId: string]: MmTimelineChannelEntity });
                    const existingChannelIds = existingChannels.map(ch => ch.channelId);
                    const channelsToAdd = channelIds.filter(chId => !existingChannelIds.includes(chId));
                    const channelsToRemove = existingChannels.filter(ch => !channelIds.includes(ch.channelId));

                    // 削除するチャンネルを処理
                    if (channelsToRemove.length > 0) {
                        await em.getRepository(MmTimelineChannelEntity).remove(channelsToRemove);
                    }

                    // 追加するチャンネルを処理（sortOrderは配列のインデックス）
                    if (channelsToAdd.length > 0) {
                        const newChannels = channelsToAdd.map(channelId => {
                            const newChannel = new MmTimelineChannelEntity();
                            newChannel.orgKey = req.info.user.orgKey;
                            newChannel.timelineId = id;
                            newChannel.channelId = channelId;
                            newChannel.sortOrder = channelIds.indexOf(channelId);
                            newChannel.createdBy = req.info.user.id;
                            newChannel.createdIp = req.info.ip;
                            newChannel.updatedBy = req.info.user.id;
                            newChannel.updatedIp = req.info.ip;
                            return newChannel;
                        });

                        await em.getRepository(MmTimelineChannelEntity).save(newChannels);
                    }

                    // 既存チャンネルのsortOrderを更新（配列のインデックスに基づいて）
                    const channelsToUpdate = existingChannels.filter(ch => channelIds.includes(ch.channelId));
                    for (const channel of channelsToUpdate) {
                        const newSortOrder = channelIds.indexOf(channel.channelId);
                        if (channel.sortOrder !== newSortOrder) {
                            channel.sortOrder = newSortOrder;
                            channel.updatedBy = req.info.user.id;
                            channel.updatedIp = req.info.ip;
                            await em.getRepository(MmTimelineChannelEntity).save(channel);
                        }
                    }
                }

                timeline.updatedBy = req.info.user.id;
                timeline.updatedIp = req.info.ip;
                const saved = await em.getRepository(MmTimelineEntity).save(timeline);
                return saved;
            });
            res.status(200).json(savedTl);
        } catch (error) {
            console.error(error);
            res.status((error as any).status || 500).json({ error: (error as any).message || 'Internal Server Error' });
        }
    }
];
export const updateTimelineChannel = [
    param('providerName').isString().notEmpty(),
    param('timelineId').isUUID().notEmpty(),
    param('timelineChannelId').isUUID().notEmpty(),
    body('isMute').optional().isBoolean(),
    body('lastViewedAt').optional().isISO8601().toDate(),
    // body('lastViewedAt').optional().isDate({ format: 'YYYY-MM-DDTHH:mm:ss.sssZ' }),
    validationErrorHandler,

    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        const { providerName, timelineId, timelineChannelId } = req.params as { providerName: string, timelineId: string, timelineChannelId: string };
        const { isMute, lastViewedAt } = req.body as { isMute: boolean, lastViewedAt?: Date };
        // console.log(req.body);
        try {
            const savedChannel = await ds.transaction(async em => {

                const timeline = await em.getRepository(MmTimelineEntity).findOne({
                    where: { orgKey: req.info.user.orgKey, id: timelineId, userId: req.info.user.id, status: MmTimelineStatus.Normal }
                });
                if (!timeline) {
                    res.status(404).json({ error: 'Timeline not found' });
                    return;
                }

                const existingChannel = await em.getRepository(MmTimelineChannelEntity).findOne({
                    where: { orgKey: req.info.user.orgKey, timelineId, id: timelineChannelId }
                });
                if (!existingChannel) {
                    res.status(404).json({ error: 'TimelineChannel not found' });
                    return;
                }

                // 更新
                if (isMute !== undefined && isMute !== null) {
                    existingChannel.isMute = isMute;
                } else { }
                if (lastViewedAt !== undefined && lastViewedAt !== null) {
                    existingChannel.lastViewedAt = lastViewedAt;
                } else { }
                existingChannel.updatedBy = req.info.user.id;
                existingChannel.updatedIp = req.info.ip;
                const savedChannel = await em.getRepository(MmTimelineChannelEntity).save(existingChannel);

                return savedChannel;
            });
            if (savedChannel) {
                res.status(200).json(savedChannel);
            } else { }
        } catch (error) {
            console.error(error);
            res.status((error as any).status || 500).json({ error: (error as any).message || 'Internal Server Error' });
        }
    }
];

export const deleteTimeline = [
    param('providerName').isString().notEmpty(),
    param('id').isUUID(),
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        const { providerName, id } = req.params as { providerName: string, id: string };
        const timelineRepository = ds.getRepository(MmTimelineEntity);
        try {
            const timeline = await timelineRepository.findOne({ where: { orgKey: req.info.user.orgKey, id } });
            if (!timeline) {
                return res.status(404).json({ error: 'Timeline not found' });
            }
            timeline.updatedBy = req.info.user.id;
            timeline.status = MmTimelineStatus.Deleted;
            await timelineRepository.save(timeline);
            res.status(204).send();
        } catch (error) {
            console.error(error);
            res.status((error as any).status || 500).json({ error: (error as any).message || 'Internal Server Error' });
        }
    }
];

/**
 * タイムラインの並び順を一括更新
 * PATCH /api/user/mattermost/:providerName/timeline/reorder
 */
export const reorderTimelines = [
    param('providerName').isString().notEmpty(),
    body('timelineIds').isArray({ min: 1 }),
    body('timelineIds.*').isUUID(),
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        const userId = req.info.user.id;
        const { providerName } = req.params as { providerName: string };
        const { timelineIds } = req.body as { timelineIds: string[] };

        try {
            // 重複チェック
            const uniqueTimelineIds = [...new Set(timelineIds)];
            if (uniqueTimelineIds.length !== timelineIds.length) {
                return res.status(400).json({
                    error: 'duplicate_timeline_ids',
                    message: 'Duplicate timeline IDs are not allowed'
                });
            }

            await ds.transaction(async em => {
                const timelineRepository = em.getRepository(MmTimelineEntity);

                // 指定されたタイムラインをすべて取得
                const timelines = await timelineRepository.find({
                    where: {
                        orgKey: req.info.user.orgKey,
                        id: In(timelineIds),
                        status: MmTimelineStatus.Normal,
                    }
                });

                // 存在しないタイムラインIDのチェック
                const foundIds = timelines.map(tl => tl.id);
                const missingIds = timelineIds.filter(id => !foundIds.includes(id));
                if (missingIds.length > 0) {
                    throw { status: 400, message: `Invalid timeline IDs: ${missingIds.join(', ')}` };
                }

                // 他ユーザーのタイムラインが含まれていないかチェック
                const otherUserTimelines = timelines.filter(tl => tl.userId !== userId);
                if (otherUserTimelines.length > 0) {
                    throw { status: 403, message: 'Cannot reorder timelines owned by other users' };
                }

                // sortOrderを更新
                for (let i = 0; i < timelineIds.length; i++) {
                    const timeline = timelines.find(tl => tl.id === timelineIds[i]);
                    if (timeline && timeline.sortOrder !== i) {
                        timeline.sortOrder = i;
                        timeline.updatedBy = userId;
                        timeline.updatedIp = req.info.ip;
                        await timelineRepository.save(timeline);
                    }
                }
            });

            res.status(200).json({ success: true });
        } catch (error) {
            console.error(error);
            res.status((error as any).status || 500).json({ error: (error as any).message || 'Internal Server Error' });
        }
    }
];

export type ToAiIdType = 'timeline' | 'timelineChannel' | 'channel' | 'thread';
export type ToAiFilterType = 'timespan' | 'count' | 'batch';
export const mattermostToAi = [
    param('providerName').isString().notEmpty(),
    body('projectId').isUUID().notEmpty(),
    body('id').isString().notEmpty(),
    body('title').isString().notEmpty(),
    // body('inDtoJson').trim().notEmpty(),
    body('idType').notEmpty().isIn(['timeline', 'timelineChannel', 'channel', 'thread']),
    body('filterType').notEmpty().isIn(['timespan', 'count', 'batch']),
    body('systemPrompt').isString().notEmpty(),
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        const { providerName } = req.params as { providerName: string };
        const { projectId, id, idType, filterType, params, systemPrompt } = req.body as { projectId: string, id: string, idType: ToAiIdType, filterType: ToAiFilterType, params: any, systemPrompt: string };
        let { title } = req.body as { title: string };
        // console.log(req.body);
        const provider = 'mattermost-default';
        const e = {} as ExtApiClient;
        try {
            Object.assign(e, await getExtApiClient(req.info.user.orgKey, provider));
        } catch (error) {
            res.status(401).json({ error: `${provider}は認証されていません。` });
            return;
        }
        const axios = await getAxios(e.uriBase);

        const initialArgs = {
            args: {
                model: "gemini-2.5-pro" as ChatModel,
                temperature: 0.7,
                top_p: 1,
                max_tokens: 8192,
                stream: true
            }
        };
        const inDto = initialArgs;

        try {
            // チェック
            const project = await ds.getRepository(ProjectEntity).findOne({ where: { orgKey: req.info.user.orgKey, id: projectId } });
            if (!project) {
                return res.status(404).json({ message: '指定されたプロジェクトが見つかりません' });
            }

            const teamMember = await ds.getRepository(TeamMemberEntity).findOne({
                where: { orgKey: req.info.user.orgKey, userId: req.info.user.id, teamId: project.teamId }
            });

            if (project.visibility !== ProjectVisibility.Public && project.visibility !== ProjectVisibility.Login && !teamMember) {
                return res.status(403).json({ message: 'このプロジェクトにファイルをアップロードする権限がありません' });
            }

            // --------------------

            const resObj: { posts: Record<string, Post>, order: string[] } = { posts: {}, order: [] };
            let urlList: string[];
            if (idType === 'timeline') {
                const timeline = await ds.getRepository(MmTimelineEntity).findOneOrFail({
                    where: { orgKey: req.info.user.orgKey, id, userId: req.info.user.id, status: MmTimelineStatus.Normal }
                });
                title = timeline.title;
                const timelineChannelList = await ds.getRepository(MmTimelineChannelEntity).find({
                    where: { orgKey: req.info.user.orgKey, timelineId: id }
                });
                urlList = timelineChannelList.map(timelineChannel => `${e.uriBase}/api/v4/channels/${timelineChannel.channelId}/posts`);
            } else if (idType === 'timelineChannel') {
                const timelineChannel = await ds.getRepository(MmTimelineChannelEntity).findOneOrFail({
                    where: { orgKey: req.info.user.orgKey, id }
                });
                urlList = [`${e.uriBase}/api/v4/channels/${timelineChannel.channelId}/posts`];
            } else if (idType === 'channel') {
                urlList = [`${e.uriBase}/api/v4/channels/${id}/posts`];
            } else if (idType === 'thread') {
                urlList = [`${e.uriBase}/api/v4/posts/${id}/thread`];
            } else {
                return res.status(400).json({ message: '不正なidTypeです' });
            }

            async function processTimelineChannels(urlList: string[]) {
                for (let i = 0; i < urlList.length; i++) {
                    const _url = urlList[i];
                    let url = _url;
                    try {
                        if (params) {
                            if (params.timespan) {
                                // const start = new Date(params.timespan.start).getTime();
                                // const end = new Date(params.timespan.end).getTime();
                                const start = params.timespan.start;
                                const end = params.timespan.end;
                                let page = 0;

                                url = `${_url}?since=${start}`;
                                // ループでとり切らないとダメかと思ったけど、200件を超えてsinceで指定したら全量取れるようだ
                                // while (true) {
                                //     url = `${_url}?page=${page}&per_page=200&since=${start}`;
                                //     console.log(`d:str   : ${url}`);
                                //     const response = await _axios.get(url, { headers: { Cookie: `MMAUTHTOKEN=${req.cookies.MMAUTHTOKEN}; MMUSERID=${req.cookies.MMUSERID};`, }, });
                                //     console.log(`d:end ${response.data.order.length}: ${url}`);
                                //     // console.log(response.data);

                                //     resObj.posts = { ...resObj.posts, ...response.data.posts };
                                //     resObj.order = resObj.order.concat(response.data.order);

                                //     page++;
                                //     const endId = response.data.order[response.data.order.length - 1];
                                //     if (response.data.posts[endId].create_at > end) {
                                //         break;
                                //     } else if (response.data.order.length > 200) {
                                //         // ループ 
                                //     } else {
                                //         break;
                                //     }
                                // }
                            } else if (params.count) {
                                url = `${url}?page=0&per_page=${params.count}`;
                                // console.log(`c:str   : ${url}`);
                                // const response = await _axios.get(url, { headers: { Cookie: `MMAUTHTOKEN=${req.cookies.MMAUTHTOKEN}; MMUSERID=${req.cookies.MMUSERID};`, }, });
                                // console.log(`c:end ${response.data.order.length}: ${url}`);
                                // resObj.posts = { ...resObj.posts, ...response.data.posts };
                                // resObj.order = resObj.order.concat(response.data.order);
                            }
                        } else {
                            // 
                        }
                        // 
                        // console.log(`str   : ${url}`);
                        const response = await axios.get(url, { headers: { Cookie: `MMAUTHTOKEN=${req.cookies.MMAUTHTOKEN}; MMUSERID=${req.cookies.MMUSERID};`, }, });
                        console.log(`end ${response.data.order.length}: ${url}`);
                        resObj.posts = { ...resObj.posts, ...response.data.posts };
                        resObj.order = resObj.order.concat(response.data.order);
                    } catch (error) {
                        console.error(JSON.stringify(error, Utils.genJsonSafer()));
                    }
                }
                return;
            }

            // 関数を実行する
            await processTimelineChannels(urlList);

            if (params) {
                if (params.timespan) {
                    // const start = new Date(params.timespan.start).getTime();
                    // const end = new Date(params.timespan.end).getTime();
                    const start = params.timespan.start;
                    const end = params.timespan.end;
                    resObj.order = resObj.order.filter(postId => resObj.posts[postId].create_at <= end);
                } else if (params.count) {
                    resObj.order = resObj.order.sort((a, b) => resObj.posts[b].create_at - resObj.posts[a].create_at).slice(0, params.count);
                }
                // TODO スレッド系がまとわりついてきていると思われるやつを消してしまってよいのか？
                resObj.posts = resObj.order.reduce((acc, postId) => ({ ...acc, [postId]: resObj.posts[postId] }), {});
            }

            if (resObj.order.length > 0) {
            } else {
                res.status(404).json({ message: 'No posts found' });
                return;
            }

            const last_delete_at = 0;
            const include_deleted = false;
            const channelUrl = `${e.uriBase}/api/v4/users/me/channels?last_delete_at=${last_delete_at}&include_deleted=${include_deleted}`;
            // console.log(`str   : ${channelUrl}`);
            const response = await axios.get(channelUrl, { headers: { Cookie: `MMAUTHTOKEN=${req.cookies.MMAUTHTOKEN}; MMUSERID=${req.cookies.MMUSERID};`, }, });
            console.log(`end ${response.data.length}: ${channelUrl}`);
            const mmChannelMas = (response.data as MattermostChannel[]).reduce((acc, channel) => {
                acc[channel.id] = channel;
                return acc;
            }, {} as { [channelId: string]: MattermostChannel });

            console.log(`${title}:${mmChannelMas[resObj.posts[resObj.order[0]].channel_id].display_name}:`);
            if (idType === 'timeline') {
            } else {
                title = mmChannelMas[resObj.posts[resObj.order[0]].channel_id].display_name || title;
            }

            type FileContentPart = { type: 'file', text: string, dataUrl: string, fileId: string };
            type ContentPart = ({ type: 'text', text: string } | FileContentPart);
            async function toAi(): Promise<ContentPart[]> {
                // this.mmChannelPosts = {};
                const allPosts = resObj.posts;
                const userIdSet = new Set<string>();
                const userNameSet = new Set<string>();

                // メンションのみを抽出する正規表現
                // const mentionRegex = /(?:^|\s)(@[a-zA-Z0-9_-]+)/g;
                const mentionRegex = /(?<![a-zA-Z0-9_-])@([a-zA-Z0-9_-]+)/g;

                const allChannelPosts = Object.entries(allPosts)
                    // .filter(([key, value]) => value.create_at > Date.now() - span)
                    .reduce((bef, [key, value]) => {
                        // ポストした人のID
                        userIdSet.add(value.user_id);
                        // メンション部分を抽出
                        const mentions = value.message.match(mentionRegex)?.map((mention) => mention.trim());
                        mentions?.forEach(mention => userNameSet.add(mention.slice(1)));

                        if (value.metadata) {
                            // 絵文字、リアクションのユーザー特定
                            const preEmojiMas: { [key: string]: MattermostEmoji } = {};
                            (value.metadata.emojis || []).forEach(emoji => {
                                preEmojiMas[emoji.name] = emoji;
                                userIdSet.add(emoji.creator_id);
                            });

                            const renewEmojis: MattermostEmoji[] = [];
                            const emojiNameMas: { [key: string]: MattermostEmoji } = {};
                            (value.metadata.reactions || []).forEach(reaction => {
                                if (reaction.emoji_name in emojiNameMas) {
                                } else {
                                    // 扱いやすいようにemojisに注入しておく。
                                    emojiNameMas[reaction.emoji_name] = {
                                        id: preEmojiMas[reaction.emoji_name]?.id || '',
                                        name: reaction.emoji_name,
                                        reactions: [],
                                        reactions_text: '', create_at: 0, update_at: 0, delete_at: 0, creator_id: '',
                                    };
                                    renewEmojis.push(emojiNameMas[reaction.emoji_name]);
                                }
                                emojiNameMas[reaction.emoji_name].reactions?.push({ user_id: reaction.user_id, nickname: '' });
                                userIdSet.add(reaction.user_id);
                            });
                            // 整形したemojiで上書き。
                            value.metadata.emojis = renewEmojis;
                        } else { }

                        if (value.channel_id in bef) {
                        } else {
                            bef[value.channel_id] = [];
                        }
                        bef[value.channel_id].push(value);
                        return bef;
                    }, {} as { [key: string]: Post[] });

                // ----------------------
                const ids = Array.from(userIdSet);
                const names = Array.from(userNameSet);

                const userRepository = ds.getRepository(MmUserEntity);
                const whereConditions = [];
                whereConditions.push({ orgKey: req.info.user.orgKey });

                if (ids.length > 0) {
                    whereConditions.push({ id: In(ids) });
                }
                if (names.length > 0) {
                    whereConditions.push({ username: In(names) });
                }
                const users = await userRepository.find({
                    where: whereConditions,
                    select: ['id', 'username', 'nickname'],
                    order: { username: 'ASC' },
                });

                // console.log(next);
                const mmUserMas = users.reduce((bef, curr) => {
                    bef[curr.id] = curr;
                    bef[curr.username] = curr; // 使い分けが面倒なのでusernameもセットで入れてしまう。どうせ被ることはないから大丈夫。
                    return bef;
                }, {} as { [key: string]: MmUserEntity });

                // メンション部分をマスタデータで置換する関数
                function replaceMentionsWithMaster(text: string): string {
                    // return text.replace(mentionRegex, (match) => {
                    //   const mention = match.trim().slice(1);
                    //   return ` <a>@${mmUserMas[mention] ? mmUserMas[mention].nickname : mention}</a> `; // マスタに存在すれば置換、なければそのまま
                    // });
                    return text.replace(mentionRegex, (match) => {
                        const mention = match.trim().slice(1);
                        // マスタに存在すれば置換、なければそのまま
                        if (mmUserMas[mention]) {
                            return ` <a>@${mmUserMas[mention].nickname}</a> `;
                        } else {
                            return `@${mention}`;
                        }
                    });
                }

                let sb = '';
                const mmSerializedPostList = [] as Post[];
                Object.entries(allChannelPosts).forEach(([channelId, posts]) => {
                    posts.forEach(post => {
                        // href="
                        post.message = post.message.replace('<a href="', '<a target="about:blank" href="');
                        post.message = replaceMentionsWithMaster(post.message);
                        // post.message = '\n' + Utils.splitCodeBlock(post.message).map((block, index) => {
                        //     if (index % 2 == 0) {
                        //         return block.split('\n').map(line => {
                        //             if (line.trim()[0] === '|' && line.trim()[line.trim().length - 1] === '|') {
                        //                 return line;
                        //             } else {
                        //                 return line + '\n';
                        //             }
                        //         }).join('\n');
                        //     } else {
                        //         return '```\n' + block.trim() + '\n```\n';
                        //     }
                        // }).join('') + '\n';

                        mmSerializedPostList.push(post);
                    });
                });

                // console.log(mmSerializedPostList.length);
                const mmGroupedSerializedPostList = [] as Post[][];
                mmSerializedPostList.sort((a, b) => a.create_at - b.create_at);
                mmSerializedPostList.map((post, index) => {
                    // console.log(mmChannelMas[post.channel_id].display_name);
                    if (post.metadata && post.metadata.emojis) {
                        post.metadata.emojis.forEach(emoji => {
                            emoji.reactions_text = emoji.reactions?.map(reaction => mmUserMas[reaction.user_id]?.nickname || mmUserMas[reaction.user_id]?.username).join(', ')
                        })
                    } else { }
                    const bef = mmSerializedPostList[index - 1];
                    if (bef) {
                        if (post.channel_id === bef.channel_id && post.user_id == bef.user_id && post.root_id === bef.root_id && post.create_at - bef.create_at < 1000 * 60 * 2) {
                            // 1個前のやつにくっつける
                            mmGroupedSerializedPostList[mmGroupedSerializedPostList.length - 1].push(post);
                        } else {
                            mmGroupedSerializedPostList.push([post]);
                        }
                    } else {
                        mmGroupedSerializedPostList.push([post]);
                    }
                });

                let postList = mmGroupedSerializedPostList;
                const contents: ContentPart[] = [];
                const chIds = postList.reduce((mas, curr) => {
                    mas.add(curr[0].channel_id);
                    return mas;
                }, new Set<string>());
                if (chIds.size > 1) {
                } else {
                    sb += `**channel:** ${mmChannelMas[postList[0][0].channel_id].display_name}\n\n`;
                }
                const postListAwait = await postList.map(async postsGroup => {
                    // console.log(mmChannelMas[postsGroup[0].channel_id].display_name);
                    const post = postsGroup[0];
                    sb += `***\n`;
                    if (chIds.size > 1) {
                        // 複数チャネルの場合はメッセージ毎にチャネルを書く
                        sb += `**channel:** ${mmChannelMas[post.channel_id].display_name}\n`;
                    } else { }
                    sb += `**messageId:** ${post.id}\n`;
                    if (post.root_id && post.id !== post.root_id) {
                        sb += `**rootId:** ${post.root_id}\n`;
                    }
                    sb += `**date:** ${Utils.formatDate(new Date(post.create_at))}\n`;
                    sb += `**sender:** ${mmUserMas[post.user_id]?.nickname || post.user_id} (${mmUserMas[post.user_id]?.username || post.user_id})\n`;
                    const postsGroupAwait = await postsGroup.map(async post => {
                        sb += `**message:**\n${post.message}\n\n`;
                        if (post.metadata && post.metadata.files) {
                            contents.push({ type: 'text', text: sb });
                            // console.log('text', sb.substring(0, 30).replaceAll(/\n/g, ''));
                            sb = '';
                            const files = post.metadata.files.filter(file =>
                                true // 一旦チェック無しにする
                                || file.mime_type.startsWith('image/')
                                || file.mime_type.startsWith('application/pdf')
                                || file.mime_type.startsWith('text/')
                                || file.mime_type.startsWith('audio/')
                                || file.mime_type.startsWith('video/')
                            ).map(async file => {
                                // console.log(file.mime_type, file.name);
                                if (e) {
                                    const imageUrl = `${e.uriBase}/api/v4/files/${file.id}`;
                                    const fileObj = { type: 'file', text: file.name, dataUrl: file.dataUrl || '', fileId: '' };
                                    // await掛ける前にリストに入れておかないと順序が崩れる。
                                    contents.push(fileObj as FileContentPart);
                                    // console.log(imageUrl, file.mime_type, file.dataUrl?.substring(0, 50).replaceAll(/\n/g, ''), file.dataUrl?.length, file.name);
                                    file.dataUrl = await downloadImageAsDataURL(axios, `MMAUTHTOKEN=${req.cookies.MMAUTHTOKEN}; MMUSERID=${req.cookies.MMUSERID};`, imageUrl);
                                    fileObj.dataUrl = file.dataUrl || '';
                                    (fileObj as any).postId = post.id; // postIdで紐づげグルーピングができるようにしておく
                                } else { }
                            });
                            return Promise.all(files);
                        } else {
                            return Promise.resolve(null);
                        }
                    });
                    return Promise.all(postsGroupAwait);
                });
                if (sb) {
                    contents.push({ type: 'text', text: sb });
                } else { }

                await Promise.all(postListAwait);
                return contents;
            }

            const contents = await toAi();

            // thread作成
            const savedThread = await ds.transaction(async tm => {
                const threadGroup = new ThreadGroupEntity();
                threadGroup.orgKey = req.info.user.orgKey;
                threadGroup.projectId = projectId;
                threadGroup.title = title;
                threadGroup.description = ``;
                threadGroup.visibility = ThreadGroupVisibility.Team;
                threadGroup.createdBy = req.info.user.id;
                threadGroup.updatedBy = req.info.user.id;
                threadGroup.createdIp = req.info.ip;
                threadGroup.updatedIp = req.info.ip;

                const savedThreadGroup = await tm.save(ThreadGroupEntity, threadGroup);

                // 新しいスレッドを作成
                const thread = new ThreadEntity();
                thread.orgKey = req.info.user.orgKey;
                thread.status = ThreadStatus.Normal;
                thread.threadGroupId = savedThreadGroup.id;
                thread.inDto = inDto;
                thread.createdBy = req.info.user.id;
                thread.updatedBy = req.info.user.id;
                thread.createdIp = req.info.ip;
                thread.updatedIp = req.info.ip;

                const savedThread = await tm.save(ThreadEntity, thread);

                // ------ file登録
                type FileTypeTemp = { filePath: string, base64Data: string, content: FileContentPart, postId: string, index: number };
                const contentsImageUrlList = contents
                    .filter(content => content.type === 'file')
                    .map((content, index) => ({ filePath: content.text, base64Data: (content as FileContentPart).dataUrl, content, postId: (content as any).postId, index } as FileTypeTemp));
                const fileBodyMapSet = await convertToMapSet(tm, contentsImageUrlList, req.info.user.orgKey, req.info.user.id, req.info.ip, req.info.user);


                // -----------------------------------------------
                const tokenCountFileList = Object.entries(fileBodyMapSet.hashMap).map(([sha256, value]) => {
                    if (value.fileBodyEntity) {
                        const fileBodyEntity = value.fileBodyEntity;
                        if (fileBodyEntity.tokenCount && fileBodyEntity.tokenCount['gemini-2.5-flash']) {
                            // 既にトークンカウント済みの場合はスキップ
                            // console.log(value.tokenCount['gemini-2.5-flash'] + ' tokens for ' + sha256);
                            return null;
                        } else {
                            if (value.fileType.startsWith('text/') || plainExtensions.includes(fileBodyEntity.innerPath) || plainMime.includes(fileBodyEntity.fileType) || fileBodyEntity.fileType.endsWith('+xml') || fileBodyMapSet.hashMap[sha256].base64Data.startsWith('IyEv')) {
                                // textの場合は生データを渡す
                                return { buffer: fileBodyMapSet.hashMap[sha256].buffer, fileBodyEntity: fileBodyEntity };
                            } else {
                                // それ以外はbase64データを渡す
                                return { base64Data: fileBodyMapSet.hashMap[sha256].base64Data, fileBodyEntity: fileBodyEntity };
                            }
                        }
                    } else {
                        return null;
                    }
                }).filter(Boolean);
                // { base64Data?: string, buffer?: Buffer | string, fileBodyEntity: FileBodyEntity }
                const tokenCountedFileBodyList = await geminiCountTokensByFile(tm, tokenCountFileList as any, req.info.user);
                // console.dir(tokenCountedFileBodyList.map(fileBodyEntity => fileBodyEntity.tokenCount));
                console.log(tokenCountFileList.length + ' files to tokenize');
                // -----------------------------------------------


                // console.log(fileBodyMapSet)
                // console.log(fileBodyEntityList.map(e => e.fileType), contentsImageUrlList.length, contents.length);
                const cotentsImageUrlListGroupByPostId = contentsImageUrlList.reduce((acc, curr) => {
                    if (curr.postId in acc) {
                        acc[curr.postId].push(curr);
                    } else {
                        acc[curr.postId] = [curr];
                    }
                    return acc;
                }, {} as { [postId: string]: FileTypeTemp[] });

                const fileIdFileGroupIdMap: { [fileId: string]: string } = {};
                const savedFileListList = await Promise.all(Object.entries(cotentsImageUrlListGroupByPostId).map(async ([postId, contentsImageUrlList]) => {
                    const fileGroup = new FileGroupEntity();
                    fileGroup.orgKey = req.info.user.orgKey;
                    fileGroup.type = FileGroupType.UPLOAD;
                    fileGroup.uploadedBy = req.info.user.id;
                    fileGroup.isActive = true;
                    fileGroup.label = postId;
                    // fileGroup.description = '';
                    fileGroup.projectId = projectId;
                    fileGroup.createdBy = req.info.user.id;
                    fileGroup.updatedBy = req.info.user.id;
                    fileGroup.createdIp = req.info.ip;
                    fileGroup.updatedIp = req.info.ip;
                    const savedFileGroup = await tm.save(FileGroupEntity, fileGroup);
                    return await Promise.all(contentsImageUrlList.map(async (content, index) => {
                        const file = await handleFileUpload(content.filePath, fileBodyMapSet.hashMap[fileBodyMapSet.hashList[content.index]].fileBodyEntity, projectId, req.info.user.orgKey, req.info.user.id, req.info.ip);
                        file.fileEntity.fileGroupId = savedFileGroup.id;
                        const savedFile = await tm.save(FileEntity, file.fileEntity);

                        fileIdFileGroupIdMap[savedFile.id] = savedFileGroup.id;

                        (content.content as FileContentPart).fileId = savedFile.id;

                        const fileAccess = new FileAccessEntity();
                        fileAccess.orgKey = req.info.user.orgKey;
                        fileAccess.fileId = savedFile.id;
                        fileAccess.teamId = project.teamId;
                        fileAccess.canRead = true;
                        fileAccess.canWrite = true;
                        fileAccess.canDelete = true;
                        fileAccess.createdBy = req.info.user.id;
                        fileAccess.updatedBy = req.info.user.id;
                        fileAccess.createdIp = req.info.ip;
                        fileAccess.updatedIp = req.info.ip;
                        await tm.save(FileAccessEntity, fileAccess);
                        return savedFile;
                    }))
                }));

                const savedFileList = savedFileListList.flat();
                const successCount = savedFileList.filter(file => !(file as any).error).length;
                const failureCount = savedFileList.length - successCount;

                // -------- メッセージ登録
                let messageGroup: MessageGroupEntity;
                let message: MessageEntity;

                const msgList = [
                    { role: 'system', message: [{ type: 'text', text: systemPrompt }] },
                    { role: 'user', message: contents },
                ];

                let previousMessageGroupId;
                let savedMessageGroup;
                let savedMessage;
                let updatedContentParts;
                for (const msg of msgList) {
                    // 新規作成の場合
                    messageGroup = new MessageGroupEntity();
                    messageGroup.orgKey = req.info.user.orgKey;
                    messageGroup.threadId = savedThread.id;
                    messageGroup.createdBy = req.info.user.id;
                    messageGroup.createdIp = req.info.ip;

                    messageGroup.previousMessageGroupId = previousMessageGroupId; // 変えちゃダメな気はする。
                    messageGroup.type = MessageGroupType.Single;
                    messageGroup.role = msg.role;
                    messageGroup.source = 'user';
                    const label = msg.message.filter(message => message.type === 'text').map(message => message.text).join('\n').substring(0, 250);
                    // messageGroup.label = label;

                    messageGroup.updatedBy = req.info.user.id;
                    messageGroup.updatedIp = req.info.ip;

                    // 新規作成の場合
                    message = new MessageEntity();
                    message.orgKey = req.info.user.orgKey;
                    message.createdBy = req.info.user.id;
                    message.createdIp = req.info.ip;

                    // message.cacheId = cacheId;
                    message.label = label;
                    message.updatedBy = req.info.user.id;
                    message.updatedIp = req.info.ip;

                    const savedMessageGroup = await tm.save(MessageGroupEntity, messageGroup);
                    message.messageGroupId = savedMessageGroup.id;
                    const savedMessage = await tm.save(MessageEntity, message);
                    // 
                    previousMessageGroupId = savedMessageGroup.id;

                    // ContentPartの作成、更新、削除
                    updatedContentParts = [];
                    const fileGroupIdSet = new Set();
                    for (const [index, content] of (msg.message as ContentPartEntity[]).entries()) {
                        // 新しいContentPartを作成
                        let contentPart = new ContentPartEntity();
                        contentPart.orgKey = req.info.user.orgKey;
                        contentPart.messageId = savedMessage.id;
                        contentPart.createdBy = req.info.user.id;
                        contentPart.createdIp = req.info.ip;

                        contentPart.type = content.type;
                        contentPart.updatedBy = req.info.user.id;
                        contentPart.updatedIp = req.info.ip;

                        // seqは全体通番なので無編集にする
                        // contentPart.seq = index + 1;

                        // console.log(content.type, content.text?.substring(0, 30).replaceAll(/\n/g, ''));
                        switch (content.type) {
                            case ContentPartType.TEXT:
                                // textはファイル無しなので無視
                                contentPart.text = content.text;
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
                                contentPart.text = content.text;
                                contentPart.linkId = fileIdFileGroupIdMap[(content as any).fileId || '']; // linkeIdではなくfileIdであることに注意
                                break;
                        }
                        if (content.type === ContentPartType.FILE && fileGroupIdSet.has(contentPart.linkId)) {
                            // 追加済みのファイルグループの人だったら追加しない。
                        } else {
                            contentPart = await tm.save(ContentPartEntity, contentPart);
                            updatedContentParts.push(contentPart);
                            // トークンカウントの更新
                            await geminiCountTokensByContentPart(tm, updatedContentParts, req.info.user);
                        }
                        if (content.type === ContentPartType.FILE) {
                            fileGroupIdSet.add(contentPart.linkId);
                        } else { }
                    }
                }
                return {
                    threadGroup: savedThreadGroup,
                    thread: savedThread,
                    messageGroup: savedMessageGroup,
                    message: savedMessage,
                    contentParts: updatedContentParts,
                };
            });

            res.status(200).json(savedThread);
        } catch (error) {
            console.log(JSON.stringify(error, Utils.genJsonSafer()) === '{}' ? error : JSON.stringify(error, Utils.genJsonSafer()));
            res.status((error as any).status || 500).json({ error: (error as any).message || 'Internal Server Error' });
        }
    }
];

async function downloadImageAsDataURL(axios: Axios, cookie: string, imageUrl: string): Promise<string | undefined> {
    try {
        const response = await axios.get(imageUrl, {
            responseType: 'arraybuffer', // 画像をバイナリデータとして取得
            headers: { Cookie: cookie, },
        });
        const base64Image = Buffer.from(response.data, 'binary').toString('base64'); // BufferからBase64に変換
        const mimeType = (response.headers['content-type'] || 'text/plain').split(';')[0]; // MIMEタイプを取得

        // Data URL形式に変換して返す
        return `data:${mimeType};base64,${base64Image}`;
    } catch (error) {
        console.error('画像のダウンロードに失敗しました:', error);
        return undefined;
    }
};

// =============================================
// ユーザーグループ CRUD operations
// =============================================

// 予約語リスト（Mattermostで使用されているものと衝突を避ける）
const RESERVED_HANDLES = ['all', 'here', 'channel'];

// ハンドルのバリデーション用正規表現
const HANDLE_REGEX = /^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/;

// メンバー数上限
const MAX_MEMBER_COUNT = 100;

/**
 * Mattermostのチームメンバーシップを確認するヘルパー関数
 * @param axios Axiosインスタンス
 * @param cookie 認証Cookie
 * @param teamId MattermostのチームID
 * @returns ユーザーがチームに所属しているかどうか
 */
async function checkMattermostTeamMembership(
    axios: Axios,
    cookie: string,
    teamId: string
): Promise<boolean> {
    try {
        // /api/v4/users/me/teams でユーザーが所属しているチーム一覧を取得
        const response = await axios.get('/api/v4/users/me/teams', {
            headers: { Cookie: cookie }
        });
        const teams = response.data as { id: string }[];
        return teams.some(team => team.id === teamId);
    } catch (error) {
        console.error('Failed to check team membership:', error);
        return false;
    }
}

/**
 * ユーザーグループ一覧取得
 * GET /api/v1/mattermost/:providerName/user-group
 */
export const getUserGroups = [
    param('providerName').isString().notEmpty(),
    query('teamId').optional().isString(),
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        const userId = req.info.user.id;
        const { providerName } = req.params as { providerName: string };
        const { teamId } = req.query as { teamId?: string };
        
        try {
            const userGroupRepository = ds.getRepository(MmUserGroupEntity);
            
            // 1. owner_idが認証ユーザーのpersonalグループ全て
            const personalGroups = await userGroupRepository.find({
                where: {
                    orgKey: req.info.user.orgKey,
                    ownerId: userId,
                    scope: MmUserGroupScope.Personal,
                    status: MmUserGroupStatus.Normal
                },
                order: { createdAt: 'DESC' },
            });
            
            // 2. team_idパラメータ指定時、そのチームのteamスコープグループ全て
            let teamGroups: MmUserGroupEntity[] = [];
            if (teamId) {
                teamGroups = await userGroupRepository.find({
                    where: {
                        orgKey: req.info.user.orgKey,
                        mmTeamId: teamId,
                        scope: MmUserGroupScope.Team,
                        status: MmUserGroupStatus.Normal
                    },
                    order: { createdAt: 'DESC' },
                });
            }
            
            res.json({ groups: [...personalGroups, ...teamGroups] });
        } catch (error) {
            console.error(error);
            res.status((error as any).status || 500).json({ error: (error as any).message || 'Internal Server Error' });
        }
    }
];

/**
 * ユーザーグループ作成
 * POST /api/v1/mattermost/:providerName/user-group
 */
export const createUserGroup = [
    param('providerName').isString().notEmpty(),
    body('name').isString().notEmpty().isLength({ min: 1, max: 64 }).trim(),
    body('handle').isString().notEmpty().isLength({ min: 1, max: 32 }).trim().toLowerCase(),
    body('memberIds').isArray({ min: 1, max: MAX_MEMBER_COUNT }),
    body('scope').isString().notEmpty().isIn([MmUserGroupScope.Personal, MmUserGroupScope.Team]),
    body('teamId').optional().isString(),
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        const userId = req.info.user.id;
        const { providerName } = req.params as { providerName: string };
        const { name, handle, memberIds, scope, teamId } = req.body as {
            name: string;
            handle: string;
            memberIds: string[];
            scope: MmUserGroupScope;
            teamId?: string;
        };
        
        try {
            // ハンドルのバリデーション
            if (!HANDLE_REGEX.test(handle)) {
                return res.status(400).json({
                    error: 'invalid_handle',
                    message: 'Handle must contain only lowercase letters, numbers, and hyphens. Cannot start or end with hyphen.'
                });
            }
            
            // 予約語チェック
            if (RESERVED_HANDLES.includes(handle)) {
                return res.status(400).json({
                    error: 'invalid_handle',
                    message: `Handle '${handle}' is reserved and cannot be used`
                });
            }
            
            // scope=teamの場合、teamIdは必須
            if (scope === MmUserGroupScope.Team && !teamId) {
                return res.status(400).json({
                    error: 'team_id_required',
                    message: 'team_id is required when scope is "team"'
                });
            }
            
            // scope=teamの場合、チームメンバーシップを確認
            if (scope === MmUserGroupScope.Team && teamId) {
                const provider = 'mattermost-default';
                try {
                    const e = await getExtApiClient(req.info.user.orgKey, provider);
                    const axios = await getAxios(e.uriBase);
                    const cookie = `MMAUTHTOKEN=${req.cookies.MMAUTHTOKEN}; MMUSERID=${req.cookies.MMUSERID};`;
                    const isMember = await checkMattermostTeamMembership(axios, cookie, teamId);
                    if (!isMember) {
                        return res.status(403).json({
                            error: 'forbidden',
                            message: 'You are not a member of the specified team'
                        });
                    }
                } catch (error) {
                    return res.status(401).json({ error: 'Mattermost authentication failed' });
                }
            }
            
            // member_idsの重複排除
            const uniqueMemberIds = [...new Set(memberIds)];
            if (uniqueMemberIds.length === 0) {
                return res.status(400).json({
                    error: 'invalid_member_ids',
                    message: 'At least one member is required'
                });
            }
            if (uniqueMemberIds.length > MAX_MEMBER_COUNT) {
                return res.status(400).json({
                    error: 'invalid_member_ids',
                    message: `Member count cannot exceed ${MAX_MEMBER_COUNT}`
                });
            }
            
            const userGroupRepository = ds.getRepository(MmUserGroupEntity);
            
            // ハンドル重複チェック
            let existingGroup: MmUserGroupEntity | null = null;
            if (scope === MmUserGroupScope.Personal) {
                existingGroup = await userGroupRepository.findOne({
                    where: {
                        orgKey: req.info.user.orgKey,
                        ownerId: userId,
                        handle: handle,
                        scope: MmUserGroupScope.Personal,
                        status: MmUserGroupStatus.Normal
                    }
                });
            } else {
                existingGroup = await userGroupRepository.findOne({
                    where: {
                        orgKey: req.info.user.orgKey,
                        mmTeamId: teamId,
                        handle: handle,
                        scope: MmUserGroupScope.Team,
                        status: MmUserGroupStatus.Normal
                    }
                });
            }
            
            if (existingGroup) {
                return res.status(409).json({
                    error: 'handle_already_exists',
                    message: `The handle '${handle}' is already in use`
                });
            }
            
            // 新規グループ作成
            const userGroup = new MmUserGroupEntity();
            userGroup.orgKey = req.info.user.orgKey;
            userGroup.name = name;
            userGroup.handle = handle;
            userGroup.memberIds = uniqueMemberIds;
            userGroup.ownerId = userId;
            userGroup.scope = scope;
            userGroup.mmTeamId = scope === MmUserGroupScope.Team ? teamId : undefined;
            userGroup.status = MmUserGroupStatus.Normal;
            userGroup.createdBy = userId;
            userGroup.updatedBy = userId;
            userGroup.createdIp = req.info.ip;
            userGroup.updatedIp = req.info.ip;
            
            const savedGroup = await userGroupRepository.save(userGroup);
            
            res.status(201).json(savedGroup);
        } catch (error) {
            console.error(error);
            res.status((error as any).status || 500).json({ error: (error as any).message || 'Internal Server Error' });
        }
    }
];

/**
 * ユーザーグループ更新
 * PUT /api/v1/mattermost/:providerName/user-group/:id
 */
export const updateUserGroup = [
    param('providerName').isString().notEmpty(),
    param('id').isUUID(),
    body('name').optional().isString().isLength({ min: 1, max: 64 }).trim(),
    body('handle').optional().isString().isLength({ min: 1, max: 32 }).trim().toLowerCase(),
    body('memberIds').optional().isArray({ min: 1, max: MAX_MEMBER_COUNT }),
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        const userId = req.info.user.id;
        const { providerName, id } = req.params as { providerName: string; id: string };
        const { name, handle, memberIds } = req.body as {
            name?: string;
            handle?: string;
            memberIds?: string[];
        };
        
        try {
            const userGroupRepository = ds.getRepository(MmUserGroupEntity);
            
            // グループ取得
            const group = await userGroupRepository.findOne({
                where: {
                    orgKey: req.info.user.orgKey,
                    id: id,
                    status: MmUserGroupStatus.Normal
                }
            });
            
            if (!group) {
                return res.status(404).json({
                    error: 'not_found',
                    message: 'User group not found'
                });
            }
            
            // 権限チェック
            if (group.scope === MmUserGroupScope.Personal) {
                // personalスコープ: owner_idが認証ユーザーと一致するか
                if (group.ownerId !== userId) {
                    return res.status(403).json({
                        error: 'forbidden',
                        message: 'You do not have permission to update this group'
                    });
                }
            } else {
                // teamスコープ: チームメンバーシップを確認
                const provider = 'mattermost-default';
                try {
                    const e = await getExtApiClient(req.info.user.orgKey, provider);
                    const axios = await getAxios(e.uriBase);
                    const cookie = `MMAUTHTOKEN=${req.cookies.MMAUTHTOKEN}; MMUSERID=${req.cookies.MMUSERID};`;
                    const isMember = await checkMattermostTeamMembership(axios, cookie, group.mmTeamId!);
                    if (!isMember) {
                        return res.status(403).json({
                            error: 'forbidden',
                            message: 'You are not a member of the team and cannot update this group'
                        });
                    }
                } catch (error) {
                    return res.status(401).json({ error: 'Mattermost authentication failed' });
                }
            }
            
            // ハンドル変更時のバリデーション
            if (handle && handle !== group.handle) {
                if (!HANDLE_REGEX.test(handle)) {
                    return res.status(400).json({
                        error: 'invalid_handle',
                        message: 'Handle must contain only lowercase letters, numbers, and hyphens. Cannot start or end with hyphen.'
                    });
                }
                
                if (RESERVED_HANDLES.includes(handle)) {
                    return res.status(400).json({
                        error: 'invalid_handle',
                        message: `Handle '${handle}' is reserved and cannot be used`
                    });
                }
                
                // 重複チェック
                let existingGroup: MmUserGroupEntity | null = null;
                if (group.scope === MmUserGroupScope.Personal) {
                    existingGroup = await userGroupRepository.findOne({
                        where: {
                            orgKey: req.info.user.orgKey,
                            ownerId: userId,
                            handle: handle,
                            scope: MmUserGroupScope.Personal,
                            status: MmUserGroupStatus.Normal,
                            id: Not(id)
                        }
                    });
                } else {
                    existingGroup = await userGroupRepository.findOne({
                        where: {
                            orgKey: req.info.user.orgKey,
                            mmTeamId: group.mmTeamId,
                            handle: handle,
                            scope: MmUserGroupScope.Team,
                            status: MmUserGroupStatus.Normal,
                            id: Not(id)
                        }
                    });
                }
                
                if (existingGroup) {
                    return res.status(409).json({
                        error: 'handle_already_exists',
                        message: `The handle '${handle}' is already in use`
                    });
                }
                
                group.handle = handle;
            }
            
            // 更新
            if (name) {
                group.name = name;
            }
            
            if (memberIds) {
                const uniqueMemberIds = [...new Set(memberIds)];
                if (uniqueMemberIds.length === 0) {
                    return res.status(400).json({
                        error: 'invalid_member_ids',
                        message: 'At least one member is required'
                    });
                }
                if (uniqueMemberIds.length > MAX_MEMBER_COUNT) {
                    return res.status(400).json({
                        error: 'invalid_member_ids',
                        message: `Member count cannot exceed ${MAX_MEMBER_COUNT}`
                    });
                }
                group.memberIds = uniqueMemberIds;
            }
            
            group.updatedBy = userId;
            group.updatedIp = req.info.ip;
            
            const savedGroup = await userGroupRepository.save(group);
            
            res.status(200).json(savedGroup);
        } catch (error) {
            console.error(error);
            res.status((error as any).status || 500).json({ error: (error as any).message || 'Internal Server Error' });
        }
    }
];

/**
 * ユーザーグループ削除
 * DELETE /api/v1/mattermost/:providerName/user-group/:id
 */
export const deleteUserGroup = [
    param('providerName').isString().notEmpty(),
    param('id').isUUID(),
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        const userId = req.info.user.id;
        const { providerName, id } = req.params as { providerName: string; id: string };
        
        try {
            const userGroupRepository = ds.getRepository(MmUserGroupEntity);
            
            // グループ取得
            const group = await userGroupRepository.findOne({
                where: {
                    orgKey: req.info.user.orgKey,
                    id: id,
                    status: MmUserGroupStatus.Normal
                }
            });
            
            if (!group) {
                return res.status(404).json({
                    error: 'not_found',
                    message: 'User group not found'
                });
            }
            
            // 権限チェック
            if (group.scope === MmUserGroupScope.Personal) {
                // personalスコープ: owner_idが認証ユーザーと一致するか
                if (group.ownerId !== userId) {
                    return res.status(403).json({
                        error: 'forbidden',
                        message: 'You do not have permission to delete this group'
                    });
                }
            } else {
                // teamスコープ: チームメンバーシップを確認
                const provider = 'mattermost-default';
                try {
                    const e = await getExtApiClient(req.info.user.orgKey, provider);
                    const axios = await getAxios(e.uriBase);
                    const cookie = `MMAUTHTOKEN=${req.cookies.MMAUTHTOKEN}; MMUSERID=${req.cookies.MMUSERID};`;
                    const isMember = await checkMattermostTeamMembership(axios, cookie, group.mmTeamId!);
                    if (!isMember) {
                        return res.status(403).json({
                            error: 'forbidden',
                            message: 'You are not a member of the team and cannot delete this group'
                        });
                    }
                } catch (error) {
                    return res.status(401).json({ error: 'Mattermost authentication failed' });
                }
            }
            
            // 論理削除
            group.status = MmUserGroupStatus.Deleted;
            group.updatedBy = userId;
            group.updatedIp = req.info.ip;
            
            await userGroupRepository.save(group);
            
            res.status(204).send();
        } catch (error) {
            console.error(error);
            res.status((error as any).status || 500).json({ error: (error as any).message || 'Internal Server Error' });
        }
    }
];


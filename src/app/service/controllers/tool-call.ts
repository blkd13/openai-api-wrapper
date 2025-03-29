import { Request, Response } from "express";
import { body, param, query } from "express-validator";

import { UserRequest } from "../models/info.js";
import { ProjectEntity, TeamMemberEntity } from "../entity/project-models.entity.js";
import { validationErrorHandler } from "../middleware/validation.js";
import { ds } from "../db.js";
import { functionDefinitions } from '../tool/_index.js';
import { ToolCallPartEntity, ToolCallGroupEntity, ToolCallPartStatus, ToolCallPart, ToolCallPartInfoBody, ToolCallPartCallBody, ToolCallPartCommandBody, ToolCallPartResultBody, ToolCallPartType } from "../entity/tool-call.entity.js";
import { ProjectVisibility } from "../models/values.js";
import { EntityNotFoundError } from "typeorm/index.js";

import crypto from 'crypto';
import { OAuthAccountEntity, OAuthAccountStatus } from "../entity/auth.entity.js";
import { readOAuth2Env } from "./auth.js";
import { Utils } from "../../common/utils.js";
import { getAxios } from "../../common/http-client.js";


const { API_KEY_HAND_REGISTRATION_PROVIDERS, ENCRYPTION_KEY } = process.env as { API_KEY_HAND_REGISTRATION_PROVIDERS: string, ENCRYPTION_KEY: string };

export const getFunctionDefinitions = [
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        // 汚い。。。
        const funcDefs = await functionDefinitions({ inDto: { args: {} as any }, messageSet: { messageGroup: {} as any, message: {} as any, contentParts: [] } as any } as any, req, null as any, 'dummy', 'dummy', null as any, 'dummy');
        res.json(funcDefs.map(f => {
            f.info.name = f.definition.function.name;
            return ({ info: f.info, definition: f.definition });
        }));
    }
];



export interface ToolCallSet {
    toolCallGroupId: string;
    toolCallId: string;

    info: ToolCallPartInfoBody;
    call: ToolCallPartCallBody;
    commandList: ToolCallPartCommandBody[];
    resultList: ToolCallPartResultBody[];
}


export function toolCallListToToolCallSetList(toolCallList: ToolCallPart[]): ToolCallSet[] {
    const toolCallSetList: ToolCallSet[] = [];
    toolCallList.forEach(toolCall => appendToolCallPart(toolCallSetList, toolCall));
    return toolCallSetList;
}

export function appendToolCallPart(toolCallSetList: ToolCallSet[], toolCallPart: ToolCallPart): ToolCallSet[] {
    const masterToolCallPart = toolCallSetList.find(toolCallSet => toolCallSet.toolCallId === toolCallPart.toolCallId) || {
        toolCallGroupId: toolCallPart.toolCallGroupId,
        toolCallId: toolCallPart.toolCallId,
        info: null as any as ToolCallPartInfoBody,
        call: null as any as ToolCallPartCallBody,
        commandList: [] as ToolCallPartCommandBody[],
        resultList: [] as ToolCallPartResultBody[],
    } as ToolCallSet;
    if (masterToolCallPart.info) {
    } else {
        toolCallSetList.push(masterToolCallPart);
    }
    // id系が合ったら追加しておく
    masterToolCallPart.toolCallGroupId = masterToolCallPart.toolCallGroupId || toolCallPart.toolCallGroupId || '';
    masterToolCallPart.toolCallId = masterToolCallPart.toolCallId || toolCallPart.toolCallId;
    switch (toolCallPart.type) {
        case ToolCallPartType.INFO:
            masterToolCallPart.info = toolCallPart.body;
            break;
        case ToolCallPartType.CALL:
            masterToolCallPart.call = toolCallPart.body;
            break;
        case ToolCallPartType.COMMAND:
            masterToolCallPart.commandList.push(toolCallPart.body);
            break;
        case ToolCallPartType.RESULT:
            masterToolCallPart.resultList.push(toolCallPart.body);
            break;
    }
    return toolCallSetList;
}


export const getToolCallGroup = [
    param('id').trim().notEmpty(),
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        const { id } = req.params as { id: string };
        // connectionIdはクライアントで発番しているので、万が一にも混ざらないようにユーザーIDを付与。

        try {
            // ツールコールグループの取得
            const toolCallGroup = await ds.getRepository(ToolCallGroupEntity).findOneOrFail({
                where: { id }
            });

            // プロジェクトの取得
            const project = await ds.getRepository(ProjectEntity).findOneOrFail({
                where: { id: toolCallGroup.projectId }
            });

            const teamMember = await ds.getRepository(TeamMemberEntity).findOne({
                where: {
                    teamId: project.teamId,
                    userId: req.info.user.id,
                }
            });

            if (!teamMember && project.visibility !== ProjectVisibility.Public) {
                throw new Error('このスレッドのメッセージを閲覧する権限がありません');
            }

            // ツールコールの取得
            const toolCallList = await ds.getRepository(ToolCallPartEntity).find({
                where: { toolCallGroupId: id, status: ToolCallPartStatus.Normal },
                order: { seq: 'ASC' },
            });

            (toolCallGroup as ToolCallGroupEntity & { toolCallList: ToolCallPartEntity[] }).toolCallList = toolCallList;
            res.json(toolCallGroup);
        } catch (error) {
            if (error instanceof EntityNotFoundError) {
                res.status(404).json({ message: 'ツールコールグループが見つかりません' });
            } else if ((error as any).message === 'このスレッドのメッセージを閲覧する権限がありません') {
                res.status(403).json({ message: (error as any).message });
            } else {
                res.status(500).json({ message: 'メッセージグループリストの取得中にエラーが発生しました' });
            }
        }
    }
];
export const getToolCallGroupByToolCallId = [
    param('id').trim().notEmpty(),
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        const { id } = req.params as { id: string };
        // connectionIdはクライアントで発番しているので、万が一にも混ざらないようにユーザーIDを付与。

        try {
            // ツールコールグループの取得
            const toolCallPart = await ds.getRepository(ToolCallPartEntity).find({
                where: { toolCallId: id, status: ToolCallPartStatus.Normal },
                order: { seq: 'ASC' },
            });

            const toolCallGroupIdSet = Array.from(new Set(toolCallPart.map(t => t.toolCallGroupId)));
            if (toolCallGroupIdSet.length !== 1) {
                throw new Error('このスレッドのメッセージを閲覧する権限がありません');
            }

            // ツールコールグループの取得
            const toolCallGroup = await ds.getRepository(ToolCallGroupEntity).findOneOrFail({
                where: { id: toolCallGroupIdSet[0] }
            });

            // プロジェクトの取得
            const project = await ds.getRepository(ProjectEntity).findOneOrFail({
                where: { id: toolCallGroup.projectId }
            });

            const teamMember = await ds.getRepository(TeamMemberEntity).findOne({
                where: {
                    teamId: project.teamId,
                    userId: req.info.user.id,
                }
            });

            if (!teamMember && project.visibility !== ProjectVisibility.Public) {
                throw new Error('このスレッドのメッセージを閲覧する権限がありません');
            }

            // ツールコールの取得
            const toolCallList = await ds.getRepository(ToolCallPartEntity).find({
                where: { toolCallId: id, status: ToolCallPartStatus.Normal },
                order: { seq: 'ASC' },
            });

            (toolCallGroup as ToolCallGroupEntity & { toolCallList: ToolCallPartEntity[] }).toolCallList = toolCallList;
            res.json(toolCallGroup);
        } catch (error) {
            if (error instanceof EntityNotFoundError) {
                res.status(404).json({ message: 'ツールコールグループが見つかりません' });
            } else if ((error as any).message === 'このスレッドのメッセージを閲覧する権限がありません') {
                res.status(403).json({ message: (error as any).message });
            } else {
                res.status(500).json({ message: 'メッセージグループリストの取得中にエラーが発生しました' });
            }
        }
    }
];

export const getApiKeys = [
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        try {
            const apiKeys = await ds.getRepository(OAuthAccountEntity).find({
                select: ['id', 'provider', 'providerUserId', 'providerEmail', 'tokenExpiresAt', 'createdAt', 'updatedAt'],
                where: { userId: req.info.user.id },
                order: { createdAt: 'DESC' }
            });
            res.json(apiKeys);
        } catch (error) {
            console.error('API key fetch error:', error);
            res.status(500).json({ message: 'APIキーの取得中にエラーが発生しました' });
        }
    }
];

export const registApiKey = [
    param('provider').trim().notEmpty().isIn(Object.values((API_KEY_HAND_REGISTRATION_PROVIDERS || 'blank').split(','))),
    body('accessToken').trim().notEmpty().isString(),
    body('refreshToken'),
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        const { provider, accessToken, refreshToken } = req.body;

        try {
            await ds.transaction(async (manager) => {
                const apiKeys = await manager.getRepository(OAuthAccountEntity).find({
                    where: { provider, userId: req.info.user.id }
                });
                const apiKey = new OAuthAccountEntity();
                if (apiKeys.length === 1) {
                    apiKey.id = apiKeys[0].id;
                } else {
                    apiKey.createdBy = req.info.user.id;
                    apiKey.createdIp = req.info.ip;
                }

                const e = readOAuth2Env(provider);
                const url = `${e.uriBase}${e.pathUserInfo}`;
                console.log(url);
                const axios = await getAxios(url);
                const axiosResponse = (await axios.get(url, {
                    headers: { 'Authorization': `Bearer ${accessToken}`, }
                }));
                const result = axiosResponse.data;
                if (result.username) {
                } else {
                    throw new Error('API鍵が無効です');
                }

                apiKey.userId = req.info.user.id;
                apiKey.provider = provider;
                apiKey.providerUserId = req.info.user.id;
                apiKey.providerEmail = req.info.user.email;
                apiKey.accessToken = encrypt(accessToken);
                if (refreshToken) {
                    apiKey.refreshToken = encrypt(refreshToken);
                } else { }
                // apiKey.tokenExpiresAt = new Date(0); // 有効期限なし
                apiKey.userInfo = JSON.stringify(result); // 今のところ使っていない
                apiKey.status = OAuthAccountStatus.ACTIVE;
                apiKey.updatedBy = req.info.user.id;
                apiKey.updatedIp = req.info.ip;

                const savedApiKey = await ds.getRepository(OAuthAccountEntity).save(apiKey);

                // キーの値自体は返さない
                const safeApiKey = {
                    id: savedApiKey.id,
                    provider: savedApiKey.provider,
                    providerUserId: savedApiKey.providerUserId,
                    providerEmail: savedApiKey.providerEmail,
                    tokenExpiresAt: savedApiKey.tokenExpiresAt,
                    createdAt: savedApiKey.createdAt,
                    updatedAt: savedApiKey.updatedAt,
                };
                res.status(201).json(safeApiKey);
            });
        } catch (error) {
            // console.error('API key creation error:', error);
            res.status(500).json({ message: 'APIキーの作成中にエラーが発生しました', detail: Utils.errorFormat(error, true) });
        }
    }
];

export const deleteApiKey = [
    param('provider').trim().notEmpty(),
    param('id').trim().notEmpty(),
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        const { provider, id } = req.params;
        try {
            await ds.transaction(async (manager) => {
                const apiKey = await manager.getRepository(OAuthAccountEntity).findOneOrFail({
                    where: { id, provider, userId: req.info.user.id }
                });
                apiKey.status = OAuthAccountStatus.DISCONNECTED;
                await manager.getRepository(OAuthAccountEntity).save(apiKey);
            });
            res.status(204).send();
        } catch (error) {
            if (error instanceof EntityNotFoundError) {
                res.status(404).json({ message: 'APIキーが見つかりません' });
            } else {
                console.error('API key deletion error:', error);
                res.status(500).json({ message: 'APIキーの削除中にエラーが発生しました' });
            }
        }
    }
];

const IV_LENGTH = 16;

export function encrypt(text: string): string {
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(ENCRYPTION_KEY), iv);
    let encrypted = cipher.update(text);
    encrypted = Buffer.concat([encrypted, cipher.final()]);
    return iv.toString('hex') + ':' + encrypted.toString('hex');
}

export function decrypt(text: string): string {
    const [ivHex, encryptedHex] = text.split(':');
    const iv = Buffer.from(ivHex, 'hex');
    const encrypted = Buffer.from(encryptedHex, 'hex');
    const decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(ENCRYPTION_KEY), iv);
    let decrypted = decipher.update(encrypted);
    decrypted = Buffer.concat([decrypted, decipher.final()]);
    return decrypted.toString();
}


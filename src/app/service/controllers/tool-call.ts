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
import { OAuthAccountEntity, OAuthAccountStatus, OrganizationEntity } from "../entity/auth.entity.js";
import { ExtApiClient, getExtApiClient } from "./auth.js";
import { Utils } from "../../common/utils.js";
import { getAxios } from "../../common/http-client.js";
import { ChatCompletionCreateParamsStreaming } from "openai/resources.js";


const { ENCRYPTION_KEY } = process.env as { ENCRYPTION_KEY: string };

export const getFunctionDefinitions = [
    query('connectedOnly').optional().isBoolean().toBoolean(),
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        const { connectedOnly } = _req.query as { connectedOnly?: boolean };
        // 汚い。。。
        const funcDefs = await functionDefinitions({ inDto: { args: {} as any }, messageSet: { messageGroup: {} as any, message: {} as any, contentParts: [] } as any } as any, req, null as any, 'dummy', 'dummy', null as any, 'dummy', connectedOnly);
        res.json(funcDefs.map(f => {
            f.info.name = f.definition.function.name;
            return ({ info: f.info, definition: f.definition });
        }));
    }
];

export const callFunction = [
    body('function_name').trim().notEmpty(),
    body('parameters').optional().isObject(),
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        console.log('callFunction called');
        try {
            console.dir(_req.body);
            // 汚い。。。
            const args = { model: 'gemini-1.5-flash', messages: [], stream: true, } as ChatCompletionCreateParamsStreaming;
            const funcDefs = await functionDefinitions({ inDto: { args }, messageSet: { messageGroup: {} as any, message: {} as any, contentParts: [] } as any } as any, req, null as any, 'dummy', 'dummy', null as any, 'dummy');
            const funcDef = funcDefs.find(f => f.info.name === _req.body.function_name);
            if (!funcDef) {
                console.error(`Function not found: ${_req.body.function_name}`);
                res.status(400).json({ message: '指定された関数が見つかりません' });
                return;
            }

            const result = await funcDef.handler(req.body.parameters).then(res => {
                console.log('LOG:--------------------');
                console.dir(res);
                return res;
            }).catch(error => {
                // handler実行時の非同期エラーをキャッチする
                console.error(`error-----------------------`);
                console.error(error);
                return { isError: true, error: Utils.errorFormattedObject(error, false) };
            });

            res.status(201).json(result);
        } catch (error) {
            console.error('Error in callFunction:', error);
            if (error instanceof EntityNotFoundError) {
                res.status(404).json({ message: 'ツールコールが見つかりません' });
            } else {
                res.status(500).json({ message: 'ツールコールの実行中にエラーが発生しました', detail: Utils.errorFormat(error, true) });
            }
        }
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
                where: { orgKey: req.info.user.orgKey, id }
            });

            // プロジェクトの取得
            const project = await ds.getRepository(ProjectEntity).findOneOrFail({
                where: { orgKey: req.info.user.orgKey, id: toolCallGroup.projectId }
            });

            const teamMember = await ds.getRepository(TeamMemberEntity).findOne({
                where: {
                    orgKey: req.info.user.orgKey,
                    teamId: project.teamId,
                    userId: req.info.user.id,
                }
            });

            if (!teamMember && project.visibility !== ProjectVisibility.Public) {
                throw new Error('このスレッドのメッセージを閲覧する権限がありません');
            }

            // ツールコールの取得
            const toolCallList = await ds.getRepository(ToolCallPartEntity).find({
                where: { orgKey: req.info.user.orgKey, toolCallGroupId: id, status: ToolCallPartStatus.Normal },
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
                where: { orgKey: req.info.user.orgKey, toolCallId: id, status: ToolCallPartStatus.Normal },
                order: { seq: 'ASC' },
            });

            const toolCallGroupIdSet = Array.from(new Set(toolCallPart.map(t => t.toolCallGroupId)));
            if (toolCallGroupIdSet.length !== 1) {
                throw new Error('このスレッドのメッセージを閲覧する権限がありません');
            }

            // ツールコールグループの取得
            const toolCallGroup = await ds.getRepository(ToolCallGroupEntity).findOneOrFail({
                where: { orgKey: req.info.user.orgKey, id: toolCallGroupIdSet[0] }
            });

            // プロジェクトの取得
            const project = await ds.getRepository(ProjectEntity).findOneOrFail({
                where: { orgKey: req.info.user.orgKey, id: toolCallGroup.projectId }
            });

            const teamMember = await ds.getRepository(TeamMemberEntity).findOne({
                where: {
                    orgKey: req.info.user.orgKey,
                    teamId: project.teamId,
                    userId: req.info.user.id,
                }
            });

            if (!teamMember && project.visibility !== ProjectVisibility.Public) {
                throw new Error('このスレッドのメッセージを閲覧する権限がありません');
            }

            // ツールコールの取得
            const toolCallList = await ds.getRepository(ToolCallPartEntity).find({
                where: { orgKey: req.info.user.orgKey, toolCallId: id, status: ToolCallPartStatus.Normal },
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
                select: ['orgKey', 'id', 'provider', 'providerUserId', 'providerEmail', 'tokenExpiresAt', 'createdAt', 'updatedAt'],
                where: { orgKey: req.info.user.orgKey, userId: req.info.user.id },
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
    param('provider').trim().notEmpty(),
    body('accessToken').trim().notEmpty().isString(),
    body('refreshToken'),
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        const { provider, accessToken, refreshToken } = req.body;

        try {
            await ds.transaction(async (manager) => {
                const apiKeys = await manager.getRepository(OAuthAccountEntity).find({
                    where: { orgKey: req.info.user.orgKey, provider, userId: req.info.user.id }
                });
                let apiKey;
                if (apiKeys.length === 1) {
                    apiKey = apiKeys[0];
                } else {
                    apiKey = new OAuthAccountEntity();
                    apiKey.orgKey = req.info.user.orgKey;
                    apiKey.createdBy = req.info.user.id;
                    apiKey.createdIp = req.info.ip;
                }

                const e = {} as ExtApiClient;
                try {
                    Object.assign(e, await getExtApiClient(req.info.user.orgKey, provider));
                } catch (error) {
                    res.status(401).json({ error: `${provider}は認証されていません。` });
                    return;
                }

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
                    where: { orgKey: req.info.user.orgKey, id, provider, userId: req.info.user.id }
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


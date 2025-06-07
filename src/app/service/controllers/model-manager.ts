import { Request, Response } from 'express';
import { param, body, query } from 'express-validator';
import { In, Not, Or } from 'typeorm';

import { AIProviderType, AIModelEntity, AIModelPricingEntity, AIModelStatus, AIModelAlias, AIProviderEntity, ScopeType, OrganizationEntity, DivisionEntity, UserEntity, UserStatus, UserRoleType, AIProviderTemplateEntity } from '../entity/auth.entity.js';
import { validationErrorHandler } from '../middleware/validation.js';
import { ds } from '../db.js';
import { UserRequest } from '../models/info.js';

/**
 * [GET] AIProvider 一覧取得
 */
export const getAIProviderTemplates = [
    query('provider').optional().isString(),
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        try {
            const { provider, scopeType, providerId } = req.query as {
                provider?: string,
                scopeType?: string,
                providerId?: string
            };

            const where: any = {
                orgKey: req.info.user.orgKey,
                isActive: true,
            };

            if (providerId) where.id = providerId;
            if (provider) where.provider = provider;
            if (scopeType) where['scopeInfo.scopeType'] = scopeType;

            const providers = await ds.getRepository(AIProviderTemplateEntity).find({
                where,
                order: { createdAt: 'DESC' }
            });

            res.status(200).json(providers);
        } catch (error) {
            console.error('Error fetching AIProviders:', error);
            res.status(500).json({ message: 'AIProvider一覧の取得に失敗しました' });
        }
    }
];

/**
 * [POST/PUT] AIProvider 作成または更新 (Upsert)
 */
export const upsertAIProviderTemplate = [
    param('providerId').optional({ nullable: true }).isUUID(),
    body('provider').isIn(Object.values(AIProviderType)),
    body('label').isString().notEmpty(),
    body('scopeInfo.scopeType').isIn(Object.values(ScopeType)),
    // body('scopeInfo.scopeId').isString().notEmpty(),
    body('metadata').optional({ nullable: true }),
    body('isActive').isBoolean(),
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        try {
            const repo = ds.getRepository(AIProviderTemplateEntity);
            const bodyData = req.body as AIProviderTemplateEntity;
            console.dir('upsertAIProvider bodyData:');
            console.dir(bodyData);
            const { providerId } = req.params;
            let entity: AIProviderTemplateEntity | null = null;
            let isNew = true;

            // 既存レコードチェック
            if (providerId) {
                entity = await repo.findOneBy({
                    orgKey: req.info.user.orgKey,
                    id: providerId,
                });
                if (entity) isNew = false;
            } else { }

            let scopeId;
            if (bodyData.scopeInfo.scopeType === ScopeType.ORGANIZATION) {
                const org = await ds.getRepository(OrganizationEntity).findOneBy({
                    orgKey: req.info.user.orgKey,
                });
                if (!org) {
                    return res.status(400).json({ message: '指定された組織が見つかりません' });
                }
                scopeId = org.id;
            } else if (bodyData.scopeInfo.scopeType === ScopeType.DIVISION) {
                const divisionRoles = req.info.user.roleList.filter(role => role.scopeInfo.scopeType === ScopeType.DIVISION && [UserRoleType.Admin, UserRoleType.Maintainer].includes(role.role));
                const division = await ds.getRepository(DivisionEntity).findOneBy({
                    orgKey: req.info.user.orgKey,
                });

                if (!division) {
                    return res.status(400).json({ message: '指定された部門が見つかりません' });
                }
                scopeId = division.id;
            } else if (bodyData.scopeInfo.scopeType === ScopeType.USER) {
                scopeId = req.info.user.id;
            }

            // 一意制約チェック: organization + scopeInfo + provider
            const conflict = await repo.findOneBy({
                provider: bodyData.provider,
                orgKey: req.info.user.orgKey,
                scopeInfo: {
                    scopeType: bodyData.scopeInfo.scopeType,
                    scopeId: scopeId,
                },
                ...(isNew ? {} : { id: Not(providerId) })
            });

            if (conflict) {
                return res.status(409).json({
                    message: `同じスコープと${bodyData.provider}のプロバイダーが既に存在します`
                });
            } else { }

            if (isNew) {
                // 新規作成
                entity = repo.create({
                    provider: bodyData.provider,
                    label: bodyData.label,
                    scopeInfo: {
                        scopeType: bodyData.scopeInfo.scopeType,
                        scopeId: scopeId,
                    },
                    metadata: bodyData.metadata,
                    isActive: bodyData.isActive ?? true,
                });
            } else {
                // 更新 - 必須フィールド
                Object.assign(entity!, {
                    provider: bodyData.provider,
                    label: bodyData.label,
                    scopeInfo: {
                        scopeType: bodyData.scopeInfo.scopeType,
                        scopeId: scopeId,
                    },
                    isActive: bodyData.isActive,
                });
            }

            // オプショナルフィールドの設定
            if ('metadata' in bodyData) entity!.metadata = bodyData.metadata;

            // 共通フィールドの設定
            entity!.orgKey = req.info.user.orgKey;
            entity!.updatedBy = req.info.user.id;
            entity!.updatedIp = req.info.ip;

            // createdBy, createdAtは新規作成時のみ設定
            if (isNew) {
                entity!.createdBy = req.info.user.id;
                entity!.createdIp = req.info.ip;
            }

            const saved = await repo.save(entity!);
            res.status(isNew ? 201 : 200).json(saved);
        } catch (error) {
            console.error('Error upserting AIProvider:', error);
            res.status(500).json({ message: 'AIProviderの保存に失敗しました' });
        }
    }
];

/**
 * [DELETE] AIProvider 論理削除
 */
export const deleteAIProviderTemplate = [
    param('providerId').isUUID(),
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        try {
            const { providerId } = req.params;
            const repo = ds.getRepository(AIProviderTemplateEntity);
            const entity = await repo.findOne({
                where: {
                    id: providerId,
                    orgKey: req.info.user.orgKey
                }
            });

            if (!entity) {
                return res.status(404).json({ message: 'AIProviderが見つかりません' });
            }

            // 論理削除
            entity.isActive = false;
            entity.updatedBy = req.info.user.id;
            entity.updatedIp = req.info.ip;
            await repo.save(entity);

            res.status(204).send();
        } catch (error) {
            console.error('Error deleting AIProvider:', error);
            res.status(500).json({ message: 'AIProviderの削除に失敗しました' });
        }
    }
];






/**
 * [GET] AIProvider 一覧取得
 */
export const getAIProviders = [
    query('provider').optional().isString(),
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        try {
            const { provider, scopeType, providerId } = req.query as {
                provider?: string,
                scopeType?: string,
                providerId?: string
            };

            const where: any = {
                orgKey: req.info.user.orgKey,
                isActive: true,
            };

            if (providerId) where.id = providerId;
            if (provider) where.provider = provider;
            if (scopeType) where['scopeInfo.scopeType'] = scopeType;

            const providers = await ds.getRepository(AIProviderEntity).find({
                where,
                order: { createdAt: 'DESC' }
            });

            res.status(200).json(providers);
        } catch (error) {
            console.error('Error fetching AIProviders:', error);
            res.status(500).json({ message: 'AIProvider一覧の取得に失敗しました' });
        }
    }
];

/**
 * [POST/PUT] AIProvider 作成または更新 (Upsert)
 */
export const upsertAIProvider = [
    param('providerId').optional({ nullable: true }).isUUID(),
    body('type').isIn(Object.values(AIProviderType)),
    body('name').isString().notEmpty(),
    body('label').isString().notEmpty(),
    body('scopeInfo.scopeType').isIn(Object.values(ScopeType)),
    // body('scopeInfo.scopeId').isString().notEmpty(),
    body('config').optional({ nullable: true }),
    body('isActive').isBoolean(),
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        try {
            const repo = ds.getRepository(AIProviderEntity);
            const bodyData = req.body as AIProviderEntity;
            const { providerId } = req.params;
            let entity: AIProviderEntity | null = null;
            let isNew = true;

            // 既存レコードチェック
            if (providerId) {
                entity = await repo.findOneBy({
                    orgKey: req.info.user.orgKey,
                    id: providerId,
                });
                if (entity) isNew = false;
            } else { }

            let scopeId;
            if (bodyData.scopeInfo.scopeType === ScopeType.ORGANIZATION) {
                const org = await ds.getRepository(OrganizationEntity).findOneBy({
                    orgKey: req.info.user.orgKey,
                });
                if (!org) {
                    return res.status(400).json({ message: '指定された組織が見つかりません' });
                }
                scopeId = org.id;
            } else if (bodyData.scopeInfo.scopeType === ScopeType.DIVISION) {
                const divisionRoles = req.info.user.roleList.filter(role => role.scopeInfo.scopeType === ScopeType.DIVISION && [UserRoleType.Admin, UserRoleType.Maintainer].includes(role.role));
                const division = await ds.getRepository(DivisionEntity).findOneBy({
                    orgKey: req.info.user.orgKey,
                });

                if (!division) {
                    return res.status(400).json({ message: '指定された部門が見つかりません' });
                }
                scopeId = division.id;
            } else if (bodyData.scopeInfo.scopeType === ScopeType.USER) {
                scopeId = req.info.user.id;
            }

            // 一意制約チェック: organization + scopeInfo + provider
            const conflict = await repo.findOneBy({
                type: bodyData.type,
                name: bodyData.name,
                orgKey: req.info.user.orgKey,
                scopeInfo: {
                    scopeType: bodyData.scopeInfo.scopeType,
                    scopeId: scopeId,
                },
                ...(isNew ? {} : { id: Not(providerId) })
            });

            if (conflict) {
                return res.status(409).json({
                    message: `同じスコープと${bodyData.type},${bodyData.name}のプロバイダーが既に存在します`
                });
            } else { }

            if (isNew) {
                // 新規作成
                entity = repo.create({
                    type: bodyData.type,
                    name: bodyData.name,
                    label: bodyData.label,
                    scopeInfo: {
                        scopeType: bodyData.scopeInfo.scopeType,
                        scopeId: scopeId,
                    },
                    config: bodyData.config,
                    isActive: bodyData.isActive ?? true,
                });
            } else {
                // 更新 - 必須フィールド
                Object.assign(entity!, {
                    type: bodyData.type,
                    name: bodyData.name,
                    label: bodyData.label,
                    scopeInfo: {
                        scopeType: bodyData.scopeInfo.scopeType,
                        scopeId: scopeId,
                    },
                    isActive: bodyData.isActive,
                });
            }

            // オプショナルフィールドの設定
            if ('config' in bodyData) entity!.config = bodyData.config;

            // 共通フィールドの設定
            entity!.orgKey = req.info.user.orgKey;
            entity!.updatedBy = req.info.user.id;
            entity!.updatedIp = req.info.ip;

            // createdBy, createdAtは新規作成時のみ設定
            if (isNew) {
                entity!.createdBy = req.info.user.id;
                entity!.createdIp = req.info.ip;
            }

            const saved = await repo.save(entity!);
            res.status(isNew ? 201 : 200).json(saved);
        } catch (error) {
            console.error('Error upserting AIProvider:', error);
            res.status(500).json({ message: 'AIProviderの保存に失敗しました' });
        }
    }
];

/**
 * [DELETE] AIProvider 論理削除
 */
export const deleteAIProvider = [
    param('providerId').isUUID(),
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        try {
            const { providerId } = req.params;
            const repo = ds.getRepository(AIProviderEntity);
            const entity = await repo.findOne({
                where: {
                    id: providerId,
                    orgKey: req.info.user.orgKey
                }
            });

            if (!entity) {
                return res.status(404).json({ message: 'AIProviderが見つかりません' });
            }

            // 論理削除
            entity.isActive = false;
            entity.updatedBy = req.info.user.id;
            entity.updatedIp = req.info.ip;
            await repo.save(entity);

            res.status(204).send();
        } catch (error) {
            console.error('Error deleting AIProvider:', error);
            res.status(500).json({ message: 'AIProviderの削除に失敗しました' });
        }
    }
];






/**
 * [GET] BaseModel 一覧取得
 */
export const getBaseModels = [
    query('provider').optional().isString(),
    query('status').optional().isString(),
    query('modelId').optional().isUUID(),
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        try {
            const { provider, status, modelId } = req.query as { provider?: string, status?: string, modelId?: string };
            const where: any = {
                orgKey: req.info.user.orgKey,
                isActive: true,
            };
            if (modelId) where.id = modelId;
            if (provider) where.provider = provider;
            if (status) where.status = status;

            const models = await ds.getRepository(AIModelEntity).find({
                where,
                order: { createdAt: 'DESC' }
            });

            // エイリアスを取得
            const aliases = await ds.getRepository(AIModelAlias).find({
                where: {
                    orgKey: req.info.user.orgKey,
                    modelId: In(models.map(model => model.id))
                }
            });
            // エイリアスをモデルにマージ
            models.forEach(model => {
                (model as any).aliases = aliases.filter(alias => alias.modelId === model.id).map(alias => alias.alias);
            });

            // プライスリストを取得
            const pricingHistory = await ds.getRepository(AIModelPricingEntity).find({
                where: {
                    orgKey: req.info.user.orgKey,
                    modelId: In(models.map(model => model.id))
                },
                order: { validFrom: 'DESC' }
            });
            // プライスリストをモデルにマージ
            models.forEach(model => {
                (model as any).pricingHistory = pricingHistory.filter(pricing => pricing.modelId === model.id);
            });

            res.status(200).json(models);
        } catch (error) {
            console.error('Error fetching BaseModels:', error);
            res.status(500).json({ message: 'BaseModel一覧の取得に失敗しました' });
        }
    }
];

/**
 * [POST/PUT] BaseModel 作成または更新 (Upsert)
 */
export const upsertBaseModel = [
    param('modelId').optional({ nullable: true }).isUUID(),
    body('providerType').isIn(Object.values(AIProviderType)),
    body('providerName').isString().notEmpty(),
    body('providerModelId').isString().notEmpty(),
    body('name').isString().notEmpty(),
    body('aliases').optional({ nullable: true }).isArray(),
    body('aliases.*').isString().notEmpty(),
    body('shortName').isString().notEmpty(),
    body('throttleKey').isString().notEmpty(),
    body('status').isIn(Object.values(AIModelStatus)),
    body('modalities').isArray().notEmpty(),
    body('modalities.*').isString().notEmpty(),
    body('maxContextTokens').isInt({ gt: 0 }),
    body('maxOutputTokens').isInt({ gt: 0 }),
    body('description').optional({ nullable: true }).isString(),
    body('details').optional({ nullable: true }).isArray(),
    body('details.*').isString(),
    body('inputFormats').optional({ nullable: true }).isArray(),
    body('inputFormats.*').isString(),
    body('outputFormats').optional({ nullable: true }).isArray(),
    body('outputFormats.*').isString(),
    body('defaultParameters').optional({ nullable: true }),
    body('capabilities').optional({ nullable: true }),
    body('metadata').optional({ nullable: true }),
    body('endpointTemplate').optional({ nullable: true }).isString(),
    body('documentationUrl').optional({ nullable: true }).isURL(),
    body('licenseType').optional({ nullable: true }).isString(),
    body('knowledgeCutoff').optional({ nullable: true }).isISO8601(),
    body('releaseDate').optional({ nullable: true }).isISO8601(),
    body('deprecationDate').optional({ nullable: true }).isISO8601(),
    body('tags').optional({ nullable: true }).isArray(),
    body('tags.*').isString(),
    body('uiOrder').optional({ nullable: true }).isInt(),
    body('isStream').isBoolean(),
    body('isActive').isBoolean(),
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        try {
            const repo = ds.getRepository(AIModelEntity);
            const repoAlias = ds.getRepository(AIModelAlias);
            const bodyData = req.body as AIModelEntity;
            const aliases: string[] = req.body.aliases || [];
            const { modelId } = req.params;
            let entity: AIModelEntity | null = null;
            let isNew = true;

            // 既存レコードチェック
            if (modelId) {
                entity = await repo.findOne({ where: { id: modelId, orgKey: req.info.user.orgKey } });
                if (entity) isNew = false;
            }

            // // 一意制約チェック: provider + providerModelId
            // const conflict = await repo.findOne({
            //     where: {
            //         providerName: bodyData.providerName,
            //         providerModelId: bodyData.providerModelId,
            //         ...(isNew ? { orgKey: req.info.user.orgKey } : { id: Not(modelId), orgKey: req.info.user.orgKey })
            //     }
            // });
            // if (conflict) {
            //     console.log('Conflict:', modelId, conflict);
            //     return res.status(409).json({ message: `${bodyData.providerName} + ${bodyData.providerModelId} のモデルが既に存在します` });
            // }

            // aliasesの整備
            if (aliases.length > 0) {
                // エイリアスの重複チェック
                const uniqueAliases = new Set(aliases);
                aliases.length = 0; // 元の配列を空にする
                uniqueAliases.forEach(alias => aliases.push(alias));
            } else {
                // エイリアスが空の場合はデフォルトエイリアスを追加
                aliases.push(bodyData.providerModelId);
            }
            // const conflictAlias = await repoAlias.find({
            //     where: {
            //         providerName: bodyData.providerName,
            //         alias: In(aliases),
            //         ...(isNew ? { orgKey: req.info.user.orgKey } : { modelId: Not(modelId), orgKey: req.info.user.orgKey })
            //     }
            // });
            // if (conflictAlias && conflictAlias.length > 0) {
            //     return res.status(409).json({ message: `${bodyData.providerName} + ${conflictAlias.map(alias => alias.alias).join(', ')} のエイリアスが既に存在します` });
            // } else { }

            if (isNew) {
                // 新規作成
                entity = repo.create({
                    providerNameList: bodyData.providerNameList || [],
                    // providerType: bodyData.providerType,
                    // providerName: bodyData.providerName,
                    providerModelId: bodyData.providerModelId,
                    name: bodyData.name,
                    status: bodyData.status,
                    modalities: bodyData.modalities,
                    maxContextTokens: bodyData.maxContextTokens,
                    maxOutputTokens: bodyData.maxOutputTokens,
                    isActive: bodyData.isActive ?? true,
                    shortName: bodyData.shortName,
                    throttleKey: bodyData.throttleKey,
                    isStream: bodyData.isStream,
                });
            } else {
                // 更新 - 必須フィールド
                Object.assign(entity!, {
                    providerNameList: bodyData.providerNameList || [],
                    // providerType: bodyData.providerType,
                    // providerName: bodyData.providerName,
                    providerModelId: bodyData.providerModelId,
                    name: bodyData.name,
                    status: bodyData.status,
                    modalities: bodyData.modalities,
                    maxContextTokens: bodyData.maxContextTokens,
                    maxOutputTokens: bodyData.maxOutputTokens,
                    isActive: bodyData.isActive,
                    shortName: bodyData.shortName,
                    throttleKey: bodyData.throttleKey,
                    isStream: bodyData.isStream,
                });
            }

            // オプショナルフィールドの設定
            // nullの場合は明示的にnullに設定、undefinedの場合は既存値を維持
            if ('shortName' in bodyData) entity!.shortName = bodyData.shortName;
            if ('throttleKey' in bodyData) entity!.throttleKey = bodyData.throttleKey;
            if ('description' in bodyData) entity!.description = bodyData.description;
            if ('details' in bodyData) entity!.details = bodyData.details;
            if ('inputFormats' in bodyData) entity!.inputFormats = bodyData.inputFormats || [];
            if ('outputFormats' in bodyData) entity!.outputFormats = bodyData.outputFormats || [];
            if ('defaultParameters' in bodyData) entity!.defaultParameters = bodyData.defaultParameters;
            if ('capabilities' in bodyData) entity!.capabilities = bodyData.capabilities;
            if ('metadata' in bodyData) entity!.metadata = bodyData.metadata;
            if ('endpointTemplate' in bodyData) entity!.endpointTemplate = bodyData.endpointTemplate;
            if ('documentationUrl' in bodyData) entity!.documentationUrl = bodyData.documentationUrl;
            if ('licenseType' in bodyData) entity!.licenseType = bodyData.licenseType;
            if ('knowledgeCutoff' in bodyData) entity!.knowledgeCutoff = bodyData.knowledgeCutoff ? new Date(bodyData.knowledgeCutoff) : undefined;
            if ('releaseDate' in bodyData) entity!.releaseDate = bodyData.releaseDate ? new Date(bodyData.releaseDate) : undefined;
            if ('deprecationDate' in bodyData) entity!.deprecationDate = bodyData.deprecationDate ? new Date(bodyData.deprecationDate) : undefined;
            if ('tags' in bodyData) entity!.tags = bodyData.tags || [];
            if ('uiOrder' in bodyData) entity!.uiOrder = bodyData.uiOrder;
            if ('isStream' in bodyData) entity!.isStream = bodyData.isStream;

            // 共通フィールドの設定
            entity!.orgKey = req.info.user.orgKey;
            entity!.updatedBy = req.info.user.id;
            entity!.updatedIp = req.info.ip;
            // createdBy, createdAtは新規作成時のみ設定
            if (isNew) {
                entity!.createdBy = req.info.user.id;
                entity!.createdIp = req.info.ip;
            }

            const saved = await repo.save(entity!);


            // 重複エイリアスが存在しない場合は既存のエイリアスを削除して新しいエイリアスを追加
            const existingAliases = await repoAlias.find({ where: { modelId: saved.id, orgKey: req.info.user.orgKey } });
            // 削除されたエイリアスを削除
            const deletedAliases = existingAliases.filter(alias => !aliases.includes(alias.alias));
            if (deletedAliases.length > 0) {
                await repoAlias.remove(deletedAliases);
            } else { }
            // 新しいエイリアスを追加
            const newAliases = aliases.filter(alias => !existingAliases.some(existingAlias => existingAlias.alias === alias));
            if (newAliases.length > 0) {
                const newAliasEntities = newAliases.map(alias => {
                    const aliasEntity = new AIModelAlias();
                    aliasEntity.orgKey = req.info.user.orgKey;
                    // aliasEntity.provider = bodyData.providerType;
                    // aliasEntity.providerType = bodyData.providerType;
                    // aliasEntity.providerName = bodyData.providerName;
                    aliasEntity.alias = alias;
                    aliasEntity.modelId = saved.id;
                    aliasEntity.createdBy = req.info.user.id;
                    aliasEntity.createdIp = req.info.ip;
                    aliasEntity.updatedBy = req.info.user.id;
                    aliasEntity.updatedIp = req.info.ip;
                    return aliasEntity;
                });
                await repoAlias.save(newAliasEntities);
            } else { }

            // 無理矢理 any型にキャストしてエイリアスを保存
            (saved as any).aliases = aliases;

            res.status(isNew ? 201 : 200).json(saved);
        } catch (error) {
            console.error('Error upserting BaseModel:', error);
            res.status(500).json({ message: 'BaseModelの保存に失敗しました' });
        }
    }
];

/**
 * [DELETE] BaseModel 論理削除
 */
export const deleteBaseModel = [
    param('modelId').isUUID(),
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        try {
            const { modelId } = req.params;
            const repo = ds.getRepository(AIModelEntity);
            const entity = await repo.findOne({ where: { id: modelId, orgKey: req.info.user.orgKey } });
            if (!entity) {
                return res.status(404).json({ message: 'BaseModelが見つかりません' });
            }
            // 論理削除フラグがなければ物理削除
            if ('isActive' in entity) {
                entity.isActive = false;
                entity.updatedBy = req.info.user.id;
                entity.updatedIp = req.info.ip;
                await repo.save(entity);
            } else {
                await repo.delete({ id: modelId, orgKey: req.info.user.orgKey });
            }
            res.status(204).send();
        } catch (error) {
            console.error('Error deleting BaseModel:', error);
            res.status(500).json({ message: 'BaseModelの削除に失敗しました' });
        }
    }
];









// GET: 一覧取得
export const getModelPricings = [
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        try {
            const repo = ds.getRepository(AIModelPricingEntity);
            const list = await repo.find({ order: { validFrom: 'DESC' }, where: { orgKey: req.info.user.orgKey } });
            res.json(list);
        } catch (err) {
            console.error(err);
            res.status(500).json({ message: '料金履歴の取得に失敗しました' });
        }
    }
];

// PUT: 新規/更新 (Upsert)
export const upsertModelPricing = [
    param('modelId').optional().isUUID(),
    body('validFrom').isISO8601(),
    body('inputPricePerUnit').isFloat({ min: 0 }),
    body('outputPricePerUnit').isFloat({ min: 0 }),
    body('unit').isString().notEmpty(),
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        const { modelId } = req.params;
        const payload = req.body as AIModelPricingEntity;
        try {
            const repo = ds.getRepository(AIModelPricingEntity);
            let entity;
            if (modelId) {
                entity = await repo.findOne({ where: { id: modelId, orgKey: req.info.user.orgKey } });
            }
            if (entity) {
                repo.merge(entity, payload);
            } else {
                entity = repo.create(payload);
                entity.createdBy = req.info.user.id;
                entity.createdIp = req.info.ip;
            }
            // 共通フィールドの設定
            entity.orgKey = req.info.user.orgKey;
            entity.updatedBy = req.info.user.id;
            entity.updatedIp = req.info.ip;
            const saved = await repo.save(entity);
            res.status(modelId ? 200 : 201).json(saved);
        } catch (err) {
            console.error(err);
            res.status(500).json({ message: '料金履歴の保存に失敗しました' });
        }
    }
];

// DELETE: 論理削除
export const deleteModelPricing = [
    param('modelId').isUUID(),
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        const { modelId } = req.params;
        try {
            const repo = ds.getRepository(AIModelPricingEntity);
            const entity = await repo.findOne({ where: { id: modelId, orgKey: req.info.user.orgKey } });
            if (!entity) {
                return res.status(404).json({ message: '料金履歴が見つかりません' });
            }
            // 論理削除フラグがなければ物理削除
            if ('isActive' in entity) {
                entity.isActive = false;
                entity.updatedBy = req.info.user.id;
                entity.updatedIp = req.info.ip;
                await repo.save(entity);
                return res.status(204).send();
            }
            // 物理削除
            await repo.delete({ modelId, orgKey: req.info.user.orgKey });
            res.status(204).send();
        } catch (err) {
            console.error(err);
            res.status(500).json({ message: '料金履歴の削除に失敗しました' });
        }
    },
];
import { Request, Response } from 'express';
import { param, body, query } from 'express-validator';
import { EntityManager, EntityNotFoundError, In, Not, Or } from 'typeorm';

import { ScopeType, OrganizationEntity, DivisionEntity, UserEntity, UserStatus, UserRoleType } from '../entity/auth.entity.js';
import { AIProviderType, AIModelEntity, AIModelPricingEntity, AIModelStatus, AIModelAlias, AIProviderEntity, AIProviderTemplateEntity, TagEntity } from '../entity/ai-model-manager.entity.js';

import { validationErrorHandler } from '../middleware/validation.js';
import { ds } from '../db.js';
import { UserRequest } from '../models/info.js';
import { safeWhere } from '../entity/base.js';
import { Utils } from '../../common/utils.js';

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
                where: safeWhere(where),
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
                entity = await repo.findOneBy(safeWhere({
                    orgKey: req.info.user.orgKey,
                    id: providerId,
                }));
                if (entity) isNew = false;
            } else { }

            let scopeId;
            if (bodyData.scopeInfo.scopeType === ScopeType.ORGANIZATION) {
                const org = await ds.getRepository(OrganizationEntity).findOneBy(safeWhere({
                    orgKey: req.info.user.orgKey,
                }));
                if (!org) {
                    return res.status(400).json({ message: '指定された組織が見つかりません' });
                }
                scopeId = org.id;
            } else if (bodyData.scopeInfo.scopeType === ScopeType.DIVISION) {
                const divisionRoles = req.info.user.roleList.filter(role => role.scopeInfo.scopeType === ScopeType.DIVISION && [UserRoleType.Admin, UserRoleType.Maintainer].includes(role.role));
                const division = await ds.getRepository(DivisionEntity).findOneBy(safeWhere({
                    orgKey: req.info.user.orgKey,
                }));

                if (!division) {
                    return res.status(400).json({ message: '指定された部門が見つかりません' });
                }
                scopeId = division.id;
            } else if (bodyData.scopeInfo.scopeType === ScopeType.USER) {
                scopeId = req.info.user.id;
            }

            // 一意制約チェック: organization + scopeInfo + provider
            // TODO DANGER safeWhereが適用できてない。
            const conflict = await repo.findOneBy({
                provider: bodyData.provider,
                orgKey: req.info.user.orgKey,
                scopeInfo: {
                    scopeType: bodyData.scopeInfo.scopeType,
                    scopeId: scopeId,
                },
                ...(isNew ? {} : { id: Not(providerId ?? 'id') })
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
                where: safeWhere({
                    id: providerId,
                    orgKey: req.info.user.orgKey
                }),
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
                where: safeWhere(where),
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
                entity = await repo.findOneBy(safeWhere({
                    orgKey: req.info.user.orgKey,
                    id: providerId,
                }));
                if (entity) isNew = false;
            } else { }

            let scopeId;
            if (bodyData.scopeInfo.scopeType === ScopeType.ORGANIZATION) {
                const org = await ds.getRepository(OrganizationEntity).findOneBy(safeWhere({
                    orgKey: req.info.user.orgKey,
                }));
                if (!org) {
                    return res.status(400).json({ message: '指定された組織が見つかりません' });
                }
                scopeId = org.id;
            } else if (bodyData.scopeInfo.scopeType === ScopeType.DIVISION) {
                const divisionRoles = req.info.user.roleList.filter(role => role.scopeInfo.scopeType === ScopeType.DIVISION && [UserRoleType.Admin, UserRoleType.Maintainer].includes(role.role));
                const division = await ds.getRepository(DivisionEntity).findOneBy(safeWhere({
                    orgKey: req.info.user.orgKey,
                }));

                if (!division) {
                    return res.status(400).json({ message: '指定された部門が見つかりません' });
                }
                scopeId = division.id;
            } else if (bodyData.scopeInfo.scopeType === ScopeType.USER) {
                scopeId = req.info.user.id;
            }

            // 一意制約チェック: organization + scopeInfo + provider
            // TODO DANGER safeWhereが適用できてない。
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
                where: safeWhere({
                    id: providerId,
                    orgKey: req.info.user.orgKey
                })
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
            // ユーザーのロールリストからスコープ条件を作成
            const scopeConditions = req.info.user.roleList.map(role => {
                const where: any = {
                    orgKey: req.info.user.orgKey,
                    scopeInfo: {
                        scopeType: role.scopeInfo.scopeType,
                        scopeId: role.scopeInfo.scopeId,
                    },
                    isActive: true,
                };
                if (modelId) where.id = modelId;
                if (provider) where.provider = provider;
                if (status) where.status = status;
                return safeWhere(where);
            });

            const allModels = await ds.getRepository(AIModelEntity).find({
                where: scopeConditions,
                order: { createdAt: 'DESC' }
            });

            // スコープ優先順位でソート・重複排除
            const priority = [ScopeType.USER, ScopeType.DIVISION, ScopeType.ORGANIZATION];
            const modelMap = allModels.reduce((prev, curr) => {
                if (prev[curr.name]) {
                    // 既に存在する場合は何もしない（優先順位が高いものが既に入っている）
                } else {
                    prev[curr.name] = [];
                }
                prev[curr.name].push(curr);
                return prev;
            }, {} as Record<string, AIModelEntity[]>);

            Object.keys(modelMap).forEach(key => {
                modelMap[key].sort((a, b) => {
                    return priority.indexOf(a.scopeInfo.scopeType) - priority.indexOf(b.scopeInfo.scopeType);
                });
            });

            const models = Object.keys(modelMap).map(key => modelMap[key][0]); // 最優先のモデルを使用

            // エイリアスを取得
            const aliases = await ds.getRepository(AIModelAlias).find({
                where: safeWhere({
                    orgKey: req.info.user.orgKey,
                    modelId: In(models.map(model => model.id))
                }),
            });
            // エイリアスをモデルにマージ
            models.forEach(model => {
                (model as any).aliases = aliases.filter(alias => alias.modelId === model.id).map(alias => alias.alias);
            });

            // プライスリストを取得
            const pricingHistory = await ds.getRepository(AIModelPricingEntity).find({
                where: safeWhere({
                    orgKey: req.info.user.orgKey,
                    modelId: In(models.map(model => model.id))
                }),
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
    body('providerNameList').isArray().notEmpty(),
    body('providerNameList.*').isString().notEmpty(),
    body('name').isString().notEmpty(),
    body('scopeInfo.scopeType').isIn(Object.values(ScopeType)),
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
                entity = await repo.findOne({ where: safeWhere({ id: modelId, orgKey: req.info.user.orgKey }) });
                if (entity) isNew = false;
            }

            let scopeId;
            if (bodyData.scopeInfo.scopeType === ScopeType.ORGANIZATION) {
                const org = await ds.getRepository(OrganizationEntity).findOneBy(safeWhere({
                    orgKey: req.info.user.orgKey,
                }));
                if (!org) {
                    return res.status(400).json({ message: '指定された組織が見つかりません' });
                }
                scopeId = org.id;
            } else if (bodyData.scopeInfo.scopeType === ScopeType.DIVISION) {
                const divisionRoles = req.info.user.roleList.filter(role => role.scopeInfo.scopeType === ScopeType.DIVISION && [UserRoleType.Admin, UserRoleType.Maintainer].includes(role.role));
                const division = await ds.getRepository(DivisionEntity).findOneBy(safeWhere({
                    orgKey: req.info.user.orgKey,
                }));

                if (!division) {
                    return res.status(400).json({ message: '指定された部門が見つかりません' });
                }
                scopeId = division.id;
            } else if (bodyData.scopeInfo.scopeType === ScopeType.USER) {
                scopeId = req.info.user.id;
            }            // 一意制約チェック: orgKey + scopeInfo + name
            const conflictWhere: any = {
                name: bodyData.name,
                orgKey: req.info.user.orgKey,
                scopeInfo: {
                    scopeType: bodyData.scopeInfo.scopeType,
                    scopeId: scopeId,
                },
            };
            if (!isNew) {
                conflictWhere.id = Not(modelId);
            }

            const conflict = await repo.findOne({
                where: safeWhere(conflictWhere),
            });
            if (conflict) {
                console.log('Conflict:', modelId, conflict);
                return res.status(409).json({ message: `同じスコープと${bodyData.name} のモデルが既に存在します` });
            }

            // providerNameListの存在チェック
            const providers = await ds.getRepository(AIProviderEntity).find({
                where: safeWhere({ name: In(bodyData.providerNameList) })
            });
            if (providers.length === 0) {
                return res.status(400).json({ message: 'providerNameListに存在しないプロバイダーが含まれています' });
            }

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

            if (isNew) {
                // 新規作成
                entity = repo.create({
                    providerNameList: bodyData.providerNameList,
                    providerModelId: bodyData.providerModelId,
                    name: bodyData.name,
                    scopeInfo: {
                        scopeType: bodyData.scopeInfo.scopeType,
                        scopeId: scopeId,
                    },
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
                    providerNameList: bodyData.providerNameList,
                    providerModelId: bodyData.providerModelId,
                    name: bodyData.name,
                    scopeInfo: {
                        scopeType: bodyData.scopeInfo.scopeType,
                        scopeId: scopeId,
                    },
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
            const entity = await repo.findOne({
                where: safeWhere({ id: modelId, orgKey: req.info.user.orgKey })
            });
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
                await repo.delete(safeWhere({ id: modelId, orgKey: req.info.user.orgKey }));
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










/**
 * [user認証] 全タグ一覧取得
 */
export const getAllTags = [
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;

        try {
            const tags = await ds.getRepository(TagEntity).find({
                where: {
                    orgKey: req.info.user.orgKey,
                    // isActive: true,
                },
                order: {
                    uiOrder: 'ASC',
                    name: 'ASC'
                }
            });

            res.status(200).json(tags);
        } catch (error) {
            console.error('Error getting tags:', JSON.stringify(error, Utils.genJsonSafer()) === '{}' ? error : JSON.stringify(error, Utils.genJsonSafer()));
            res.status(500).json({ message: 'タグ一覧の取得中にエラーが発生しました' });
        }
    }
];

/**
 * [user認証] タグ作成・更新（Upsert）
 */
export const upsertTag = [
    param('tagId').optional().isUUID(),
    body('name').notEmpty().isString().trim().isLength({ max: 50 }),
    body('label').optional({ nullable: true }).isString().trim().isLength({ max: 100 }),
    body('category').optional({ nullable: true }).isString().trim().isLength({ max: 50 }),
    body('uiOrder').optional({ nullable: true }).isInt({ min: 0 }),
    body('overrideOthers').optional({ nullable: true }).isBoolean(),
    body('description').optional({ nullable: true }).isString().trim().isLength({ max: 500 }),
    body('color').optional({ nullable: true }).isString().matches(/^#[0-9A-Fa-f]{6}$/),
    body('isActive').optional({ nullable: true }).isBoolean(),
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        const { tagId } = req.params;
        const { name, label, description, color, isActive = true } = req.body;

        try {
            const result = await ds.transaction(async transactionalEntityManager => {
                let tag: TagEntity;
                let isCreation = false;

                if (tagId) {
                    // 更新の場合
                    const _tag = await transactionalEntityManager.findOne(TagEntity, {
                        where: {
                            orgKey: req.info.user.orgKey,
                            id: tagId
                        }
                    });

                    if (!_tag) {
                        throw new EntityNotFoundError(TagEntity, { tagId });
                    }
                    tag = _tag;
                } else {
                    // 作成の場合
                    tag = new TagEntity();
                    tag.orgKey = req.info.user.orgKey;
                    tag.createdBy = req.info.user.id;
                    tag.createdIp = req.info.ip;
                    tag.usageCount = 0;
                    isCreation = true;
                }

                // 名前の重複チェック（既存のタグの名前と異なる場合のみ）
                if (!tagId || name !== tag.name) {
                    const existingTag = await transactionalEntityManager.findOne(TagEntity, {
                        where: { orgKey: req.info.user.orgKey, name }
                    });

                    if (existingTag && existingTag.id !== tagId) {
                        throw new Error('同じ名前のタグが既に存在します');
                    }
                }

                // タグ情報を設定・更新
                tag.name = name;
                tag.label = label || name || null;
                tag.description = description || null;
                tag.category = req.body.category || null;
                tag.uiOrder = req.body.uiOrder || 10000;
                tag.overrideOthers = req.body.overrideOthers || false;
                tag.color = color || null;
                tag.isActive = isActive;
                tag.updatedBy = req.info.user.id;
                tag.updatedIp = req.info.ip;

                const savedTag = await transactionalEntityManager.save(TagEntity, tag);
                return { tag: savedTag, isCreation };
            });

            const statusCode = result.isCreation ? 201 : 200;
            const message = result.isCreation ? 'タグが正常に作成されました' : 'タグ情報が正常に更新されました';

            res.status(statusCode).json({
                ...result.tag,
                message
            });

        } catch (error) {
            console.error('Error upserting tag:', JSON.stringify(error, Utils.genJsonSafer()) === '{}' ? error : JSON.stringify(error, Utils.genJsonSafer()));
            if (error instanceof EntityNotFoundError) {
                res.status(404).json({ message: '指定されたタグが見つかりません' });
            } else if ((error as any).message === '同じ名前のタグが既に存在します') {
                res.status(400).json({ message: (error as any).message });
            } else {
                res.status(500).json({ message: 'タグの作成・更新中にエラーが発生しました' });
            }
        }
    }
];

/**
 * [user認証] タグ削除（論理削除）
 */
export const deleteTag = [
    param('tagId').notEmpty().isUUID(),
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        const { tagId } = req.params;

        try {
            await ds.transaction(async transactionalEntityManager => {
                // 削除対象のタグが存在するか確認
                const tag = await transactionalEntityManager.findOne(TagEntity, {
                    where: {
                        orgKey: req.info.user.orgKey,
                        id: tagId,
                        isActive: true
                    }
                });

                if (!tag) {
                    throw new EntityNotFoundError(TagEntity, { tagId });
                }

                // タグを論理削除
                tag.isActive = false;
                tag.updatedBy = req.info.user.id;
                tag.updatedIp = req.info.ip;

                await transactionalEntityManager.save(TagEntity, tag);
            });

            res.status(200).json({ message: 'タグが正常に削除されました' });
        } catch (error) {
            console.error('Error deleting tag:', JSON.stringify(error, Utils.genJsonSafer()) === '{}' ? error : JSON.stringify(error, Utils.genJsonSafer()));
            if (error instanceof EntityNotFoundError) {
                res.status(404).json({ message: '指定されたタグが見つかりません' });
            } else {
                res.status(500).json({ message: 'タグの削除中にエラーが発生しました' });
            }
        }
    }
];

/**
 * タグを自動作成または使用回数を増加（内部用）
 * モデル作成時にタグが存在しなければ自動作成する
 */
export const getOrCreateTag = async (
    tagName: string,
    orgKey: string,
    userId: string,
    ip: string,
    manager?: EntityManager
): Promise<TagEntity> => {
    const em = (manager || ds).getRepository(TagEntity);

    // 既存タグを検索
    let tag = await em.findOne({
        where: { orgKey, name: tagName, isActive: true }
    });

    if (tag) {
        // 使用回数を増加
        tag.usageCount += 1;
        tag.updatedBy = userId;
        tag.updatedIp = ip;
        await em.save(tag);
    } else {
        // 新規タグを作成
        tag = new TagEntity();
        tag.orgKey = orgKey;
        tag.name = tagName;
        tag.usageCount = 1;
        tag.isActive = true;
        tag.createdBy = userId;
        tag.updatedBy = userId;
        tag.createdIp = ip;
        tag.updatedIp = ip;
        await em.save(tag);
    }

    return tag;
};

/**
 * 複数タグの一括処理（モデル保存時用）
 */
export const processModelTags = async (
    tagNames: string[],
    orgKey: string,
    userId: string,
    ip: string,
    manager?: EntityManager
): Promise<TagEntity[]> => {
    const processedTags: TagEntity[] = [];

    for (const tagName of tagNames) {
        if (tagName && tagName.trim()) {
            const tag = await getOrCreateTag(tagName.trim(), orgKey, userId, ip, manager);
            processedTags.push(tag);
        }
    }

    return processedTags;
};

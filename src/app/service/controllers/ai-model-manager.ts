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
import { ScopedEntityService } from '../common/scoped-entity-service.js';
import { ScopeUtils } from '../common/scope-utils.js';

/**
 * [GET] AIProvider 一覧取得
 */
export const getAIProviderTemplates = [
    query('provider').optional().isString(),
    query('includeOverridden').optional().isBoolean(),
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        try {
            const { provider, scopeType, providerId, includeOverridden } = req.query as {
                provider?: string,
                scopeType?: string,
                providerId?: string,
                includeOverridden?: boolean
            };

            // 追加フィルター条件を準備
            const additionalFilters: any = {};
            if (providerId) additionalFilters.id = providerId;
            if (provider) additionalFilters.provider = provider;
            if (scopeType) additionalFilters['scopeInfo.scopeType'] = scopeType;

            // 新しいサービスを使用してスコープ考慮の一覧取得
            const providers = await ScopedEntityService.findAllWithScope(
                ds.getRepository(AIProviderTemplateEntity),
                req.info.user,
                { additionalFilters, includeOverridden }
            );

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
    body('name').isString().notEmpty(),
    body('label').isString().notEmpty(),
    body('scopeInfo.scopeType').isIn(Object.values(ScopeType)),
    body('scopeInfo.scopeId').optional({ nullable: true }).isUUID(),
    body('metadata').optional({ nullable: true }),
    body('isActive').isBoolean(),
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        try {
            const bodyData = req.body as AIProviderTemplateEntity;
            const { providerId } = req.params;

            // ScopedEntityServiceを使用してupsert処理
            const result = await ScopedEntityService.upsertWithScope(
                ds.getRepository(AIProviderTemplateEntity),
                req.info.user,
                providerId,
                bodyData,
                req.info.ip,
                {
                    uniqueFields: ['name', 'provider'],
                    beforeSave: async (entity: AIProviderTemplateEntity, isNew: boolean) => {
                        // オプショナルフィールドの設定
                        if ('metadata' in bodyData) entity.metadata = bodyData.metadata;
                    }
                }
            );

            res.status(result.isNew ? 201 : 200).json(result.entity);
        } catch (error) {
            console.error('Error upserting AIProvider:', error);
            if (error instanceof Error && error.message.includes('Conflict')) {
                res.status(409).json({ message: error.message });
            } else {
                res.status(500).json({ message: 'AIProviderの保存に失敗しました' });
            }
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

            const deleted = await ScopedEntityService.deleteWithScope(
                ds.getRepository(AIProviderTemplateEntity),
                req.info.user,
                providerId,
                { userIp: req.info.ip }
            );

            if (!deleted) {
                return res.status(404).json({ message: 'AIProviderが見つかりません' });
            }

            res.status(204).send();
        } catch (error) {
            console.error('Error deleting AIProvider:', error);
            if (error instanceof Error && error.message.includes('Access denied')) {
                res.status(403).json({ message: error.message });
            } else {
                res.status(500).json({ message: 'AIProviderの削除に失敗しました' });
            }
        }
    }
];






/**
 * [GET] AIProvider 一覧取得
 */
export const getAIProviders = [
    query('provider').optional().isString(),
    query('includeOverridden').optional().isBoolean(),
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        try {
            const { provider, scopeType, providerId, includeOverridden } = req.query as {
                provider?: string,
                scopeType?: string,
                providerId?: string,
                includeOverridden?: boolean
            };

            // 追加フィルター条件を準備
            const additionalFilters: any = {};
            if (providerId) additionalFilters.id = providerId;
            if (provider) additionalFilters.type = provider;
            if (scopeType) additionalFilters['scopeInfo.scopeType'] = scopeType;

            // 新しいサービスを使用してスコープ考慮の一覧取得
            const providers = await ScopedEntityService.findAllWithScope(
                ds.getRepository(AIProviderEntity),
                req.info.user,
                { additionalFilters, includeOverridden },
            );

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
    body('description').optional({ nullable: true }).isString(),
    body('scopeInfo.scopeType').isIn(Object.values(ScopeType)),
    body('scopeInfo.scopeId').optional({ nullable: true }).isUUID(),
    body('config').optional({ nullable: true }),
    body('isActive').isBoolean(),
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        try {
            const bodyData = req.body as AIProviderEntity;
            const { providerId } = req.params;

            // ScopedEntityServiceを使用してupsert処理
            const result = await ScopedEntityService.upsertWithScope(
                ds.getRepository(AIProviderEntity),
                req.info.user,
                providerId,
                bodyData,
                req.info.ip,
                {
                    uniqueFields: ['type', 'name'],
                    beforeSave: async (entity: AIProviderEntity, isNew: boolean) => {
                        // オプショナルフィールドの設定
                        if ('description' in bodyData) entity.description = bodyData.description;
                        if ('config' in bodyData) entity.config = bodyData.config;
                    }
                }
            );

            res.status(result.isNew ? 201 : 200).json(result.entity);
        } catch (error) {
            console.error('Error upserting AIProvider:', error);
            if (error instanceof Error && error.message.includes('Conflict')) {
                res.status(409).json({ message: error.message });
            } else {
                res.status(500).json({ message: 'AIProviderの保存に失敗しました' });
            }
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

            const deleted = await ScopedEntityService.deleteWithScope(
                ds.getRepository(AIProviderEntity),
                req.info.user,
                providerId,
                { userIp: req.info.ip }
            );

            if (!deleted) {
                return res.status(404).json({ message: 'AIProviderが見つかりません' });
            }

            res.status(204).send();
        } catch (error) {
            console.error('Error deleting AIProvider:', error);
            if (error instanceof Error && error.message.includes('Access denied')) {
                res.status(403).json({ message: error.message });
            } else {
                res.status(500).json({ message: 'AIProviderの削除に失敗しました' });
            }
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
    query('includeOverridden').optional().isBoolean(),
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        try {
            const { provider, status, modelId, includeOverridden } = req.query as { provider?: string, status?: string, modelId?: string, includeOverridden?: boolean };

            // 追加フィルター条件を準備
            const additionalFilters: any = {};
            if (modelId) additionalFilters.id = modelId;
            if (provider) additionalFilters.provider = provider;
            if (status) additionalFilters.status = status;

            // 新しいサービスを使用してスコープ考慮の一覧取得
            const models = await ScopedEntityService.findAllWithScope(
                ds.getRepository(AIModelEntity),
                req.info.user,
                { additionalFilters, includeOverridden }
            );

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
                const modelPricingHistory = pricingHistory.filter(pricing => pricing.modelId === model.id);
                if (modelPricingHistory.length > 0) {
                    (model as any).pricingHistory = modelPricingHistory;
                } else {
                    console.error(`Model ${model.id} ${model.name} has no pricing history, adding dummy entry`);
                    // モデルに価格履歴がない場合、ダミーを入れておく。画面側が壊れないように
                    (model as any).pricingHistory = [{
                        modelId: model.id,
                        orgKey: req.info.user.orgKey,
                        validFrom: new Date(),
                        inputPricePerUnit: 0,
                        outputPricePerUnit: 0,
                        unit: 'dummy', // デフォルト値
                        isActive: true
                    }] as AIModelPricingEntity[]; // 空の配列を設定
                }
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
    body('scopeInfo.scopeId').optional({ nullable: true }).isUUID(),
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
    validationErrorHandler, async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        try {
            const bodyData = req.body as AIModelEntity;
            const aliases: string[] = req.body.aliases || [];
            const { modelId } = req.params;

            // providerNameListの存在チェック
            const providers = await ds.getRepository(AIProviderEntity).find({
                where: safeWhere({ name: In(bodyData.providerNameList) })
            });
            if (providers.length === 0) {
                return res.status(400).json({ message: 'providerNameListに存在しないプロバイダーが含まれています' });
            }

            // エイリアスの整備
            const processedAliases = aliases.length > 0
                ? [...new Set(aliases)] // 重複除去
                : [bodyData.providerModelId]; // デフォルトエイリアス

            // ScopedEntityServiceを使用してupsert処理
            const result = await ScopedEntityService.upsertWithScope(
                ds.getRepository(AIModelEntity),
                req.info.user,
                modelId,
                bodyData,
                req.info.ip,
                {
                    uniqueFields: ['name', 'providerModelId'],
                    beforeSave: async (entity: AIModelEntity, isNew: boolean) => {
                        // オプショナルフィールドの設定
                        if ('description' in bodyData) entity.description = bodyData.description;
                        if ('details' in bodyData) entity.details = bodyData.details;
                        if ('inputFormats' in bodyData) entity.inputFormats = bodyData.inputFormats;
                        if ('outputFormats' in bodyData) entity.outputFormats = bodyData.outputFormats;
                        if ('defaultParameters' in bodyData) entity.defaultParameters = bodyData.defaultParameters;
                        if ('capabilities' in bodyData) entity.capabilities = bodyData.capabilities;
                        if ('metadata' in bodyData) entity.metadata = bodyData.metadata;
                        if ('endpointTemplate' in bodyData) entity.endpointTemplate = bodyData.endpointTemplate;
                        if ('documentationUrl' in bodyData) entity.documentationUrl = bodyData.documentationUrl;
                        if ('licenseType' in bodyData) entity.licenseType = bodyData.licenseType;
                        if ('knowledgeCutoff' in bodyData) entity.knowledgeCutoff = bodyData.knowledgeCutoff ? new Date(bodyData.knowledgeCutoff) : undefined;
                        if ('releaseDate' in bodyData) entity.releaseDate = bodyData.releaseDate ? new Date(bodyData.releaseDate) : undefined;
                        if ('deprecationDate' in bodyData) entity.deprecationDate = bodyData.deprecationDate ? new Date(bodyData.deprecationDate) : undefined;
                        if ('tags' in bodyData) entity.tags = bodyData.tags || [];
                        if ('uiOrder' in bodyData) entity.uiOrder = bodyData.uiOrder;
                        if ('isStream' in bodyData) entity.isStream = bodyData.isStream;
                    }
                }
            );

            // エイリアスの処理
            const repoAlias = ds.getRepository(AIModelAlias);
            const existingAliases = await repoAlias.find({
                where: { modelId: result.entity.id, orgKey: req.info.user.orgKey }
            });

            // 削除されたエイリアスを削除
            const deletedAliases = existingAliases.filter(alias => !processedAliases.includes(alias.alias));
            if (deletedAliases.length > 0) {
                await repoAlias.remove(deletedAliases);
            }

            // 新しいエイリアスを追加
            const newAliases = processedAliases.filter(alias =>
                !existingAliases.some(existingAlias => existingAlias.alias === alias)
            );
            if (newAliases.length > 0) {
                const newAliasEntities = newAliases.map(alias => {
                    const aliasEntity = new AIModelAlias();
                    aliasEntity.orgKey = req.info.user.orgKey;
                    aliasEntity.scopeInfo = result.entity.scopeInfo; // 親モデルのscopeInfoを継承
                    aliasEntity.alias = alias;
                    aliasEntity.modelId = result.entity.id;
                    aliasEntity.createdBy = req.info.user.id;
                    aliasEntity.createdIp = req.info.ip;
                    aliasEntity.updatedBy = req.info.user.id;
                    aliasEntity.updatedIp = req.info.ip;
                    return aliasEntity;
                });
                await repoAlias.save(newAliasEntities);
            }

            // レスポンスにエイリアスを含める
            (result.entity as any).aliases = processedAliases;

            res.status(result.isNew ? 201 : 200).json(result.entity);
        } catch (error) {
            console.error('Error upserting BaseModel:', error);
            if (error instanceof Error && error.message.includes('Conflict')) {
                res.status(409).json({ message: error.message });
            } else {
                res.status(500).json({ message: 'BaseModelの保存に失敗しました' });
            }
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

            const deleted = await ScopedEntityService.deleteWithScope(
                ds.getRepository(AIModelEntity),
                req.info.user,
                modelId,
                { userIp: req.info.ip }
            );

            if (!deleted) {
                return res.status(404).json({ message: 'BaseModelが見つかりません' });
            }

            res.status(204).send();
        } catch (error) {
            console.error('Error deleting BaseModel:', error);
            if (error instanceof Error && error.message.includes('Access denied')) {
                res.status(403).json({ message: error.message });
            } else {
                res.status(500).json({ message: 'BaseModelの削除に失敗しました' });
            }
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
    body('modelId').isUUID(),
    body('name').isString().notEmpty(),
    body('scopeInfo.scopeType').isIn(Object.values(ScopeType)),
    body('scopeInfo.scopeId').optional({ nullable: true }).isUUID(),
    body('validFrom').isISO8601(),
    body('inputPricePerUnit').isFloat({ min: 0 }),
    body('outputPricePerUnit').isFloat({ min: 0 }),
    body('unit').isString().notEmpty(),
    body('isActive').optional({ nullable: true }).isBoolean(),
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        const { modelId: paramModelId } = req.params;
        const bodyData = req.body as AIModelPricingEntity;

        try {            // ScopedEntityServiceを使用してupsert処理
            const result = await ScopedEntityService.upsertWithScope(
                ds.getRepository(AIModelPricingEntity),
                req.info.user,
                paramModelId,
                bodyData,
                req.info.ip,
                {
                    uniqueFields: ['name'], // nameで一意性を保証（スコープを考慮）
                }
            );

            res.status(result.isNew ? 201 : 200).json(result.entity);
        } catch (error) {
            console.error('Error upserting model pricing:', error);
            if (error instanceof Error && error.message.includes('Conflict')) {
                res.status(409).json({ message: error.message });
            } else {
                res.status(500).json({ message: '料金履歴の保存に失敗しました' });
            }
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
    query('includeOverridden').optional().isBoolean(),
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;

        try {
            const { includeOverridden } = req.query as { includeOverridden?: boolean };

            // ScopedEntityServiceを使用してスコープ考慮の一覧取得
            const tags = await ScopedEntityService.findAllWithScope(
                ds.getRepository(TagEntity),
                req.info.user,
                { includeOverridden }
            );

            // UIソート順でソート
            tags.sort((a, b) => {
                // まずuiOrderでソート、次にnameでソート
                if (a.uiOrder !== b.uiOrder) {
                    return a.uiOrder - b.uiOrder;
                }
                return a.name.localeCompare(b.name);
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
    body('scopeInfo.scopeType').optional().isIn(Object.values(ScopeType)),
    body('scopeInfo.scopeId').optional({ nullable: true }).isUUID(),
    body('uiOrder').optional({ nullable: true }).isInt({ min: 0 }),
    body('overrideOthers').optional({ nullable: true }).isBoolean(),
    body('description').optional({ nullable: true }).isString().trim().isLength({ max: 500 }),
    body('color').optional({ nullable: true }).isString().matches(/^#[0-9A-Fa-f]{6}$/),
    body('isActive').optional({ nullable: true }).isBoolean(),
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        const { tagId } = req.params;
        const bodyData = req.body as TagEntity;

        try {
            // デフォルトスコープをORGANIZATIONに設定（指定されていない場合）
            if (!bodyData.scopeInfo?.scopeType) {
                bodyData.scopeInfo = {
                    scopeType: ScopeType.ORGANIZATION,
                    scopeId: '' // ScopedEntityServiceが解決する
                };
            }

            // ScopedEntityServiceを使用してupsert処理
            const result = await ScopedEntityService.upsertWithScope(
                ds.getRepository(TagEntity),
                req.info.user,
                tagId,
                bodyData,
                req.info.ip,
                {
                    uniqueFields: ['name'],
                    beforeSave: async (entity: TagEntity, isNew: boolean) => {
                        // オプショナルフィールドの設定
                        if ('label' in bodyData) entity.label = bodyData.label || bodyData.name;
                        if ('category' in bodyData) entity.category = bodyData.category;
                        if ('description' in bodyData) entity.description = bodyData.description;
                        if ('color' in bodyData) entity.color = bodyData.color;
                        if ('uiOrder' in bodyData) entity.uiOrder = bodyData.uiOrder || 10000;
                        if ('overrideOthers' in bodyData) entity.overrideOthers = bodyData.overrideOthers || false;

                        // 新規作成時のデフォルト値設定
                        if (isNew) {
                            entity.usageCount = 0;
                            entity.uiOrder = entity.uiOrder || 10000;
                        }
                    }
                }
            );

            const statusCode = result.isNew ? 201 : 200;
            const message = result.isNew ? 'タグが正常に作成されました' : 'タグ情報が正常に更新されました';

            res.status(statusCode).json({
                ...result.entity,
                message
            });

        } catch (error) {
            console.error('Error upserting tag:', JSON.stringify(error, Utils.genJsonSafer()) === '{}' ? error : JSON.stringify(error, Utils.genJsonSafer()));
            if (error instanceof Error && error.message.includes('Conflict')) {
                res.status(409).json({ message: '同じ名前のタグが既に存在します' });
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
            const deleted = await ScopedEntityService.deleteWithScope(
                ds.getRepository(TagEntity),
                req.info.user,
                tagId,
                { userIp: req.info.ip }
            );

            if (!deleted) {
                return res.status(404).json({ message: '指定されたタグが見つかりません' });
            }

            res.status(200).json({ message: 'タグが正常に削除されました' });
        } catch (error) {
            console.error('Error deleting tag:', JSON.stringify(error, Utils.genJsonSafer()) === '{}' ? error : JSON.stringify(error, Utils.genJsonSafer()));
            if (error instanceof Error && error.message.includes('Access denied')) {
                res.status(403).json({ message: error.message });
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

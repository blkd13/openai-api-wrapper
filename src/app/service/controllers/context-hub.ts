import { Request, Response } from 'express';
import { body, param } from 'express-validator';
import { EntityNotFoundError } from 'typeorm';
import { Utils } from '../../common/utils.js';
import { ds } from '../db.js';
import { ContextHubEntity, ContextResourceEntity, ContextResourceProviderType, ContextResourceSyncStatus } from '../entity/context-hub.entity.js';
import { validationErrorHandler } from '../middleware/validation.js';
import { UserRequest } from '../models/info.js';
import { syncResource, syncAllResources } from './context-hub-sync.js';

// ============================================
// Context Hub CRUD
// ============================================

/**
 * [user認証] プロジェクトのContext Hubを取得（なければ作成）
 */
export const getOrCreateContextHub = [
    param('projectId').notEmpty().isUUID(),
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        const { projectId } = req.params;

        try {
            // 既存のハブを検索
            let hub = await ds.getRepository(ContextHubEntity).findOne({
                where: {
                    orgKey: req.info.user.orgKey,
                    projectId: projectId,
                }
            });

            // なければ作成
            if (!hub) {
                hub = new ContextHubEntity();
                hub.projectId = projectId;
                hub.name = 'Default Hub';
                hub.isActive = true;
                hub.orgKey = req.info.user.orgKey;
                hub.createdBy = req.info.user.id;
                hub.updatedBy = req.info.user.id;
                hub.createdIp = req.info.ip;
                hub.updatedIp = req.info.ip;
                hub = await ds.getRepository(ContextHubEntity).save(hub);
            }

            // リソース一覧を取得
            const resources = await ds.getRepository(ContextResourceEntity).find({
                where: {
                    orgKey: req.info.user.orgKey,
                    contextHubId: hub.id,
                },
                order: { sortOrder: 'ASC', createdAt: 'ASC' }
            });

            const hubForView = {
                ...hub,
                resources,
                resourceCount: resources.length,
            };

            res.status(200).json(hubForView);
        } catch (error) {
            console.error('Error getting context hub:', JSON.stringify(error, Utils.genJsonSafer()) === '{}' ? error : JSON.stringify(error, Utils.genJsonSafer()));
            res.status(500).json({ message: 'Context Hub取得中にエラーが発生しました' });
        }
    }
];

/**
 * [user認証] Context Hub作成
 */
export const createContextHub = [
    body('projectId').notEmpty().isUUID(),
    body('name').notEmpty().isString().trim(),
    body('description').optional().isString().trim(),
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        const { projectId, name, description } = req.body;

        try {
            const hub = new ContextHubEntity();
            hub.projectId = projectId;
            hub.name = name;
            hub.description = description;
            hub.isActive = true;
            hub.orgKey = req.info.user.orgKey;
            hub.createdBy = req.info.user.id;
            hub.updatedBy = req.info.user.id;
            hub.createdIp = req.info.ip;
            hub.updatedIp = req.info.ip;

            const savedHub = await ds.getRepository(ContextHubEntity).save(hub);

            const hubForView = {
                ...savedHub,
                resources: [],
                resourceCount: 0,
            };

            res.status(201).json(hubForView);
        } catch (error) {
            console.error('Error creating context hub:', JSON.stringify(error, Utils.genJsonSafer()) === '{}' ? error : JSON.stringify(error, Utils.genJsonSafer()));
            res.status(500).json({ message: 'Context Hub作成中にエラーが発生しました' });
        }
    }
];

/**
 * [user認証] Context Hub更新
 */
export const updateContextHub = [
    param('hubId').notEmpty().isUUID(),
    body('name').optional().isString().trim().notEmpty(),
    body('description').optional().isString().trim(),
    body('isActive').optional().isBoolean(),
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        const { hubId } = req.params;
        const { name, description, isActive } = req.body;

        try {
            const hub = await ds.getRepository(ContextHubEntity).findOneOrFail({
                where: {
                    orgKey: req.info.user.orgKey,
                    id: hubId,
                }
            });

            if (name !== undefined) hub.name = name;
            if (description !== undefined) hub.description = description;
            if (isActive !== undefined) hub.isActive = isActive;
            hub.updatedBy = req.info.user.id;
            hub.updatedIp = req.info.ip;

            const savedHub = await ds.getRepository(ContextHubEntity).save(hub);

            // リソース一覧を取得
            const resources = await ds.getRepository(ContextResourceEntity).find({
                where: {
                    orgKey: req.info.user.orgKey,
                    contextHubId: hub.id,
                },
                order: { sortOrder: 'ASC', createdAt: 'ASC' }
            });

            const hubForView = {
                ...savedHub,
                resources,
                resourceCount: resources.length,
            };

            res.status(200).json(hubForView);
        } catch (error) {
            console.error('Error updating context hub:', JSON.stringify(error, Utils.genJsonSafer()) === '{}' ? error : JSON.stringify(error, Utils.genJsonSafer()));
            if (error instanceof EntityNotFoundError) {
                res.status(404).json({ message: '指定されたContext Hubが見つかりません' });
            } else {
                res.status(500).json({ message: 'Context Hub更新中にエラーが発生しました' });
            }
        }
    }
];

/**
 * [user認証] Context Hub削除
 */
export const deleteContextHub = [
    param('hubId').notEmpty().isUUID(),
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        const { hubId } = req.params;

        try {
            await ds.transaction(async (transactionalEntityManager) => {
                const hub = await transactionalEntityManager.findOneOrFail(ContextHubEntity, {
                    where: {
                        orgKey: req.info.user.orgKey,
                        id: hubId,
                    }
                });

                // 関連リソースも削除
                await transactionalEntityManager.delete(ContextResourceEntity, {
                    orgKey: req.info.user.orgKey,
                    contextHubId: hubId,
                });

                await transactionalEntityManager.remove(ContextHubEntity, hub);
            });

            res.status(200).json({ message: 'Context Hubを削除しました' });
        } catch (error) {
            console.error('Error deleting context hub:', JSON.stringify(error, Utils.genJsonSafer()) === '{}' ? error : JSON.stringify(error, Utils.genJsonSafer()));
            if (error instanceof EntityNotFoundError) {
                res.status(404).json({ message: '指定されたContext Hubが見つかりません' });
            } else {
                res.status(500).json({ message: 'Context Hub削除中にエラーが発生しました' });
            }
        }
    }
];

// ============================================
// Context Resource CRUD
// ============================================

/**
 * [user認証] Context Resource作成
 */
export const createContextResource = [
    body('contextHubId').notEmpty().isUUID(),
    body('providerType').isIn(Object.values(ContextResourceProviderType)),
    body('providerName').notEmpty().isString().trim(),
    body('label').notEmpty().isString().trim(),
    body('description').optional().isString().trim(),
    body('config').optional().isObject(),
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        const { contextHubId, providerType, providerName, label, description, config } = req.body;

        try {
            // ハブの存在確認
            await ds.getRepository(ContextHubEntity).findOneOrFail({
                where: {
                    orgKey: req.info.user.orgKey,
                    id: contextHubId,
                }
            });

            // 既存リソースの最大sortOrderを取得
            const existingResources = await ds.getRepository(ContextResourceEntity).find({
                where: {
                    orgKey: req.info.user.orgKey,
                    contextHubId,
                },
                order: { sortOrder: 'DESC' },
                take: 1,
            });
            const maxSortOrder = existingResources.length > 0 ? existingResources[0].sortOrder : 0;

            const resource = new ContextResourceEntity();
            resource.contextHubId = contextHubId;
            resource.providerType = providerType;
            resource.providerName = providerName;
            resource.label = label;
            resource.description = description;
            resource.config = config;
            resource.isActive = true;
            resource.syncStatus = ContextResourceSyncStatus.Pending;
            resource.sortOrder = maxSortOrder + 1;
            resource.orgKey = req.info.user.orgKey;
            resource.createdBy = req.info.user.id;
            resource.updatedBy = req.info.user.id;
            resource.createdIp = req.info.ip;
            resource.updatedIp = req.info.ip;

            const savedResource = await ds.getRepository(ContextResourceEntity).save(resource);

            res.status(201).json(savedResource);
        } catch (error) {
            console.error('Error creating context resource:', JSON.stringify(error, Utils.genJsonSafer()) === '{}' ? error : JSON.stringify(error, Utils.genJsonSafer()));
            if (error instanceof EntityNotFoundError) {
                res.status(404).json({ message: '指定されたContext Hubが見つかりません' });
            } else {
                res.status(500).json({ message: 'Context Resource作成中にエラーが発生しました' });
            }
        }
    }
];

/**
 * [user認証] Context Resource更新
 */
export const updateContextResource = [
    param('resourceId').notEmpty().isUUID(),
    body('label').optional().isString().trim().notEmpty(),
    body('description').optional().isString().trim(),
    body('isActive').optional().isBoolean(),
    body('config').optional().isObject(),
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        const { resourceId } = req.params;
        const { label, description, isActive, config } = req.body;

        try {
            const resource = await ds.getRepository(ContextResourceEntity).findOneOrFail({
                where: {
                    orgKey: req.info.user.orgKey,
                    id: resourceId,
                }
            });

            if (label !== undefined) resource.label = label;
            if (description !== undefined) resource.description = description;
            if (isActive !== undefined) resource.isActive = isActive;
            if (config !== undefined) {
                // 既存のconfigとマージ
                resource.config = { ...resource.config, ...config };
            }
            resource.updatedBy = req.info.user.id;
            resource.updatedIp = req.info.ip;

            const savedResource = await ds.getRepository(ContextResourceEntity).save(resource);

            res.status(200).json(savedResource);
        } catch (error) {
            console.error('Error updating context resource:', JSON.stringify(error, Utils.genJsonSafer()) === '{}' ? error : JSON.stringify(error, Utils.genJsonSafer()));
            if (error instanceof EntityNotFoundError) {
                res.status(404).json({ message: '指定されたContext Resourceが見つかりません' });
            } else {
                res.status(500).json({ message: 'Context Resource更新中にエラーが発生しました' });
            }
        }
    }
];

/**
 * [user認証] Context Resource削除
 */
export const deleteContextResource = [
    param('resourceId').notEmpty().isUUID(),
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        const { resourceId } = req.params;

        try {
            const resource = await ds.getRepository(ContextResourceEntity).findOneOrFail({
                where: {
                    orgKey: req.info.user.orgKey,
                    id: resourceId,
                }
            });

            await ds.getRepository(ContextResourceEntity).remove(resource);

            res.status(200).json({ message: 'Context Resourceを削除しました' });
        } catch (error) {
            console.error('Error deleting context resource:', JSON.stringify(error, Utils.genJsonSafer()) === '{}' ? error : JSON.stringify(error, Utils.genJsonSafer()));
            if (error instanceof EntityNotFoundError) {
                res.status(404).json({ message: '指定されたContext Resourceが見つかりません' });
            } else {
                res.status(500).json({ message: 'Context Resource削除中にエラーが発生しました' });
            }
        }
    }
];

// ============================================
// Sync Operations
// ============================================

/**
 * [user認証] 単一リソースを同期
 */
export const syncContextResource = [
    param('resourceId').notEmpty().isUUID(),
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        const { resourceId } = req.params;

        try {
            const resource = await ds.getRepository(ContextResourceEntity).findOneOrFail({
                where: {
                    orgKey: req.info.user.orgKey,
                    id: resourceId,
                }
            });

            // 同期処理を実行
            const updatedResource = await syncResource(resource, req);

            res.status(200).json(updatedResource);
        } catch (error) {
            console.error('Error syncing context resource:', JSON.stringify(error, Utils.genJsonSafer()) === '{}' ? error : JSON.stringify(error, Utils.genJsonSafer()));
            if (error instanceof EntityNotFoundError) {
                res.status(404).json({ message: '指定されたContext Resourceが見つかりません' });
            } else {
                res.status(500).json({ message: 'Context Resource同期中にエラーが発生しました' });
            }
        }
    }
];

/**
 * [user認証] Hub内の全リソースを同期
 */
export const syncAllContextResources = [
    param('hubId').notEmpty().isUUID(),
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        const { hubId } = req.params;

        try {
            const hub = await ds.getRepository(ContextHubEntity).findOneOrFail({
                where: {
                    orgKey: req.info.user.orgKey,
                    id: hubId,
                }
            });

            // 全リソースを同期
            const resources = await syncAllResources(hubId, req);

            const hubForView = {
                ...hub,
                resources,
                resourceCount: resources.length,
            };

            res.status(200).json(hubForView);
        } catch (error) {
            console.error('Error syncing all context resources:', JSON.stringify(error, Utils.genJsonSafer()) === '{}' ? error : JSON.stringify(error, Utils.genJsonSafer()));
            if (error instanceof EntityNotFoundError) {
                res.status(404).json({ message: '指定されたContext Hubが見つかりません' });
            } else {
                res.status(500).json({ message: 'Context Resource同期中にエラーが発生しました' });
            }
        }
    }
];

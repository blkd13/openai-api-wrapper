import { Request, Response } from 'express';
import { body, param, query, validationResult } from 'express-validator';
import { Not } from 'typeorm';

import { ds } from '../db.js'; // データソース
import { validationErrorHandler } from '../middleware/validation.js';
import { UserSettingEntity } from '../entity/user.entity.js';
import { UserRequest } from '../models/info.js';
import { ApiProviderEntity, OAuth2Config, TenantEntity } from '../entity/auth.entity.js';

/**
 * [UPSERT] ユーザー設定を作成または更新
 */
export const upsertUserSetting = [
    param('key').isString().trim().notEmpty(),
    body('value').notEmpty(),
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        const { key } = req.params as { key: string };
        const { value } = req.body as { value: any };
        const userId = req.info.user.id;
        const tenantKey = req.info.user.tenantKey; // テナントIDを取得
        // console.log('userId:', userId);
        // console.log('key:', key);
        // console.log('value:', value);
        try {
            const repository = ds.getRepository(UserSettingEntity);

            // `userId` と `key` の組み合わせで既存のレコードを探す
            let setting = await repository.findOne({ where: { tenantKey, userId, key } });

            if (setting) {
                // 既存のレコードがある場合は更新
                setting.value = value;
            } else {
                // 新しいレコードを作成
                setting = new UserSettingEntity();
                setting.userId = userId;
                setting.key = key;
                setting.value = value;
                setting.tenantKey = req.info.user.tenantKey;
                setting.createdBy = userId; // 作成者
                setting.createdIp = req.info.ip; // 作成IP
            }
            setting.updatedBy = userId; // 更新者
            setting.updatedIp = req.info.ip; // 更新IP

            // 作成または更新を保存
            const savedSetting = await repository.save(setting);
            res.status(200).json(savedSetting);
        } catch (error) {
            console.error('Error upserting user setting:', error);
            res.status(500).json({ message: 'ユーザー設定の作成または更新中にエラーが発生しました' });
        }
    },
];

/**
 * [READ] ユーザー設定を取得
 */
export const getUserSetting = [
    param('key').isString().trim().notEmpty(),
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        const { key } = req.params as { key: string };
        const userId = req.info.user.id;
        const tenantKey = req.info.user.tenantKey; // テナントIDを取得
        try {
            const setting = await ds.getRepository(UserSettingEntity).findOne({ where: { tenantKey, userId, key } });
            if (!setting) {
                // return res.status(404).json({ message: 'ユーザー設定が見つかりません' });
                return res.status(200).json({});
            }
            res.status(200).json(setting);
        } catch (error) {
            console.error('Error retrieving user setting:', error);
            res.status(500).json({ message: 'ユーザー設定の取得中にエラーが発生しました' });
        }
    },
];

/**
 * [DELETE] ユーザー設定を削除
 */
export const deleteUserSetting = [
    param('key').isString().trim().notEmpty(),
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        const { key } = req.params as { key: string };
        const userId = req.info.user.id;
        const tenantKey = req.info.user.tenantKey; // テナントIDを取得
        try {
            const repository = ds.getRepository(UserSettingEntity);
            const setting = await repository.findOne({ where: { tenantKey, userId, key } });
            if (!setting) {
                return res.status(404).json({ message: 'ユーザー設定が見つかりません' });
            }

            await repository.remove(setting);
            res.status(204).send(); // No Content
        } catch (error) {
            console.error('Error deleting user setting:', error);
            res.status(500).json({ message: 'ユーザー設定の削除中にエラーが発生しました' });
        }
    },
];

/**
 * [UPSERT] OAuthプロバイダー設定の作成または更新（テナント単位）
 */
export const upsertOAuthProvider = [
    param('type').isString().notEmpty(),
    body('uriBase').isURL(),
    body('clientId').notEmpty(),
    body('clientSecret').notEmpty(),
    body('pathAuthorize').notEmpty(),
    body('pathAccessToken').notEmpty(),
    body('pathUserInfo').notEmpty(),
    body('pathTop').notEmpty(),
    body('scope').optional().isString(),
    body('postType').isIn(['json', 'params']),
    body('redirectUri').isURL(),
    body('requireMailAuth').isBoolean(),
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        const tenantKey = req.info.user.tenantKey;
        const createdBy = req.info.user.id;
        const ip = req.info.ip;
        const { type } = req.params;
        const bodyData = req.body;

        // OAuth2Config 用のオブジェクトを作成
        const oAuth2Config: OAuth2Config = {
            uriBaseAuth: bodyData.uriBaseAuth, // 任意項目
            clientId: bodyData.clientId,
            clientSecret: bodyData.clientSecret,
            pathAuthorize: bodyData.pathAuthorize,
            pathAccessToken: bodyData.pathAccessToken,
            pathTop: bodyData.pathTop,
            scope: bodyData.scope,
            postType: bodyData.postType,
            redirectUri: bodyData.redirectUri,
            requireMailAuth: bodyData.requireMailAuth,
        };

        try {
            const repository = ds.getRepository(ApiProviderEntity);
            let entity = await repository.findOne({
                where: { tenantKey, type, uriBase: bodyData.uriBase }
            });

            if (entity) {
                // 既存エンティティの更新
                entity.uriBase = bodyData.uriBase;
                entity.pathUserInfo = bodyData.pathUserInfo;
                entity.oAuth2Config = oAuth2Config;
                if (bodyData.description !== undefined) {
                    entity.description = bodyData.description;
                }
                // provider, label もリクエストに含まれていれば更新
                if (bodyData.provider !== undefined) {
                    entity.provider = bodyData.provider;
                }
                if (bodyData.label !== undefined) {
                    entity.label = bodyData.label;
                }
            } else {
                // 新規作成時：新しいエンティティインスタンスを生成
                entity = repository.create({
                    tenantKey,
                    type,
                    uriBase: bodyData.uriBase,
                    pathUserInfo: bodyData.pathUserInfo,
                    oAuth2Config,
                    description: bodyData.description,
                    provider: bodyData.provider,
                    label: bodyData.label,
                    createdBy,
                    createdIp: ip
                });
            }

            entity.isDeleted = false; // 論理削除フラグをリセット
            entity.updatedBy = createdBy;
            entity.updatedIp = ip;

            const saved = await repository.save(entity);
            res.status(200).json(saved);
        } catch (error) {
            console.error('Error upserting OAuth provider:', error);
            res.status(500).json({ message: 'OAuthプロバイダー設定の作成/更新中にエラーが発生しました' });
        }
    }
];


/**
 * [GET] OAuthプロバイダー設定の取得（テナント＋プロバイダー種別）
 */
export const getOAuthProvider = [
    param('type').isString().notEmpty(),
    param('uriBase').isURL(),
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        const { type, uriBase } = req.params;
        const tenantKey = req.info.user.tenantKey;

        try {
            const entity = await ds.getRepository(ApiProviderEntity).findOne({
                where: { tenantKey, type, uriBase, isDeleted: false }
            });
            if (!entity) return res.status(200).json({});
            res.status(200).json(entity);
        } catch (error) {
            console.error('Error retrieving OAuth provider:', error);
            res.status(500).json({ message: 'OAuthプロバイダー設定の取得中にエラーが発生しました' });
        }
    }
];

/**
 * [DELETE] OAuthプロバイダー設定の論理削除（テナント＋プロバイダー種別）
 */
export const deleteOAuthProvider = [
    param('type').isString().notEmpty(),
    param('uriBase').isURL(),
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        const { type, uriBase } = req.params;
        const tenantKey = req.info.user.tenantKey;

        try {
            const repository = ds.getRepository(ApiProviderEntity);
            const entity = await repository.findOne({
                where: { tenantKey, type, uriBase, isDeleted: false }
            });

            if (!entity) {
                return res.status(404).json({ message: 'OAuthプロバイダー設定が見つかりません' });
            }

            entity.isDeleted = true;
            entity.updatedBy = req.info.user.id;
            entity.updatedIp = req.info.ip;

            await repository.save(entity);
            res.status(204).send();
        } catch (error) {
            console.error('Error deleting OAuth provider:', error);
            res.status(500).json({ message: 'OAuthプロバイダー設定の削除中にエラーが発生しました' });
        }
    }
];


















/**
 * [GET] APIプロバイダー一覧の取得（テナント単位）
 */
export const getApiProviders = [
    query('type').optional().isString(),
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        const tenantKey = req.info.user.tenantKey;
        const { type } = req.query;

        try {
            const whereClause: any = {
                tenantKey,
                isDeleted: false
            };

            // タイプが指定されていればフィルタリング
            if (type) {
                whereClause.type = type;
            }

            const entities = await ds.getRepository(ApiProviderEntity).find({
                where: whereClause,
                order: {
                    type: 'ASC',
                    provider: 'ASC',
                    label: 'ASC'
                }
            });

            res.status(200).json(entities);
        } catch (error) {
            console.error('Error retrieving API providers:', error);
            res.status(500).json({ message: 'APIプロバイダー一覧の取得中にエラーが発生しました' });
        }
    }
];

/**
 * [GET] APIプロバイダーの取得（ID指定）
 */
export const getApiProviderById = [
    param('id').isUUID(),
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        const tenantKey = req.info.user.tenantKey;
        const { id } = req.params;

        try {
            const entity = await ds.getRepository(ApiProviderEntity).findOne({
                where: { id, tenantKey, isDeleted: false }
            });

            if (!entity) {
                return res.status(404).json({ message: 'APIプロバイダーが見つかりません' });
            }

            res.status(200).json(entity);
        } catch (error) {
            console.error('Error retrieving API provider:', error);
            res.status(500).json({ message: 'APIプロバイダーの取得中にエラーが発生しました' });
        }
    }
];

/**
 * [GET] APIプロバイダーの取得（プロバイダー指定）
 */
export const getApiProviderByProvider = [
    param('provider').isString().notEmpty(),
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        const tenantKey = req.info.user.tenantKey;
        const { provider } = req.params;

        try {
            const entity = await ds.getRepository(ApiProviderEntity).findOne({
                where: { tenantKey, provider, isDeleted: false }
            });

            if (!entity) {
                return res.status(404).json({ message: 'APIプロバイダーが見つかりません' });
            }

            res.status(200).json(entity);
        } catch (error) {
            console.error('Error retrieving API provider:', error);
            res.status(500).json({ message: 'APIプロバイダーの取得中にエラーが発生しました' });
        }
    }
];

/**
 * [GET] APIプロバイダーの取得（タイプ＋URIベース指定）
 */
export const getApiProviderByTypeAndUri = [
    param('type').isString().notEmpty(),
    param('uriBase').isURL(),
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        const tenantKey = req.info.user.tenantKey;
        const { type, uriBase } = req.params;

        try {
            const entity = await ds.getRepository(ApiProviderEntity).findOne({
                where: { tenantKey, type, uriBase, isDeleted: false }
            });

            if (!entity) {
                return res.status(404).json({ message: 'APIプロバイダーが見つかりません' });
            }

            res.status(200).json(entity);
        } catch (error) {
            console.error('Error retrieving API provider:', error);
            res.status(500).json({ message: 'APIプロバイダーの取得中にエラーが発生しました' });
        }
    }
];

/**
 * [POST] APIプロバイダーの新規作成
 */
export const createApiProvider = [
    body('type').isString().notEmpty(),
    body('provider').isString().notEmpty(),
    body('label').isString().notEmpty(),
    body('uriBase').isURL(),
    body('pathUserInfo').isString().notEmpty(),
    body('description').optional().isString(),
    body('oAuth2Config').optional(),
    body('oAuth2Config.clientId').optional().isString(),
    body('oAuth2Config.clientSecret').optional().isString(),
    body('oAuth2Config.pathAuthorize').optional().isString(),
    body('oAuth2Config.pathAccessToken').optional().isString(),
    body('oAuth2Config.pathTop').optional().isString(),
    body('oAuth2Config.scope').optional().isString(),
    body('oAuth2Config.postType').optional().isIn(['json', 'params']),
    body('oAuth2Config.redirectUri').optional().isURL(),
    body('oAuth2Config.requireMailAuth').optional().isBoolean(),
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        const tenantKey = req.info.user.tenantKey;
        const createdBy = req.info.user.id;
        const ip = req.info.ip;
        const bodyData = req.body;

        try {
            const repository = ds.getRepository(ApiProviderEntity);

            // 既存エンティティのチェック（同一テナント内で type+uriBase と type+provider の両方が一意）
            const existsWithTypeAndUri = await repository.findOne({
                where: { tenantKey, type: bodyData.type, uriBase: bodyData.uriBase }
            });

            if (existsWithTypeAndUri) {
                return res.status(409).json({
                    message: '同じタイプとURIベースを持つAPIプロバイダーが既に存在します'
                });
            }

            const existsWithTypeAndProvider = await repository.findOne({
                where: { tenantKey, type: bodyData.type, provider: bodyData.provider }
            });

            if (existsWithTypeAndProvider) {
                return res.status(409).json({
                    message: '同じタイプとプロバイダー名を持つAPIプロバイダーが既に存在します'
                });
            }

            // 新規エンティティの作成
            const entity = repository.create({
                tenantKey,
                type: bodyData.type,
                provider: bodyData.provider,
                label: bodyData.label,
                uriBase: bodyData.uriBase,
                pathUserInfo: bodyData.pathUserInfo,
                oAuth2Config: bodyData.oAuth2Config,
                description: bodyData.description,
                isDeleted: false,
                createdBy,
                createdIp: ip,
                updatedBy: createdBy,
                updatedIp: ip
            });

            const saved = await repository.save(entity);
            res.status(201).json(saved);
        } catch (error) {
            console.error('Error creating API provider:', error);
            res.status(500).json({ message: 'APIプロバイダーの作成中にエラーが発生しました' });
        }
    }
];

/**
 * [PUT] APIプロバイダーの更新
 */
export const updateApiProvider = [
    param('id').isUUID(),
    body('type').optional().isString().notEmpty(),
    body('provider').optional().isString().notEmpty(),
    body('label').optional().isString().notEmpty(),
    body('uriBase').optional().isURL(),
    body('pathUserInfo').optional().isString().notEmpty(),
    body('description').optional().isString(),
    body('oAuth2Config').optional(),
    body('oAuth2Config.uriBaseAuth').optional().isURL(),
    body('oAuth2Config.clientId').optional().isString(),
    body('oAuth2Config.clientSecret').optional().isString(),
    body('oAuth2Config.pathAuthorize').optional().isString(),
    body('oAuth2Config.pathAccessToken').optional().isString(),
    body('oAuth2Config.pathTop').optional().isString(),
    body('oAuth2Config.scope').optional().isString(),
    body('oAuth2Config.postType').optional().isIn(['json', 'params']),
    body('oAuth2Config.redirectUri').optional().isURL(),
    body('oAuth2Config.requireMailAuth').optional().isBoolean(),
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        const tenantKey = req.info.user.tenantKey;
        const { id } = req.params;
        const updatedBy = req.info.user.id;
        const ip = req.info.ip;
        const bodyData = req.body;

        try {
            const repository = ds.getRepository(ApiProviderEntity);

            // 更新対象のエンティティを取得
            const entity = await repository.findOne({
                where: { id, tenantKey, isDeleted: false }
            });

            if (!entity) {
                return res.status(404).json({ message: 'APIプロバイダーが見つかりません' });
            }

            // type または provider が変更される場合、一意性チェック
            if (bodyData.type && bodyData.type !== entity.type ||
                bodyData.provider && bodyData.provider !== entity.provider ||
                bodyData.uriBase && bodyData.uriBase !== entity.uriBase) {

                // type + uriBase の一意性チェック
                if (bodyData.type && bodyData.uriBase) {
                    const existsWithTypeAndUri = await repository.findOne({
                        where: {
                            tenantKey,
                            type: bodyData.type,
                            uriBase: bodyData.uriBase,
                            id: Not(id) // 自分自身を除外
                        }
                    });

                    if (existsWithTypeAndUri) {
                        return res.status(409).json({
                            message: '同じタイプとURIベースを持つAPIプロバイダーが既に存在します'
                        });
                    }
                }

                // type + provider の一意性チェック
                if (bodyData.type && bodyData.provider) {
                    const existsWithTypeAndProvider = await repository.findOne({
                        where: {
                            tenantKey,
                            type: bodyData.type,
                            provider: bodyData.provider,
                            id: Not(id) // 自分自身を除外
                        }
                    });

                    if (existsWithTypeAndProvider) {
                        return res.status(409).json({
                            message: '同じタイプとプロバイダー名を持つAPIプロバイダーが既に存在します'
                        });
                    }
                }
            }

            // エンティティの更新
            if (bodyData.type !== undefined) entity.type = bodyData.type;
            if (bodyData.provider !== undefined) entity.provider = bodyData.provider;
            if (bodyData.label !== undefined) entity.label = bodyData.label;
            if (bodyData.uriBase !== undefined) entity.uriBase = bodyData.uriBase;
            if (bodyData.pathUserInfo !== undefined) entity.pathUserInfo = bodyData.pathUserInfo;
            if (bodyData.description !== undefined) entity.description = bodyData.description;
            if (bodyData.oAuth2Config !== undefined) entity.oAuth2Config = bodyData.oAuth2Config;

            entity.updatedBy = updatedBy;
            entity.updatedIp = ip;

            const saved = await repository.save(entity);
            res.status(200).json(saved);
        } catch (error) {
            console.error('Error updating API provider:', error);
            res.status(500).json({ message: 'APIプロバイダーの更新中にエラーが発生しました' });
        }
    }
];

/**
 * [DELETE] APIプロバイダーの論理削除
 */
export const deleteApiProvider = [
    param('id').isUUID(),
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        const tenantKey = req.info.user.tenantKey;
        const { id } = req.params;
        const updatedBy = req.info.user.id;
        const ip = req.info.ip;

        try {
            const repository = ds.getRepository(ApiProviderEntity);
            const entity = await repository.findOne({
                where: { id, tenantKey, isDeleted: false }
            });

            if (!entity) {
                return res.status(404).json({ message: 'APIプロバイダーが見つかりません' });
            }

            entity.isDeleted = true;
            entity.updatedBy = updatedBy;
            entity.updatedIp = ip;

            await repository.save(entity);
            res.status(204).send();
        } catch (error) {
            console.error('Error deleting API provider:', error);
            res.status(500).json({ message: 'APIプロバイダーの削除中にエラーが発生しました' });
        }
    }
];

/**
 * [PATCH] APIプロバイダーのOAuth2設定更新
 */
export const updateOAuth2Config = [
    param('id').isUUID(),
    body('uriBaseAuth').optional().isURL(),
    body('clientId').optional().isString().notEmpty(),
    body('clientSecret').optional().isString().notEmpty(),
    body('pathAuthorize').optional().isString().notEmpty(),
    body('pathAccessToken').optional().isString().notEmpty(),
    body('pathTop').optional().isString().notEmpty(),
    body('scope').optional().isString(),
    body('postType').optional().isIn(['json', 'params']),
    body('redirectUri').optional().isURL(),
    body('requireMailAuth').optional().isBoolean(),
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        const tenantKey = req.info.user.tenantKey;
        const { id } = req.params;
        const updatedBy = req.info.user.id;
        const ip = req.info.ip;
        const bodyData = req.body;

        try {
            const repository = ds.getRepository(ApiProviderEntity);
            const entity = await repository.findOne({
                where: { id, tenantKey, isDeleted: false }
            });

            if (!entity) {
                return res.status(404).json({ message: 'APIプロバイダーが見つかりません' });
            }

            // 既存のOAuth2設定をコピー（または新規作成）
            const oAuth2Config: OAuth2Config = entity.oAuth2Config ? { ...entity.oAuth2Config } : {} as OAuth2Config;

            // 送信されたフィールドで更新
            if (bodyData.uriBaseAuth !== undefined) oAuth2Config.uriBaseAuth = bodyData.uriBaseAuth;
            if (bodyData.clientId !== undefined) oAuth2Config.clientId = bodyData.clientId;
            if (bodyData.clientSecret !== undefined) oAuth2Config.clientSecret = bodyData.clientSecret;
            if (bodyData.pathAuthorize !== undefined) oAuth2Config.pathAuthorize = bodyData.pathAuthorize;
            if (bodyData.pathAccessToken !== undefined) oAuth2Config.pathAccessToken = bodyData.pathAccessToken;
            if (bodyData.pathTop !== undefined) oAuth2Config.pathTop = bodyData.pathTop;
            if (bodyData.scope !== undefined) oAuth2Config.scope = bodyData.scope;
            if (bodyData.postType !== undefined) oAuth2Config.postType = bodyData.postType;
            if (bodyData.redirectUri !== undefined) oAuth2Config.redirectUri = bodyData.redirectUri;
            if (bodyData.requireMailAuth !== undefined) oAuth2Config.requireMailAuth = bodyData.requireMailAuth;

            entity.oAuth2Config = oAuth2Config;
            entity.updatedBy = updatedBy;
            entity.updatedIp = ip;

            const saved = await repository.save(entity);
            res.status(200).json(saved);
        } catch (error) {
            console.error('Error updating OAuth2 config:', error);
            res.status(500).json({ message: 'OAuth2設定の更新中にエラーが発生しました' });
        }
    }
];

/**
 * [DELETE] APIプロバイダーのOAuth2設定削除
 */
export const deleteOAuth2Config = [
    param('id').isUUID(),
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        const tenantKey = req.info.user.tenantKey;
        const { id } = req.params;
        const updatedBy = req.info.user.id;
        const ip = req.info.ip;

        try {
            const repository = ds.getRepository(ApiProviderEntity);
            const entity = await repository.findOne({
                where: { id, tenantKey, isDeleted: false }
            });

            if (!entity) {
                return res.status(404).json({ message: 'APIプロバイダーが見つかりません' });
            }

            if (!entity.oAuth2Config) {
                return res.status(404).json({ message: 'OAuth2設定が存在しません' });
            }

            entity.oAuth2Config = undefined;
            entity.updatedBy = updatedBy;
            entity.updatedIp = ip;

            const saved = await repository.save(entity);
            res.status(200).json(saved);
        } catch (error) {
            console.error('Error deleting OAuth2 config:', error);
            res.status(500).json({ message: 'OAuth2設定の削除中にエラーが発生しました' });
        }
    }
];























/**
 * [GET] テナント一覧の取得
 * 管理者ユーザー向け
 */
export const getTenants = [
    query('isActive').optional().isBoolean(),
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;

        // 管理者権限チェック
        if (req.info.user.role !== 'Admin') {
            return res.status(403).json({ message: 'このアクションには管理者権限が必要です' });
        }

        const { isActive } = req.query;

        try {
            const whereClause: any = {};

            // アクティブフラグでフィルタリング
            if (isActive !== undefined) {
                whereClause.isActive = isActive === 'true';
            }

            const entities = await ds.getRepository(TenantEntity).find({
                where: whereClause,
                order: {
                    name: 'ASC'
                }
            });

            res.status(200).json(entities);
        } catch (error) {
            console.error('Error retrieving tenants:', error);
            res.status(500).json({ message: 'テナント一覧の取得中にエラーが発生しました' });
        }
    }
];

/**
 * [GET] テナント情報の取得（ID指定）
 */
export const getTenantById = [
    param('id').isUUID(),
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        const { id } = req.params;

        // 管理者または自分のテナントのみアクセス可能
        if (req.info.user.role !== 'Admin' && req.info.user.tenantKey !== id) {
            return res.status(403).json({ message: 'このテナント情報へのアクセス権限がありません' });
        }

        try {
            const entity = await ds.getRepository(TenantEntity).findOne({
                where: { id }
            });

            if (!entity) {
                return res.status(404).json({ message: 'テナントが見つかりません' });
            }

            res.status(200).json(entity);
        } catch (error) {
            console.error('Error retrieving tenant:', error);
            res.status(500).json({ message: 'テナント情報の取得中にエラーが発生しました' });
        }
    }
];

/**
 * [GET] 自分のテナント情報の取得
 */
export const getMyTenant = [
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        const tenantKey = req.info.user.tenantKey;

        try {
            const entity = await ds.getRepository(TenantEntity).findOne({
                where: { id: tenantKey }
            });

            if (!entity) {
                return res.status(404).json({ message: 'テナントが見つかりません' });
            }

            res.status(200).json(entity);
        } catch (error) {
            console.error('Error retrieving tenant:', error);
            res.status(500).json({ message: 'テナント情報の取得中にエラーが発生しました' });
        }
    }
];

/**
 * [POST] テナントの新規作成
 * 管理者ユーザー向け
 */
export const createTenant = [
    body('name').isString().notEmpty().withMessage('テナント名は必須です'),
    body('description').optional().isString(),
    body('isActive').optional().isBoolean(),
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;

        // 管理者権限チェック
        if (req.info.user.role !== 'Admin') {
            return res.status(403).json({ message: 'このアクションには管理者権限が必要です' });
        }

        const createdBy = req.info.user.id;
        const ip = req.info.ip;
        const { name, description, isActive = true } = req.body;

        try {
            // テナント名の重複チェック
            const existingTenant = await ds.getRepository(TenantEntity).findOne({
                where: { name }
            });

            if (existingTenant) {
                return res.status(409).json({ message: '同じ名前のテナントが既に存在します' });
            }

            // 新規テナントの作成
            const repository = ds.getRepository(TenantEntity);
            const entity = repository.create({
                name,
                description,
                isActive,
                createdBy,
                createdIp: ip,
                updatedBy: createdBy,
                updatedIp: ip
            });

            const saved = await repository.save(entity);
            res.status(201).json(saved);
        } catch (error) {
            console.error('Error creating tenant:', error);
            res.status(500).json({ message: 'テナントの作成中にエラーが発生しました' });
        }
    }
];

/**
 * [PUT] テナント情報の更新
 * 管理者ユーザー向け
 */
export const updateTenant = [
    param('id').isUUID(),
    body('name').optional().isString().notEmpty(),
    body('description').optional().isString(),
    body('isActive').optional().isBoolean(),
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;

        // 管理者権限チェック
        if (req.info.user.role !== 'Admin') {
            return res.status(403).json({ message: 'このアクションには管理者権限が必要です' });
        }

        const { id } = req.params;
        const updatedBy = req.info.user.id;
        const ip = req.info.ip;
        const updateData = req.body;

        try {
            const repository = ds.getRepository(TenantEntity);
            const entity = await repository.findOne({
                where: { id }
            });

            if (!entity) {
                return res.status(404).json({ message: 'テナントが見つかりません' });
            }

            // テナント名の重複チェック（変更される場合のみ）
            if (updateData.name && updateData.name !== entity.name) {
                const existingTenant = await repository.findOne({
                    where: { name: updateData.name, id: Not(id) }
                });

                if (existingTenant) {
                    return res.status(409).json({ message: '同じ名前のテナントが既に存在します' });
                }
            }

            // エンティティの更新
            if (updateData.name !== undefined) entity.name = updateData.name;
            if (updateData.description !== undefined) entity.description = updateData.description;
            if (updateData.isActive !== undefined) entity.isActive = updateData.isActive;

            entity.updatedBy = updatedBy;
            entity.updatedIp = ip;

            const saved = await repository.save(entity);
            res.status(200).json(saved);
        } catch (error) {
            console.error('Error updating tenant:', error);
            res.status(500).json({ message: 'テナントの更新中にエラーが発生しました' });
        }
    }
];

/**
 * [PATCH] テナントの有効化/無効化
 * 管理者ユーザー向け
 */
export const toggleTenantActive = [
    param('id').isUUID(),
    body('isActive').isBoolean(),
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;

        // 管理者権限チェック
        if (req.info.user.role !== 'Admin') {
            return res.status(403).json({ message: 'このアクションには管理者権限が必要です' });
        }

        const { id } = req.params;
        const { isActive } = req.body;
        const updatedBy = req.info.user.id;
        const ip = req.info.ip;

        try {
            const repository = ds.getRepository(TenantEntity);
            const entity = await repository.findOne({
                where: { id }
            });

            if (!entity) {
                return res.status(404).json({ message: 'テナントが見つかりません' });
            }

            entity.isActive = isActive;
            entity.updatedBy = updatedBy;
            entity.updatedIp = ip;

            const saved = await repository.save(entity);
            res.status(200).json(saved);
        } catch (error) {
            console.error('Error toggling tenant active state:', error);
            res.status(500).json({ message: 'テナントの状態変更中にエラーが発生しました' });
        }
    }
];

/**
 * [DELETE] テナントの削除
 * 管理者ユーザー向け - 物理削除に注意
 */
export const deleteTenant = [
    param('id').isUUID(),
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;

        // 管理者権限チェック
        if (req.info.user.role !== 'Admin') {
            return res.status(403).json({ message: 'このアクションには管理者権限が必要です' });
        }

        const { id } = req.params;

        try {
            const repository = ds.getRepository(TenantEntity);
            const entity = await repository.findOne({
                where: { id }
            });

            if (!entity) {
                return res.status(404).json({ message: 'テナントが見つかりません' });
            }

            // テナントの削除前に関連するエンティティの存在チェックなどを行うべき
            // ここではシンプルに削除するが、実際の実装では関連チェックを行うことを推奨

            await repository.remove(entity);
            res.status(204).send();
        } catch (error) {
            console.error('Error deleting tenant:', error);
            res.status(500).json({ message: 'テナントの削除中にエラーが発生しました' });
        }
    }
];

/**
 * [GET] テナントの統計情報取得
 * 管理者ユーザー向け
 */
export const getTenantStats = [
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;

        // 管理者権限チェック
        if (req.info.user.role !== 'Admin') {
            return res.status(403).json({ message: 'このアクションには管理者権限が必要です' });
        }

        try {
            const tenantRepository = ds.getRepository(TenantEntity);

            // アクティブテナント数
            const activeTenantCount = await tenantRepository.count({
                where: { isActive: true }
            });

            // 非アクティブテナント数
            const inactiveTenantCount = await tenantRepository.count({
                where: { isActive: false }
            });

            // 全テナント数
            const totalTenantCount = activeTenantCount + inactiveTenantCount;

            res.status(200).json({
                total: totalTenantCount,
                active: activeTenantCount,
                inactive: inactiveTenantCount
            });
        } catch (error) {
            console.error('Error retrieving tenant stats:', error);
            res.status(500).json({ message: 'テナント統計情報の取得中にエラーが発生しました' });
        }
    }
];
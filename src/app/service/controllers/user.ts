import { Request, Response } from 'express';
import { body, param, query, validationResult } from 'express-validator';
import { BaseEntity, FindOptionsSelect, FindOptionsWhere, Not } from 'typeorm';

import { ds } from '../db.js'; // データソース
import { validationErrorHandler } from '../middleware/validation.js';
import { UserSettingEntity } from '../entity/user.entity.js';
import { UserRequest } from '../models/info.js';
import { ApiProviderAuthType, ApiProviderEntity, ApiProviderPostType, ApiProviderTemplateEntity, OAuth2Config, OAuth2ConfigTemplate, TenantEntity, UserRoleType } from '../entity/auth.entity.js';
import { NextFunction } from 'http-proxy-middleware/dist/types.js';
import { decrypt, encrypt } from './tool-call.js';
import { MakeOptional } from '../../common/utils.js';

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


/* ApiProvider Controller */

/**
 * [GET] APIプロバイダー一覧の取得
 */
export const getApiProviders = [
    param('tenantKey').optional({ values: 'undefined' }).isString(),
    query('type').optional().isString(),
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        const { type } = req.query as { type: string };
        // 認証済み経路の方はパラメータに tenantKey が無いので、ユーザー情報から取得する
        const nonAuth = !!req.params.tenantKey;
        const isAdmin = req.info && req.info.user && [UserRoleType.Admin, UserRoleType.Maintainer].includes(req.info.user.role);
        const tenantKey = isAdmin ? req.info.user.tenantKey : req.params.tenantKey;
        // console.log('isAdmin:', isAdmin);
        // tenantKey が指定されている場合、ユーザーのテナントキーと一致しない場合は403エラーを返す
        if (isAdmin && req.params.tenantKey && req.params.tenantKey !== req.info.user.tenantKey) {
            // そもそも tenantKey が指定されている場合はユーザ認証経路を使わないはずだが、経路としては空いているので塞いでおく。
            return res.status(403).json({ message: '権限がありません' });
        } else { }

        try {
            const select: FindOptionsSelect<ApiProviderEntity> = {
                id: true,
                type: true,
                authType: true,
                name: true,
                label: true,
                description: false,
            };

            // 管理者の場合は oAuth2Config も取得
            if (isAdmin) {
                // console.log('Admin or Maintainer role detected, including oAuth2Config in selection.');
                select.uriBase = true;
                select.uriBaseAuth = true;
                select.pathUserInfo = true;
                select.description = true;
                // select.pathUserInfo = true;
                select.oAuth2Config = {
                    clientId: true,
                    // clientSecret: true, // セキュリティ上、クライアントシークレットは返さない
                    // pathAuthorize: true,
                    // pathAccessToken: true,
                    // pathTop: true,
                    // scope: true,
                    // postType: true,
                    // redirectUri: true,
                    clientSecret: false,
                    requireMailAuth: true
                } as FindOptionsSelect<OAuth2Config>;
            } else {
                if (!nonAuth) {
                    select.uriBase = true;
                    select.pathUserInfo = true;
                    select.description = true;
                    select.oAuth2Config = {
                        clientSecret: false,
                    }
                } else {
                    // 
                }
            }
            // console.dir(select, { depth: null });
            const whereClause: {
                tenantKey: string,
                isDeleted: false,
                type?: string,
            } = {
                tenantKey,
                isDeleted: false
            };

            // タイプが指定されていればフィルタリング
            if (type) {
                whereClause.type = type;
            }
            const entities = await ds.getRepository(ApiProviderEntity).find({
                select,
                where: whereClause,
                order: {
                    sortSeq: 'ASC',
                }
            });
            // console.dir(entities, { depth: null });

            entities.forEach(entity => {
                if (isAdmin) {
                    if (entity.oAuth2Config) {
                        entity.oAuth2Config.clientSecret = 'dummy';
                        // delete (entity.oAuth2Config as any).clientSecret; // セキュリティ上、クライアントシークレットは返さない
                    } else { }
                } else {
                    entity.oAuth2Config = undefined; // 管理者以外は oAuth2Config を返さない    
                }
            });
            // console.dir(entities, { depth: null });

            res.status(200).json(entities);
        } catch (error) {
            console.error('Error retrieving API providers:', error);
            res.status(500).json({ message: 'APIプロバイダー一覧の取得中にエラーが発生しました' });
        }
    }
];
/**
 * エンティティのフィールドを更新するヘルパー関数
 */
const updateEntityFields = (entity: ApiProviderEntity, bodyData: MakeOptional<ApiProviderEntity, 'id' | 'createdBy' | 'createdIp' | 'updatedBy' | 'updatedIp'>, userId: string, ip: string) => {
    entity.type = bodyData.type;
    entity.name = bodyData.name;
    entity.label = bodyData.label;
    entity.authType = bodyData.authType;
    entity.uriBase = bodyData.uriBase;
    entity.uriBaseAuth = bodyData.uriBaseAuth || bodyData.uriBase;
    entity.pathUserInfo = bodyData.pathUserInfo;
    if (bodyData.description !== undefined) entity.description = bodyData.description;

    // OAuth2Configの更新
    if (bodyData.oAuth2Config !== undefined) {
        if (!entity.oAuth2Config) {
            entity.oAuth2Config = {
                // pathAuthorize: bodyData.oAuth2Config.pathAuthorize,
                // pathAccessToken: bodyData.oAuth2Config.pathAccessToken,
                // scope: bodyData.oAuth2Config.scope,
                // postType: bodyData.oAuth2Config.postType,
                // redirectUri: bodyData.oAuth2Config.redirectUri,
                // clientId: bodyData.oAuth2Config.clientId,
                // clientSecret: bodyData.oAuth2Config.clientSecret,
                // requireMailAuth: bodyData.oAuth2Config.requireMailAuth
            } as OAuth2Config;
        }

        // 各フィールドを個別に更新
        const oAuth2Fields = [
            'pathAuthorize', 'pathAccessToken', 'scope',
            'postType', 'redirectUri', 'clientId', 'requireMailAuth'
        ];

        oAuth2Fields.forEach(field => {
            if ((bodyData.oAuth2Config as any)[field] !== undefined) {
                (entity.oAuth2Config as any)[field] = (bodyData.oAuth2Config as any)[field];
            }
        });

        // clientSecretは特別な処理が必要
        if (bodyData.oAuth2Config.clientSecret !== undefined &&
            bodyData.oAuth2Config.clientSecret !== 'dummy') {
            entity.oAuth2Config.clientSecret = bodyData.oAuth2Config.clientSecret;
        }
    }

    entity.updatedBy = userId;
    entity.updatedIp = ip;

    return entity;
};

/**
 * レスポンス用にデータを整形するヘルパー関数
 */
const prepareResponseData = (entity: ApiProviderEntity) => {
    const responseData = { ...entity };

    // クライアントシークレットを隠す
    if (responseData.oAuth2Config && responseData.oAuth2Config.clientSecret) {
        responseData.oAuth2Config.clientSecret = 'dummy';
    }

    return responseData;
};

/**
 * [PUT] APIプロバイダーの作成または更新 (Upsert)
 */
export const upsertApiProvider = [
    param('id').optional().isUUID(),
    body('type').isString().notEmpty(),
    body('name').isString().notEmpty(),
    body('label').isString().notEmpty(),
    body('uriBase').isURL({ require_tld: false }),
    body('uriBaseAuth').optional().isString(),
    body('pathUserInfo').isString().notEmpty(),
    body('authType').isString().notEmpty(),
    body('description').optional().isString(),
    // OAuth2Config バリデーション
    body('oAuth2Config').optional(),
    body('oAuth2Config.pathAuthorize').optional().isString(),
    body('oAuth2Config.pathAccessToken').optional().isString(),
    body('oAuth2Config.scope').optional().isString(),
    body('oAuth2Config.postType').optional().isString(),
    body('oAuth2Config.redirectUri').optional().isURL({ require_tld: false }),
    body('oAuth2Config.clientId').optional().isString(),
    body('oAuth2Config.clientSecret').optional().isString(),
    body('oAuth2Config.requireMailAuth').optional().isBoolean(),
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        const tenantKey = req.info.user.tenantKey;
        const userId = req.info.user.id;
        const ip = req.info.ip;
        const bodyData = req.body as MakeOptional<ApiProviderEntity, 'id' | 'createdBy' | 'createdIp' | 'updatedBy' | 'updatedIp'>;
        const id = req.params.id;

        try {
            const repository = ds.getRepository(ApiProviderEntity);
            let entity: ApiProviderEntity | null = null;
            let isNew = true;

            // IDが提供されている場合、既存のエンティティを検索
            if (id) {
                entity = await repository.findOne({
                    where: { id, tenantKey, isDeleted: false }
                });

                if (entity) {
                    isNew = false;

                    // OAuth2Configの処理
                    if (bodyData.oAuth2Config && entity.oAuth2Config) {
                        // クライアントシークレットが'dummy'または空の場合、既存の値を保持
                        if (!bodyData.oAuth2Config.clientSecret ||
                            (bodyData.oAuth2Config.clientSecret &&
                                bodyData.oAuth2Config.clientSecret === 'dummy')) {

                            bodyData.oAuth2Config.clientSecret = decrypt(entity.oAuth2Config.clientSecret);
                        }
                    }
                }
            }

            // 一意性チェック（同一テナント内で type+uriBase と type+provider の両方が一意）
            const typeAndUriQuery: FindOptionsWhere<ApiProviderEntity> = {
                tenantKey,
                type: bodyData.type,
                uriBase: bodyData.uriBase,
                isDeleted: false
            };

            const typeAndProviderQuery: FindOptionsWhere<ApiProviderEntity> = {
                tenantKey,
                type: bodyData.type,
                name: bodyData.name,
                isDeleted: false
            };

            // 更新の場合は自分自身を除外
            if (!isNew) {
                typeAndUriQuery.id = Not(id);
                typeAndProviderQuery.id = Not(id);
            }

            const existsWithTypeAndUri = await repository.findOne({
                where: typeAndUriQuery
            });

            if (existsWithTypeAndUri) {
                return res.status(409).json({
                    message: '同じタイプとURIベースを持つAPIプロバイダーが既に存在します'
                });
            }

            const existsWithTypeAndName = await repository.findOne({
                where: typeAndProviderQuery
            });

            if (existsWithTypeAndName) {
                return res.status(409).json({
                    message: '同じタイプとプロバイダー名を持つAPIプロバイダーが既に存在します'
                });
            }

            // 論理削除されたエンティティの復活チェック
            const deletedEntity = await repository.findOne({
                where: [
                    { tenantKey, type: bodyData.type, uriBase: bodyData.uriBase, isDeleted: true },
                    { tenantKey, type: bodyData.type, name: bodyData.name, isDeleted: true }
                ]
            });

            // 新規作成または更新
            if (isNew) {
                // 削除されたエンティティを再利用するか、新規エンティティの作成
                if (deletedEntity) {
                    entity = deletedEntity;
                    // 基本情報の更新
                    updateEntityFields(entity, bodyData, userId, ip);
                    entity.isDeleted = false; // 論理削除フラグを解除
                } else {
                    entity = repository.create({
                        tenantKey,
                        type: bodyData.type,
                        name: bodyData.name,
                        label: bodyData.label,
                        authType: bodyData.authType,
                        uriBase: bodyData.uriBase,
                        uriBaseAuth: bodyData.uriBaseAuth || bodyData.uriBase, // uriBaseAuthがない場合はuriBaseを使用
                        pathUserInfo: bodyData.pathUserInfo,
                        oAuth2Config: bodyData.oAuth2Config,
                        description: bodyData.description,
                        isDeleted: false,
                        createdBy: userId,
                        createdIp: ip,
                        updatedBy: userId,
                        updatedIp: ip
                    });
                }
            } else {
                // 既存エンティティの更新
                updateEntityFields(entity!, bodyData, userId, ip);
            }

            // OAuth2ConfigのclientSecretを暗号化
            if (entity && entity.oAuth2Config && entity.oAuth2Config.clientSecret) {
                entity.oAuth2Config.clientSecret = encrypt(entity.oAuth2Config.clientSecret);
            }

            const saved = await repository.save(entity!);

            // レスポンス用にデータを整形（機密情報を隠す等）
            const responseData = prepareResponseData(saved);

            res.status(isNew ? 201 : 200).json(responseData);
        } catch (error) {
            console.error('Error upserting API provider:', error);
            res.status(500).json({
                message: 'APIプロバイダーの作成/更新中にエラーが発生しました',
                error: process.env.NODE_ENV === 'development' ? (error as any).message : undefined
            });
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

/* ApiProviderTemplate Controller */

/**
 * [GET] APIプロバイダーテンプレート一覧の取得
 */
export const getApiProviderTemplates = [
    query('authType').optional().isIn(Object.values(ApiProviderAuthType)),
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        const tenantKey = req.info.user.tenantKey;
        const { authType } = req.query as { authType: ApiProviderAuthType };

        try {
            const whereClause: FindOptionsWhere<ApiProviderTemplateEntity> = {
                tenantKey,
                isDeleted: false
            };

            // タイプが指定されていればフィルタリング
            if (authType) {
                whereClause.authType = authType;
            }

            const entities = await ds.getRepository(ApiProviderTemplateEntity).find({
                where: whereClause,
                order: {
                    authType: 'ASC'
                }
            });

            res.status(200).json(entities);
        } catch (error) {
            console.error('Error retrieving API provider templates:', error);
            res.status(500).json({ message: 'APIプロバイダーテンプレート一覧の取得中にエラーが発生しました' });
        }
    }
];

/**
 * [PUT] APIプロバイダーテンプレートの作成または更新 (Upsert)
 */
export const upsertApiProviderTemplate = [
    param('id').optional().isUUID(),
    body('name').isString().notEmpty().withMessage('名前は必須です'),
    body('authType').isIn(Object.values(ApiProviderAuthType)).notEmpty().withMessage('タイプは OAuth2 または APIKey である必要があります'),
    body('pathUserInfo').isString().notEmpty().withMessage('PathUserInfo は必須です'),

    // Conditional validation for OAuth2 type
    body('oAuth2Config.pathAuthorize')
        .if(body('authType').equals(ApiProviderAuthType.OAuth2))
        .isString().notEmpty().withMessage('OAuth2の場合、pathAuthorize は必須です'),

    body('oAuth2Config.pathAccessToken')
        .if(body('authType').equals(ApiProviderAuthType.OAuth2))
        .isString().notEmpty().withMessage('OAuth2の場合、pathAccessToken は必須です'),

    body('oAuth2Config.scope')
        .if(body('authType').equals(ApiProviderAuthType.OAuth2))
        .isString().notEmpty().withMessage('OAuth2の場合、scope は必須です'),

    body('oAuth2Config.postType')
        .if(body('authType').equals(ApiProviderAuthType.OAuth2))
        .isIn(Object.values(ApiProviderPostType)).notEmpty().withMessage('OAuth2の場合、postType は json, params, または form である必要があります'),

    body('oAuth2Config.redirectUri')
        .if(body('authType').equals(ApiProviderAuthType.OAuth2))
        .isString().notEmpty().withMessage('OAuth2の場合、redirectUri は必須です'),

    // Conditional validation for APIKey type
    body('uriBaseAuth')
        .if(body('authType').equals(ApiProviderAuthType.APIKey))
        .not().isEmpty().withMessage('APIKeyの場合、uriBaseAuth は必須です'),
    // .isURL().withMessage('uriBaseAuth は有効なURLである必要があります'),

    // Optional fields
    body('uriBaseAuth')
        .if(body('authType').equals(ApiProviderAuthType.OAuth2))
        .optional({ nullable: true, checkFalsy: true }) // checkFalsy: true を追加して空文字も許容
        .isURL().withMessage('uriBaseAuth は有効なURLである必要があります'),

    body('description').optional({ nullable: true }).isString(),

    // Custom validator to check all required fields based on type
    (req: Request, res: Response, next: NextFunction) => {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ errors: errors.array() });
        }

        const { authType, oAuth2Config } = req.body;
        const validationErrors = [];

        // Additional validation for OAuth2
        if (authType === ApiProviderAuthType.OAuth2) {
            if (!oAuth2Config) {
                validationErrors.push({ msg: 'OAuth2の場合、oAuth2Config は必須です', param: 'oAuth2Config' });
            } else {
                if (!oAuth2Config.pathAuthorize) {
                    validationErrors.push({ msg: 'OAuth2の場合、pathAuthorize は必須です', param: 'oAuth2Config.pathAuthorize' });
                }
                if (!oAuth2Config.pathAccessToken) {
                    validationErrors.push({ msg: 'OAuth2の場合、pathAccessToken は必須です', param: 'oAuth2Config.pathAccessToken' });
                }
                if (!oAuth2Config.scope) {
                    validationErrors.push({ msg: 'OAuth2の場合、scope は必須です', param: 'oAuth2Config.scope' });
                }
                if (!oAuth2Config.postType) {
                    validationErrors.push({ msg: 'OAuth2の場合、postType は必須です', param: 'oAuth2Config.postType' });
                }
                if (!oAuth2Config.redirectUri) {
                    validationErrors.push({ msg: 'OAuth2の場合、redirectUri は必須です', param: 'oAuth2Config.redirectUri' });
                }
            }
        }

        // Additional validation for APIKey
        if (authType === ApiProviderAuthType.APIKey && (req.body.uriBaseAuth === undefined || req.body.uriBaseAuth === '')) {
            validationErrors.push({ msg: 'APIKeyの場合、uriBaseAuth は必須です', param: 'uriBaseAuth' });
        }

        if (validationErrors.length > 0) {
            return res.status(400).json({ errors: validationErrors });
        }

        next();
    },

    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        const tenantKey = req.info.user.tenantKey;
        const userId = req.info.user.id;
        const ip = req.info.ip;
        const bodyData = req.body;
        const id = req.params.id;

        try {
            const repository = ds.getRepository(ApiProviderTemplateEntity);
            let entity: ApiProviderTemplateEntity | null = null;
            let isNew = true;

            // IDが提供されている場合、既存のエンティティを検索
            if (id) {
                entity = await repository.findOne({
                    where: { id, tenantKey, isDeleted: false }
                });

                if (entity) {
                    isNew = false;
                }
            }

            // name の一意性チェック
            const nameQuery: any = {
                tenantKey,
                name: bodyData.name,
                isDeleted: false
            };

            // 更新の場合は自分自身を除外
            if (!isNew) {
                nameQuery.id = Not(id);
            }

            const existsWithName = await repository.findOne({
                where: nameQuery
            });

            if (existsWithName) {
                return res.status(409).json({
                    message: '同じタイプを持つAPIプロバイダーテンプレートが既に存在します'
                });
            }

            // 新規作成または更新
            if (isNew) {
                // 新規エンティティの作成
                const newEntity: any = {
                    tenantKey,
                    name: bodyData.name,
                    authType: bodyData.authType,
                    pathUserInfo: bodyData.pathUserInfo,
                    uriBaseAuth: bodyData.uriBaseAuth,
                    description: bodyData.description,
                    isDeleted: false,
                    createdBy: userId,
                    createdIp: ip,
                    updatedBy: userId,
                    updatedIp: ip
                };

                // OAuth2Configの追加（OAuth2の場合のみ）
                if (bodyData.authType === ApiProviderAuthType.OAuth2 && bodyData.oAuth2Config) {
                    newEntity.oAuth2Config = {
                        pathAuthorize: bodyData.oAuth2Config.pathAuthorize,
                        pathAccessToken: bodyData.oAuth2Config.pathAccessToken,
                        scope: bodyData.oAuth2Config.scope,
                        postType: bodyData.oAuth2Config.postType,
                        redirectUri: bodyData.oAuth2Config.redirectUri
                    };
                }

                entity = repository.create(newEntity) as any as ApiProviderTemplateEntity;
            } else if (entity) {
                // 既存エンティティの更新
                entity!.name = bodyData.name;
                entity!.authType = bodyData.authType;
                entity!.pathUserInfo = bodyData.pathUserInfo;
                if (bodyData.uriBaseAuth !== undefined) entity!.uriBaseAuth = bodyData.uriBaseAuth;
                if (bodyData.description !== undefined) entity!.description = bodyData.description;

                // OAuth2Configの更新（OAuth2の場合のみ）
                if (bodyData.authType === ApiProviderAuthType.OAuth2 && bodyData.oAuth2Config) {
                    entity.oAuth2Config = {
                        pathAuthorize: bodyData.oAuth2Config.pathAuthorize,
                        pathAccessToken: bodyData.oAuth2Config.pathAccessToken,
                        scope: bodyData.oAuth2Config.scope,
                        postType: bodyData.oAuth2Config.postType,
                        redirectUri: bodyData.oAuth2Config.redirectUri,
                    } as OAuth2ConfigTemplate;
                } else {
                    // APIKeyの場合はoAuth2Configをnullに設定
                    entity!.oAuth2Config = undefined;
                }

                entity!.updatedBy = userId;
                entity!.updatedIp = ip;
            }

            const saved = await repository.save(entity!);
            res.status(isNew ? 201 : 200).json(saved);
        } catch (error) {
            console.error('Error upserting API provider template:', error);
            res.status(500).json({ message: 'APIプロバイダーテンプレートの作成/更新中にエラーが発生しました' });
        }
    }
];

/**
 * [DELETE] APIプロバイダーテンプレートの論理削除
 */
export const deleteApiProviderTemplate = [
    param('id').isUUID(),
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        const tenantKey = req.info.user.tenantKey;
        const { id } = req.params;
        const updatedBy = req.info.user.id;
        const ip = req.info.ip;

        try {
            const repository = ds.getRepository(ApiProviderTemplateEntity);
            const entity = await repository.findOne({
                where: { id, tenantKey, isDeleted: false }
            });

            if (!entity) {
                return res.status(404).json({ message: 'APIプロバイダーテンプレートが見つかりません' });
            }

            entity.isDeleted = true;
            entity.updatedBy = updatedBy;
            entity.updatedIp = ip;

            await repository.save(entity);
            res.status(204).send();
        } catch (error) {
            console.error('Error deleting API provider template:', error);
            res.status(500).json({ message: 'APIプロバイダーテンプレートの削除中にエラーが発生しました' });
        }
    }
];

/* Tenant Controller */

/**
 * [GET] テナント一覧の取得
 */
export const getTenants = [
    query('isActive').optional().isBoolean(),
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        const tenantKey = req.info.user.tenantKey;
        const { isActive } = req.query;

        try {
            const whereClause: any = {
                tenantKey
            };

            // アクティブフラグが指定されていればフィルタリング
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
 * [PUT] テナントの作成または更新 (Upsert)
 */
export const upsertTenant = [
    param('id').optional().isUUID(),
    body('name').isString().notEmpty(),
    body('description').optional().isString(),
    body('isActive').optional().isBoolean(),
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        const tenantKey = req.info.user.tenantKey;
        const userId = req.info.user.id;
        const ip = req.info.ip;
        const bodyData = req.body;
        const id = req.params.id;

        try {
            const repository = ds.getRepository(TenantEntity);
            let entity: TenantEntity | null = null;
            let isNew = true;

            // IDが提供されている場合、既存のエンティティを検索
            if (id) {
                entity = await repository.findOne({
                    where: { id, tenantKey }
                });

                if (entity) {
                    isNew = false;
                }
            }

            // 新規作成または更新
            if (isNew) {
                // 新規エンティティの作成
                entity = repository.create({
                    tenantKey,
                    name: bodyData.name,
                    description: bodyData.description,
                    isActive: bodyData.isActive !== undefined ? bodyData.isActive : true,
                    createdBy: userId,
                    createdIp: ip,
                    updatedBy: userId,
                    updatedIp: ip
                });
            } else {
                // 既存エンティティの更新
                entity!.name = bodyData.name;
                if (bodyData.description !== undefined) entity!.description = bodyData.description;
                if (bodyData.isActive !== undefined) entity!.isActive = bodyData.isActive;
                entity!.updatedBy = userId;
                entity!.updatedIp = ip;
            }

            const saved = await repository.save(entity!);
            res.status(isNew ? 201 : 200).json(saved);
        } catch (error) {
            console.error('Error upserting tenant:', error);
            res.status(500).json({ message: 'テナントの作成/更新中にエラーが発生しました' });
        }
    }
];

/**
 * [DELETE] テナントの非アクティブ化
 * 注意: テナントは物理的に削除せず、isActiveフラグをfalseに設定
 */
export const deactivateTenant = [
    param('id').isUUID(),
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        const tenantKey = req.info.user.tenantKey;
        const { id } = req.params;
        const updatedBy = req.info.user.id;
        const ip = req.info.ip;

        try {
            const repository = ds.getRepository(TenantEntity);
            const entity = await repository.findOne({
                where: { id, tenantKey }
            });

            if (!entity) {
                return res.status(404).json({ message: 'テナントが見つかりません' });
            }

            entity.isActive = false;
            entity.updatedBy = updatedBy;
            entity.updatedIp = ip;

            await repository.save(entity);
            res.status(200).json(entity);
        } catch (error) {
            console.error('Error deactivating tenant:', error);
            res.status(500).json({ message: 'テナントの非アクティブ化中にエラーが発生しました' });
        }
    }
];
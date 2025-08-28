import { AxiosInstance } from 'axios';
import bcrypt from 'bcrypt';
import { createHmac, randomBytes, randomInt, randomUUID } from 'crypto';
import { Request, Response } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { body, param, query } from 'express-validator';
import jwt, { Algorithm } from 'jsonwebtoken';
import ms from 'ms';
import nodemailer from 'nodemailer';
import { EntityManager, In, MoreThan } from 'typeorm';

import { Utils } from '../../common/utils.js';
import { ds } from '../db.js';
import { ApiProviderAuthType, ApiProviderEntity, DivisionEntity, InviteEntity, LoginHistoryEntity, OAuthAccountEntity, OAuthAccountStatus, OAuthStateEntity, OnetimeStatus, OrganizationEntity, ScopeType, SessionEntity, SessionRefreshEntity, SessionStatus, UserEntity, UserRole, UserRoleEntity, UserRoleType, UserStatus } from '../entity/auth.entity.js';
import { ProjectEntity, TeamEntity, TeamMemberEntity } from '../entity/project-models.entity.js';
import { InviteTokenPayload, UserTokenPayload, UserTokenPayloadWithRole } from '../middleware/authenticate.js';
import { validationErrorHandler } from '../middleware/validation.js';
import { InviteRequest, UserRequest } from '../models/info.js';
import { ProjectStatus, ProjectVisibility, TeamMemberRoleType, TeamStatus, TeamType } from '../models/values.js';

const { API_KEY_PEPPER, SMTP_USER, SMTP_PASSWORD, SMTP_ALIAS, FRONT_BASE_URL, SMTP_SERVER, SMTP_PORT, SMTP_DOMAIN, MAIL_DOMAIN_WHITELIST, MAIL_EXPIRES_IN, OAUTH2_PATH_MAIL_MESSAGE, OAUTH2_PATH_MAIL_AUTH, JWT_ISS, JWT_AUD, } = process.env as Record<string, string>;
export const { ACCESS_TOKEN_JWT_SECRET, ACCESS_TOKEN_EXPIRES_IN, REFRESH_TOKEN_EXPIRES_IN, API_TOKEN_EXPIRES_IN, ONETIME_TOKEN_JWT_SECRET, ONETIME_TOKEN_EXPIRES_IN, API_TOKEN_FOR_CONSOLE_EXPIRES_IN }
    = process.env as {
        ACCESS_TOKEN_JWT_SECRET: string, ACCESS_TOKEN_EXPIRES_IN: ms.StringValue,
        REFRESH_TOKEN_EXPIRES_IN: ms.StringValue,
        API_TOKEN_EXPIRES_IN: ms.StringValue,
        ONETIME_TOKEN_JWT_SECRET: string, ONETIME_TOKEN_EXPIRES_IN: ms.StringValue,
        API_TOKEN_FOR_CONSOLE_EXPIRES_IN: ms.StringValue,
    };
Utils.requiredEnvVarsCheck({
    ACCESS_TOKEN_JWT_SECRET, ACCESS_TOKEN_EXPIRES_IN, REFRESH_TOKEN_EXPIRES_IN, API_TOKEN_EXPIRES_IN, ONETIME_TOKEN_JWT_SECRET, ONETIME_TOKEN_EXPIRES_IN,
    API_TOKEN_FOR_CONSOLE_EXPIRES_IN,
    API_KEY_PEPPER, SMTP_USER, SMTP_PASSWORD, SMTP_ALIAS, FRONT_BASE_URL, SMTP_SERVER, SMTP_PORT, SMTP_DOMAIN, MAIL_DOMAIN_WHITELIST, MAIL_EXPIRES_IN,
    OAUTH2_PATH_MAIL_MESSAGE, OAUTH2_PATH_MAIL_AUTH,
    JWT_ISS, JWT_AUD,
});
export const JWT_STAT_PARAM = { algorithm: 'HS256' as Algorithm, issuer: JWT_ISS, audience: JWT_AUD };

// httpsの証明書検証スキップ用のエージェント。社内だから検証しなくていい。
// import https from 'https';
import { getAxios } from '../../common/http-client.js';
import { getAccessToken } from '../api/api-proxy.js';
import { safeWhere } from '../entity/base.js';
import { redirectingPage } from './auth/page.js';
import { genTokenSet, verifyRefresh } from './auth/token.js';
import { decrypt, encrypt } from './tool-call.js';

const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15分
    max: 5, // 最大5回の試行
    message: '試行回数が上限に達しました。しばらくしてからお試しください。',
    standardHeaders: true,
    legacyHeaders: false,
});
export const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    standardHeaders: true,       // RateLimit-* ヘッダ付与
    legacyHeaders: false,
    message: { message: '試行回数が多すぎます。しばらくしてからお試しください。' },
    statusCode: 429,
    keyGenerator: (req, _res) => {
        const { orgKey, email } = req.body;
        const ip0 = ipKeyGenerator(req.ip || '');
        // 同一ユーザー＋同一IPでまとめて制限
        const ip = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.ip;
        console.log(req.headers['x-forwarded-for']);
        console.log(req.ip);
        console.log(ip0);
        return `${orgKey}:${email}:${ip}`;
    },
    skipFailedRequests: false,   // 失敗/成功を区別せずカウント（パスワード変更は両方カウントが無難）
});

export type OAuth2TokenDto = { access_token: string, token_type: string, expires_in: number, scope: string, refresh_token: string, id_token: string, };

/**
 * [認証不要] ユーザーログイン
 * @param req 
 * @param res 
 * @returns 
 */
export const userLogin = [
    authLimiter, // 追加
    param('orgKey').trim().notEmpty(),
    body('email').trim().notEmpty(),  // .withMessage('メールアドレスを入力してください。'),
    body('password').trim().notEmpty(),  // .withMessage('パスワードを入力してください。'),
    validationErrorHandler,
    async (req: Request, res: Response) => {
        const { orgKey } = req.params as { orgKey: string };
        await ds.transaction(async tm => {
            const organization = await tm.getRepository(OrganizationEntity).findOneOrFail({ where: { orgKey, isActive: true } });
            // console.log(`userLogin-111 ${orgKey} ${req.body.email}`);
            const userAndRoleList = await getUserAndRoleList({ orgKey, email: req.body.email }, tm);
            const user = userAndRoleList.user;
            // console.log(`userLogin-222 ${orgKey} ${req.body.email} ${user?.id} ${user?.name} ${user?.email} ${user?.status} ${user?.authGeneration} ${bcrypt.compareSync(req.body.password, user?.passwordHash || '')} ${userAndRoleList.roleList.length}`);
            if (user == null || !bcrypt.compareSync(req.body.password, user.passwordHash || '') || userAndRoleList.roleList.length === 0) {
                // console.error(`認証に失敗しました。${req.body.email} ${user?.id} ${user?.name} ${user?.email} ${user?.status} ${user?.authGeneration} ${user?.passwordHash}`);
                console.error(`認証に失敗しました。ユーザー: ${req.body.email}`);
                res.status(401).json({ message: '認証に失敗しました。' });
                return;
            } else {
                await authAfter(user, userAndRoleList.roleList, tm, 'local', { authGeneration: user.authGeneration }, req, res);
                res.json({ user: { id: user.id, name: user.name, email: user.email, roleList: userAndRoleList.roleList } });
            }
        }).catch((e) => {
            // console.error(e);
            res.status(500).json({ message: '認証に失敗しました。' });
        });
    }
];

async function authAfter(user: UserEntity, roleList: UserRole[], manager: EntityManager, provider: string, authInfoObj: any, req: Request, res: Response): Promise<{ accessToken: string, refreshToken: string }> {
    let deviceInfo = {};
    if (req.useragent) {
        deviceInfo = Utils.jsonOrder(req.useragent, ['browser', 'version', 'os', 'platform', 'isDesktop', 'isMobile', 'isTablet']);
    } else { }

    const xRealIp = req.ip || '';

    const loginHistory = new LoginHistoryEntity();
    loginHistory.userId = user.id; // ユーザー認証後に設定
    loginHistory.ipAddress = xRealIp
    loginHistory.deviceInfo = JSON.stringify(deviceInfo);
    loginHistory.authGeneration = user.authGeneration;
    loginHistory.orgKey = user.orgKey;
    loginHistory.createdBy = user.id;
    loginHistory.updatedBy = user.id;
    loginHistory.createdIp = xRealIp;
    loginHistory.updatedIp = xRealIp;
    manager.getRepository(LoginHistoryEntity).save(loginHistory); // ログイン履歴登録の成否は見ずにレスポンスを返す

    const session = new SessionEntity();
    session.userId = user.id; // ユーザー認証後に設定
    session.deviceInfo = deviceInfo;
    session.provider = provider;
    session.authInfo = authInfoObj;

    // セッション有効期限を設定
    const expirationMs = Utils.parseTimeStringToMilliseconds(REFRESH_TOKEN_EXPIRES_IN);// クッキーの有効期限をミリ秒で指定
    session.expiresAt = new Date(Date.now() + expirationMs);
    session.lastActiveAt = new Date();
    session.orgKey = user.orgKey;
    session.createdBy = user.id;
    session.updatedBy = user.id;
    session.createdIp = xRealIp;
    session.updatedIp = xRealIp;
    const savedSession = await manager.getRepository(SessionEntity).save(session);



    const { jti, verifier, salt, hash } = await genTokenSet();

    const row = new SessionRefreshEntity();
    row.sid = savedSession.id;
    row.userId = user.id;
    row.authGeneration = user.authGeneration;
    row.jti = jti;
    row.hash = hash;
    row.salt = salt;
    row.current = true;
    row.revoked = false;
    row.expiresAt = session.expiresAt;
    row.deviceInfo = deviceInfo;

    row.orgKey = user.orgKey;
    row.createdBy = user.id;
    row.updatedBy = user.id;
    row.createdIp = xRealIp;
    row.updatedIp = xRealIp;

    const saved = await ds.getRepository(SessionRefreshEntity).save(row);

    const userTokenPayload: UserTokenPayload = { type: 'user', id: user.id, orgKey: user.orgKey, authGeneration: user.authGeneration ?? 0, sid: row.sid, jti: jti };

    // アクセストークン（短寿命）に orgKey と sid を入れる
    const accessToken = jwt.sign(userTokenPayload,
        ACCESS_TOKEN_JWT_SECRET, { expiresIn: ACCESS_TOKEN_EXPIRES_IN, ...JWT_STAT_PARAM }
    );

    // クライアントへ渡す不透明トークン（split形式）
    const refreshToken = `${jti}.${verifier}`;

    // クッキーをセット
    res.cookie('access_token', accessToken, {
        maxAge: Utils.parseTimeStringToMilliseconds(ACCESS_TOKEN_EXPIRES_IN), // ミリ秒単位で指定
        httpOnly: true, // クッキーをHTTPプロトコルのみでアクセス可能にする
        secure: true, // HTTPSでのみ送信されるようにする
        sameSite: 'strict', // CSRF保護のためのオプション
    });

    // Cookieにセット（Pathをリフレッシュ専用にすると攻撃面が狭まる）
    const baseHref = req.originalUrl.substring(0, req.originalUrl.length - req.url.length);
    res.cookie('refresh_token', refreshToken, {
        path: `${baseHref}/auth/refresh`, // トークンリフレッシュのタイミングのみ使う。
        maxAge: expirationMs,
        httpOnly: true,
        secure: true,
        sameSite: 'strict',
    });
    return { accessToken, refreshToken };
}

// base64url
// src/services/apiKey.service.ts

export function digestSecret(secret: string, pepper = API_KEY_PEPPER!) {
    if (!pepper) throw new Error("API_KEY_PEPPER is not set");
    return createHmac("sha256", pepper).update(secret, "utf8").digest();
}

export async function verifyApiKey(xRealIp: string, manager: EntityManager, raw: string): Promise<UserTokenPayload | null> {
    // 形式: sk_(live|test)_{jti}_{secret}
    const parts = raw.split("_");
    if (!parts || parts.length < 3) return null;
    const [prefix, orgKey, jti, ...rest] = [parts.slice(0, 3).join('_'), parts[3], parts[4], parts.slice(5).join('_')];
    if (!/^sk_(live|test)_org$/.test(prefix)) return null;

    const secret = rest as unknown as string; // join済
    // console.log(`verifyApiKey ${prefix} ${orgKey} ${jti} ${secret}`);

    // const key = await manager.getRepository(ApiKeyEntity).findOne({ where: { orgKey, keyId, } });
    // if (!key || key.status !== SessionStatus.Active) return null;
    // if (key.expiresAt && key.expiresAt < new Date()) return null;
    const rec = await manager.getRepository(SessionRefreshEntity).findOneOrFail({ where: { orgKey, jti, } });
    if (!(rec.current && !rec.revoked)) return null;
    if (rec.expiresAt && rec.expiresAt < new Date()) return null;

    const ok = await verifyRefresh(secret, rec.salt, rec.hash);
    if (!ok) return null;

    const user = await manager.getRepository(UserEntity).findOneOrFail({
        select: { authGeneration: true },
        where: { orgKey, id: rec.userId },
    });

    const userTokenPayload: UserTokenPayload = {
        orgKey: orgKey,
        type: 'user',
        id: rec.userId,
        authGeneration: user.authGeneration,
        sid: rec.sid,
        jti: Buffer.from(rec.jti).toString('base64url'),
    };
    return userTokenPayload;
}

const genApiTokenCore = async (user: UserTokenPayloadWithRole, label: string, deviceInfo: any, xRealIp: string, manager: EntityManager, expirationTime: number): Promise<{ entity: OAuthAccountEntity, apiKey: string } | null> => {
    const loginHistory = new LoginHistoryEntity();
    loginHistory.userId = user.id; // ユーザー認証後に設定
    loginHistory.ipAddress = xRealIp;
    loginHistory.deviceInfo = JSON.stringify(deviceInfo);
    loginHistory.authGeneration = user.authGeneration;
    loginHistory.orgKey = user.orgKey;
    loginHistory.createdBy = user.id;
    loginHistory.updatedBy = user.id;
    loginHistory.createdIp = xRealIp;
    loginHistory.updatedIp = xRealIp;
    manager.getRepository(LoginHistoryEntity).save(loginHistory); // ログイン履歴登録の成否は見ずにレスポンスを返す

    const session = new SessionEntity();
    session.userId = user.id; // ユーザー認証後に設定
    session.deviceInfo = deviceInfo;
    session.provider = 'session';
    session.authInfo = {};

    session.expiresAt = new Date(Date.now() + expirationTime);
    session.lastActiveAt = new Date();
    session.orgKey = user.orgKey;
    session.createdBy = user.id;
    session.updatedBy = user.id;
    session.createdIp = xRealIp;
    session.updatedIp = xRealIp;
    const savedSession = await manager.getRepository(SessionEntity).save(session);

    // TODO でもよく考えたらAPIはAuthGenerationは無視したい。revoke管理は別途作り込む。
    // DBのユーザーEntityを持ってきてauthGeneartionを持ってくる
    // const userFromDb = await manager.getRepository(UserEntity).findOneOrFail({ where: { orgKey: req.info.user.orgKey, id: req.info.user.id } });
    const userFromDb = await getUserAndRoleList({ orgKey: user.orgKey, id: user.id });
    if (!userFromDb || !userFromDb.user) {
        throw new Error('ユーザー情報が取得できません。');
    } else { }

    const prefix = 'sk_live';

    const { jti, verifier, salt, hash } = await genTokenSet();
    const apiKeyFull = `${prefix}_org_${user.orgKey}_${jti}_${verifier}`;

    const exists = await manager.getRepository(OAuthAccountEntity).findOneBy({ orgKey: user.orgKey, userId: user.id, provider: `local-${label}` });
    if (exists && exists.status === OAuthAccountStatus.ACTIVE) {
        return null;
    } else { }

    const row = new SessionRefreshEntity();
    row.sid = savedSession.id;
    row.userId = user.id;
    row.authGeneration = user.authGeneration;
    row.jti = jti;
    row.hash = hash;
    row.salt = salt;
    row.current = true;
    row.revoked = false;
    row.expiresAt = session.expiresAt;
    row.deviceInfo = deviceInfo;

    row.orgKey = user.orgKey;
    row.createdBy = user.id;
    row.updatedBy = user.id;
    row.createdIp = xRealIp;
    row.updatedIp = xRealIp;

    const saved = await ds.getRepository(SessionRefreshEntity).save(row);

    const apiTokenEntity = exists || new OAuthAccountEntity();
    if (exists) {
    } else {
        apiTokenEntity.userId = user.id;
        apiTokenEntity.providerUserId = user.id;
        apiTokenEntity.providerEmail = userFromDb.user.email;
        apiTokenEntity.userInfo = user;
        apiTokenEntity.orgKey = user.orgKey;
        apiTokenEntity.createdBy = user.id;
        apiTokenEntity.createdIp = xRealIp;
    }
    apiTokenEntity.provider = `local-${label}`;
    apiTokenEntity.label = label;
    apiTokenEntity.accessToken = '-';
    apiTokenEntity.refreshToken = undefined;
    apiTokenEntity.idToken = undefined;
    apiTokenEntity.tokenExpiresAt = session.expiresAt;
    apiTokenEntity.tokenBody = { hash, };
    apiTokenEntity.status = OAuthAccountStatus.ACTIVE;
    apiTokenEntity.updatedBy = user.id;
    apiTokenEntity.updatedIp = xRealIp;

    await manager.getRepository(OAuthAccountEntity).save(apiTokenEntity);
    return { entity: apiTokenEntity, apiKey: apiKeyFull };
}

/**
 * [user認証] APIトークン発行
 */
export const genApiKey = [
    body('label').trim().notEmpty(),
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req: UserRequest = _req as UserRequest;
        const user = req.info.user;
        const label = req.body.label;
        let deviceInfo = {};
        if (req.useragent) {
            deviceInfo = Utils.jsonOrder(req.useragent, ['browser', 'version', 'os', 'platform', 'isDesktop', 'isMobile', 'isTablet']);
        } else { }

        const xRealIp = req.ip || '';

        const expirationTime = Utils.parseTimeStringToMilliseconds(API_TOKEN_EXPIRES_IN);// クッキーの有効期限をミリ秒で指定
        await ds.transaction(async (manager) => {
            // セッション有効期限を設定
            const apiKeyObj = await genApiTokenCore(user, label, deviceInfo, xRealIp, manager, expirationTime);
            if (!apiKeyObj) {
                res.status(400).json({ error: 'APIトークンは既に存在します。' });
                return;
            } else { }
            res.json({ apiKey: apiKeyObj.apiKey });
        });
    }
];

export type ExtApiClient = ApiProviderEntity & { provider: string, redirectUri: string, pathTop: string, axiosWithAuth: Promise<((userId: string) => Promise<AxiosInstance>)>, };
const eMas: Record<string, ExtApiClient> = {};
export async function getExtApiClient(orgKey: string, provider: string): Promise<ExtApiClient> {
    const pType = provider.substring(0, provider.indexOf('-'));
    const pName = provider.substring(provider.indexOf('-') + 1);
    const eKey = `${orgKey}:${provider}`;
    if (eMas[eKey]) {
        return Promise.resolve(eMas[eKey]);
    } else {
        // organization存在チェック
        // console.log(`getExtApiClient-000 ${orgKey} ${provider}`);
        const organization = await ds.getRepository(OrganizationEntity).findOneByOrFail({ orgKey, isActive: true });
        // console.log(`getExtApiClient-111 ${orgKey} ${provider}`);
        const apiProvider = await ds.getRepository(ApiProviderEntity).findOneByOrFail({
            orgKey, type: pType, name: pName, isDeleted: false,
        });
        // console.log(`getExtApiClient-222 ${orgKey} ${provider}`);
        // providerTemplate定義はcommonにしかないので、orgKeyはcommon固定
        // クライアントシークレットは暗号化されているので復号化する。
        if (apiProvider.authType === ApiProviderAuthType.OAuth2 && apiProvider.oAuth2Config) {
            apiProvider.oAuth2Config.clientSecret = decrypt(apiProvider.oAuth2Config.clientSecret);
        } else { }

        // console.dir(apiProviderTemplate, { depth: null });
        // console.dir(apiProvider, { depth: null });
        // console.log(`getExtApiClient-333 ${orgKey} ${provider}`);
        const apiClient = {
            provider,
            redirectUri: `${organization.siteConfig.oauth2RedirectUriList?.at(0) || ''}`,
            pathTop: organization.siteConfig.pathTop || '',
            ...apiProvider,
            axiosWithAuth: getOAuthClient(orgKey, provider, apiProvider.uriBase),
        } as ExtApiClient;
        eMas[eKey] = apiClient;
        // console.log(`getExtApiClient ${provider} ${JSON.stringify(e)}`);
        return apiClient;
    }
}

/**
 * 二重Promiseになる謎
 * @param provider 
 * @returns 
 */
export async function getOAuthClient(orgKey: string, provider: string, uriBase: string): Promise<((userId: string) => Promise<AxiosInstance>)> {
    return (async (userId: string) => {

        const oAuthAccount = await getAccessToken(orgKey, userId, provider);

        // console.log(`getOAuthClient ${provider} ${oAuthAccount.accessToken}`);
        const headers = {
            Authorization: `Bearer ${decrypt(oAuthAccount.accessToken)}`,
            'Content-Type': 'application/json',
        };

        const axiosInstance: AxiosInstance = await getAxios(uriBase, headers);

        // リクエスト失敗時のインターセプター
        axiosInstance.interceptors.response.use(
            response => response, // 成功時はそのまま返す
            async error => {
                const originalRequest = error.config;

                // 401エラーかつ、リトライフラグが立っていない場合
                if (error.response?.status === 401 && !originalRequest._retry && oAuthAccount.refreshToken) {
                    originalRequest._retry = true; // リトライフラグを立てる

                    try {
                        // リフレッシュトークンを使って新しいアクセストークンを取得
                        const newTokens = await getAccessToken(oAuthAccount.orgKey, oAuthAccount.userId, oAuthAccount.provider);

                        // トークンを更新
                        oAuthAccount.accessToken = newTokens.accessToken;
                        // リフレッシュトークンも更新される場合
                        if (newTokens.refreshToken) {
                            oAuthAccount.refreshToken = newTokens.refreshToken;
                        }

                        // 新しいトークンでヘッダーを更新
                        originalRequest.headers.Authorization = `Bearer ${decrypt(newTokens.accessToken)}`;

                        // 元のリクエストを再試行
                        return axiosInstance(originalRequest);
                    } catch (refreshError) {
                        // リフレッシュ処理自体が失敗した場合
                        console.error('トークンのリフレッシュに失敗しました', refreshError);
                        // ここでログアウト処理などを行うことも可能
                        return Promise.reject(refreshError);
                    }
                }
                // 401以外のエラーまたはリフレッシュ不可能な場合は元のエラーを返す
                return Promise.reject(error);
            }
        );
        return axiosInstance;
    });
}

export const verifyAccessToken = async (token: string): Promise<UserTokenPayloadWithRole> => {
    try {
        const payload = await verifyJwt<UserTokenPayload>(token, ACCESS_TOKEN_JWT_SECRET, 'user');
        const roleList = (await ds.getRepository(UserRoleEntity).find({
            where: {
                orgKey: payload.orgKey,
                userId: payload.id,
                status: UserStatus.Active,
            }
        })).map(role => {
            return ({ role: role.role, scopeInfo: role.scopeInfo } as UserRole);
        });
        return { ...payload, roleList };
    } catch (error) {
        throw new Error('Invalid access token');
    }
};

export const userLoginOAuth2 = [
    param('orgKey').trim().notEmpty(),
    param('provider').trim().notEmpty(),
    validationErrorHandler,
    async (req: Request, res: Response) => {
        // OAuth2認可エンドポイントにリダイレクト
        const { orgKey, provider } = req.params as { orgKey: string, provider: string };

        let payload: UserTokenPayloadWithRole | null = null;
        if (req.cookies.access_token) {
            // クッキーが存在する場合の処理
            try {
                payload = await verifyAccessToken(req.cookies.access_token);
            } catch (e) {
                // アクセストークンの検証に失敗した場合の処理
            }
        } else {
            // アクセストークンが存在しない場合の処理
        }

        let userId: string | null = null;
        if (payload) {
            if (payload.orgKey !== orgKey) {
                throw new Error('OrgKey mismatch');
            } else {
                // アクセストークンが有効な場合の処理
                userId = payload.id;
            }
        } else {
            userId = null;
        }

        // console.log(`OAuth2 login request: ${provider} ${JSON.stringify(req.query)}`);
        const e = {} as ExtApiClient;
        try {
            Object.assign(e, await getExtApiClient(orgKey, provider));
        } catch (error) {
            res.status(401).json({ error: `${provider}は認証されていません。` });
            return;
        }
        if (e.oAuth2Config) {
        } else {
            res.status(401).json({ error: 'OAuth2 config not found' });
            return;
        }
        // パスによってリダイレクトURIを振り分ける
        const redirectUri = e.redirectUri;
        const xRealIp = req.ip;
        let state = randomUUID();
        const maxAge = 5 * 60 * 1000; // 5分
        await ds.transaction(async tm => {
            const repo = tm.getRepository(OAuthStateEntity);
            const existing = await repo.findOneBy({ orgKey, state });
            if (existing) {
                // 一応1回はチェックするが、まず衝突しないのでループにはしない
                state = randomUUID();
                const existing = await repo.findOneBy({ orgKey, state });
                if (existing) {
                    throw new Error('OAuth state already exists');
                } else { }
            } else { }
            const saved = await repo.save({
                orgKey, state, userId, meta: {
                    orgKey,
                    userId,
                    provider,
                    redirectUri,
                    query: req.query
                },
                provider,
                expiresAt: new Date(Date.now() + maxAge),
                status: OnetimeStatus.Unused,
                createdBy: userId || xRealIp,
                createdIp: xRealIp,
                updatedBy: userId || xRealIp,
                updatedIp: xRealIp,
            });
        });

        const pathAuthorize = `${e.oAuth2Config.pathAuthorize.startsWith('https://') ? '' : (e.uriBaseAuth || e.uriBase)}${e.oAuth2Config.pathAuthorize}`;
        const authURL = `${pathAuthorize}?client_id=${e.oAuth2Config.clientId}&response_type=code&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${e.oAuth2Config.scope}&state=${state}&access_type=offline&prompt=consent`;
        res.redirect(authURL);
    }
];

// トークン検証用ヘルパー関数（Promise化でスッキリさせることも可能）
export function verifyJwt<T>(token: string, secret: string, tokenType?: string): Promise<T> {
    return new Promise((resolve, reject) => {
        jwt.verify(token, secret, JWT_STAT_PARAM, (err: any, decoded: any) => {
            if (err) return reject(err);
            resolve(decoded);
        });
    });
}

/**
 *  リフレッシュトークンを使ってアクセストークンを再発行する
 * @param req 
 * @param res 
 * @param refreshToken 
 * @returns 
 */
export async function tryRefreshCore(tm: EntityManager, xRealIp: string, deviceInfo: Record<string, any>, token: string, roleType: UserRoleType = UserRoleType.User):
    Promise<{ userTokenPayload: UserTokenPayloadWithRole, accessToken: String, refreshToken: String, sid: string }> {

    const repo = tm.getRepository(SessionRefreshEntity);

    if (!token) throw new Error("Refresh token is missing");

    const [jti0, verifier0] = token.split('.'); // 形式チェックのために分割
    const existing = await repo.findOneOrFail({ where: { jti: jti0 } });
    if (!existing || existing.revoked || !existing.current || new Date() > existing.expiresAt) {
        throw new Error("Invalid refresh token");
    } else { }

    // 有効なら新しいアクセストークンを発行するなどの処理
    const session = await tm.findOneOrFail(SessionEntity, { where: { orgKey: existing.orgKey, id: existing.sid, userId: existing.userId } });

    const match = await verifyRefresh(verifier0, existing.salt, existing.hash);
    existing.current = false;
    existing.updatedBy = existing.userId;
    existing.updatedIp = xRealIp; // IPアドレスを記録
    session.updatedBy = existing.userId;
    session.updatedIp = xRealIp; // IPアドレスを記録
    if (!match) {
        // 再利用検知：このセッションは乗っ取られた可能性
        existing.revoked = true;
        await repo.save(existing); // セッションを無効化
        await repo.update({ orgKey: existing.orgKey, userId: existing.userId, sid: existing.sid, revoked: false }, { current: false, revoked: true, updatedBy: existing.userId, updatedIp: xRealIp });

        session.status = SessionStatus.Revoked;
        tm.getRepository(SessionEntity).save(session);
        throw new Error("Token reuse detected");
    } else { }

    existing.rotatedAt = new Date();
    await repo.save(existing); // セッションを無効化

    const { jti, verifier, salt, hash } = await genTokenSet();

    const newRow = new SessionRefreshEntity();
    newRow.sid = existing.sid;
    newRow.userId = existing.userId;
    newRow.authGeneration = existing.authGeneration;
    newRow.jti = jti;      // ★ Buffer(16)
    newRow.hash = hash;    // ★ Buffer(32)
    newRow.salt = salt;    // ★ Buffer(16)
    newRow.current = true;
    newRow.revoked = false;
    newRow.expiresAt = existing.expiresAt;
    newRow.deviceInfo = deviceInfo;

    newRow.orgKey = existing.orgKey;
    newRow.createdBy = existing.createdBy;
    newRow.updatedBy = xRealIp;
    newRow.createdIp = existing.createdIp;
    newRow.updatedIp = xRealIp;

    await repo.save(newRow);

    // -------------------------------

    const where = {
        orgKey: existing.orgKey,
        id: existing.userId,                     // JWTのユーザーIDと一致すること
        // authGeneration: existing.authGeneration, // JWTの認証世代と一致すること
        status: UserStatus.Active, // activeユーザーじゃないと使えない
    } as Record<string, any>;

    const userRoleWhere = {
        orgKey: existing.orgKey,
        userId: existing.userId,
        status: UserStatus.Active, // activeユーザーじゃないと使えない
    };
    // userRoleListの取得
    const userRoleList: UserRole[] = (await tm.find(UserRoleEntity, { where: userRoleWhere })).map(roleBinding => {
        return {
            // orgKey: roleBinding.orgKey,
            // userId: roleBinding.userId,
            scopeInfo: roleBinding.scopeInfo,
            role: roleBinding.role,
        } as UserRole;
    });
    if (userRoleList.length === 0) {
        throw new Error(`User role not found: ${existing.userId}`);
    } else { }

    // ユーザーの存在確認
    const user = await tm.findOneOrFail(UserEntity, { where });

    // roleTypeのチェック
    if (userRoleList.find(userRole => userRole.role === roleType)) {
    } else {
        throw new Error(`User role not found: ${existing.userId}`); // 管理者権限がない
    }

    // authGenerationのチェック
    if (user.authGeneration !== existing.authGeneration) {
        throw new Error(`Auth generation mismatch: ${existing.userId}`);
    } else { }

    // 最終更新日だけ更新して更新
    session.lastActiveAt = new Date();
    session.updatedBy = user.id;
    session.updatedIp = xRealIp;
    const savedSession = await tm.save(SessionEntity, session);

    // JWTの生成
    const userTokenPayload: UserTokenPayload =
    {
        type: 'user', id: user.id, orgKey: user.orgKey, authGeneration: user.authGeneration ?? 0,
        sid: existing.sid, jti: existing.jti,
    };

    // アクセストークン（短寿命）に orgKey と sid を入れる
    const accessToken = jwt.sign(userTokenPayload,
        ACCESS_TOKEN_JWT_SECRET, { expiresIn: ACCESS_TOKEN_EXPIRES_IN, ...JWT_STAT_PARAM }
    );

    // クライアントへ渡す不透明トークン（split形式）
    const newRefreshToken = `${jti}.${verifier}`;

    // アクセストークンのペイロードは最小限にするためにroleListはjwtに含めない。jwt作った後で追加する。
    const userTokenPayloadWithRole = { ...userTokenPayload, roleList: userRoleList };
    return { userTokenPayload: userTokenPayloadWithRole, accessToken, refreshToken: newRefreshToken, sid: existing.sid };
}

/**
 * [認証不要] ユーザーログイン
 * @param req 
 * @param res 
 * @returns 
 */
export const userLoginOAuth2Callback = [
    query('code').isString().trim().notEmpty(),  // .withMessage('メールアドレスを入力してください。'),
    query('state').isString().trim().notEmpty(),  // .withMessage('メールアドレスを入力してください。'),
    validationErrorHandler,
    async (req: Request, res: Response) => {
        // console.log('OAuth2 callback');

        const { code, state } = req.query as { code: string, state: string };

        const ipAddress = req.ip || '';
        try {
            // awaitをつけておかないと、例外が発生してもcatchされない。
            await ds.transaction(async manager => {

                // OAuthステートを検証
                // TODO 本当はorgKeyを入れて検証したいけどどこから取るのか？pathに入れるべきだった？
                const existing = await manager.getRepository(OAuthStateEntity).findOneBy({ state });
                if (existing && existing.status === OnetimeStatus.Unused && existing.expiresAt > new Date()) {
                } else {
                    res.status(401).json({ error: 'Invalid or expired OAuth state' });
                    return;
                }

                // ステータスを「使用済み」に更新
                existing.status = OnetimeStatus.Used;
                await manager.save(existing);

                // OAuthクライアントを取得
                const e = {} as ExtApiClient;
                try {
                    Object.assign(e, await getExtApiClient(existing.orgKey, existing.provider));
                } catch (error) {
                    res.status(401).json({ error: `${existing.provider}は認証されていません。` });
                    return;
                }

                if (!e || !e.oAuth2Config) {
                    res.status(400).json({ error: 'Provider not found' });
                    return;
                } else { }

                const postData = { client_id: e.oAuth2Config.clientId, client_secret: e.oAuth2Config.clientSecret, grant_type: 'authorization_code', code, redirect_uri: `${e.redirectUri}` };
                let params = null, body = null;
                if (e.oAuth2Config.postType === 'params') {
                    params = postData;
                } else {
                    body = postData;
                }

                const pathAccessToken = e.oAuth2Config.pathAccessToken.startsWith('https://') ? e.oAuth2Config.pathAccessToken : `${e.uriBase}${e.oAuth2Config.pathAccessToken}`;
                const pathUserInfo = e.pathUserInfo.startsWith('https://') ? e.pathUserInfo : `${e.uriBase}${e.pathUserInfo}`;

                // アクセストークンを取得するためのリクエスト
                // const token = await e.axios.post<OAuth2TokenDto>(`${e.uriBase}${e.pathAccessToken}`, body, { params });
                const axios = await getAxios(e.uriBase);
                let token = null;
                if (params) {
                    token = await axios.post<OAuth2TokenDto>(pathAccessToken, {}, { params });
                } else {
                    token = await axios.post<OAuth2TokenDto>(pathAccessToken, body, { headers: { 'Content-Type': 'application/json' }, });
                }
                const accessToken = token.data.access_token;
                // console.log(`token=${JSON.stringify(token.data)}`);

                // APIを呼び出してみる
                const userInfo = await axios.get<{ id: string, username?: string, email: string, login?: string }>(pathUserInfo, {
                    headers: { Authorization: `Bearer ${accessToken}` }
                });
                const oAuthUserInfo = userInfo.data;
                // console.log(JSON.stringify(oAuthUserInfo));

                // ここはちょっとキモイ。。けど複数を纏めているから仕方ない。。
                if (e.type === 'box') {
                    // boxはcu認証なのでcuを外してemailに入れる。
                    oAuthUserInfo.email = oAuthUserInfo.login?.replace('@cu.', '@') || '';
                } else if (e.oAuth2Config.requireMailAuth) {
                    // 独自のメール認証をしているプロバイダーはメアドも仮の可能性がある
                    oAuthUserInfo.email = oAuthUserInfo.email.replaceAll(/@localhost$/g, `@${MAIL_DOMAIN_WHITELIST.split(',')[0]}`) || '';
                } else { }

                // emailを事実上の鍵として紐づけに行くので、メアドが変なやつじゃないかはちゃんとチェックする。
                if (MAIL_DOMAIN_WHITELIST.split(',').find(domain => oAuthUserInfo.email.endsWith(`@${domain}`))) {
                } else {
                    // whiltelist登録されているドメインのアドレス以外は登録禁止。
                    throw new Error(JSON.stringify({
                        error: "Invalid email",
                        message: "whitelist登録されているドメインのアドレス以外は登録禁止です。",
                        details: {
                            attemptedEmail: oAuthUserInfo.email,
                        }
                    }));
                }

                if (existing.userId) {
                    const authenticatedUser = await manager.getRepository(UserEntity).findOne({
                        select: { email: true },
                        where: { orgKey: existing.orgKey, id: existing.userId }
                    });
                    if (authenticatedUser && authenticatedUser.email !== oAuthUserInfo.email) {
                        // emailが一致するユーザーじゃないと紐づけさせない。
                        throw new Error(JSON.stringify({
                            error: "Invalid email",
                            message: `ログイン中のユーザーと異なるemailを持つアカウントとは紐づけできません。${e.provider}をログアウトしてから再度試してください。`,
                            details: {
                                provider: e.provider,
                                authenticatedUserEmail: authenticatedUser.email,
                                targetEmail: oAuthUserInfo.email
                            }
                        }));
                    } else {
                        // 既にログインしているユーザーと同じメールアドレスの場合は何もしない。
                    }
                } else { /** 未ログインのばあいは何もしない */ }

                // console.log(oAuthUserInfo.email);
                // emailを事実上の鍵として紐づけに行く。
                let { user, roleList } = await getUserAndRoleList({ orgKey: existing.orgKey, email: oAuthUserInfo.email });
                // console.log('LINK::');
                // console.log(user);
                if (user) {
                    // 既存ユーザーの場合は何もしない。
                } else {
                    // 新規ユーザーの場合は登録する
                    user = new UserEntity();
                    user.name = oAuthUserInfo.username || oAuthUserInfo.email.split('@')[0];
                    // jwtの検証で取得した情報をそのまま登録する
                    user.email = oAuthUserInfo.email;
                    user.orgKey = existing.orgKey;
                    user.createdBy = ipAddress; // 作成者はIP
                    user.updatedBy = ipAddress; // 更新者はIP
                    user.createdIp = ipAddress;
                    user.updatedIp = ipAddress;

                    // 本当はメール認証できてないのにユーザー登録してしまうのはいかがなものか、、だけどそんなに害もないし、難しくなるのでこのままにする。
                    user = await manager.getRepository(UserEntity).save(user);
                    roleList = (await createUserInitial(ipAddress, user, manager)).roleList; // ユーザー初期作成に伴う色々作成
                }
                // oAuthの一意キー
                const oAuthKey = { orgKey: existing.orgKey, provider: existing.provider, userId: user.id, providerUserId: oAuthUserInfo.id };
                let oAuthAccount = await manager.getRepository(OAuthAccountEntity).findOne({ where: oAuthKey });
                if (oAuthAccount) {
                    // 既存の場合
                    oAuthAccount.userInfo = oAuthUserInfo;
                    oAuthAccount.status = OAuthAccountStatus.ACTIVE; // 有効にする
                } else {
                    // 新規の場合
                    oAuthAccount = new OAuthAccountEntity();
                    oAuthAccount.provider = oAuthKey.provider;
                    oAuthAccount.userId = oAuthKey.userId;
                    oAuthAccount.providerUserId = oAuthKey.providerUserId;
                    oAuthAccount.providerEmail = oAuthUserInfo.email;
                    oAuthAccount.userInfo = oAuthUserInfo;
                    oAuthAccount.orgKey = existing.orgKey;
                    oAuthAccount.createdBy = user.id;
                    oAuthAccount.createdIp = ipAddress;
                }

                // console.dir(token);

                // トークンは暗号化して保存する。

                // アクセストークン
                oAuthAccount.accessToken = token.data.access_token ? encrypt(token.data.access_token) : token.data.access_token;
                // リフレッシュトークン
                oAuthAccount.refreshToken = token.data.refresh_token ? encrypt(token.data.refresh_token) : token.data.refresh_token;
                // IDトークン
                oAuthAccount.idToken = token.data.id_token ? encrypt(token.data.id_token) : token.data.id_token;

                oAuthAccount.tokenBody = token.data;
                // 現在の時刻にexpiresInSeconds（秒）を加算して、有効期限のDateオブジェクトを作成
                if (token.data.expires_in) {
                    oAuthAccount.tokenExpiresAt = new Date(Date.now() + token.data.expires_in * 1000);
                } else { /** expiresは設定されていないこともある。 */ }
                oAuthAccount.updatedBy = user.id;
                oAuthAccount.updatedIp = ipAddress;

                if (e.oAuth2Config.requireMailAuth === false) {
                    // 追加メール認証不要
                    // 保存
                    if (existing.provider.startsWith('mattermost-')) {
                        // // mattermost の認証トークンは保存しないようにする。
                        // token.data.access_token = `dummy`;
                        // token.data.refresh_token = `dummy`;
                        // oAuthAccount.accessToken = token.data.access_token;
                        // oAuthAccount.refreshToken = token.data.refresh_token;
                        // oAuthAccount.tokenBody = JSON.stringify(token.data);
                        // cookie に MMAUTHTOKEN としてセットしておけばトークン使わずに行ける。
                        // const prefix = req.originalUrl.substring(0, req.originalUrl.length - req.url.length);
                        // const proxyPath = `${prefix}/${e.provider.split('-')[0]}/${e.name}`;
                        // console.log(proxyPath);
                        res.cookie('MMAUTHTOKEN', accessToken, {
                            maxAge: Utils.parseTimeStringToMilliseconds(`1y`), // ミリ秒単位で指定
                            httpOnly: true, // クッキーをHTTPプロトコルのみでアクセス可能にする
                            secure: true, // HTTPSでのみ送信されるようにする
                            sameSite: 'strict', // CSRF保護のためのオプション
                        });
                    } else {
                    }
                    const savedOAuthAccount = await manager.getRepository(OAuthAccountEntity).save(oAuthAccount);
                    // トークン発行
                    await authAfter(user, roleList, manager, existing.provider, oAuthKey, req, res);
                    // レスポンス
                    try {
                        // console.log(`OAuth2 login success: ${existing.provider} ${oAuthUserInfo.email} ${existing.meta?.query.fromUrl || e.pathTop}`);
                        console.log(`OAuth2 login success: provider=${existing.provider}, userId=${user.id}`);
                        // res.redirect(`${existing.meta?.query.fromUrl || e.pathTop}`);
                        // // HTMLをクライアントに送信
                        // res.send(`<!DOCTYPE html><html><head><title>リダイレクト中...</title><meta http-equiv="refresh" content="0; URL=${decoded.query.fromUrl || e.pathTop}"></head><body><p>リダイレクト中です。しばらくお待ちください。</p></body></html>`);
                        res.send(redirectingPage(existing.meta?.query.fromUrl || e.pathTop));
                        return;
                    } catch (err) {
                        throw new Error(`OAuth2 flow state verification failed. ${err}`);
                    }
                } else {
                    if (oAuthAccount.id) {
                        // 既存の場合は敢えてpendingにすることもないかな。。。
                    } else {
                        // 新規登録の場合、メール認証が終わるまではPENDINGにしておく。
                        oAuthAccount.status = OAuthAccountStatus.PENDING;
                    }
                    // 保存
                    const savedOAuthAccount = await manager.getRepository(OAuthAccountEntity).save(oAuthAccount);
                    // 
                    const pincode = generateSecureRandomNumber(6);

                    // 一時トークンの生成
                    const onetimeToken = generateOnetimeToken();
                    // ワンタイムトークンの登録
                    const inviteEntity = new InviteEntity();
                    inviteEntity.email = oAuthUserInfo.email;
                    inviteEntity.onetimeToken = onetimeToken;
                    inviteEntity.type = 'oauth2MailAuth';
                    inviteEntity.status = OnetimeStatus.Unused;
                    inviteEntity.data = { name: '', email: oAuthUserInfo.email, pincode, oAuthAccountId: savedOAuthAccount.id, orgKey: existing.orgKey, userId: user.id };
                    inviteEntity.expiresAt = new Date(Date.now() + Utils.parseTimeStringToMilliseconds(MAIL_EXPIRES_IN));
                    inviteEntity.orgKey = existing.orgKey;
                    inviteEntity.createdBy = ipAddress;
                    inviteEntity.updatedBy = ipAddress;
                    inviteEntity.createdIp = ipAddress;
                    inviteEntity.updatedIp = ipAddress;
                    await inviteEntity.save();

                    // メール送信
                    sendMail(oAuthUserInfo.email, 'メール認証依頼', `認証要求がありました。\n${FRONT_BASE_URL}/#${OAUTH2_PATH_MAIL_AUTH}/${onetimeToken}\n\nお心当たりのない場合は無視してください。`)
                        .then(_ => {
                            // pincodeをcookieにつけておく。（同じブラウザであれば手入力しなくて済むように）
                            res.cookie('pincode', pincode, { maxAge: Utils.parseTimeStringToMilliseconds(MAIL_EXPIRES_IN), httpOnly: true, secure: true, sameSite: 'strict', });
                            // トークン発行はせずに追加のメール認証が必要である旨のページに飛ばす
                            res.redirect(`${FRONT_BASE_URL}/#${OAUTH2_PATH_MAIL_MESSAGE}/${pincode}`);
                            // res.send(`<!DOCTYPE html><html><head><title>リダイレクト中...</title><meta http-equiv="refresh" content="0; URL=${FRONT_BASE_URL}/#${OAUTH2_PATH_MAIL_MESSAGE}/${pincode}"></head><body><p>リダイレクト中です。しばらくお待ちください。</p></body></html>`);
                            // res.json({ message: 'パスワード設定依頼メールを送信しました。' });
                        })
                        .catch(error => {
                            res.json({ message: `メール送信に失敗しました。` });
                            console.log(error);
                        });
                }
            });
        } catch (error) {
            console.error(error);
            // console.error('Error fetching access token or user info:', error.response ? error.response.data : error.message);
            res.cookie('access_token', '', { maxAge: 0, path: '/' });
            const baseHref = req.originalUrl.substring(0, req.originalUrl.length - req.url.length);
            res.cookie('refresh_token', '', {
                maxAge: 0,
                path: `${baseHref}/auth/refresh`, // トークンリフレッシュのタイミングのみ使う。
            });
            res.status(500).send('Error during authentication.');
        }
    }
];

const getUserAndRoleList = async (_where: { orgKey: string, id: string } | { orgKey: string, email: string }, manager?: EntityManager): Promise<{ user: UserEntity | null, roleList: UserRole[] }> => {
    // const user = await (manager || ds).getRepository(UserEntity).findOne({ where, relations: ['roleBindings'] });
    const where = { ..._where, status: UserStatus.Active }; // activeユーザーじゃないと使えない
    const user = await (manager || ds).getRepository(UserEntity).findOne({ where });
    if (!user) {
        return { user, roleList: [] };
    } else {
        const roleList = (await (manager || ds).getRepository(UserRoleEntity).find({ where: { orgKey: user.orgKey, userId: user.id, status: UserStatus.Active } })).map(roleBinding => {
            return {
                // orgKey: roleBinding.orgKey,
                // userId: roleBinding.userId,
                role: roleBinding.role,
                scopeInfo: roleBinding.scopeInfo,
            } as UserRole;
        });
        return { user, roleList };
    }
};

export const getScopeLabels = [
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req: UserRequest = _req as UserRequest;
        try {
            const { user, roleList } = await getUserAndRoleList({ orgKey: req.info.user.orgKey, id: req.info.user.id });
            if (!user) {
                res.status(404).json({ message: 'User not found' });
                return;
            }

            // roleListをscopeType/scopeIdでdistinct
            const distinctRoleMap = Array.from(new Set(roleList.map(role => `${role.scopeInfo.scopeType}/${role.scopeInfo.scopeId}`))).reduce((acc, role) => {
                const [scopeType, scopeId] = role.split('/');
                if (!acc[scopeType]) {
                    acc[scopeType] = [];
                } else { }
                // スコープIDが重複している場合は追加しない（まぁdistinctしてるので基本的に重複はないはず）
                if (!acc[scopeType].includes(scopeId)) {
                    acc[scopeType].push(scopeId);
                } else { }
                return acc;
            }, {} as Record<string, string[]>);

            // roleListに基づいて対象スコープの実体定義を取得
            const orgList = distinctRoleMap[ScopeType.ORGANIZATION] ? await ds.getRepository(OrganizationEntity).findBy({ orgKey: req.info.user.orgKey, id: In(distinctRoleMap[ScopeType.ORGANIZATION]), isActive: true }) : [];
            // if (org.length === 0) {
            //     res.status(404).json({ message: 'Organization not found' });
            //     return;
            // }
            const divisionList = distinctRoleMap[ScopeType.DIVISION] ? await ds.getRepository(DivisionEntity).findBy({ orgKey: req.info.user.orgKey, id: In(distinctRoleMap[ScopeType.DIVISION]), isActive: true }) : [];
            const projectList = distinctRoleMap[ScopeType.PROJECT] ? await ds.getRepository(ProjectEntity).findBy({ orgKey: req.info.user.orgKey, id: In(distinctRoleMap[ScopeType.PROJECT]), status: ProjectStatus.InProgress }) : [];
            const teamList = distinctRoleMap[ScopeType.TEAM] ? await ds.getRepository(TeamEntity).findBy({ orgKey: req.info.user.orgKey, id: In(distinctRoleMap[ScopeType.TEAM]), status: TeamStatus.Normal }) : [];

            // Response DTOの型定義
            interface ScopeLabelsResponse {
                scopeLabels: {
                    [ScopeType.ORGANIZATION]: { id: string, key: string, label: string, }[],
                    [ScopeType.DIVISION]: { id: string, name: string, label: string }[],
                    [ScopeType.PROJECT]: { id: string, name: string, label: string }[],
                    [ScopeType.TEAM]: { id: string, name: string, label: string }[],
                },
                roleList: { role: UserRoleType, scopeType: ScopeType, scopeId: string }[];
            }

            const response: ScopeLabelsResponse = {
                scopeLabels: {
                    [ScopeType.ORGANIZATION]: orgList.map(org => ({ id: org.id, key: org.key, label: org.label })),
                    [ScopeType.DIVISION]: divisionList.map(division => ({ id: division.id, name: division.name, label: division.label })),
                    [ScopeType.PROJECT]: projectList.map(project => ({ id: project.id, name: project.name, label: project.label })),
                    [ScopeType.TEAM]: teamList.map(team => ({ id: team.id, name: team.name, label: team.label }))
                },
                roleList: roleList.map(role => ({
                    role: role.role,
                    scopeType: role.scopeInfo.scopeType,
                    scopeId: role.scopeInfo.scopeId,
                })),
            };
            res.json(response);
        } catch (error) {
            console.error(error);
            res.status(500).json({ message: 'Internal server error' });
        }
    }
];

export const oAuthEmailAuth = [
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req: InviteRequest = _req as InviteRequest;
        const postedPincode = req.body.pincode || req.cookies.pincode;
        try {
            if (postedPincode) {
                await ds.transaction(async (manager) => {
                    // 追加メール認証不要
                    const invite = await manager.getRepository(InviteEntity).findOneOrFail({ where: { orgKey: req.info.invite.orgKey, id: req.info.invite.id } });
                    const { email, pincode, oAuthAccountId, userId } = invite.data as { email: string, pincode: string, oAuthAccountId: string, orgKey: string, userId: string };
                    if (postedPincode === pincode) {
                        // TODO inviteを閉じるのはこのタイミングが適切なのかは微妙。開いた瞬間閉じる方が良いかも？
                        await manager.getRepository(InviteEntity).findOne({ where: { orgKey: req.info.invite.orgKey, id: req.info.invite.id } }).then((invite: InviteEntity | null) => {
                            if (invite) {
                                invite.updatedBy = req.info.invite.id;
                                invite.updatedIp = req.info.ip;
                                invite.status = OnetimeStatus.Used;
                                invite.save();
                            } else {
                                // エラー。起こりえないケース
                            }
                            return invite;
                        });

                        const oAuthAccount = await manager.getRepository(OAuthAccountEntity).findOneOrFail({ where: { orgKey: req.info.invite.orgKey, id: oAuthAccountId } });
                        // activate
                        oAuthAccount.status = OAuthAccountStatus.ACTIVE;
                        oAuthAccount.updatedBy = req.info.invite.id; // inviteのIDを入れる
                        oAuthAccount.updatedIp = req.info.ip;
                        await manager.getRepository(OAuthAccountEntity).save(oAuthAccount);
                        // const user = await manager.getRepository(UserEntity).findOneOrFail({ where: { orgKey: req.info.invite.orgKey, id: userId } });
                        const { user, roleList } = await getUserAndRoleList({ orgKey: req.info.invite.orgKey, id: userId }, manager);
                        if (user) { } else { throw new Error('ユーザーが見つかりません。'); }

                        // トークン発行
                        const oAuthKey = { provider: oAuthAccount.provider, userId, providerUserId: oAuthAccount.providerUserId };
                        await authAfter(user, roleList, manager, oAuthAccount.provider, oAuthKey, req, res);
                        // レスポンス
                        res.json({ role: user.role, name: user.name, email: user.email, id: user.id });
                        // Pending中かどうかで処理分けようと思ったけどやめた。inviteの消化で代替できてる。
                        // if (oAuthAccount.status === OAuthAccountStatus.PENDING) {
                        // } else {
                        //     // TODO activate済みの場合はログイン画面に飛ばす→Cookieが付いてれば自動でログインされるはず。
                        //     throw new Error('既にactivate済み');
                        // }
                    } else {
                        throw new Error('pincode不一致');
                    }
                });
            } else {
                throw new Error('pincode無し');
            }
        } catch (e) {
            console.log(e);
            res.status(403).send('Error during authentication');
        }
    }
];

function generateSecureRandomNumber(len: number) {
    const n = randomInt(0, 10 ** len);
    return String(n).padStart(len, '0');
}

/**
 * [認証不要] ゲストログイン
 * @param req 
 * @param res 
 * @returns 
 */
export const guestLogin = [
    validationErrorHandler,
    (req: Request, res: Response) => {
        // return ds.getRepository(UserEntity).findOne({ where: { email: 'guest@example.com' } }).then((user: UserEntity | null) => {
        //     // ゲストログインはパスワード検証無し。その代わりIPアドレス必須。
        //     if (user == null) {
        //         res.status(401).json({ message: '認証に失敗しました。' });
        //         return;
        //     }
        //     // ゲスト
        //     const deviceInfo = JSON.stringify({
        //         browser: req.useragent?.browser,
        //         version: req.useragent?.version,
        //         os: req.useragent?.os,
        //         platform: req.useragent?.platform,
        //         isMobile: req.useragent?.isMobile,
        //         isTablet: req.useragent?.isTablet,
        //         isDesktop: req.useragent?.isDesktop,
        //     });

        //     const loginHistory = new LoginHistoryEntity();
        //     loginHistory.userId = user.id; // ユーザー認証後に設定
        //     loginHistory.ipAddress = req.headers['x-real-ip'] as string || req.ip || '';
        //     loginHistory.deviceInfo = deviceInfo;
        //     loginHistory.authGeneration = user.authGeneration;
        //     loginHistory.createdBy = user.id;
        //     loginHistory.updatedBy = user.id;
        //     loginHistory.save(); // ログイン履歴登録の成否は見ずにレスポンスを返す

        //     // JWTの生成
        //     const userToken: UserToken = { type: 'user', id: user.id, authGeneration: user.authGeneration || 0 };
        //     const token = jwt.sign(userToken, JWT_SECRET, { expiresIn: '20m' , ...JWT_STAT_PARAM });
        //     res.json({ token, user });
        //     // return { token };
        // });
    }
];
export const logout = [
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        res.cookie('access_token', '', {
            maxAge: 0, // 有効期限を0にすることで即座に削除
            httpOnly: true,
            secure: true,
            sameSite: 'strict',
        });
        const baseHref = req.originalUrl.substring(0, req.originalUrl.length - req.url.length);
        res.cookie('refresh_token', '', {
            path: `${baseHref}/auth/refresh`, // トークンリフレッシュのタイミングのみ使う。
            maxAge: 0, // 有効期限を0にすることで即座に削除
            httpOnly: true,
            secure: true,
            sameSite: 'strict',
        });

        await ds.transaction(async (manager) => {
            const repo = manager.getRepository(SessionRefreshEntity);
            const row = await repo.findOne({ where: { orgKey: req.info.user.orgKey, userId: req.info.user.id, sid: req.info.user.sid, jti: req.info.user.jti } });
            if (row) {
                // 該当セッション全体を失効
                const sessRepo = manager.getRepository(SessionEntity);
                const sess = await sessRepo.findOne({ where: { orgKey: row.orgKey, userId: req.info.user.id, id: row.sid } });
                if (sess) {
                    sess.expiresAt = new Date();
                    sess.status = SessionStatus.Expired;
                    await sessRepo.save(sess);
                }
                // 既存の current を全て revoke
                await repo.update({ orgKey: row.orgKey, userId: req.info.user.id, sid: row.sid, current: true, revoked: false }, { current: false, revoked: true, updatedBy: req.info.user.id, updatedIp: req.ip || '0.0.0.0' });
            }
        });
        return res.sendStatus(204);
    }
];

/**
 * [認証不要] ワンタイムトークンの検証
 * @param req 
 * @param res 
 * @returns 
 */
export const onetimeLogin = [
    param('orgKey').trim().notEmpty(),
    body('type').trim().notEmpty(),  // .withMessage('ワンタイムトークンのタイプを入力してください。'),
    body('token').trim().notEmpty(),  // .withMessage('ワンタイムトークンを入力してください。'),
    validationErrorHandler,
    (req: Request, res: Response) => {
        const { orgKey } = req.params as { orgKey: string };
        ds.getRepository(InviteEntity).findOne({
            where: {
                orgKey,
                onetimeToken: req.body.token as string,
                status: OnetimeStatus.Unused,
                type: req.body.type,
                expiresAt: MoreThan(new Date()),
            },
        }).then((onetimeModel: InviteEntity | null) => {
            if (onetimeModel == null) {
                res.status(403).json({ message: 'ワンタイムトークンが見つかりませんでした。' });
                return;
            } else {
                const inviteToken: InviteTokenPayload = {
                    orgKey,
                    type: 'invite',
                    id: onetimeModel.id,
                };
                // JWTの生成
                const jwtToken = jwt.sign(inviteToken, ONETIME_TOKEN_JWT_SECRET, { expiresIn: ONETIME_TOKEN_EXPIRES_IN, ...JWT_STAT_PARAM });
                res.json({ token: jwtToken });
            }
        });
    }
];

/**
 * [認証不要] パスワード設定用のワンタイムトークンを発行する
 * @param req 
 * @param res 
 * @returns 
 */
export const requestForPasswordReset = [
    param('orgKey').trim().notEmpty(),
    body('email').trim().notEmpty().isEmail(),  // .withMessage('メールアドレスを入力してください。'),
    validationErrorHandler,
    async (req: Request, res: Response) => {
        const { orgKey } = req.params as { orgKey: string };

        // emailを事実上の鍵として紐づけに行くので、メアドが変なやつじゃないかはちゃんとチェックする。
        if (MAIL_DOMAIN_WHITELIST.split(',').find(domain => req.body.email.endsWith(`@${domain}`))) {
        } else {
            // whiltelist登録されているドメインのアドレス以外は登録禁止。
            res.status(403).json({ message: `${MAIL_DOMAIN_WHITELIST} 以外のメールアドレスは受け付けられません。` });
            return;
        }

        // 一時トークンの生成
        const onetimeToken = generateOnetimeToken();
        // ワンタイムトークンの登録
        const inviteEntity = new InviteEntity();
        inviteEntity.email = req.body.email;
        inviteEntity.onetimeToken = onetimeToken;
        inviteEntity.type = 'passwordReset';
        inviteEntity.status = OnetimeStatus.Unused;
        inviteEntity.data = { name: req.body.name, email: req.body.email };
        inviteEntity.expiresAt = new Date(Date.now() + Utils.parseTimeStringToMilliseconds(MAIL_EXPIRES_IN));
        inviteEntity.orgKey = orgKey;
        inviteEntity.createdBy = req.ip || '0.0.0.0';
        inviteEntity.updatedBy = req.ip || '0.0.0.0';
        inviteEntity.createdIp = req.ip || '0.0.0.0';
        inviteEntity.updatedIp = req.ip || '0.0.0.0';
        await inviteEntity.save();

        // メール送信
        sendMail(req.body.email, 'パスワード設定依頼', `以下のURLからパスワード設定を完了してください。\n${FRONT_BASE_URL}/#/invite/${onetimeToken}`)
            .then(_ => {
                res.json({ message: 'パスワード設定依頼メールを送信しました。' });
            })
            .catch(error => {
                res.json({ message: error });
            });
        // res.json({ onetimeToken }); // デバッグ用：メールサーバー無いときはレスポンスでワンタイムトークンを渡してしまう。セキュリティホール。
    }
];

/**
 * [invite認証] パスワード設定
 * @param req 
 * @param res 
 * @returns 
 */
export const passwordReset = [
    body('password').trim().notEmpty(),  // .withMessage('パスワードを入力してください。'),
    body('passwordConfirm').trim().notEmpty(),  // .withMessage('パスワード(確認)を入力してください。'),
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as InviteRequest;

        const passwordValidationMessage = passwordValidation(req.body.password, req.body.passwordConfirm);
        if (!passwordValidationMessage.isValid) {
            res.status(400).json(passwordValidationMessage);
            return;
        } else {
            // 継続
        }

        let isCreate = false;
        await ds.transaction(async manager => {
            // パスワード設定（emailが事実上の鍵）
            // return manager.getRepository(UserEntity).findOne({ where: { orgKey: req.info.invite.orgKey, email: req.info.invite.email } }).then((user: UserEntity | null) => {
            const inviteEntity = await manager.getRepository(InviteEntity).findOneByOrFail({ id: req.info.invite.id, orgKey: req.info.invite.orgKey, status: OnetimeStatus.Unused });

            const userAndRoleList = await getUserAndRoleList({ orgKey: req.info.invite.orgKey, email: inviteEntity.email }, manager);
            let user = userAndRoleList.user;
            if (user) {
                // 既存ユーザーの場合はパスワードを更新する
                // パスワードのハッシュ化
                user.passwordHash = await bcrypt.hash(req.body.password, 10);
                user.authGeneration = (user.authGeneration || 0) + 1;
            } else {
                isCreate = true;
                // 初期名前をメールアドレスにする。エラーにならないように。。
                req.body.name == req.body.name || inviteEntity.email;
                // 新規ユーザーの場合は登録する
                user = new UserEntity();
                user.name = req.body.name;
                user.name = user.name || 'dummy name';
                user.name = inviteEntity.email.split('@')[0]; // メールアドレス前半
                // jwtの検証で取得した情報をそのまま登録する
                user.email = inviteEntity.email;
                // パスワードのハッシュ化
                user.passwordHash = await bcrypt.hash(req.body.password, 10);
                user.authGeneration = 1;
                user.orgKey = req.info.invite.orgKey; // orgKeyはinviteから取得する
                user.createdBy = req.info.invite.id; // 作成者はinvite
                user.createdIp = req.info.ip;
            }
            user.updatedBy = req.info.invite.id; // 更新者はinvite
            user.updatedIp = req.info.ip;
            userAndRoleList.user = user;

            userAndRoleList.user = await manager.getRepository(UserEntity).save(userAndRoleList.user);
            if (isCreate) {
                userAndRoleList.roleList = (await createUserInitial(req.info.ip, userAndRoleList.user, manager)).roleList; // ユーザー初期作成に伴う色々作成
            } else {
            }
            const invite = await manager.getRepository(InviteEntity).findOne({ where: { orgKey: req.info.invite.orgKey, id: req.info.invite.id } });
            if (invite) {
                invite.status = OnetimeStatus.Used;
                invite.updatedIp = req.info.ip;
                invite.save();
            } else {
                // エラー。起こりえないケース
            }

            await authAfter(userAndRoleList.user, userAndRoleList.roleList, manager, 'local', { authGeneration: userAndRoleList.user.authGeneration }, req, res);
            const roleList = userAndRoleList.roleList.map(obj => ({ scopeInfo: obj.scopeInfo, role: obj.role, priority: obj.priority })); // レスポンス用に整形);
            const resUser = { id: userAndRoleList.user.id, name: userAndRoleList.user.name, email: userAndRoleList.user.email, roleList: roleList };
            res.json({ message: 'パスワードを設定しました。', user: resUser });
        }).catch((err) => {
            console.error(err);
            res.status(500).json({ message: 'パスワード設定に失敗しました。' });
        });
    }
];

/**
 * [user認証] 自分のユーザー情報取得
 */
export const getUser = [
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        // console.log('req');
        // console.dir(req.info);
        // email と name を取得する。
        try {
            const user = await ds.getRepository(UserEntity).findOneOrFail({ where: { orgKey: req.info.user.orgKey, id: req.info.user.id, status: UserStatus.Active } });
            res.json({ user: { ...req.info.user, email: user.email, name: user.name } });
        } catch (error) {
            // console.error(error);
            res.status(500).json({ message: 'ユーザー情報の取得に失敗しました。' });
        }
    }
];

export const refresh = [
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        try {
            const req = _req as UserRequest;

            const xRealIp = req.ip || '';
            let deviceInfo = {};
            if (req.useragent) {
                deviceInfo = Utils.jsonOrder(req.useragent, ['browser', 'version', 'os', 'platform', 'isDesktop', 'isMobile', 'isTablet']);
            } else { }

            const { userTokenPayload, accessToken } = await ds.transaction(async manager => {
                // リフレッシュトークン検証
                const coreRes = await tryRefreshCore(manager, xRealIp, deviceInfo, req.cookies.refresh_token, UserRoleType.User);
                // クッキーをセット
                res.cookie('access_token', coreRes.accessToken, {
                    maxAge: Utils.parseTimeStringToMilliseconds(ACCESS_TOKEN_EXPIRES_IN), // ミリ秒単位で指定
                    httpOnly: true, // クッキーをHTTPプロトコルのみでアクセス可能にする
                    secure: true, // HTTPSでのみ送信されるようにする
                    sameSite: 'strict', // CSRF保護のためのオプション
                });

                // Cookieにセット（Pathをリフレッシュ専用にすると攻撃面が狭まる）
                const baseHref = req.originalUrl.substring(0, req.originalUrl.length - req.url.length);
                res.cookie('refresh_token', coreRes.refreshToken, {
                    path: `${baseHref}/auth/refresh`, // トークンリフレッシュのタイミングのみ使う。
                    maxAge: Utils.parseTimeStringToMilliseconds(REFRESH_TOKEN_EXPIRES_IN),
                    httpOnly: true,
                    secure: true,
                    sameSite: 'strict',
                });
                return coreRes;
            });

            // // console.log(`ref:userToken=${JSON.stringify(userTokenPayload, Utils.genJsonSafer())}`);
            // (req as UserRequest).info = { user: userTokenPayload, ip: xRealIp, cookie: req.cookies };
            // return { isAuth: true, obj: userTokenPayload };
            res.json({ message: 'トークンをリフレッシュしました。', user: userTokenPayload, isAuth: true });
        } catch (err) {
            // // リフレッシュトークン無し
            console.log(`リフレッシュトークンの検証に失敗しました。`);
            // console.log(err);
            res.status(401).json({ message: 'トークンの検証に失敗しました。再度ログインしてください。' });
        }
    }
];

/**
 * [user認証] ユーザー情報更新
 */
export const updateUser = [
    body('name').trim().notEmpty(),  // .withMessage('名前を入力してください。'),
    validationErrorHandler,
    (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        ds.getRepository(UserEntity).findOne({ where: { orgKey: req.info.user.orgKey, id: req.info.user.id } }).then((user: UserEntity | null) => {
            if (user == null) {
                res.status(400).json({ message: 'ユーザーが見つかりませんでした。' });
                return;
            } else {
                // ユーザー情報の更新（名前以外は更新できないようにしておく）
                user.name = req.body.name;
                user.updatedBy = req.info.user.id;
                user.updatedIp = req.info.ip;
                user.save().then(() => {
                    const resDto = { id: user.id, name: user.name, email: user.email, role: user.role };
                    res.json({ message: 'ユーザー情報を更新しました。', resDto });
                });
            }
        });
    }
];

/**
 * [user認証] パスワード変更
 */
export const changePassword = [
    body('password').trim().notEmpty(),
    body('passwordConfirm').trim().notEmpty(),
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        const passwordValidationMessage = passwordValidation(req.body.password, req.body.passwordConfirm);
        if (!passwordValidationMessage.isValid) {
            res.status(400).json(passwordValidationMessage);
            return;
        } else {
            // 継続
        }

        // パスワード設定（emailが鍵のような役割）
        const user: UserEntity | null = await ds.getRepository(UserEntity).findOne({ where: { orgKey: req.info.user.orgKey, id: req.info.user.id } });
        if (user == null) {
            res.status(400).json({ message: 'ユーザーが見つかりませんでした。' });
            return;
        } else {
            // パスワードのハッシュ化
            user.passwordHash = await bcrypt.hash(req.body.password, 10);
            user.authGeneration = (user.authGeneration || 0) + 1;
            user.updatedBy = req.info.user.id;
            user.updatedIp = req.info.ip;
            await user.save();
            const resDto = { id: user.id, name: user.name, email: user.email, role: user.role };
            res.json({ message: 'パスワードを変更しました。', resDto });
        }
    }
];

/**
 * [user認証] ユーザー削除
 */
export const deleteUser = [
    validationErrorHandler,
    (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        // ユーザー情報の削除
        ds.getRepository(UserEntity).findOne({ where: { orgKey: req.info.user.orgKey, id: req.info.user.id } }).then((user: UserEntity | null) => {
            if (user == null) {
                res.status(400).json({ message: 'ユーザーが見つかりませんでした。' });
                return;
            } else {
                // ユーザー情報の削除
                user.remove().then(() => {
                    res.json({ message: 'ユーザー情報を削除しました。' });
                });
            }
        });
    }
];

/**
 * メール送信
 * @param to 
 * @param subject 
 * @param text 
 */
function sendMail(to: string, subject: string, text: string): Promise<void> {
    // SMTPサーバーの設定
    let transporter = nodemailer.createTransport({
        host: SMTP_SERVER,
        port: Number(SMTP_PORT),
        secure: false, // true for 465, false for other ports
        auth: {
            user: SMTP_USER, // Outlookメールアドレス
            pass: SMTP_PASSWORD, // Outlookパスワード
        },
        tls: {
            ciphers: 'SSLv3', // 暗号化方式を指定
        },
    });

    // メールを送信
    return transporter.sendMail({
        from: `"${SMTP_ALIAS}" <${SMTP_USER}@${SMTP_DOMAIN}>`,
        to,
        subject,
        text,
    }).then((info) => {
        console.log('Message sent: %s', info.messageId);
    }).catch((err) => {
        console.error(err);
    });
}

/**
 * ランダムな文字列を生成する
 * @param length 文字列の長さ
 */
function generateOnetimeToken(length: number = 15): string {
    return randomBytes(length).toString('hex');
};

/**
 * パスワードのバリデーション
 * @param password 
 * @param passwordConfirm 
 * @returns 
 */
function passwordValidation(password: string, passwordConfirm: string): { isValid: boolean, errors: string[] } {
    const minLength = 15;
    const hasUpperCase = /[A-Z]/.test(password);
    const hasLowerCase = /[a-z]/.test(password);
    const hasNumbers = /[0-9]/.test(password);
    const hasSpecialChar = /[!@#$%^&*(),.?":{}|<>]/.test(password);

    const errors: string[] = [];

    if (password != passwordConfirm) {
        errors.push('パスワードが一致しません。');
        return { isValid: errors.length === 0, errors };
    }

    if (password.length < minLength) {
        errors.push(`パスワードは ${minLength} 文字以上にしてください。`);
    }
    if (!hasUpperCase) {
        errors.push('パスワードには少なくとも1つの大文字を含めてください。');
    }
    if (!hasLowerCase) {
        errors.push('パスワードには少なくとも1つの小文字を含めてください。');
    }
    if (!hasNumbers) {
        errors.push('パスワードには少なくとも1つの数字を含めてください。');
    }
    if (!hasSpecialChar) {
        errors.push('パスワードには少なくとも1つの特殊文字を含めてください。');
    }

    return { isValid: errors.length === 0, errors };
}

/**
 * [user認証] ユーザー情報取得
 */
export const getUserList = [
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        try {
            const organization = await ds.getRepository(OrganizationEntity).findOneByOrFail({ orgKey: req.info.user.orgKey });
            const userList = await ds.getRepository(UserEntity).find({
                select: { id: true, name: true, email: true, status: true },
                where: { orgKey: req.info.user.orgKey },
            });
            res.json({ userList });
        } catch (e) {
            console.error(e);
            res.status(500).json({ error: 'Internal Server Error' });
        }
    }
];

async function createUserInitial(ip: string, user: UserEntity, manager: EntityManager): Promise<{ user: UserEntity, roleList: UserRoleEntity[] }> {
    const organization = await manager.getRepository(OrganizationEntity).findOneOrFail({ where: { orgKey: user.orgKey } });
    const role = new UserRoleEntity();
    role.userId = user.id;
    role.scopeInfo = {
        scopeId: organization.id,
        scopeType: ScopeType.ORGANIZATION,
    };
    role.role = UserRoleType.User;
    role.orgKey = user.orgKey;
    role.createdBy = user.id;
    role.updatedBy = user.id;
    role.createdIp = ip;
    role.updatedIp = ip;
    await manager.getRepository(UserRoleEntity).save(role);

    // console.log(`Create Default Projects.`);
    // デフォルトの個人用プロジェクト回りを整備
    // TODO 本来はキューとかで別ドメインに移管したい処理。
    const team = new TeamEntity();
    team.teamType = TeamType.Alone;
    team.name = user.name!;
    team.label = '個人用';
    team.description = '個人用';

    // チーム作成
    team.orgKey = user.orgKey;
    team.createdBy = user.id;
    team.updatedBy = user.id;
    team.createdIp = ip;
    team.updatedIp = ip;
    return await manager.getRepository(TeamEntity).save(team).then(savedTeam => {
        // console.log(`Create Default Projects. Team fine.`);
        // チーム作成ユーザーをメンバーとして追加
        const teamMember = new TeamMemberEntity();
        teamMember.teamId = savedTeam.id;
        teamMember.userId = user.id;
        teamMember.role = TeamMemberRoleType.Owner;
        teamMember.orgKey = user.orgKey;
        teamMember.createdBy = user.id;
        teamMember.updatedBy = user.id;
        teamMember.createdIp = ip;
        teamMember.updatedIp = ip;

        // 個人用デフォルトプロジェクト
        const projectDef = new ProjectEntity();
        projectDef.name = `${user.name}-default`;
        projectDef.teamId = savedTeam.id;
        projectDef.status = ProjectStatus.InProgress;
        projectDef.visibility = ProjectVisibility.Default;
        projectDef.description = '個人用チャットプロジェクト';
        projectDef.label = '個人用チャット';
        projectDef.orgKey = user.orgKey;
        projectDef.createdBy = user.id;
        projectDef.updatedBy = user.id;
        projectDef.createdIp = ip;
        projectDef.updatedIp = ip;

        // 個人用アーカイブ
        const projectArch = new ProjectEntity();
        projectArch.name = `${user.name}-archive`;
        projectArch.teamId = savedTeam.id;
        projectArch.status = ProjectStatus.InProgress;
        projectArch.visibility = ProjectVisibility.Team;
        projectArch.description = '古いスレッドはアーカイブに移しましょう。';
        projectArch.label = '個人用アーカイブ';
        projectArch.orgKey = user.orgKey;
        projectArch.createdBy = user.id;
        projectArch.updatedBy = user.id;
        projectArch.createdIp = ip;
        projectArch.updatedIp = ip;

        // 作成
        return Promise.all([
            manager.getRepository(TeamMemberEntity).save(teamMember),
            manager.getRepository(ProjectEntity).save(projectDef),
            manager.getRepository(ProjectEntity).save(projectArch),
        ]).then(() => ({ user, roleList: [role] }));
    })
}

/**
 * [user認証] OAuth認証済みアカウント一覧を取得
 */
export const getOAuthAccountList = [
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        try {
            const oauthAccounts = await ds.getRepository(OAuthAccountEntity).find({
                where: { orgKey: req.info.user.orgKey, userId: req.info.user.id, status: OAuthAccountStatus.ACTIVE },
                // accessTokenとかrefreshTokenは流出すると危険なので必ず絞る。
                select: ['tokenExpiresAt', 'orgKey', 'id', 'userInfo', 'provider', 'label', 'providerUserId', 'providerEmail', 'createdAt', 'updatedAt']
            });
            // console.log(oauthAccounts);
            res.json({ oauthAccounts });
        } catch (error) {
            console.error('Error fetching OAuth accounts:', error);
            res.status(500).json({ message: 'OAuth認証済みアカウントの取得中にエラーが発生しました。' });
        }
    }
];

/**
 * [user認証] OAuth認証済みアカウント一覧を取得
 */
export const getOAuthAccount = [
    param('providerType').isString().notEmpty(),
    param('providerName').isString().notEmpty(),
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        const { providerType, providerName } = req.params as { providerType: string, providerName: string };
        const provider = `${providerType}-${providerName}`;
        try {
            // const accessToken = await getAccessToken(req.info.user.id, provider);
            const oauthAccount = await ds.getRepository(OAuthAccountEntity).findOneOrFail({
                where: { orgKey: req.info.user.orgKey, userId: req.info.user.id, provider, status: OAuthAccountStatus.ACTIVE },
                // accessTokenとかrefreshTokenは流出すると危険なので必ず絞る。
                select: ['orgKey', 'id', 'userInfo', 'provider', 'label', 'providerUserId', 'providerEmail', 'createdAt', 'updatedAt']
            });
            // console.log(oauthAccounts);
            res.json({ oauthAccount });
        } catch (error) {
            // console.error('Error fetching OAuth accounts:', error);
            res.status(401).json({ message: 'OAuth認証済みアカウントが取得できませんでした。' });
        }
    }
];

/**
 * [user認証] ClaudeCode Console用プロジェクト権限チェック（nginx auth用）
 */
export const checkProjectPermission = [
    // header('X-Original-URI').notEmpty(),
    param('projectId').isUUID().notEmpty(),
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        const originalUri = req.headers['x-original-uri'] as string;
        const { projectId } = req.params as { projectId: string };

        try {
            // // URIからプロジェクトIDを抽出 (例: /api/project/xxx/files -> xxx)
            // const projectIdMatch = originalUri.match(/\/project\/([a-f0-9-]{36})/);
            // if (!projectIdMatch) {
            //     return res.status(403).json({ message: 'プロジェクトIDが見つかりません' });
            // }
            // const projectId = projectIdMatch[1];

            // プロジェクトの存在確認
            const project = await ds.getRepository(ProjectEntity).findOne({
                where: safeWhere({ orgKey: req.info.user.orgKey, id: projectId })
            });

            if (!project) {
                return res.status(404).json({ message: 'プロジェクトが見つかりません' });
            }

            // チームメンバーかどうかをチェック
            const teamMember = await ds.getRepository(TeamMemberEntity).findOne({
                where: safeWhere({
                    orgKey: req.info.user.orgKey,
                    teamId: project.teamId,
                    userId: req.info.user.id,
                    role: In([TeamMemberRoleType.Owner, TeamMemberRoleType.Admin, TeamMemberRoleType.Member])
                })
            });

            if (teamMember) {
                const user = req.info.user;
                const label = `${projectId}-${user.id}-${generateSecureRandomNumber(6)}`;
                let deviceInfo = {};
                if (req.useragent) {
                    deviceInfo = Utils.jsonOrder(req.useragent, ['browser', 'version', 'os', 'platform', 'isDesktop', 'isMobile', 'isTablet']);
                } else { }
                await ds.transaction(async (manager) => {
                    let apiTokenEntity: OAuthAccountEntity | null = null;
                    const exists = await manager.getRepository(OAuthAccountEntity).findOneBy({ orgKey: user.orgKey, userId: user.id, provider: `local-${label}` });
                    if (exists && exists.status === OAuthAccountStatus.ACTIVE) {
                        // 既存のものを消す
                        apiTokenEntity = exists;
                        exists.status = OAuthAccountStatus.DISCONNECTED;
                        await manager.getRepository(OAuthAccountEntity).save(exists); // 非同期で更新
                    } else {
                    }
                    const expirationTime = Utils.parseTimeStringToMilliseconds(API_TOKEN_FOR_CONSOLE_EXPIRES_IN);// クッキーの有効期限をミリ秒で指定
                    const ent = await genApiTokenCore(user, label, deviceInfo, req.ip || '', manager, expirationTime);
                    if (ent) {
                        apiTokenEntity = ent.entity;
                    } else {
                    }
                    if (!apiTokenEntity) {
                        res.status(400).json({ error: 'APIトークンは既に存在します。' });
                        return;
                    } else { }
                    function splitString(str: string, chunkSize = 200) {
                        const chunks = [];
                        for (let i = 0; i < str.length; i += chunkSize) {
                            chunks.push(str.slice(i, i + chunkSize));
                        }
                        return chunks;
                    }
                    splitString(encodeURIComponent(decrypt(apiTokenEntity.tokenBody?.apiKey || ''))).forEach((chunk, index) => {
                        res.setHeader(`X-API-Key_${index + 1}`, chunk);
                    });
                    res.status(200).json({ message: 'アクセス許可' });
                });
                // 権限あり
            } else {
                // 権限なし
                res.status(403).json({ message: 'プロジェクトへのアクセス権限がありません' });
            }
        } catch (error) {
            console.error('Error checking project permission:', error);
            res.status(500).json({ message: 'プロジェクト権限チェック中にエラーが発生しました' });
        }
    }
];

import { body, cookie, param, query } from 'express-validator';
import jwt from 'jsonwebtoken';
import ms from 'ms';
import bcrypt from 'bcrypt';
import { randomBytes, getRandomValues } from 'crypto';
import nodemailer from 'nodemailer';
import { Request, Response } from 'express';

import { InviteRequest, UserRequest } from '../models/info.js';
import { UserEntity, InviteEntity, LoginHistoryEntity, UserRoleType, DepartmentMemberEntity, DepartmentRoleType, DepartmentEntity, UserStatus, SessionEntity, OAuthAccountEntity, OAuthAccountStatus, TenantEntity, ApiProviderEntity, OAuth2Config } from '../entity/auth.entity.js';
import { InviteToken, ACCESS_TOKEN_JWT_SECRET, ACCESS_TOKEN_EXPIRES_IN, REFRESH_TOKEN_EXPIRES_IN, REFRESH_TOKEN_JWT_SECRET, ONETIME_TOKEN_JWT_SECRET, ONETIME_TOKEN_EXPIRES_IN, RefreshToken, UserToken, API_TOKEN_EXPIRES_IN, API_TOKEN_JWT_SECRET } from '../middleware/authenticate.js';
import { validationErrorHandler } from '../middleware/validation.js';
import { EntityManager, In, MoreThan, Not } from 'typeorm';
import { ds } from '../db.js';

import { ProjectEntity, TeamEntity, TeamMemberEntity } from '../entity/project-models.entity.js';
import { ProjectStatus, ProjectVisibility, TeamMemberRoleType, TeamType } from '../models/values.js';
import { Utils } from '../../common/utils.js';
import { AxiosInstance } from 'axios';

const { SMTP_USER, SMTP_PASSWORD, SMTP_ALIAS, FRONT_BASE_URL, SMTP_SERVER, SMTP_PORT, SMTP_DOMAIN, MAIL_DOMAIN_WHITELIST, MAIL_EXPIRES_IN, OAUTH2_FLOW_STATE_JWT_SECRET, OAUTH2_FLOW_STATE_EXPIRES_IN, OAUTH2_PATH_MAIL_MESSAGE, OAUTH2_PATH_MAIL_AUTH, } = process.env as Record<string, string>;
Utils.requiredEnvVarsCheck({
    SMTP_USER, SMTP_PASSWORD, SMTP_ALIAS, FRONT_BASE_URL, SMTP_SERVER, SMTP_PORT, SMTP_DOMAIN, MAIL_DOMAIN_WHITELIST, MAIL_EXPIRES_IN, OAUTH2_FLOW_STATE_JWT_SECRET, OAUTH2_FLOW_STATE_EXPIRES_IN, OAUTH2_PATH_MAIL_MESSAGE, OAUTH2_PATH_MAIL_AUTH,
});

// httpsの証明書検証スキップ用のエージェント。社内だから検証しなくていい。
// import https from 'https';
import { getAccessToken } from '../api/api-proxy.js';
import { decrypt, encrypt } from './tool-call.js';
import { getAxios } from '../../common/http-client.js';
// import { HttpsProxyAgent } from 'https-proxy-agent';
// export const agent = new HttpsProxyAgent(`${AXIOS_EXTERNAL_PROXY_PROTOCOL}://${AXIOS_EXTERNAL_PROXY_HOST}:${AXIOS_EXTERNAL_PROXY_PORT}`);
// // export const agent = new https.Agent({});

// // プロキシ無しaxios
// export const axiosWithoutProxy = axios.create({ httpAgent: false, httpsAgent: false, proxy: false, });
// // export const axiosWithProxy = axios.create({ httpAgent: agent, httpsAgent: agent, proxy: { host: AXIOS_EXTERNAL_PROXY_HOST, port: Number(AXIOS_EXTERNAL_PROXY_PORT), }, });
// export const axiosWithProxy = axios.create({ httpAgent: agent, httpsAgent: agent, proxy: false, });
// // export const axiosWithProxy = axios.create({
// //     httpAgent: false, httpsAgent: agent, proxy: {
// //         host: AXIOS_EXTERNAL_PROXY_HOST,
// //         port: Number(AXIOS_EXTERNAL_PROXY_PORT),
// //         auth: {
// //             username: AXIOS_EXTERNAL_PROXY_USER || '',
// //             password: AXIOS_EXTERNAL_PROXY_PASSWORD || '',
// //         },
// //     },
// // });

export type OAuth2TokenDto = { access_token: string, token_type: string, expires_in: number, scope: string, refresh_token: string, id_token: string, };

/**
 * [認証不要] ユーザーログイン
 * @param req 
 * @param res 
 * @returns 
 */
export const userLogin = [
    param('tenantKey').trim().notEmpty(),
    body('email').trim().notEmpty(),  // .withMessage('メールアドレスを入力してください。'),
    body('password').trim().notEmpty(),  // .withMessage('パスワードを入力してください。'),
    validationErrorHandler,
    async (req: Request, res: Response) => {
        const { tenantKey } = req.params as { tenantKey: string };
        let tenant: TenantEntity;
        try {
            tenant = await ds.getRepository(TenantEntity).findOneOrFail({ where: { tenantKey, isActive: true } });
        } catch (e) {
            res.status(401).json({ message: '認証に失敗しました。' });
            return;
        }
        return ds.transaction(manager =>
            manager.getRepository(UserEntity).findOne({ where: { tenantKey, email: req.body.email } }).then((user: UserEntity | null) => {
                if (user == null || !bcrypt.compareSync(req.body.password, user.passwordHash || '')) {
                    res.status(401).json({ message: '認証に失敗しました。' });
                    return;
                }
                authAfter(user, manager, 'local', { authGeneration: user.authGeneration }, req, res).then(tokenObject => {
                    res.json({ user: { id: user.id, name: user.name, email: user.email, role: user.role } });
                });
            })
        );
    }
];

async function authAfter(user: UserEntity, manager: EntityManager, provider: string, authInfoObj: any, req: Request, res: Response): Promise<{ accessToken: string, refreshToken: string }> {
    let deviceInfo = {};
    if (req.useragent) {
        deviceInfo = Utils.jsonOrder(req.useragent, ['browser', 'version', 'os', 'platform', 'isDesktop', 'isMobile', 'isTablet']);
    } else { }

    const xRealIp = req.headers['x-real-ip'] as string || req.ip || '';

    const loginHistory = new LoginHistoryEntity();
    loginHistory.userId = user.id; // ユーザー認証後に設定
    loginHistory.ipAddress = xRealIp
    loginHistory.deviceInfo = JSON.stringify(deviceInfo);
    loginHistory.authGeneration = user.authGeneration;
    loginHistory.tenantKey = user.tenantKey;
    loginHistory.createdBy = user.id;
    loginHistory.updatedBy = user.id;
    loginHistory.createdIp = xRealIp
    loginHistory.updatedIp = xRealIp
    manager.getRepository(LoginHistoryEntity).save(loginHistory); // ログイン履歴登録の成否は見ずにレスポンスを返す

    const session = new SessionEntity();
    session.userId = user.id; // ユーザー認証後に設定
    session.ipAddress = xRealIp
    session.deviceInfo = JSON.stringify(deviceInfo);
    session.provider = provider;
    session.authInfo = JSON.stringify(authInfoObj);

    // セッション有効期限を設定
    const expirationTime = Utils.parseTimeStringToMilliseconds(REFRESH_TOKEN_EXPIRES_IN);// クッキーの有効期限をミリ秒で指定
    session.expiresAt = new Date(Date.now() + expirationTime);
    session.lastActiveAt = new Date();
    session.tenantKey = user.tenantKey;
    session.createdBy = user.id;
    session.updatedBy = user.id;
    session.createdIp = xRealIp;
    session.updatedIp = xRealIp;
    const savedSession = await manager.getRepository(SessionEntity).save(session);

    // JWTの生成
    const userToken: UserToken = { type: 'user', id: user.id, role: user.role, name: user.name, authGeneration: user.authGeneration || 0, email: user.email, tenantKey: user.tenantKey };
    const accessToken = jwt.sign(userToken, ACCESS_TOKEN_JWT_SECRET, { expiresIn: ACCESS_TOKEN_EXPIRES_IN as ms.StringValue });
    // クッキーをセット
    res.cookie('access_token', accessToken, {
        maxAge: Utils.parseTimeStringToMilliseconds(ACCESS_TOKEN_EXPIRES_IN), // ミリ秒単位で指定
        httpOnly: true, // クッキーをHTTPプロトコルのみでアクセス可能にする
        secure: true, // HTTPSでのみ送信されるようにする
        sameSite: true, // CSRF保護のためのオプション
    });
    const refreshTokenBody: RefreshToken = { type: 'refresh', sessionId: savedSession.id, userId: user.id, role: user.role, name: user.name, lastActiveAt: session.lastActiveAt, authGeneration: user.authGeneration || 0, email: user.email, tenantKey: user.tenantKey };
    const refreshToken = jwt.sign(refreshTokenBody, REFRESH_TOKEN_JWT_SECRET, { expiresIn: REFRESH_TOKEN_EXPIRES_IN as ms.StringValue });
    res.cookie('refresh_token', refreshToken, {
        maxAge: expirationTime, // 14日間。クッキーの有効期限をミリ秒で指定
        httpOnly: true, // クッキーをHTTPプロトコルのみでアクセス可能にする
        secure: true, // HTTPSでのみ送信されるようにする
        sameSite: true, // CSRF保護のためのオプション
    });
    // res.redirect(e.pathTop);
    return { accessToken, refreshToken: savedSession.id }
}

/**
 * [user認証] APIトークン発行
 */
export const genApiToken = [
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

        const xRealIp = req.headers['x-real-ip'] as string || req.ip || '';

        ds.transaction(async (manager) => {
            const loginHistory = new LoginHistoryEntity();
            loginHistory.userId = user.id; // ユーザー認証後に設定
            loginHistory.ipAddress = xRealIp;
            loginHistory.deviceInfo = JSON.stringify(deviceInfo);
            loginHistory.authGeneration = user.authGeneration;
            loginHistory.tenantKey = req.info.user.tenantKey;
            loginHistory.createdBy = user.id;
            loginHistory.updatedBy = user.id;
            loginHistory.createdIp = xRealIp;
            loginHistory.updatedIp = xRealIp;
            manager.getRepository(LoginHistoryEntity).save(loginHistory); // ログイン履歴登録の成否は見ずにレスポンスを返す

            const session = new SessionEntity();
            session.userId = user.id; // ユーザー認証後に設定
            session.ipAddress = xRealIp;
            session.deviceInfo = JSON.stringify(deviceInfo);
            session.provider = 'session';
            session.authInfo = JSON.stringify({});

            // セッション有効期限を設定
            const expirationTime = Utils.parseTimeStringToMilliseconds(API_TOKEN_EXPIRES_IN);// クッキーの有効期限をミリ秒で指定
            session.expiresAt = new Date(Date.now() + expirationTime);
            session.lastActiveAt = new Date();
            session.tenantKey = req.info.user.tenantKey;
            session.createdBy = user.id;
            session.updatedBy = user.id;
            session.createdIp = xRealIp;
            session.updatedIp = xRealIp;
            const savedSession = await manager.getRepository(SessionEntity).save(session);

            // TODO でもよく考えたらAPIはAuthGenerationは無視したい。revoke管理は別途作り込む。
            // DBのユーザーEntityを持ってきてauthGeneartionを持ってくる
            const userFromDb = await manager.getRepository(UserEntity).findOneOrFail({ where: { tenantKey: req.info.user.tenantKey, id: req.info.user.id } });

            // JWTの生成
            const apiTokenBody: RefreshToken = {
                type: 'api', sessionId: savedSession.id, userId: user.id, role: user.role, name: user.name, lastActiveAt: session.lastActiveAt, authGeneration: userFromDb.authGeneration || 0, email: user.email, tenantKey: user.tenantKey
            };
            const apiToken = jwt.sign(apiTokenBody, API_TOKEN_JWT_SECRET, { expiresIn: API_TOKEN_EXPIRES_IN as ms.StringValue });

            const apiTokenEntity = new OAuthAccountEntity();
            apiTokenEntity.userId = user.id;
            apiTokenEntity.provider = `local-${label}`;
            apiTokenEntity.providerUserId = user.id;
            apiTokenEntity.providerEmail = user.email;
            apiTokenEntity.label = label;
            apiTokenEntity.accessToken = apiToken;
            apiTokenEntity.refreshToken = '';
            apiTokenEntity.tokenExpiresAt = session.expiresAt;
            apiTokenEntity.tokenBody = '{}';
            apiTokenEntity.userInfo = '{}';
            apiTokenEntity.status = OAuthAccountStatus.ACTIVE;
            apiTokenEntity.tenantKey = user.tenantKey;
            apiTokenEntity.createdBy = user.id;
            apiTokenEntity.updatedBy = user.id;
            apiTokenEntity.createdIp = xRealIp;
            apiTokenEntity.updatedIp = xRealIp;
            await manager.getRepository(OAuthAccountEntity).save(apiTokenEntity);

            res.json({ apiToken });
        });
    }
];

export type ExtApiClient = ApiProviderEntity & { axiosWithAuth: Promise<((userId: string) => Promise<AxiosInstance>)>, };
const eMas: Record<string, ExtApiClient> = {};
export async function getExtApiClient(tenantKey: string, provider: string): Promise<ExtApiClient> {
    const eKey = `${tenantKey}:${provider}`;
    if (eMas[eKey]) {
        return Promise.resolve(eMas[eKey]);
    } else {
        const tenant = await ds.getRepository(TenantEntity).findOneByOrFail({ tenantKey, isActive: true });
        const apiProvider = await ds.getRepository(ApiProviderEntity).findOneByOrFail({
            tenantKey, provider, isDeleted: false,
        });
        const apiClient = {
            ...apiProvider,
            axiosWithAuth: getOAuthClient(tenantKey, provider, apiProvider.uriBase),
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
export async function getOAuthClient(tenantKey: string, provider: string, uriBase: string): Promise<((userId: string) => Promise<AxiosInstance>)> {
    return (async (userId: string) => {

        const oAuthAccount = await getAccessToken(tenantKey, userId, provider);

        console.log(`getOAuthClient ${provider} ${oAuthAccount.accessToken}`);
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
                        const newTokens = await getAccessToken(oAuthAccount.tenantKey, oAuthAccount.userId, oAuthAccount.provider);

                        // トークンを更新
                        oAuthAccount.accessToken = newTokens.accessToken;
                        // リフレッシュトークンも更新される場合
                        if (newTokens.refreshToken) {
                            oAuthAccount.refreshToken = newTokens.refreshToken;
                        }

                        // 新しいトークンでヘッダーを更新
                        originalRequest.headers.Authorization = `Bearer ${newTokens.accessToken}`;

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

export const userLoginOAuth2 = [
    param('tenantKey').trim().notEmpty(),
    param('provider').trim().notEmpty(),
    validationErrorHandler,
    async (req: Request, res: Response) => {
        // OAuth2認可エンドポイントにリダイレクト
        const { tenantKey, provider } = req.params as { tenantKey: string, provider: string };
        // console.log(`OAuth2 login request: ${provider} ${JSON.stringify(req.query)}`);
        const e = await getExtApiClient(tenantKey, provider);
        if (!e || !e.oAuth2Config) {
            res.status(400).json({ error: 'Provider not found' });
            return;
        }
        // パスによってリダイレクトURIを振り分ける
        const redirectUri = `${e.oAuth2Config.redirectUri}`;

        const stateSeed = Utils.generateUUID();
        // stateにリダイレクト先URL等の任意情報を埋め込む用の JWT の生成
        const statePack: OAuth2State = { tenantKey, type: 'oauth-state', stateSeed, provider, redirectUri, query: req.query };
        const state = jwt.sign(statePack, OAUTH2_FLOW_STATE_JWT_SECRET as string, { expiresIn: OAUTH2_FLOW_STATE_EXPIRES_IN as ms.StringValue });
        // console.log(e);
        const authURL = `${e.oAuth2Config.uriBaseAuth || e.uriBase}${e.oAuth2Config.pathAuthorize}?client_id=${e.oAuth2Config.clientId}&response_type=code&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${e.oAuth2Config.scope}&state=${state}`;

        // ログイン済みの場合、ログイン済みの情報とOAuth2の認証を紐づけるためのJWTの生成
        const pack: OAuth2FlowState = { tenantKey, type: 'oauth-flow', state, provider, redirectUri, accessToken: req.cookies?.access_token, refreshToken: req.cookies?.refresh_token };
        const oauth2FlowState = jwt.sign(pack, OAUTH2_FLOW_STATE_JWT_SECRET as string, { expiresIn: OAUTH2_FLOW_STATE_EXPIRES_IN as ms.StringValue });
        // ID紐づけ用のCookieをセット
        res.cookie(`oauth_onetime_${provider}`, oauth2FlowState, {
            maxAge: Utils.parseTimeStringToMilliseconds(OAUTH2_FLOW_STATE_EXPIRES_IN as string), // クッキーの有効期限をミリ秒で指定
            httpOnly: true, // クッキーをHTTPプロトコルのみでアクセス可能にする
            secure: true, // HTTPSでのみ送信されるようにする
            sameSite: 'lax', // CSRF保護のためのオプションだがOAuth2の場合はfalseにしないとリダイレクトのときにCookieが送信されないのでfalseにする。httpOnlyでsecure指定なので問題なしとする。
        });
        res.redirect(authURL);
    }
];

// stateとしてOAuth2のサーバーに渡るので秘密情報は入れない。
type OAuth2State = {
    tenantKey: string,
    type: 'oauth-state',
    stateSeed: string,
    provider: string,
    redirectUri: string,
    query: Record<string, any>, // 任意パラメータを埋め込めるが、実際はfromUrlくらいしか使わない
};

// Cookieとして保持するので秘密情報入ってもまぁ良しとする。
type OAuth2FlowState = {
    tenantKey: string,
    type: 'oauth-flow',
    provider: string,
    redirectUri: string,
    accessToken?: string,
    refreshToken?: string,
    state: string,
};

// トークン検証用ヘルパー関数（Promise化でスッキリさせることも可能）
export function verifyJwt<T>(token: string, secret: string, tokenType?: string): Promise<T> {
    return new Promise((resolve, reject) => {
        jwt.verify(token, secret, (err: any, decoded: any) => {
            if (err) return reject(err);
            resolve(decoded);
        });
    });
}

/**
 * oauth2FlowStateの検証をして結果が三通りに分岐するハンドラー
 *  - oauth2FlowStateの検証エラーであれば例外を投げる。
 *  - oauth2FlowStateの検証がOKで、かつログイン済みであればユーザーエンティティを返す。
 *  - oauth2FlowStateの検証がOKで、かつ未ログインであればnullを返す。
 * 
 * @param req 
 * @param res 
 * @returns 
 */
async function handleOAuthCallback(tm: EntityManager, req: Request, res: Response, xRealIp: string): Promise<UserEntity | null> {
    // oauth2FlowState の検証
    let oAuth2FlowStateToken: string = req.cookies[`oauth_onetime_${req.params.provider}`];
    let oAuth2FlowState: OAuth2FlowState;

    res.cookie(`oauth_onetime_${req.params.provider}`, '', { maxAge: 0 }); // 一度使ったら消す

    try {
        const decoded = await verifyJwt<OAuth2FlowState>(oAuth2FlowStateToken, OAUTH2_FLOW_STATE_JWT_SECRET);
        oAuth2FlowState = decoded;
    } catch (err) {
        throw new Error(`OAuth2 flow state verification failed. ${err}`);
    }

    // stateおよびtypeチェック
    if (oAuth2FlowState.type !== 'oauth-flow' || oAuth2FlowState.state !== req.query.state) {
        throw new Error(`Invalid OAuth2 flow state. ${oAuth2FlowState.type}!=oauth or ${oAuth2FlowState.state}!=${req.query.state}`);
    }

    // トークンが存在するかどうかで処理を分岐
    const hasAccessToken = Boolean(oAuth2FlowState.accessToken);
    const hasRefreshToken = Boolean(oAuth2FlowState.refreshToken);

    // ユーザー状態オブジェクト（仮）
    let userId: string | null = null;
    let isAuthenticated = false;

    if (hasAccessToken) {
        // アクセストークンの検証
        try {
            const userToken = await verifyJwt<UserToken>(oAuth2FlowState.accessToken!, ACCESS_TOKEN_JWT_SECRET);
            if (userToken.type === 'user' && userToken.id) {
                // 有効なユーザーアクセストークン
                userId = userToken.id;
                isAuthenticated = true;
            } else {
                // アクセストークンが無効な場合、リフレッシュトークンがあれば再発行を試みる
                if (hasRefreshToken) {
                    userId = (await tryRefresh(tm, req, res, xRealIp, 'refresh', oAuth2FlowState.refreshToken!)).userEntity.id;
                    isAuthenticated = true;
                } else {
                    // リフレッシュトークンなし => 認証不可、サインアップ扱い
                    // ここでサインアップロジックへ飛ぶ
                }
            }
        } catch (err) {
            // アクセストークンが検証失敗の場合、リフレッシュトークンで再発行を試みる
            if (hasRefreshToken) {
                try {
                    userId = (await tryRefresh(tm, req, res, xRealIp, 'refresh', oAuth2FlowState.refreshToken!)).userEntity.id;
                    isAuthenticated = true;
                } catch (err) {
                    // リフレッシュ失敗 => サインアップフロー
                }
            } else {
                // リフレッシュトークンなし => サインアップフロー
            }
        }

    } else {
        // アクセストークンなしの場合
        if (hasRefreshToken) {
            // リフレッシュトークンから再発行を試みる
            try {
                userId = (await tryRefresh(tm, req, res, xRealIp, 'refresh', oAuth2FlowState.refreshToken!)).userEntity.id;
                isAuthenticated = true;
            } catch (err) {
                // リフレッシュ失敗 => サインアップフロー
            }
        } else {
            // アクセス、リフレッシュ両方なし => 新規サインアップリクエスト
            // サインアップロジックへ
        }
    }
    // userIdの有無で認証済みかどうかを判定
    return userId ? await ds.getRepository(UserEntity).findOneOrFail({ where: { tenantKey: oAuth2FlowState.tenantKey, id: userId } }) : null;
}

/**
 *  リフレッシュトークンを使ってアクセストークンを再発行する
 * @param req 
 * @param res 
 * @param refreshToken 
 * @returns 
 */
export async function tryRefreshCore(tm: EntityManager, xRealIp: string, tokenType: 'refresh' | 'api', refreshToken: string, roleType: UserRoleType = UserRoleType.User): Promise<{ userEntity: UserEntity, accessToken: String }> {
    // リフレッシュトークン検証
    const decoded = await verifyJwt<RefreshToken>(refreshToken, tokenType === 'refresh' ? REFRESH_TOKEN_JWT_SECRET : API_TOKEN_JWT_SECRET);
    if (decoded.type !== tokenType) {
        throw new Error(`Invalid token type: tokenType(${tokenType})!=decoded(${decoded.type})`);
    } else { }

    // 有効なら新しいアクセストークンを発行するなどの処理
    const session = await tm.findOneOrFail(SessionEntity, { where: { id: decoded.sessionId, userId: decoded.userId } });

    const where = {
        tenantKey: decoded.tenantKey,
        id: decoded.userId,                     // JWTのユーザーIDと一致すること
        authGeneration: decoded.authGeneration, // JWTの認証世代と一致すること
        status: UserStatus.Active, // activeユーザーじゃないと使えない
    } as Record<string, any>;
    if (roleType === UserRoleType.Admin) {
        // 管理者用の認証チェック
        where['role'] = In([UserRoleType.Admin, UserRoleType.Maintainer]);
    } else { }
    // ユーザーの存在確認 ※こんなことやってるからjwtにした意味はなくなってしまうが即時停止をやりたいのでやむなく。
    const user = await tm.findOneOrFail(UserEntity, { where });

    // 認証OK。リクエストにユーザーIDを付与して次の処理へ
    // user.dataValuesはそのままだとゴミがたくさん付くので、項目ごとにUserModelにマッピングする。
    // TODO ここはもっとスマートに書けるはず。マッパーを用意するべきか？
    const userEntity = new UserEntity();
    userEntity.id = user.id;
    userEntity.name = user.name;
    userEntity.email = user.email;
    userEntity.role = user.role;
    // (req as UserRequest).info = { user: userEntity, ip: xRealIp, cookie: req.cookies };

    // 最終更新日だけ更新して更新
    session.lastActiveAt = new Date();
    session.updatedBy = user.id;
    session.updatedIp = xRealIp;
    const savedSession = await tm.save(SessionEntity, session);

    // JWTの生成
    const userToken: UserToken = { type: 'user', id: user.id, role: user.role, name: user.name, authGeneration: user.authGeneration || 0, email: user.email, tenantKey: user.tenantKey };
    const accessToken = jwt.sign(userToken, ACCESS_TOKEN_JWT_SECRET, { expiresIn: ACCESS_TOKEN_EXPIRES_IN as ms.StringValue });
    return { userEntity, accessToken };
}

/**
 *  リフレッシュトークンを使ってアクセストークンを再発行する
 * @param req 
 * @param res 
 * @param refreshToken 
 * @returns 
 */
export async function tryRefresh(tm: EntityManager, req: Request, res: Response, xRealIp: string, tokenType: 'refresh' | 'api', refreshToken: string, roleType: UserRoleType = UserRoleType.User): Promise<{ userEntity: UserEntity, accessToken: String }> {
    const coreRes = await tryRefreshCore(tm, xRealIp, tokenType, refreshToken, roleType);
    // クッキーをセット
    res.cookie('access_token', coreRes.accessToken, {
        maxAge: Utils.parseTimeStringToMilliseconds(ACCESS_TOKEN_EXPIRES_IN), // クッキーの有効期限をミリ秒で指定
        httpOnly: true, // クッキーをHTTPプロトコルのみでアクセス可能にする
        secure: true, // HTTPSでのみ送信されるようにする
        sameSite: false, // CSRF保護のためのオプション
    });
    return coreRes;
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

        let decoded: OAuth2State;
        try {
            decoded = await verifyJwt<OAuth2State>(state, OAUTH2_FLOW_STATE_JWT_SECRET);
        } catch (err) {
            throw new Error(`OAuth2 flow state verification failed. ${err}`);
        }
        const oAuth2FlowState = decoded as OAuth2State;

        const e = await getExtApiClient(oAuth2FlowState.tenantKey, oAuth2FlowState.provider);
        const tenantKey = oAuth2FlowState.tenantKey;
        const provider = oAuth2FlowState.provider;

        const ipAddress = req.headers['x-real-ip'] as string || req.ip || '';
        try {
            // awaitをつけておかないと、例外が発生してもcatchされない。
            await ds.transaction(async (manager) => {
                if (!e || !e.oAuth2Config) {
                    res.status(400).json({ error: 'Provider not found' });
                    return;
                } else { }

                // oAuth2FlowState の検証
                const authenticatedUser = await handleOAuthCallback(manager, req, res, ipAddress);

                const postData = { client_id: e.oAuth2Config.clientId, client_secret: e.oAuth2Config.clientSecret, grant_type: 'authorization_code', code: code, redirect_uri: `${e.oAuth2Config.redirectUri}` };
                let params = null, body = null;
                if (e.oAuth2Config.postType === 'params') {
                    params = postData;
                } else {
                    body = postData;
                }

                // アクセストークンを取得するためのリクエスト
                // const token = await e.axios.post<OAuth2TokenDto>(`${e.uriBase}${e.pathAccessToken}`, body, { params });
                const axios = await getAxios(e.uriBase);
                let token = null;
                if (params) {
                    token = await axios.post<OAuth2TokenDto>(`${e.uriBase}${e.oAuth2Config.pathAccessToken}`, {}, { params });
                } else {
                    // console.dir(body, { depth: null });
                    // console.log(`--------------------852--`);
                    // console.log(`curl -X POST -H 'Content-Type: application/json' -d '${JSON.stringify(body)}' ${e.uriBase}${e.pathAccessToken}`);
                    token = await axios.post<OAuth2TokenDto>(`${e.uriBase}${e.oAuth2Config.pathAccessToken}`, body, { headers: { 'Content-Type': 'application/json' }, });
                    // proxy: false, httpsAgent: agent 
                    // console.log(`--------------------840--`);
                    // console.log(`--------------------853--`);
                    // // e.userProxy
                    // const response = await fetch(`${e.uriBase}${e.pathAccessToken}`, {
                    //     method: 'POST',
                    //     headers: { 'Content-Type': 'application/json', },
                    //     body: JSON.stringify(body),
                    //     agent: agent,
                    // });
                    // console.log(`--------------------841--`);
                    // // console.log(`token------------------`);
                    // // console.log(response);
                    // token = { data: await response.json() } as { data: OAuth2TokenDto };
                    // // token = await e.axios.post<OAuth2TokenDto>(`${e.uriBase}${e.pathAccessToken}`, body, {});
                }
                const accessToken = token.data.access_token;
                // console.log(`tokne=${JSON.stringify(token.data)}`)
                // console.log('AccessToken:', accessToken);
                // console.log(e.axios);
                // APIを呼び出してみる
                const userInfo = await axios.get<{ id: string, username?: string, email: string, login?: string }>(`${e.uriBase}${e.pathUserInfo}`, {
                    headers: { Authorization: `Bearer ${accessToken}` }
                });
                const oAuthUserInfo = userInfo.data;
                // console.log(JSON.stringify(userInfo.data));

                // ここはちょっとキモイ。。けど複数を纏めているから仕方ない。。
                if (e.type === 'box') {
                    // boxはcu認証なのでcuを外してemailに入れる。
                    userInfo.data.email = userInfo.data.login?.replace('@cu.', '@') || '';
                } else if (e.oAuth2Config.requireMailAuth) {
                    // 独自のメール認証をしているプロバイダーはメアドも仮の可能性がある
                    userInfo.data.email = userInfo.data.email.replaceAll(/@localhost$/g, `@${MAIL_DOMAIN_WHITELIST.split(',')[0]}`) || '';
                } else { }

                // emailを事実上の鍵として紐づけに行くので、メアドが変なやつじゃないかはちゃんとチェックする。
                if (MAIL_DOMAIN_WHITELIST.split(',').find(domain => userInfo.data.email.endsWith(`@${domain}`))) {
                } else {
                    // whiltelist登録されているドメインのアドレス以外は登録禁止。
                    throw new Error(JSON.stringify({
                        error: "Invalid email",
                        message: "whitelist登録されているドメインのアドレス以外は登録禁止です。",
                        details: {
                            attemptedEmail: userInfo.data.email,
                        }
                    }));
                }
                if (authenticatedUser && authenticatedUser.email !== userInfo.data.email) {
                    // emailが一致するユーザーじゃないと紐づけさせない。
                    throw new Error(JSON.stringify({
                        error: "Invalid email",
                        message: `ログイン中のユーザーと異なるemailを持つアカウントとは紐づけできません。${e.provider}をログアウトしてから再度試してください。`,
                        details: {
                            provider: e.provider,
                            authenticatedUserEmail: authenticatedUser.email,
                            targetEmail: userInfo.data.email
                        }
                    }));
                } else {
                    // 未ログイン、もしくは既にログインしているユーザーと同じメールアドレスの場合は何もしない。
                }
                // console.log(oAuthUserInfo.email);
                // emailを事実上の鍵として紐づけに行く。
                let user = await manager.getRepository(UserEntity).findOne({ where: { tenantKey, email: oAuthUserInfo.email } });
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
                    user.tenantKey = tenantKey;
                    user.createdBy = ipAddress; // 作成者はIP
                    user.updatedBy = ipAddress; // 更新者はIP
                    user.createdIp = ipAddress;
                    user.updatedIp = ipAddress;

                    // 本当はメール認証できてないのにユーザー登録してしまうのはいかがなものか、、だけどそんなに害もないし、難しくなるのでこのままにする。
                    user = await manager.getRepository(UserEntity).save(user);
                    await createUserInitial(ipAddress, user, manager); // ユーザー初期作成に伴う色々作成
                }
                // oAuthの一意キー
                const oAuthKey = { tenantKey, provider, userId: user.id, providerUserId: oAuthUserInfo.id };
                let oAuthAccount = await manager.getRepository(OAuthAccountEntity).findOne({ where: oAuthKey });
                if (oAuthAccount) {
                    // 既存の場合
                    oAuthAccount.userInfo = JSON.stringify(userInfo.data);
                    oAuthAccount.status = OAuthAccountStatus.ACTIVE; // 有効にする
                } else {
                    // 新規の場合
                    oAuthAccount = new OAuthAccountEntity();
                    oAuthAccount.provider = oAuthKey.provider;
                    oAuthAccount.userId = oAuthKey.userId;
                    oAuthAccount.providerUserId = oAuthKey.providerUserId;
                    oAuthAccount.providerEmail = oAuthUserInfo.email;
                    oAuthAccount.userInfo = JSON.stringify(userInfo.data);
                    oAuthAccount.tenantKey = tenantKey;
                    oAuthAccount.createdBy = user.id;
                    oAuthAccount.createdIp = ipAddress;
                }
                oAuthAccount.accessToken = encrypt(token.data.access_token);
                oAuthAccount.refreshToken = encrypt(token.data.refresh_token);
                oAuthAccount.tokenBody = JSON.stringify(token.data);
                // 現在の時刻にexpiresInSeconds（秒）を加算して、有効期限のDateオブジェクトを作成
                if (token.data.expires_in) {
                    oAuthAccount.tokenExpiresAt = new Date(Date.now() + token.data.expires_in * 1000);
                } else { /** expiresは設定されていないこともある。 */ }
                oAuthAccount.updatedBy = user.id;
                oAuthAccount.updatedIp = ipAddress;

                if (e.oAuth2Config.requireMailAuth === false) {
                    // 追加メール認証不要
                    // 保存
                    if (provider === 'mattermost') {
                        // // mattermost の認証トークンは保存しないようにする。
                        // token.data.access_token = `dummy`;
                        // token.data.refresh_token = `dummy`;
                        // oAuthAccount.accessToken = token.data.access_token;
                        // oAuthAccount.refreshToken = token.data.refresh_token;
                        // oAuthAccount.tokenBody = JSON.stringify(token.data);
                        // cookie に MMAUTHTOKEN としてセットしておけばトークン使わずに行ける。
                        res.cookie('MMAUTHTOKEN', accessToken, {
                            maxAge: Utils.parseTimeStringToMilliseconds(`1y`), // ミリ秒単位で指定
                            httpOnly: true, // クッキーをHTTPプロトコルのみでアクセス可能にする
                            secure: true, // HTTPSでのみ送信されるようにする
                            sameSite: true, // CSRF保護のためのオプション
                        });
                    } else {
                    }
                    const savedOAuthAccount = await manager.getRepository(OAuthAccountEntity).save(oAuthAccount);
                    // トークン発行
                    await authAfter(user, manager, provider, oAuthKey, req, res);
                    // レスポンス
                    // res.redirect(`${e.pathTop}${redirectType}`);
                    try {
                        const decoded = await verifyJwt<OAuth2State>(state, OAUTH2_FLOW_STATE_JWT_SECRET);
                        console.log(`OAuth2 login success: ${provider} ${oAuthUserInfo.email} ${decoded.query.fromUrl || e.oAuth2Config.pathTop}`);
                        res.redirect(`${decoded.query.fromUrl || e.oAuth2Config.pathTop}`);
                        // // HTMLをクライアントに送信
                        // res.send(`<!DOCTYPE html><html><head><title>リダイレクト中...</title><meta http-equiv="refresh" content="0; URL=${decoded.query.fromUrl || e.pathTop}"></head><body><p>リダイレクト中です。しばらくお待ちください。</p></body></html>`);
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
                    inviteEntity.status = 'unused';
                    inviteEntity.data = JSON.stringify({ name: '', email: oAuthUserInfo.email, pincode, oAuthAccountId: savedOAuthAccount.id, tenantKey: user.tenantKey, userId: user.id });
                    inviteEntity.limit = Date.now() + Utils.parseTimeStringToMilliseconds(MAIL_EXPIRES_IN);
                    inviteEntity.tenantKey = tenantKey;
                    inviteEntity.createdBy = ipAddress;
                    inviteEntity.updatedBy = ipAddress;
                    inviteEntity.createdIp = ipAddress;
                    inviteEntity.updatedIp = ipAddress;
                    await inviteEntity.save();

                    // メール送信
                    sendMail(oAuthUserInfo.email, 'メール認証依頼', `認証要求がありました。\n${FRONT_BASE_URL}/#${OAUTH2_PATH_MAIL_AUTH}/${onetimeToken}\n\nお心当たりのない場合は無視してください。`)
                        .then(_ => {
                            // pincodeをcookieにつけておく。（同じブラウザであれば手入力しなくて済むように）
                            res.cookie('pincode', pincode, { maxAge: Utils.parseTimeStringToMilliseconds(MAIL_EXPIRES_IN), httpOnly: true, secure: true, sameSite: true, });
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
            res.cookie('refresh_token', '', { maxAge: 0, path: '/' });
            res.status(500).send('Error during authentication.\n' + (error as any).message);
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
                    const invite = await manager.getRepository(InviteEntity).findOneOrFail({ where: { tenantKey: req.info.invite.tenantKey, id: req.info.invite.id } });
                    const { email, pincode, oAuthAccountId, userId } = JSON.parse(invite.data);
                    if (postedPincode === pincode) {
                        // TODO inviteを閉じるのはこのタイミングが適切なのかは微妙。開いた瞬間閉じる方が良いかも？
                        await manager.getRepository(InviteEntity).findOne({ where: { tenantKey: req.info.invite.tenantKey, id: req.info.invite.id } }).then((invite: InviteEntity | null) => {
                            if (invite) {
                                invite.updatedBy = req.info.invite.id;
                                invite.updatedIp = req.info.ip;
                                invite.status = 'used';
                                invite.save();
                            } else {
                                // エラー。起こりえないケース
                            }
                            return invite;
                        });

                        const oAuthAccount = await manager.getRepository(OAuthAccountEntity).findOneOrFail({ where: { tenantKey: req.info.invite.tenantKey, id: oAuthAccountId } });
                        // activate
                        oAuthAccount.status = OAuthAccountStatus.ACTIVE;
                        oAuthAccount.updatedBy = req.info.invite.id; // inviteのIDを入れる
                        oAuthAccount.updatedIp = req.info.ip;
                        await manager.getRepository(OAuthAccountEntity).save(oAuthAccount);
                        const user = await manager.getRepository(UserEntity).findOneOrFail({ where: { tenantKey: req.info.invite.tenantKey, id: userId } });
                        // トークン発行
                        const oAuthKey = { provider: oAuthAccount.provider, userId, providerUserId: oAuthAccount.providerUserId };
                        await authAfter(user, manager, oAuthAccount.provider, oAuthKey, req, res);
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

function generateSecureRandomNumber(length: number) {
    const array = new Uint32Array(1);
    getRandomValues(array);
    const randomNumber = array[0] % 1000000;  // 0から999999までの範囲に収める
    return String(randomNumber).padStart(length, '0');  // 6桁になるようゼロパディング
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
        //     const token = jwt.sign(userToken, JWT_SECRET, { expiresIn: '20m' as ms.StringValue  });
        //     res.json({ token, user });
        //     // return { token };
        // });
    }
];
export const logout = [
    validationErrorHandler,
    async (req: Request, res: Response) => {
        res.cookie('access_token', '', {
            maxAge: 0, // 有効期限を0にすることで即座に削除
            httpOnly: true,
            secure: true,
            sameSite: true,
        });
        res.cookie('refresh_token', '', {
            maxAge: 0, // 有効期限を0にすることで即座に削除
            httpOnly: true,
            secure: true,
            sameSite: true,
        });
        if (!(req.cookies && req.cookies.refresh_token)) {
            res.sendStatus(401);
        } else {
            // console.log(`token refresh ${req.cookies.refresh_token}`);
            jwt.verify(req.cookies.refresh_token, REFRESH_TOKEN_JWT_SECRET, (err: any, _token: any) => {
                const refreshToken = _token as RefreshToken;
                if (err) {
                    res.sendStatus(401);
                    return;
                }
                ds.transaction(async manager => {
                    const currSession = await manager.getRepository(SessionEntity).findOneOrFail({ where: { tenantKey: refreshToken.tenantKey, id: refreshToken.sessionId } });
                    currSession.expiresAt = new Date(); // 即時expire
                    currSession.updatedBy = refreshToken.userId;
                    currSession.updatedIp = req.headers['x-real-ip'] as string || '0.0.0.0';
                    const removed = await manager.getRepository(SessionEntity).save(currSession);
                    res.sendStatus(204);
                    return;
                });
            })
        }
    }
];

/**
 * [認証不要] ワンタイムトークンの検証
 * @param req 
 * @param res 
 * @returns 
 */
export const onetimeLogin = [
    param('tenantKey').trim().notEmpty(),
    body('type').trim().notEmpty(),  // .withMessage('ワンタイムトークンのタイプを入力してください。'),
    body('token').trim().notEmpty(),  // .withMessage('ワンタイムトークンを入力してください。'),
    validationErrorHandler,
    (req: Request, res: Response) => {
        const { tenantKey } = req.params as { tenantKey: string };
        ds.getRepository(InviteEntity).findOne({
            where: {
                tenantKey,
                onetimeToken: req.body.token as string,
                status: 'unused',
                type: req.body.type,
                limit: MoreThan(Date.now()),
            },
        }).then((onetimeModel: InviteEntity | null) => {
            if (onetimeModel == null) {
                res.status(403).json({ message: 'ワンタイムトークンが見つかりませんでした。' });
                return;
            } else {
                const inviteToken: InviteToken = {
                    tenantKey,
                    type: 'invite',
                    id: onetimeModel.id,
                    email: onetimeModel.email,
                };
                // JWTの生成
                const jwtToken = jwt.sign(inviteToken, ONETIME_TOKEN_JWT_SECRET, { expiresIn: ONETIME_TOKEN_EXPIRES_IN as ms.StringValue });
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
    param('tenantKey').trim().notEmpty(),
    body('email').trim().notEmpty().isEmail(),  // .withMessage('メールアドレスを入力してください。'),
    validationErrorHandler,
    async (req: Request, res: Response) => {
        const { tenantKey } = req.params as { tenantKey: string };

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
        inviteEntity.status = 'unused';
        inviteEntity.data = JSON.stringify({ name: req.body.name, email: req.body.email });
        inviteEntity.limit = Date.now() + Utils.parseTimeStringToMilliseconds(MAIL_EXPIRES_IN);
        inviteEntity.tenantKey = tenantKey;
        inviteEntity.createdBy = req.headers['x-real-ip'] as string || '0.0.0.0';
        inviteEntity.updatedBy = req.headers['x-real-ip'] as string || '0.0.0.0';
        inviteEntity.createdIp = req.headers['x-real-ip'] as string || '0.0.0.0';
        inviteEntity.updatedIp = req.headers['x-real-ip'] as string || '0.0.0.0';
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
    (_req: Request, res: Response) => {
        const req = _req as InviteRequest;

        const passwordValidationMessage = passwordValidation(req.body.password, req.body.passwordConfirm);
        if (!passwordValidationMessage.isValid) {
            res.status(400).json(passwordValidationMessage);
            return;
        } else {
            // 継続
        }

        let isCreate = false;
        ds.transaction((manager) => {
            // パスワード設定（emailが事実上の鍵）
            return manager.getRepository(UserEntity).findOne({ where: { tenantKey: req.info.invite.tenantKey, email: req.info.invite.email } }).then((user: UserEntity | null) => {
                if (user) {
                    // 既存ユーザーの場合はパスワードを更新する
                    // パスワードのハッシュ化
                    user.passwordHash = bcrypt.hashSync(req.body.password, 10);
                    user.authGeneration = user.authGeneration || 0 + 1;
                } else {
                    isCreate = true;
                    // 初期名前をメールアドレスにする。エラーにならないように。。
                    req.body.name == req.body.name || req.info.invite.email;
                    // 新規ユーザーの場合は登録する
                    user = new UserEntity();
                    user.name = req.body.name;
                    user.name = user.name || 'dummy name';
                    user.name = req.info.invite.email.split('@')[0]; // メールアドレス前半
                    // jwtの検証で取得した情報をそのまま登録する
                    user.email = req.info.invite.email;
                    // パスワードのハッシュ化
                    user.passwordHash = bcrypt.hashSync(req.body.password, 10);
                    user.authGeneration = 1;
                    user.tenantKey = req.info.invite.tenantKey; // tenantKeyはinviteから取得する
                    user.createdBy = req.info.invite.id; // 作成者はinvite
                    user.createdIp = req.info.ip;
                }
                user.updatedBy = req.info.invite.id; // 更新者はinvite
                user.updatedIp = req.info.ip;
                return user;
            }).then((user) => {
                return manager.getRepository(UserEntity).save(user);
            }).then((user) => {
                if (isCreate) {
                    return createUserInitial(req.info.ip, user, manager);
                } else {
                    return user;
                }
            }).then((user) => {
                return manager.getRepository(InviteEntity).findOne({ where: { tenantKey: req.info.invite.tenantKey, id: req.info.invite.id } }).then((invite: InviteEntity | null) => {
                    if (invite) {
                        invite.status = 'used';
                        invite.updatedIp = req.info.ip;
                        invite.save();
                    } else {
                        // エラー。起こりえないケース
                    }
                    return user;
                });
            }).then((user) => {
                authAfter(user, manager, 'local', { authGeneration: user.authGeneration }, req, res).then(_ => {
                    const resDto = { id: user.id, name: user.name, email: user.email, role: user.role };
                    res.json({ message: 'パスワードを設定しました。', resDto });
                })
            });
        });
    }
];

/**
 * [user認証] ユーザー情報取得
 */
export const getUser = [
    validationErrorHandler,
    (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        res.json({ user: req.info.user });
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
        ds.getRepository(UserEntity).findOne({ where: { tenantKey: req.info.user.tenantKey, id: req.info.user.id } }).then((user: UserEntity | null) => {
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
    (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        const passwordValidationMessage = passwordValidation(req.body.password, req.body.passwordConfirm);
        if (!passwordValidationMessage.isValid) {
            res.status(400).json(passwordValidationMessage);
            return;
        } else {
            // 継続
        }

        // パスワード設定（emailが鍵のような役割）
        ds.getRepository(UserEntity).findOne({ where: { tenantKey: req.info.user.tenantKey, id: req.info.user.id } }).then((user: UserEntity | null) => {
            if (user == null) {
                res.status(400).json({ message: 'ユーザーが見つかりませんでした。' });
                return;
            } else {
                // パスワードのハッシュ化
                user.passwordHash = bcrypt.hashSync(req.body.password, 10);
                user.authGeneration = user.authGeneration || 0 + 1;
                user.updatedBy = req.info.user.id;
                user.updatedIp = req.info.ip;
                user.save().then(() => {
                    const resDto = { id: user.id, name: user.name, email: user.email, role: user.role };
                    res.json({ message: 'パスワードを変更しました。', resDto });
                });
            }
        });
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
        ds.getRepository(UserEntity).findOne({ where: { tenantKey: req.info.user.tenantKey, id: req.info.user.id } }).then((user: UserEntity | null) => {
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
 * [user認証] 部一覧
 */
export const getDepartmentList = [
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        const myList = await ds.getRepository(DepartmentMemberEntity).find({
            where: {
                tenantKey: req.info.user.tenantKey,
                // 自分が所属している部の一覧を取る。
                // userId: req.info.user.id,
                name: req.info.user.name,
            },
        });
        const departmentIdList = myList.map((member: DepartmentMemberEntity) => member.departmentId);
        const departmentList = await ds.getRepository(DepartmentEntity).find({
            where: { tenantKey: req.info.user.tenantKey, id: In(departmentIdList), },
        });
        res.json({ departmentList });
    }
];

/**
 * [user認証] 部員一覧
 */
export const getDepartment = [
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        const myList = await ds.getRepository(DepartmentMemberEntity).find({
            where: {
                tenantKey: req.info.user.tenantKey,
                // 自分が管理者となっている部の一覧を取る。
                // userId: req.info.user.id,
                name: req.info.user.name,
                departmentRole: DepartmentRoleType.Admin,
            },
        });
        const departmentIdList = myList.map((member: DepartmentMemberEntity) => member.departmentId);
        const departmentList = await ds.getRepository(DepartmentEntity).find({
            where: { tenantKey: req.info.user.tenantKey, id: In(departmentIdList), },
        });
        const memberList = await ds.getRepository(DepartmentMemberEntity).find({
            where: {
                tenantKey: req.info.user.tenantKey,
                // 自分が管理者となっている部の一覧を取る。
                departmentId: In(departmentIdList),
                departmentRole: DepartmentRoleType.Member, // Memberだけにする。（Adminの人はAdminとMemberの両方の行があるので大丈夫。Deputy（主務じゃない人）は混乱するので除外。）
            },
        });
        const memberUserList = await ds.getRepository(UserEntity).find({
            where: {
                tenantKey: req.info.user.tenantKey,
                name: In(memberList.map((member: DepartmentMemberEntity) => member.name))
            }
        });
        const memberMap = memberList.reduce((map, member) => { map[member.name] = member; return map; }, {} as { [key: string]: DepartmentMemberEntity });

        const totalCosts = await ds.query(`
            SELECT TO_CHAR(created_at,'YYYY-MM') as yyyy_mm, created_by, model, sum(cost) as cost, sum(req_token) as req_token, sum(res_token) as res_token, COUNT(*)  
            FROM predict_history_view 
            GROUP BY created_by, model, ROLLUP(yyyy_mm)
            ORDER BY created_by, model, yyyy_mm;
          `);
        type History = { created_by: string, yyyy_mm: string, model: string, cost: number, req_token: number, res_token: number };
        type HistorySummaryMap = { [createdBy: string]: { [yyyyMm: string]: { totalCost: number, totalReqToken: number, totalResToken: number, foreignModelReqToken: number, foreignModelResToken: number } } };
        const costMap = totalCosts.reduce((map: HistorySummaryMap, history: History) => {
            // ROLLUPを使っているのでyyyy_mmがnullの場合＝ALLということ。
            history.yyyy_mm = history.yyyy_mm || 'ALL';
            if (history.created_by in map) {
            } else {
                map[history.created_by] = {};
            }
            if (history.created_by in map && history.yyyy_mm in map[history.created_by]) {
            } else {
                map[history.created_by][history.yyyy_mm] = {
                    totalCost: 0,
                    totalReqToken: 0,
                    totalResToken: 0,
                    foreignModelReqToken: 0,
                    foreignModelResToken: 0,
                };
            }
            map[history.created_by][history.yyyy_mm].totalCost += Number(history.cost);
            map[history.created_by][history.yyyy_mm].totalReqToken += Number(history.req_token);
            map[history.created_by][history.yyyy_mm].totalResToken += Number(history.res_token);
            // 海外リージョン
            if ([
                'meta/llama3-405b-instruct-maas',
                'claude-3-5-sonnet@20240620',
                'claude-3-5-sonnet-v2@20241022',
                'gemini-flash-experimental',
                'gemini-pro-experimental',
                'gemini-exp-1206',
                'gemini-2.0-flash-exp',
                'gemini-2.0-flash-thinking-exp-1219',
                'gemini-2.0-flash-thinking-exp-01-21',
                'o1-preview',
                'o1',
            ].includes(history.model)) {
                map[history.created_by][history.yyyy_mm].foreignModelReqToken += Number(history.req_token);
                map[history.created_by][history.yyyy_mm].foreignModelResToken += Number(history.res_token);
            }
            return map;
        }, {} as HistorySummaryMap) as HistorySummaryMap;

        // 無理矢理userオブジェクトを埋め込む
        memberUserList.forEach(user => {
            (memberMap[user.name || ''] as any).user = { status: user.status, id: user.id, name: user.name, cost: costMap[user.id] };
            (memberMap[user.name || ''] as any).cost = costMap[user.id];
        });

        // 纏める
        // 纏める
        const departmentMemberList = departmentList.map((department) => {
            const members = memberList
                .filter(member => member.departmentId === department.id)
                .map(member => memberMap[member.name])
                .sort((a, b) => a.name.localeCompare(b.name));
            const cost = members.reduce((sum, member) => {
                if ((member as any).cost) {
                    Object.entries((member as any).cost).forEach(([period, periodCost]: [string, any]) => {
                        if (!sum[period]) {
                            sum[period] = {
                                totalCost: 0,
                                totalReqToken: 0,
                                totalResToken: 0,
                                foreignModelReqToken: 0,
                                foreignModelResToken: 0,
                            };
                        }
                        sum[period].totalCost += periodCost.totalCost;
                        sum[period].totalReqToken += periodCost.totalReqToken;
                        sum[period].totalResToken += periodCost.totalResToken;
                        sum[period].foreignModelReqToken += periodCost.foreignModelReqToken;
                        sum[period].foreignModelResToken += periodCost.foreignModelResToken;
                    });
                }
                return sum;
            }, {} as {
                [period: string]: {
                    totalCost: number,
                    totalReqToken: number,
                    totalResToken: number,
                    foreignModelReqToken: number,
                    foreignModelResToken: number,
                }
            });
            return { department, cost, members };
        });

        res.json({ departmentList: departmentMemberList });
    }
];


export const getDepartmentMemberLog = [
    validationErrorHandler,
    param('userId').isUUID().notEmpty(),
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        const { userId } = req.params as { userId: string };
        const myList = await ds.getRepository(DepartmentMemberEntity).find({
            where: {
                tenantKey: req.info.user.tenantKey,
                // 自分が管理者となっている部の一覧を取る。
                // userId: req.info.user.id,
                name: req.info.user.name,
                departmentRole: DepartmentRoleType.Admin,
            },
        });
        const targetUser = await ds.getRepository(UserEntity).findOneOrFail({ where: { tenantKey: req.info.user.tenantKey, id: userId } });
        const departmentIdList = myList.map((member: DepartmentMemberEntity) => member.departmentId);
        const departmentList = await ds.getRepository(DepartmentEntity).find({
            where: { tenantKey: req.info.user.tenantKey, id: In(departmentIdList), },
        });
        const memberList = await ds.getRepository(DepartmentMemberEntity).find({
            where: {
                tenantKey: req.info.user.tenantKey,
                // 自分が管理者となっている部の一覧を取る。
                departmentId: In(departmentList.map(department => department.id)),
                departmentRole: DepartmentRoleType.Member, // Memberだけにする。（Adminの人はAdminとMemberの両方の行があるので大丈夫。Deputy（主務じゃない人）は混乱するので除外。）
                name: targetUser.name,
            },
        });
        if (memberList.length > 0) {
        } else {
            // 何かがおかしい
            res.status(400).json({ error: '権限無し' });
            return;
        }
        // console.log(memberList);
        const predictHistory = await ds.query(`
            SELECT created_at, model, provider, take, cost, req_token, res_token, status
            FROM predict_history_view 
            WHERE name = (SELECT name FROM user_entity WHERE id='{${userId}}') ;
          `);
        // 纏める
        res.json({ predictHistory });
    }
];


export const getDepartmentMemberLogForUser = [
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        const userId = req.info.user.id;
        const predictHistory = await ds.query(`
            SELECT created_at, model, provider, take, cost, req_token, res_token, status
            FROM predict_history_view 
            WHERE name = (SELECT name FROM user_entity WHERE id='{${userId}}') ;
          `);
        // 纏める
        res.json({ predictHistory });
    }
];


/**
 * [user認証] 部員管理（主に緊急停止用）
 */
export const patchDepartmentMember = [
    validationErrorHandler,
    param('departmentId').isUUID(),
    body('role').optional().isIn(Object.values(DepartmentRoleType)),
    body('status').optional().isIn(Object.values(UserStatus)),
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        const { role, status } = req.body;
        const myList = await ds.getRepository(DepartmentMemberEntity).find({
            where: {
                tenantKey: req.info.user.tenantKey,
                // 自分が管理者となっている部の一覧を取る。
                // userId: req.info.user.id,
                name: req.info.user.name,
                departmentRole: DepartmentRoleType.Admin,
            },
        });
        const departmentIdList = myList.map((member: DepartmentMemberEntity) => member.departmentId);
        const memberList = await ds.getRepository(DepartmentMemberEntity).find({
            where: {
                tenantKey: req.info.user.tenantKey,
                // 対称部員が含まれるか
                departmentId: In(departmentIdList),
                name: req.info.user.name,
                // userId: userId,
            },
        });

        // 
        const userIdSet = new Set(memberList.map((member) => member.userId));
        const userIdAry = [...userIdSet];
        if (userIdAry.length === 1) {
            // 一人だけなら
            const user = await ds.getRepository(UserEntity).findOne({ where: { tenantKey: req.info.user.tenantKey, id: userIdAry[0] } });
            if (user) {
                // ステータス更新
                user.status = status || user.status;
                // ロール更新
                user.role = role || user.role;
                user.updatedBy = req.info.user.id;
                user.updatedIp = req.info.ip;
                // ユーザー情報を保存
                await ds.getRepository(UserEntity).save(user);
                // レスポンスを返す
                res.json({ success: true });
            } else {
                // ユーザーが見つからない場合
                res.status(404).json({ error: 'ユーザーが見つかりません。' });
            }
        } else {
            // 何かがおかしい
            res.status(400).json({ error: '何かがおかしいです。' });
        }
    }
];


/**
 * [user認証] ユーザー情報取得
 */
export const getUserList = [
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        const tenant = await ds.getRepository(TenantEntity).findOneByOrFail({ tenantKey: req.info.user.tenantKey });
        const userList = await ds.query(`
            SELECT u.id, name, u.email, u.role, u.status, m.label
            FROM user_entity u
            LEFT OUTER JOIN (SELECT DISTINCT name, label FROM department_member_entity) m
            USING (name)
            WHERE u.tenant_key = '${tenant.tenantKey}'
          `);
        res.json({ userList });
    }
];

function createUserInitial(ip: string, user: UserEntity, manager: EntityManager): Promise<UserEntity> {
    // console.log(`Create Default Projects.`);
    // デフォルトの個人用プロジェクト回りを整備
    // TODO 本来はキューとかで別ドメインに移管したい処理。
    const team = new TeamEntity();
    team.teamType = TeamType.Alone;
    team.name = user.name!;
    team.label = '個人用';
    team.description = '個人用';

    // チーム作成
    team.tenantKey = user.tenantKey;
    team.createdBy = user.id;
    team.updatedBy = user.id;
    team.createdIp = ip;
    team.updatedIp = ip;
    return manager.getRepository(TeamEntity).save(team).then(savedTeam => {
        // console.log(`Create Default Projects. Team fine.`);
        // チーム作成ユーザーをメンバーとして追加
        const teamMember = new TeamMemberEntity();
        teamMember.teamId = savedTeam.id;
        teamMember.userId = user.id;
        teamMember.role = TeamMemberRoleType.Owner;
        teamMember.tenantKey = user.tenantKey;
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
        projectDef.tenantKey = user.tenantKey;
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
        projectArch.tenantKey = user.tenantKey;
        projectArch.createdBy = user.id;
        projectArch.updatedBy = user.id;
        projectArch.createdIp = ip;
        projectArch.updatedIp = ip;

        // 作成
        return Promise.all([
            manager.getRepository(TeamMemberEntity).save(teamMember),
            manager.getRepository(ProjectEntity).save(projectDef),
            manager.getRepository(ProjectEntity).save(projectArch),
        ]).then(() => user); // 最後userに戻して返す。  
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
                where: { tenantKey: req.info.user.tenantKey, userId: req.info.user.id, status: OAuthAccountStatus.ACTIVE },
                // accessTokenとかrefreshTokenは流出すると危険なので必ず絞る。
                select: ['tenantKey', 'id', 'userInfo', 'provider', 'label', 'providerUserId', 'providerEmail', 'createdAt', 'updatedAt']
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
    param('provider').isString().notEmpty(),
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        const provider = req.params.provider as string;
        try {
            // const accessToken = await getAccessToken(req.info.user.id, provider);
            const oauthAccount = await ds.getRepository(OAuthAccountEntity).findOneOrFail({
                where: { tenantKey: req.info.user.tenantKey, userId: req.info.user.id, provider, status: OAuthAccountStatus.ACTIVE },
                // accessTokenとかrefreshTokenは流出すると危険なので必ず絞る。
                select: ['tenantKey', 'id', 'userInfo', 'provider', 'label', 'providerUserId', 'providerEmail', 'createdAt', 'updatedAt']
            });
            // console.log(oauthAccounts);
            res.json({ oauthAccount });
        } catch (error) {
            console.error('Error fetching OAuth accounts:', error);
            res.status(401).json({ message: 'OAuth認証済みアカウントが取得できませんでした。' });
        }
    }
];

import { ds } from '../db.js';
import jwt from 'jsonwebtoken';

import { NextFunction, Request, Response } from 'express';

import { InviteEntity, OAuthAccountEntity, OAuthAccountStatus, SessionEntity, UserEntity, UserRoleType, UserStatus } from '../entity/auth.entity.js';

import { InviteRequest, OAuthUserRequest, UserRequest } from '../models/info.js';
import { Utils } from '../../common/utils.js';

// import { randomBytes } from 'crypto';
import { In } from 'typeorm';
import cookieParser from 'cookie-parser';
import cookie from 'cookie';
import { tryRefreshCore, verifyJwt } from '../controllers/auth.js';
import { getAccessToken } from '../api/api-proxy.js';
import { decrypt } from '../controllers/tool-call.js';
// export const JWT_SECRET: string = process.env['JWT_SECRET'] || randomBytes(64).toString('hex').substring(0, 64);

export const { ACCESS_TOKEN_JWT_SECRET, ACCESS_TOKEN_EXPIRES_IN, REFRESH_TOKEN_JWT_SECRET, REFRESH_TOKEN_EXPIRES_IN, API_TOKEN_JWT_SECRET, API_TOKEN_EXPIRES_IN, ONETIME_TOKEN_JWT_SECRET, ONETIME_TOKEN_EXPIRES_IN } = process.env as { ACCESS_TOKEN_JWT_SECRET: string, ACCESS_TOKEN_EXPIRES_IN: string, REFRESH_TOKEN_JWT_SECRET: string, REFRESH_TOKEN_EXPIRES_IN: string, API_TOKEN_JWT_SECRET: string, API_TOKEN_EXPIRES_IN: string, ONETIME_TOKEN_JWT_SECRET: string, ONETIME_TOKEN_EXPIRES_IN: string };
export interface Token {
    tenantKey: string;
    type: string;
}

/**
 * JWTのユーザー認証情報
 */
export interface UserToken extends Token {
    type: 'user';
    id: string;
    // seq: number;
    email: string;
    name?: string;
    role: UserRoleType;
    authGeneration: number;
}

/**
 * JWTの招待トークン情報
 */
export interface InviteToken extends Token {
    type: 'invite';
    id: string;
    // seq: number;
    email: string;
}

/**
 * JWTのリフレッシュトークン情報
 */
export interface RefreshToken extends Token {
    type: 'refresh' | 'api';
    userId: string;
    sessionId: string;
    lastActiveAt: Date;
    authGeneration: number;
    email: string;
    name?: string;
    role: UserRoleType;
}
type IsAuthDto = { isAuth: boolean, obj: any };

/**
 * ユーザー認証の検証
 */
export const authenticateUserTokenMiddleGenerator = (roleType?: UserRoleType, force = true) =>
    async (req: Request, res: Response, next: NextFunction): Promise<IsAuthDto> => {
        // console.log(`req.cookies=` + JSON.stringify(req.cookies, Utils.genJsonSafer()));
        const xRealIp = req.headers['x-real-ip'] as string || req.ip || '';
        try {
            return Promise.resolve().then(async () => {
                // JWT認証ロジック
                // console.log(`req.cookies.access_token=` + req.cookies.access_token);
                if (!((req.cookies && (req.cookies.access_token || req.cookies.refresh_token)) || req.headers.authorization)) {
                    // 全くトークンがない場合は即時停止
                    return Promise.resolve({ isAuth: false, obj: new Error('auth info not found 0') });
                } else {
                    // トークンアリの場合は検証を行う。
                }

                try {
                    // アクセストークン検証
                    const userToken = await verifyJwt<UserToken>(req.cookies.access_token, ACCESS_TOKEN_JWT_SECRET, 'user');
                    const userEntity = { id: userToken.id, role: userToken.role, name: userToken.name, email: userToken.email, tenantKey: userToken.tenantKey } as UserToken;

                    (req as UserRequest).info = { user: userToken, ip: xRealIp, cookie: req.cookies, };
                    return { isAuth: true, obj: userEntity };
                } catch (err) {
                    // アクセストークン無し
                }

                try {
                    // リフレッシュトークン検証
                    const { userEntity, accessToken } = await ds.transaction(async manager => await tryRefreshCore(manager, xRealIp, 'refresh', req.cookies.refresh_token, roleType));

                    // クッキーをセット
                    res.cookie('access_token', accessToken, {
                        maxAge: Utils.parseTimeStringToMilliseconds(ACCESS_TOKEN_EXPIRES_IN), // クッキーの有効期限をミリ秒で指定
                        httpOnly: true, // クッキーをHTTPプロトコルのみでアクセス可能にする
                        secure: true, // HTTPSでのみ送信されるようにする
                        sameSite: false, // CSRF保護のためのオプション
                    });

                    const userToken = { id: userEntity.id, role: userEntity.role, name: userEntity.name, email: userEntity.email, tenantKey: userEntity.tenantKey } as UserToken;
                    (req as UserRequest).info = { user: userToken, ip: xRealIp, cookie: req.cookies };
                    return { isAuth: true, obj: userEntity };
                } catch (err) {
                    // リフレッシュトークン無し
                }


                try {
                    // API用トークンの検証
                    const { userEntity, accessToken } = await ds.transaction(async manager => await tryRefreshCore(manager, xRealIp, 'api', req.headers.authorization?.split(' ')[1] || '', roleType));

                    const userToken = { id: userEntity.id, role: userEntity.role, name: userEntity.name, email: userEntity.email, tenantKey: userEntity.tenantKey } as UserToken;
                    (req as UserRequest).info = { user: userToken, ip: xRealIp, cookie: req.cookies };
                    return { isAuth: true, obj: userEntity };
                } catch (err) {
                    // API用トークン無し
                    // console.log(err);
                }

                return { isAuth: false, obj: new Error('Authentication failed: No valid token found') };
            }).then(isAuthDto => {
                if (force) {
                    // console.log(`isAuthDto.isAuth=${isAuthDto.isAuth}`);
                    // foceの場合は後続を実行 or Responseを返す。
                    if (isAuthDto.isAuth) {
                        next();
                    } else {
                        res.cookie('access_token', '', { maxAge: 0, path: '/' });
                        res.cookie('refresh_token', '', { maxAge: 0, path: '/' });
                        res.sendStatus(401);
                    }
                } else {
                    // DryRunなので何もしない。
                }
                return isAuthDto;
            });
        } catch (e) {
            res.cookie('access_token', '', { maxAge: 0, path: '/' });
            res.cookie('refresh_token', '', { maxAge: 0, path: '/' });
            res.sendStatus(401);
            return Promise.resolve({ isAuth: false, obj: new Error('Authentication failed: Token not found') });
        }
    };

/**
 * ユーザー認証の検証
 */
export const authenticateOAuthUser = async (_req: Request, res: Response, next: NextFunction) => {
    // JWT認証ロジック
    const req = _req as OAuthUserRequest;
    // console.log(`req.path=${req.path}`);
    const [_, providerType, providerName] = req.path.replaceAll(/^\//g, '').split('/');
    const provider = `${providerType}-${providerName}`;
    try {
        // console.log(`provider=${provider}`);
        const { accessToken, providerUserId, providerEmail, tokenExpiresAt, userInfo } = await getAccessToken(req.info.user.tenantKey, req.info.user.id, provider);
        // console.log(`accessToken=${accessToken}`);
        // なんとなく使いそうな項目だけに絞っておく。
        req.info.oAuth = { accessToken, providerUserId, providerEmail, tokenExpiresAt, userInfo, provider } as OAuthAccountEntity;
        if (req.info.oAuth.accessToken && req.info.oAuth.accessToken !== 'dummy') {
            req.info.oAuth.accessToken = decrypt(req.info.oAuth.accessToken);
        } else { }
        if (req.info.oAuth.refreshToken && req.info.oAuth.refreshToken !== 'dummy') {
            req.info.oAuth.refreshToken = decrypt(req.info.oAuth.refreshToken);
        } else { }

        // const jwtStringBefore = req.cookies[`oauth_${provider}`];
        // // console.log(`provider=${provider} jwtStringBefore=${jwtStringBefore}`);

        // // _oAuth2TokenDto: OAuth2TokenDto
        // const jwtDto = await verifyJwt<{ userId: string, provider: string, oAuth2TokenDto: OAuth2TokenDto }>(jwtStringBefore, OAUTH2_STATE_JWT_SECRET);
        // let access_token = jwtDto.oAuth2TokenDto.access_token;

        // if (jwtDto.userId !== req.info.user.id) {
        //     throw new Error('invalid user');
        // } else { }

        // let oAuthAccount = await ds.getRepository(OAuthAccountEntity).findOneOrFail({
        //     where: { userId: req.info.user.id, status: OAuthAccountStatus.ACTIVE, provider },
        // });
        // const e = readOAuth2Env(provider);

        // async function refreshToken() {
        //     // トークンリフレッシュ
        //     const postData = { client_id: e.clientId, client_secret: e.clientSecret, grant_type: 'refresh_token', refresh_token: jwtDto.oAuth2TokenDto.refresh_token };
        //     let params = null, body = null;
        //     if (e.postType === 'params') {
        //         params = postData;
        //     } else {
        //         body = postData;
        //     }

        //     let tokenPromise = null;
        //     if (params) {
        //         tokenPromise = e.axios.post<OAuth2TokenDto>(`${e.uriBase}${e.pathAccessToken}`, {}, { params });
        //     } else {
        //         tokenPromise = e.axios.post<OAuth2TokenDto>(`${e.uriBase}${e.pathAccessToken}`, body);
        //     }

        //     // アクセストークンを取得するためのリクエスト
        //     return tokenPromise.then(async token => {
        //         // 現在の時刻にexpiresInSeconds（秒）を加算して、有効期限のDateオブジェクトを作成
        //         if (token.data.expires_in) {
        //             oAuthAccount.tokenExpiresAt = new Date(Date.now() + token.data.expires_in * 1000);
        //         } else { /** expiresは設定されていないこともある。 */ }

        //         // JWTの生成
        //         const jwtString = jwt.sign({ userId: req.info.user.id, provider, tokenExpiresAt: oAuthAccount.tokenExpiresAt, oAuth2TokenDto: token.data }, OAUTH2_STATE_JWT_SECRET, { expiresIn: `${token.data.expires_in}s` });
        //         res.cookie(`oauth_${provider}`, jwtString, {
        //             maxAge: token.data.expires_in * 1000, // ミリ秒単位で指定
        //             httpOnly: true, // クッキーをHTTPプロトコルのみでアクセス可能にする
        //             secure: true, // HTTPSでのみ送信されるようにする
        //             sameSite: true, // CSRF保護のためのオプション
        //         });

        //         access_token = token.data.access_token;
        //         // 保存しないように塗りつぶす。
        //         token.data.access_token = `dummy`;
        //         token.data.refresh_token = `dummy`;
        //         oAuthAccount.accessToken = token.data.access_token;
        //         oAuthAccount.refreshToken = token.data.refresh_token;
        //         oAuthAccount.tokenBody = JSON.stringify(token.data);
        //         oAuthAccount.updatedBy = req.info.user.id;

        //         // 後でトランザクション化した方が良いか？
        //         oAuthAccount = await oAuthAccount.save();
        //         return oAuthAccount;
        //     });
        // }

        // // console.log(oAuthAccount.tokenExpiresAt, new Date());
        // if (oAuthAccount.tokenExpiresAt && oAuthAccount.tokenExpiresAt < new Date()) {
        //     await refreshToken();
        // } else {
        //     // 変更無し
        // }
        // const { accessToken, providerUserId, providerEmail, tokenExpiresAt, userInfo } = oAuthAccount;

        // req.info.oAuth = { accessToken, providerUserId, providerEmail, tokenExpiresAt, userInfo, provider } as OAuthAccountEntity;
        // req.info.oAuth.accessToken = access_token; // dummyになっているのを戻す。

        // const originalSend = res.send.bind(res);
        // // res.sendをオーバーライド
        // res.send = (body?: any): Response => {
        //     // ステータスコードが401の場合
        //     if (res.statusCode === 401) {
        //         console.log('下流のミドルウェアから401が返されました。アクセストークンをリフレッシュします。');

        //         refreshToken().then(oAuthAccount => {
        //             next();
        //         }).catch(error => {
        //             // リフレッシュに失敗した場合、エラーレスポンスを送信
        //             res.status(401).send('トークンのリフレッシュに失敗しました');
        //         });

        //         // オーバーライドしたsendを元に戻す
        //         res.send = originalSend;

        //         // 一旦レスポンスの送信を中断
        //         return res;
        //     } else {
        //         // ステータスコードが401以外の場合は、そのまま送信
        //         return originalSend(body);
        //     }
        // };

        next();
    } catch (error) {
        console.error(`OAuth authentication failed: ${error}`);
        try {
            // 認証情報とかがログに出ないように特定の項目に絞る
            const logObj = Object.fromEntries(['data', 'code', 'message', 'status', 'response.data'].map(key => [key, key === 'response.data' ? (error as any).response?.data : (error as any)[key]]));
            console.dir(logObj);
        } catch (error) { }
        res.sendStatus(401);
    }
    return;
}

// ws用認証ミドルウェア。雑過ぎる。
export const authenticateUserTokenWsMiddleGenerator = (roleType?: UserRoleType) =>
    (req: Request, socket: any, header: any, next: any) => {
        try {
            new Promise((resolve, reject) => {
                // JWT認証ロジック
                // console.log(`req.cookies.access_token=` + req.cookies.access_token);
                const parsedCookies = cookie.parse(req.headers?.cookie || '');
                if (!(req.headers && parsedCookies.access_token)) {
                    reject(new Error('cookie not found'));
                    return;
                }
                const token = parsedCookies.access_token;
                // console.log(`token=` + parsedCookies.access_token);
                jwt.verify(token, ACCESS_TOKEN_JWT_SECRET, (err: any, _token: any) => {
                    const userToken = _token as UserToken;
                    if (err) {
                        reject(err);
                        return;
                    }
                    if (userToken.type === 'user' && userToken.id) {
                        const where = {
                            id: userToken.id,                     // JWTのユーザーIDと一致すること
                            authGeneration: userToken.authGeneration, // JWTの認証世代と一致すること
                            status: UserStatus.Active, // activeユーザーじゃないと使えない
                        } as Record<string, any>;

                        if (roleType === UserRoleType.Admin) {
                            // 管理者用の認証チェック
                            where['role'] = In([UserRoleType.Admin, UserRoleType.Maintainer]);
                        } else { }
                        // ユーザーの存在確認 ※こんなことやってるからjwtにした意味はなくなってしまうが即時停止をやりたいのでやむなく。
                        ds.getRepository(UserEntity).findOne({ where }).then((user: UserEntity | null) => {
                            if (user == null) {
                                // res.status(401).json({ message: 'ユーザーが見つかりませんでした。' });
                                reject(new Error('user not found'));
                                return;
                            } else {
                                // 認証OK。リクエストにユーザーIDを付与して次の処理へ
                                // user.dataValuesはそのままだとゴミがたくさん付くので、項目ごとにUserModelにマッピングする。
                                // TODO ここはもっとスマートに書けるはず。マッパーを用意するべきか？
                                const userToken = {
                                    tenantKey: user.tenantKey,
                                    type: 'user',
                                    id: user.id,
                                    name: user.name,
                                    email: user.email,
                                    role: user.role,
                                } as UserToken;
                                (req as UserRequest).info = { user: userToken, ip: req.headers['x-real-ip'] as string || '0.0.0.0', cookie: req.cookies };
                                resolve(userToken);
                                return;
                            }
                        });
                    } else {
                        reject(new Error('invalid token'));
                        return;
                    }
                })
            }).then(ok => {
                next();
            }).catch(error => {
                // トークンリフレッシュを内部的にやったとてcookieで戻せないので何もできない・・？
                console.log(error);
                socket.destroy();
            });
        } catch (e) {
            socket.destroy();
            // res.sendStatus(401);
        }
    }

/**
 * inviteTokenの検証。
 */
export const authenticateInviteToken = (req: Request, res: Response, next: NextFunction) => {
    // JWT認証ロジック
    const token = req.headers.authorization?.split(' ')[1];
    if (token == null) return res.sendStatus(401);
    jwt.verify(token, ONETIME_TOKEN_JWT_SECRET, (err: any, _token: any) => {
        const inviteToken = _token as InviteToken;
        if (err) return res.sendStatus(403);
        if (inviteToken.type === 'invite') {
            (req as InviteRequest).info = { invite: inviteToken, ip: req.headers['x-real-ip'] as string || '0.0.0.0' };
            next();
        } else {
            return res.sendStatus(403);
        }
    });
    return;
}

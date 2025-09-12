import cookie from 'cookie';
import { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { In } from 'typeorm';

import { Utils } from '../../common/utils.js';
import { getAccessToken } from '../api/api-proxy.js';
import { ACCESS_TOKEN_JWT_SECRET, JWT_STAT_PARAM, ONETIME_TOKEN_JWT_SECRET, verifyApiKey, verifyJwt } from '../controllers/auth.js';
import { decrypt } from '../controllers/tool-call.js';
import { ds } from '../db.js';
import { OAuthAccountEntity, UserEntity, UserRole, UserRoleEntity, UserRoleType, UserStatus } from '../entity/auth.entity.js';
import { InviteRequest, OAuthUserRequest, UserRequest } from '../models/info.js';

export interface TokenPayload {
    orgKey: string;
    type: 'user' | 'invite' | 'refresh' | 'api' | 'session';
}

/**
 * JWTのユーザー認証情報
 */
export interface UserTokenPayload extends TokenPayload {
    type: 'user';
    id: string;
    authGeneration: number;
    sid: string;
    jti: string;
}
export interface UserTokenPayloadWithRole extends UserTokenPayload {
    roleList: UserRole[];
}

/**
 * JWTの招待トークン情報
 */
export interface InviteTokenPayload extends TokenPayload {
    type: 'invite';
    id: string;
    // seq: number;
}

/**
 * JWTのリフレッシュトークン情報
 */
export interface RefreshTokenPayload extends TokenPayload {
    type: 'refresh' | 'api';
    userId: string;
    sessionId: string;
    authGeneration: number;
}
type IsAuthDto = { isAuth: true, obj: UserTokenPayloadWithRole } | { isAuth: false, obj: Error };

/**
 * ユーザー認証の検証
 */
export const authenticateUserTokenMiddleGenerator = (roleType?: UserRoleType, force = true) =>
    async (req: Request, res: Response, next: NextFunction): Promise<IsAuthDto> => {
        // console.log(`req.cookies=` + JSON.stringify(req.cookies, Utils.genJsonSafer()));
        const xRealIp = req.ip || '';
        let deviceInfo = {};
        if (req.useragent) {
            deviceInfo = Utils.jsonOrder(req.useragent, ['browser', 'version', 'os', 'platform', 'isDesktop', 'isMobile', 'isTablet']);
        } else { }

        try {
            return Promise.resolve().then(async () => {
                // JWT認証ロジック
                // console.log(`req.cookies.access_token=` + req.cookies.access_token);
                if (!((req.cookies && req.cookies.access_token) || req.headers.authorization)) {
                    // 全くトークンがない場合は即時停止
                    return Promise.resolve({ isAuth: false, obj: new Error('auth info not found 0') });
                } else {
                    // トークンアリの場合は検証を行う。
                }

                try {
                    const userTokenPayload = await (req.cookies.access_token
                        // アクセストークン検証
                        ? verifyJwt<UserTokenPayload>(req.cookies.access_token, ACCESS_TOKEN_JWT_SECRET, 'user')
                        // API用トークンの検証
                        : ds.transaction(async manager => await verifyApiKey(xRealIp, manager, req.headers.authorization?.split(' ')[1] || ''))
                    );

                    if (!userTokenPayload) {
                        throw new Error(`${req.ip} API key not found`);
                    }

                    // ロールを毎回DBから取得
                    const roleList = (await ds.getRepository(UserRoleEntity).find({
                        // select: ['role', 'scopeInfo'],
                        where: {
                            orgKey: userTokenPayload.orgKey,
                            userId: userTokenPayload.id,
                            status: UserStatus.Active,
                        }
                    })).map(role => {
                        return ({ role: role.role, scopeInfo: role.scopeInfo } as UserRole);
                    });

                    const enrichedPayload = { ...userTokenPayload, roleList };
                    (req as UserRequest).info = { ip: xRealIp, user: enrichedPayload };
                    return { isAuth: true, obj: enrichedPayload };
                } catch (err: Error | any) {
                    if (err instanceof jwt.TokenExpiredError) {
                        console.warn(`${req.ip} Access token has expired.`);
                    } else if (err instanceof jwt.JsonWebTokenError) {
                        console.error(`${req.ip} Failed to verify JWT.`);
                    } else if (err instanceof Error) {
                        console.error(`${req.ip} ${err.message}`);
                    } else {
                        console.error(`${req.ip} Unexpected error occurred during authentication.`);
                        // console.error(err);
                    }
                }

                console.log(`auth info not found 1`);
                return { isAuth: false, obj: new Error('Authentication failed: No valid token found') };
            }).then(isAuthDto => {
                if (force) {
                    // console.log(`isAuthDto.isAuth=${isAuthDto.isAuth}`);
                    // forceの場合は後続を実行 or Responseを返す。
                    if (isAuthDto.isAuth) {
                        next();
                    } else {
                        res.cookie('access_token', '', { maxAge: 0, path: '/' });
                        res.sendStatus(401);
                    }
                } else {
                    // DryRunなので何もしない。
                }
                return isAuthDto as IsAuthDto;
            });
        } catch (e) {
            res.cookie('access_token', '', { maxAge: 0, path: '/' });
            res.sendStatus(401);
            console.log(`auth info not found 2`);
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
        const { accessToken, providerUserId, providerEmail, tokenExpiresAt, userInfo } = await getAccessToken(req.info.user.orgKey, req.info.user.id, provider);
        // console.log(`accessToken=${accessToken}`);
        // なんとなく使いそうな項目だけに絞っておく。
        req.info.oAuth = { accessToken, providerUserId, providerEmail, tokenExpiresAt, userInfo, provider } as OAuthAccountEntity;
        if (req.info.oAuth.accessToken && req.info.oAuth.accessToken !== 'dummy') {
            req.info.oAuth.accessToken = decrypt(req.info.oAuth.accessToken);
        } else { }
        if (req.info.oAuth.refreshToken && req.info.oAuth.refreshToken !== 'dummy') {
            req.info.oAuth.refreshToken = decrypt(req.info.oAuth.refreshToken);
        } else { }

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
            const xRealIp = req.ip || '0.0.0.0';
            new Promise((resolve, reject) => {
                // JWT認証ロジック
                // console.log(`req.cookies.access_token=` + req.cookies.access_token);
                const parsedCookies = cookie.parse(req.headers?.cookie || '');
                if (!(req.headers && parsedCookies.access_token)) {
                    reject(new Error(`cookie not found ${xRealIp}`));
                    return;
                }
                const token = parsedCookies.access_token;
                // console.log(`token=` + parsedCookies.access_token);
                jwt.verify(token, ACCESS_TOKEN_JWT_SECRET, JWT_STAT_PARAM, (err: any, _payload: any) => {
                    const tokenPayload = _payload as UserTokenPayload;
                    if (err) {
                        reject(err);
                        return;
                    }
                    if (tokenPayload.type === 'user' && tokenPayload.id) {
                        const where = {
                            orgKey: tokenPayload.orgKey, // JWTの組織キーと一致すること
                            id: tokenPayload.id,                     // JWTのユーザーIDと一致すること
                            authGeneration: tokenPayload.authGeneration, // JWTの認証世代と一致すること
                            status: UserStatus.Active, // activeユーザーじゃないと使えない
                        } as Record<string, any>;

                        // ユーザーの存在確認 ※こんなことやってるからjwtにした意味はなくなってしまうが即時停止をやりたいのでやむなく。
                        ds.getRepository(UserEntity).findOne({ where }).then((user: UserEntity | null) => {
                            if (user == null) {
                                // res.status(401).json({ message: 'ユーザーが見つかりませんでした。' });
                                reject(new Error(`user not found ${xRealIp}`));
                                return;
                            } else {
                                ds.getRepository(UserRoleEntity).find({ where: { orgKey: user.orgKey, userId: user.id, status: UserStatus.Active } }).then(roleList => {
                                    // 認証OK。リクエストにユーザーIDを付与して次の処理へ
                                    // user.dataValuesはそのままだとゴミがたくさん付くので、項目ごとにUserModelにマッピングする。
                                    // TODO ここはもっとスマートに書けるはず。マッパーを用意するべきか？

                                    // // 管理者用の認証チェック
                                    where['role'] = In([roleType, UserRoleType.SuperAdmin]);

                                    const userTokenPayload = {
                                        type: 'user',
                                        orgKey: user.orgKey,
                                        id: user.id,
                                        email: user.email,
                                        name: user.name,
                                        roleList: roleList,
                                        authGeneration: user.authGeneration,
                                        jti: tokenPayload.jti,
                                        sid: tokenPayload.sid,
                                    } as UserTokenPayloadWithRole;
                                    (req as UserRequest).info = { user: userTokenPayload, ip: xRealIp };
                                    resolve(userTokenPayload);
                                    return;
                                });
                            }
                        });
                    } else {
                        reject(new Error(`invalid token ${xRealIp}`));
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
    jwt.verify(token, ONETIME_TOKEN_JWT_SECRET, JWT_STAT_PARAM, (err: any, _token: any) => {
        const inviteTokenPayload = _token as InviteTokenPayload;
        if (err) return res.sendStatus(403);
        if (inviteTokenPayload.type === 'invite') {
            (req as InviteRequest).info = { invite: inviteTokenPayload, ip: req.ip || '0.0.0.0' };
            next();
        } else {
            return res.sendStatus(403);
        }
    });
    return;
}

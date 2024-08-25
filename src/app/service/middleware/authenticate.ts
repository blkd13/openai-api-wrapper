import { ds } from '../db.js';
import jwt from 'jsonwebtoken';
import { NextFunction, Request, Response } from 'express';

import { InviteEntity, SessionEntity, UserEntity, UserRoleType, UserStatus } from '../entity/auth.entity.js';

import { InviteRequest, UserRequest } from '../models/info.js';
import { Utils } from '../../common/utils.js';

import * as dotenv from 'dotenv';
// import { randomBytes } from 'crypto';
import { In } from 'typeorm';
dotenv.config();
// export const JWT_SECRET: string = process.env['JWT_SECRET'] || randomBytes(64).toString('hex').substring(0, 64);

export const { ACCESS_TOKEN_JWT_SECRET, ACCESS_TOKEN_EXPIRES_IN, REFRESH_TOKEN_JWT_SECRET, REFRESH_TOKEN_EXPIRES_IN, ONETIME_TOKEN_JWT_SECRET, ONETIME_TOKEN_EXPIRES_IN } = process.env as { ACCESS_TOKEN_JWT_SECRET: string, ACCESS_TOKEN_EXPIRES_IN: string, REFRESH_TOKEN_JWT_SECRET: string, REFRESH_TOKEN_EXPIRES_IN: string, ONETIME_TOKEN_JWT_SECRET: string, ONETIME_TOKEN_EXPIRES_IN: string };
export interface Token {
    type: string;
}

/**
 * JWTのユーザー認証情報
 */
export interface UserToken extends Token {
    type: 'user';
    id: string;
    // seq: number;
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
    type: 'refresh';
    userId: string;
    sessionId: string;
    lastActiveAt: Date;
    authGeneration: number;
}

/**
 * ユーザー認証の検証
 */
export const authenticateUserTokenMiddleGenerator = (roleType?: UserRoleType) =>
    (req: Request, res: Response, next: NextFunction) => {
        try {
            // TODO なんかちょっと雑に拡張したからバグったかも。。要チェック。
            new Promise((resolve, reject) => {
                // JWT認証ロジック
                // console.log(`req.cookies.access_token=` + req.cookies.access_token);
                if (!(req.cookies && req.cookies.access_token)) {
                    reject(new Error('cookie not found'));
                    return;
                }
                const token = req.cookies.access_token;
                // console.log(`token=` + req.cookies.access_token);
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
                                const userEntity = new UserEntity();
                                userEntity.id = user.id;
                                userEntity.name = user.name;
                                userEntity.email = user.email;
                                userEntity.role = user.role;
                                (req as UserRequest).info = { user: userEntity };
                                resolve(userEntity);
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
                // トークンリフレッシュを内部的にやってしまう。
                if (!(req.cookies && req.cookies.refresh_token)) {
                    res.sendStatus(401);
                } else {
                    console.log(`token refresh ${req.cookies.refresh_token}`);
                    jwt.verify(req.cookies.refresh_token, REFRESH_TOKEN_JWT_SECRET, (err: any, _token: any) => {
                        const refreshToken = _token as RefreshToken;
                        if (err) {
                            res.sendStatus(401);
                            return;
                        }
                        ds.transaction(async manager => {
                            try {

                                const session = await manager.getRepository(SessionEntity).findOneOrFail({ where: { id: refreshToken.sessionId, userId: refreshToken.userId } });

                                const where = {
                                    id: refreshToken.userId,                     // JWTのユーザーIDと一致すること
                                    authGeneration: refreshToken.authGeneration, // JWTの認証世代と一致すること
                                    status: UserStatus.Active, // activeユーザーじゃないと使えない
                                } as Record<string, any>;
                                if (roleType === UserRoleType.Admin) {
                                    // 管理者用の認証チェック
                                    where['role'] = In([UserRoleType.Admin, UserRoleType.Maintainer]);
                                } else { }
                                // ユーザーの存在確認 ※こんなことやってるからjwtにした意味はなくなってしまうが即時停止をやりたいのでやむなく。
                                const user = await manager.getRepository(UserEntity).findOneOrFail({ where });

                                // 認証OK。リクエストにユーザーIDを付与して次の処理へ
                                // user.dataValuesはそのままだとゴミがたくさん付くので、項目ごとにUserModelにマッピングする。
                                // TODO ここはもっとスマートに書けるはず。マッパーを用意するべきか？
                                const userEntity = new UserEntity();
                                userEntity.id = user.id;
                                userEntity.name = user.name;
                                userEntity.email = user.email;
                                userEntity.role = user.role;
                                (req as UserRequest).info = { user: userEntity };

                                // 最終更新日だけ更新して更新
                                session.lastActiveAt = new Date();
                                session.updatedBy = user.id;
                                const savedSession = await manager.getRepository(SessionEntity).save(session);

                                // JWTの生成
                                const userToken: UserToken = { type: 'user', id: user.id, authGeneration: user.authGeneration || 0 };
                                const accessToken = jwt.sign(userToken, ACCESS_TOKEN_JWT_SECRET, { expiresIn: ACCESS_TOKEN_EXPIRES_IN });

                                // クッキーをセット
                                res.cookie('access_token', accessToken, {
                                    maxAge: Utils.parseTimeStringToMilliseconds(ACCESS_TOKEN_EXPIRES_IN), // クッキーの有効期限をミリ秒で指定
                                    httpOnly: true, // クッキーをHTTPプロトコルのみでアクセス可能にする
                                    secure: true, // HTTPSでのみ送信されるようにする
                                    sameSite: true, // CSRF保護のためのオプション
                                });

                                // リフレッシュトークンの回転は並列リクエストを考慮すると難しかったので一旦やらない。
                                // if (session.expiresAt) {
                                //     // session.expiresAtは動かしたくないので、そこからの差分を求める。
                                //     const expiresInMs = session.expiresAt.getTime() - new Date().getTime();
                                //     // 差分を秒に変換
                                //     const expiresIn = Math.floor(expiresInMs / 1000);
                                //     const refreshTokenBody: RefreshToken = { type: 'refresh', sessionId: savedSession.id, userId: user.id, lastActiveAt: session.lastActiveAt, authGeneration: user.authGeneration || 0 };
                                //     const refreshToken = jwt.sign(refreshTokenBody, REFRESH_TOKEN_JWT_SECRET, { expiresIn: expiresIn });
                                //     // リフレッシュトークンを回転
                                //     res.cookie('refresh_token', refreshToken, {
                                //         maxAge: expiresInMs, // 14日間。クッキーの有効期限をミリ秒で指定
                                //         httpOnly: true, // クッキーをHTTPプロトコルのみでアクセス可能にする
                                //         secure: true, // HTTPSでのみ送信されるようにする
                                //         sameSite: true, // CSRF保護のためのオプション
                                //     });
                                //     next();
                                // } else {
                                //     next();
                                // }
                                next();
                            } catch (e) {
                                res.sendStatus(401);
                                return;
                            }
                        })
                    });
                }
            });
        } catch (e) {
            res.sendStatus(401);
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
            const invite = new InviteEntity();
            invite.id = inviteToken.id;
            invite.email = inviteToken.email;
            (req as InviteRequest).info = { invite: invite };
            next();
        } else {
            return res.sendStatus(403);
        }
    });
    return;
}
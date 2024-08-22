import jwt from 'jsonwebtoken';
import { NextFunction, Request, Response } from 'express';

import { InviteEntity, UserEntity, UserRoleType, UserStatus } from '../entity/auth.entity.js';

import { InviteRequest, UserRequest } from '../models/info.js';

import * as dotenv from 'dotenv';
import { randomBytes } from 'crypto';
import { In } from 'typeorm';
dotenv.config();
export const JWT_SECRET: string = process.env['JWT_SECRET'] || randomBytes(64).toString('hex').substring(0, 64);

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
 * ユーザー認証の検証
 */
export const authenticateUserTokenMiddleGenerator = (roleType?: UserRoleType) =>
    (req: Request, res: Response, next: NextFunction) => {
        // JWT認証ロジック
        const token = req.headers.authorization?.split(' ')[1];
        if (token == null) return res.sendStatus(401);
        jwt.verify(token, JWT_SECRET, (err: any, _token: any) => {
            const userToken = _token as UserToken;
            if (err) return res.sendStatus(401);
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
                // ユーザーが存在確認
                UserEntity.findOne<UserEntity>({ where }).then((user: UserEntity | null) => {
                    if (user == null) {
                        res.status(401).json({ message: 'ユーザーが見つかりませんでした。' });
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
                        next();
                    }
                });
            } else {
                return res.sendStatus(401);
            }
        })
    }

/**
 * inviteTokenの検証。
 */
export const authenticateInviteToken = (req: Request, res: Response, next: NextFunction) => {
    // JWT認証ロジック
    const token = req.headers.authorization?.split(' ')[1];
    if (token == null) return res.sendStatus(401);
    jwt.verify(token, JWT_SECRET, (err: any, _token: any) => {
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
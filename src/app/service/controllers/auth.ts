import { body, param } from 'express-validator';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';
import { randomBytes } from 'crypto';
import nodemailer from 'nodemailer';
import { Request, Response } from 'express';

import { InviteRequest, UserRequest } from '../models/info.js';
import { UserEntity, InviteEntity } from '../entity/auth.entity.js';
import { InviteToken, JWT_SECRET, UserToken } from '../middleware/authenticate.js';
import { validationErrorHandler } from '../middleware/validation.js';
import { MoreThan } from 'typeorm';
import { ds } from '../db.js';

/**
 * [認証不要] ユーザーログイン
 * @param req 
 * @param res 
 * @returns 
 */
export const userLogin = [
    body('email').trim().notEmpty(),  // .withMessage('メールアドレスを入力してください。'),
    body('password').trim().notEmpty(),  // .withMessage('パスワードを入力してください。'),
    validationErrorHandler,
    (req: Request, res: Response) => {
        return ds.getRepository(UserEntity).findOne({ where: { email: req.body.email } }).then((user: UserEntity | null) => {
            if (user == null || !bcrypt.compareSync(req.body.password, user.passwordHash || '')) {
                res.status(401).json({ message: '認証に失敗しました。' });
                return;
            }
            // JWTの生成
            const userToken: UserToken = { type: 'user', id: user.id, authGeneration: user.authGeneration || 0 };
            const token = jwt.sign(userToken, JWT_SECRET, { expiresIn: '1y' });
            res.json({ token });
            // return { token };
        });
    }
];

/**
 * [認証不要] ワンタイムトークンの検証
 * @param req 
 * @param res 
 * @returns 
 */
export const onetimeLogin = [
    body('type').trim().notEmpty(),  // .withMessage('ワンタイムトークンのタイプを入力してください。'),
    body('token').trim().notEmpty(),  // .withMessage('ワンタイムトークンを入力してください。'),
    validationErrorHandler,
    (req: Request, res: Response) => {
        ds.getRepository(InviteEntity).findOne({
            where: {
                onetimeToken: req.body.token as string,
                status: 'unused',
                type: req.body.type,
                limit: MoreThan(Date.now()),
            },
        }).then((onetimeModel: InviteEntity | null) => {
            if (onetimeModel == null) {
                res.status(401).json({ message: 'ワンタイムトークンが見つかりませんでした。' });
                return;
            } else {
                const inviteToken: InviteToken = {
                    type: 'invite',
                    id: onetimeModel.id,
                    email: onetimeModel.email,
                };
                // JWTの生成
                const jwtToken = jwt.sign(inviteToken, JWT_SECRET, { expiresIn: '1h' });
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
    body('email').trim().notEmpty().isEmail(),  // .withMessage('メールアドレスを入力してください。'),
    validationErrorHandler,
    (req: Request, res: Response) => {
        // 一時トークンの生成
        const onetimeToken = generateOnetimeToken();
        // ワンタイムトークンの登録
        const inviteEntity = new InviteEntity();
        inviteEntity.email = req.body.email;
        inviteEntity.onetimeToken = onetimeToken;
        inviteEntity.type = 'passwordReset';
        inviteEntity.status = 'unused';
        inviteEntity.data = JSON.stringify({ name: req.body.name, email: req.body.email });
        inviteEntity.limit = Date.now() + 1000 * 60 * 5; // 5分以内
        inviteEntity.save();

        // メール送信
        sendMail(req.body.email, 'パスワード設定依頼', `以下のURLからパスワード設定を完了してください。\nhttp://localhost:3000/invite/emailConfirm?token=${onetimeToken}`);

        // res.json({ message: 'パスワード設定依頼を受け付けました。' });
        res.json({ onetimeToken });
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

        const passwordValidateionMessage = passwordValidateion(req.body.password, req.body.passwordConfirm);
        if (passwordValidateionMessage) {
            res.status(401).json({ message: passwordValidateionMessage });
            return;
        } else {
            // 継続
        }

        ds.transaction((manager) => {
            // パスワード設定（emailが事実上の鍵）
            return manager.getRepository(UserEntity).findOne({ where: { email: req.info.invite.email } }).then((user: UserEntity | null) => {
                if (user) {
                    // 既存ユーザーの場合はパスワードを更新する
                    // パスワードのハッシュ化
                    user.passwordHash = bcrypt.hashSync(req.body.password, 10);
                    user.authGeneration = user.authGeneration || 0 + 1;
                } else {
                    // 初期名前をメールアドレスにする。エラーにならないように。。
                    req.body.name == req.body.name || req.info.invite.email;
                    // if (req.body.name == null || req.body.name == '') {
                    //     res.status(401).json({ message: '名前を入力してください。' });
                    //     throw new Error('名前を入力してください。');
                    // } else {
                    //     // 継続
                    // }
                    // 新規ユーザーの場合は登録する
                    user = new UserEntity();
                    user.name = req.body.name;
                    user.name = user.name || 'dummy name';
                    // jwtの検証で取得した情報をそのまま登録する
                    user.email = req.info.invite.email;
                    // パスワードのハッシュ化
                    user.passwordHash = bcrypt.hashSync(req.body.password, 10);
                    user.authGeneration = 1;
                }
                return user;
            }).then((user) => {
                return manager.getRepository(UserEntity).save(user);
            }).then((user) => {
                return manager.getRepository(InviteEntity).findOne({ where: { id: req.info.invite.id } }).then((invite: InviteEntity | null) => {
                    if (invite) {
                        invite.status = 'used';
                        invite.save();
                    } else {
                        // エラー。起こりえないケース
                    }
                    return user;
                });
            }).then((user) => {
                // JWTの生成
                const userToken: UserToken = { type: 'user', id: user.id, authGeneration: user.authGeneration || 0 };
                const jwtToken = jwt.sign(userToken, JWT_SECRET, { expiresIn: '1y' });
                res.json({ message: 'パスワードを設定しました。', token: jwtToken });
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
        ds.getRepository(UserEntity).findOne({ where: { id: req.info.user.id } }).then((user: UserEntity | null) => {
            if (user == null) {
                res.status(401).json({ message: 'ユーザーが見つかりませんでした。' });
                return;
            } else {
                // ユーザー情報の更新
                user.name = req.body.name;
                user.save().then(() => {
                    res.json({ message: 'ユーザー情報を更新しました。', user });
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
        const passwordValidateionMessage = passwordValidateion(req.body.password, req.body.passwordConfirm);
        if (passwordValidateionMessage) {
            res.status(401).json({ message: passwordValidateionMessage });
            return;
        } else {
            // 継続
        }

        // パスワード設定（emailが鍵のような役割）
        ds.getRepository(UserEntity).findOne({ where: { id: req.info.user.id } }).then((user: UserEntity | null) => {
            if (user == null) {
                res.status(401).json({ message: 'ユーザーが見つかりませんでした。' });
                return;
            } else {
                // パスワードのハッシュ化
                user.passwordHash = bcrypt.hashSync(req.body.password, 10);
                user.authGeneration = user.authGeneration || 0 + 1;
                user.save().then(() => {
                    res.json({ message: 'パスワードを変更しました。', user });
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
        ds.getRepository(UserEntity).findOne({ where: { id: req.info.user.id } }).then((user: UserEntity | null) => {
            if (user == null) {
                res.status(401).json({ message: 'ユーザーが見つかりませんでした。' });
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
function sendMail(to: string, subject: string, text: string): void {
    const myAddress = `my@adress.com`;
    const transporter = nodemailer.createTransport({
        host: 'smtp.gmail.com',
        port: 465,
        secure: true, // SSL
        auth: {
            user: myAddress,
            pass: `password`,
        }
    });
    return;
    transporter.sendMail({
        from: `"${myAddress}" <${myAddress}>`,
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
function generateOnetimeToken(length: number = 16): string {
    return randomBytes(length).toString('hex');
};

/**
 * パスワードのバリデーション
 * @param password 
 * @param passwordConfirm 
 * @returns 
 */
function passwordValidateion(password: string, passwordConfirm: string): string | null {
    if (password != passwordConfirm) {
        return 'パスワードが一致しません。';
    } else if (password.length < 8) {
        return 'パスワードは8文字以上にしてください。';
    } else if (password.match(/[^a-zA-Z0-9\.\-\_]/)) {
        return 'パスワードは半角英数字記号(.-_)のみ使用できます。';
    } else {
        return null;
    }
}

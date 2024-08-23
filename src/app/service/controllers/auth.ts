import useragent from 'express-useragent';
import { body, param } from 'express-validator';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';
import { randomBytes } from 'crypto';
import nodemailer from 'nodemailer';
import { Request, Response } from 'express';

import { InviteRequest, UserRequest } from '../models/info.js';
import { UserEntity, InviteEntity, LoginHistory, UserRoleType, DepartmentMember, DepartmentRoleType, Department, UserStatus } from '../entity/auth.entity.js';
import { InviteToken, JWT_SECRET, UserToken } from '../middleware/authenticate.js';
import { validationErrorHandler } from '../middleware/validation.js';
import { In, MoreThan, Not } from 'typeorm';
import { ds } from '../db.js';

import * as dotenv from 'dotenv';
import { ProjectEntity, TeamEntity, TeamMemberEntity } from '../entity/project-models.entity.js';
import { ProjectStatus, ProjectVisibility, TeamMemberRoleType, TeamType } from '../models/values.js';
dotenv.config();
const { SMTP_USER, SMTP_PASSWORD, SMTP_ALIAS, FRONT_BASE_URL, SMTP_SERVER, SMTP_PORT, SMTP_DOMAIN } = process.env;

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

            const deviceInfo = JSON.stringify({
                browser: req.useragent?.browser,
                version: req.useragent?.version,
                os: req.useragent?.os,
                platform: req.useragent?.platform,
                isMobile: req.useragent?.isMobile,
                isTablet: req.useragent?.isTablet,
                isDesktop: req.useragent?.isDesktop,
            });

            const loginHistory = new LoginHistory();
            loginHistory.userId = user.id; // ユーザー認証後に設定
            loginHistory.ipAddress = req.headers['x-real-ip'] as string || req.ip || '';
            loginHistory.deviceInfo = deviceInfo;
            loginHistory.authGeneration = user.authGeneration;
            loginHistory.createdBy = user.id;
            loginHistory.updatedBy = user.id;
            loginHistory.save(); // ログイン履歴登録の成否は見ずにレスポンスを返す

            // JWTの生成
            const userToken: UserToken = { type: 'user', id: user.id, authGeneration: user.authGeneration || 0 };
            const token = jwt.sign(userToken, JWT_SECRET, { expiresIn: '30d' });
            res.json({ token, user });
            // return { token };
        });
    }
];

/**
 * [認証不要] ゲストログイン
 * @param req 
 * @param res 
 * @returns 
 */
export const guestLogin = [
    validationErrorHandler,
    (req: Request, res: Response) => {
        return ds.getRepository(UserEntity).findOne({ where: { email: 'guest@example.com' } }).then((user: UserEntity | null) => {
            // ゲストログインはパスワード検証無し。その代わりIPアドレス必須。
            if (user == null) {
                res.status(401).json({ message: '認証に失敗しました。' });
                return;
            }
            // ゲスト
            const deviceInfo = JSON.stringify({
                browser: req.useragent?.browser,
                version: req.useragent?.version,
                os: req.useragent?.os,
                platform: req.useragent?.platform,
                isMobile: req.useragent?.isMobile,
                isTablet: req.useragent?.isTablet,
                isDesktop: req.useragent?.isDesktop,
            });

            const loginHistory = new LoginHistory();
            loginHistory.userId = user.id; // ユーザー認証後に設定
            loginHistory.ipAddress = req.headers['x-real-ip'] as string || req.ip || '';
            loginHistory.deviceInfo = deviceInfo;
            loginHistory.authGeneration = user.authGeneration;
            loginHistory.createdBy = user.id;
            loginHistory.updatedBy = user.id;
            loginHistory.save(); // ログイン履歴登録の成否は見ずにレスポンスを返す

            // JWTの生成
            const userToken: UserToken = { type: 'user', id: user.id, authGeneration: user.authGeneration || 0 };
            const token = jwt.sign(userToken, JWT_SECRET, { expiresIn: '20m' });
            res.json({ token, user });
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
                res.status(403).json({ message: 'ワンタイムトークンが見つかりませんでした。' });
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
        if (req.body.email.endsWith('@nri.co.jp')) {
        } else {
            res.status(403).json({ message: `@nri.co.jp 以外のメールアドレスは受け付けられません。` });
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
        inviteEntity.limit = Date.now() + 1000 * 60 * 5; // 5分以内
        inviteEntity.createdBy = req.headers['x-real-ip'] as string || 'dummy';
        inviteEntity.updatedBy = req.headers['x-real-ip'] as string || 'dummy';
        inviteEntity.save();

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
            return manager.getRepository(UserEntity).findOne({ where: { email: req.info.invite.email } }).then((user: UserEntity | null) => {
                if (user) {
                    // 既存ユーザーの場合はパスワードを更新する
                    // パスワードのハッシュ化
                    user.passwordHash = bcrypt.hashSync(req.body.password, 10);
                    user.authGeneration = user.authGeneration || 0 + 1;
                } else {
                    isCreate = true;
                    // 初期名前をメールアドレスにする。エラーにならないように。。
                    req.body.name == req.body.name || req.info.invite.email;
                    // if (req.body.name == null || req.body.name == '') {
                    //     res.status(400).json({ message: '名前を入力してください。' });
                    //     throw new Error('名前を入力してください。');
                    // } else {
                    //     // 継続
                    // }
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
                    user.createdBy = req.info.invite.id; // 作成者はinvite
                }
                user.updatedBy = req.info.invite.id; // 更新者はinvite
                return user;
            }).then((user) => {
                return manager.getRepository(UserEntity).save(user);
            }).then((user) => {
                if (isCreate) {
                    console.log(`Create Default Projects.`);
                    // デフォルトの個人用プロジェクト回りを整備
                    // TODO 本来はキューとかで別ドメインに移管したい処理。
                    const team = new TeamEntity();
                    team.teamType = TeamType.Alone;
                    team.name = user.name!;
                    team.label = '個人用';
                    team.description = '個人用';

                    // チーム作成
                    team.createdBy = user.id;
                    team.updatedBy = user.id;
                    return manager.getRepository(TeamEntity).save(team).then(savedTeam => {
                        console.log(`Create Default Projects. Team fine.`);
                        // チーム作成ユーザーをメンバーとして追加
                        const teamMember = new TeamMemberEntity();
                        teamMember.teamId = savedTeam.id;
                        teamMember.userId = user.id;
                        teamMember.role = TeamMemberRoleType.Owner;
                        teamMember.createdBy = user.id;
                        teamMember.updatedBy = user.id;

                        // 個人用デフォルトプロジェクト
                        const projectDef = new ProjectEntity();
                        projectDef.name = `${user.name}-default`;
                        projectDef.teamId = savedTeam.id;
                        projectDef.status = ProjectStatus.InProgress;
                        projectDef.visibility = ProjectVisibility.Default;
                        projectDef.description = '個人用チャットプロジェクト';
                        projectDef.label = '個人用チャット';
                        projectDef.createdBy = user.id;
                        projectDef.updatedBy = user.id;

                        // 個人用アーカイブ
                        const projectArch = new ProjectEntity();
                        projectArch.name = `${user.name}-archive`;
                        projectArch.teamId = savedTeam.id;
                        projectArch.status = ProjectStatus.InProgress;
                        projectArch.visibility = ProjectVisibility.Team;
                        projectArch.description = '古いスレッドはアーカイブに移しましょう。';
                        projectArch.label = '個人用アーカイブ';
                        projectArch.createdBy = user.id;
                        projectArch.updatedBy = user.id;

                        // 作成
                        return Promise.all([
                            manager.getRepository(TeamMemberEntity).save(teamMember),
                            manager.getRepository(ProjectEntity).save(projectDef),
                            manager.getRepository(ProjectEntity).save(projectArch),
                        ]).then(() => user); // 最後userに戻して返す。  
                    })
                } else {
                    return user;
                }
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
                res.json({ message: 'パスワードを設定しました。', token: jwtToken, user });
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
                res.status(400).json({ message: 'ユーザーが見つかりませんでした。' });
                return;
            } else {
                // ユーザー情報の更新（名前以外は更新できないようにしておく）
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
        const passwordValidationMessage = passwordValidation(req.body.password, req.body.passwordConfirm);
        if (!passwordValidationMessage.isValid) {
            res.status(400).json(passwordValidationMessage);
            return;
        } else {
            // 継続
        }

        // パスワード設定（emailが鍵のような役割）
        ds.getRepository(UserEntity).findOne({ where: { id: req.info.user.id } }).then((user: UserEntity | null) => {
            if (user == null) {
                res.status(400).json({ message: 'ユーザーが見つかりませんでした。' });
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
        const myList = await ds.getRepository(DepartmentMember).find({
            where: {
                // 自分が所属している部の一覧を取る。
                // userId: req.info.user.id,
                name: req.info.user.name,
            },
        });
        const departmentIdList = myList.map((member: DepartmentMember) => member.departmentId);
        const departmentList = await ds.getRepository(Department).find({
            where: { id: In(departmentIdList), },
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
        const myList = await ds.getRepository(DepartmentMember).find({
            where: {
                // 自分が管理者となっている部の一覧を取る。
                // userId: req.info.user.id,
                name: req.info.user.name,
                departementRole: DepartmentRoleType.Admin,
            },
        });
        const departmentIdList = myList.map((member: DepartmentMember) => member.departmentId);
        const departmentList = await ds.getRepository(Department).find({
            where: { id: In(departmentIdList), },
        });
        const memberList = await ds.getRepository(DepartmentMember).find({
            where: {
                // 自分が管理者となっている部の一覧を取る。
                departmentId: In(departmentIdList),
                departementRole: Not(DepartmentRoleType.Deputy), // Deputy（主務じゃない人）は混乱するので除外。
            },
        });
        const memberUserList = await ds.getRepository(UserEntity).find({
            where: { name: In(memberList.map((member: DepartmentMember) => member.name)) }
        });
        const memberMap = memberList.reduce((map, member) => { map[member.name] = member; return map; }, {} as { [key: string]: DepartmentMember });

        const totalCosts = await ds.query(`
            SELECT created_by, model, sum(cost) as cost, sum(req_token) as req_token, sum(res_token) as res_token, COUNT(*)  
            FROM predict_history_view 
            GROUP BY created_by, model;
          `);
        const costMap = totalCosts.reduce((map: any, cost: any) => {
            if (cost.created_by in map) {
            } else {
                map[cost.created_by] = {
                    totalCost: 0,
                    totalReqToken: 0,
                    totalResToken: 0,
                    foreignModelReqToken: 0,
                    foreignModelResToken: 0,
                };
            }
            map[cost.created_by].totalCost += Number(cost.cost);
            map[cost.created_by].totalReqToken += Number(cost.req_token);
            map[cost.created_by].totalResToken += Number(cost.res_token);
            if (['meta/llama3-405b-instruct-maas', 'claude-3-5-sonnet@20240620'].includes(cost.model)) {
                map[cost.created_by].foreignModelReqToken += Number(cost.req_token);
                map[cost.created_by].foreignModelResToken += Number(cost.res_token);
            }
            return map;
        }, {} as { [key: string]: any });

        // 無理矢理userオブジェクトを埋め込む
        memberUserList.forEach(user => {
            (memberMap[user.name || ''] as any).user = { status: user.status, id: user.id, name: user.name, cost: costMap[user.id] };
            (memberMap[user.name || ''] as any).cost = costMap[user.id];
        });

        // 纏める
        const departmentMemberList = departmentList.map((department) => {
            const members = memberList.filter(member => member.departmentId === department.id).map(member => memberMap[member.name]).sort((a, b) => a.name.localeCompare(b.name));
            const cost = members.reduce((sum, member) => {
                if ((member as any).cost) {
                    sum.totalCost += (member as any).cost.totalCost;
                    sum.totalReqToken += (member as any).cost.totalReqToken;
                    sum.totalResToken += (member as any).cost.totalResToken;
                    sum.foreignModelReqToken += (member as any).cost.foreignModelReqToken;
                    sum.foreignModelResToken += (member as any).cost.foreignModelResToken;
                } else { }
                return sum;
            }, {
                totalCost: 0,
                totalReqToken: 0,
                totalResToken: 0,
                foreignModelReqToken: 0,
                foreignModelResToken: 0,
            });
            return { department, cost, members };
        });
        res.json({ departmentList: departmentMemberList });
    }
];

/**
 * [user認証] 部員管理
 */
export const patchDepartmentMember = [
    validationErrorHandler,
    param('departmentId').isUUID(),
    body('userName').notEmpty().isString(),
    body('role').optional().isIn(Object.values(DepartmentRoleType)),
    body('status').optional().isIn(Object.values(UserStatus)),
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        const { userName, role, status } = req.body;
        const myList = await ds.getRepository(DepartmentMember).find({
            where: {
                // 自分が管理者となっている部の一覧を取る。
                // userId: req.info.user.id,
                name: req.info.user.name,
                departementRole: DepartmentRoleType.Admin,
            },
        });
        const departmentIdList = myList.map((member: DepartmentMember) => member.departmentId);
        const memberList = await ds.getRepository(DepartmentMember).find({
            where: {
                // 対称部員が含まれるか
                departmentId: In(departmentIdList),
                name: userName,
                // userId: userId,
            },
        });

        // 
        const userIdSet = new Set(memberList.map((member) => member.userId));
        const userIdAry = [...userIdSet];
        if (userIdAry.length === 1) {
            // 一人だけなら
            const user = await ds.getRepository(UserEntity).findOne({ where: { id: userIdAry[0] } });
            if (user) {
                // ステータス更新
                user.status = status || user.status;
                // ロール更新
                user.role = role || user.role;
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
        const userList = await ds.query(`
            SELECT u.id, name, u.email, u.role, u.status, m.label
            FROM user_entity u
            LEFT OUTER JOIN (SELECT DISTINCT name, label FROM department_member) m
            USING (name)
          `);
        res.json({ userList });
    }
];

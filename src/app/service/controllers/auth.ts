import { body, param, query } from 'express-validator';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';
import { randomBytes } from 'crypto';
import nodemailer from 'nodemailer';
import { Request, Response } from 'express';

import { InviteRequest, UserRequest } from '../models/info.js';
import { UserEntity, InviteEntity, LoginHistoryEntity, UserRoleType, DepartmentMemberEntity, DepartmentRoleType, DepartmentEntity, UserStatus, SessionEntity, OAuthAccountEntity, OAuthAccountStatus } from '../entity/auth.entity.js';
import { InviteToken, ACCESS_TOKEN_JWT_SECRET, ACCESS_TOKEN_EXPIRES_IN, REFRESH_TOKEN_EXPIRES_IN, REFRESH_TOKEN_JWT_SECRET, ONETIME_TOKEN_JWT_SECRET, ONETIME_TOKEN_EXPIRES_IN, RefreshToken, UserToken } from '../middleware/authenticate.js';
import { validationErrorHandler } from '../middleware/validation.js';
import { EntityManager, In, MoreThan, Not } from 'typeorm';
import { ds } from '../db.js';

import { ProjectEntity, TeamEntity, TeamMemberEntity } from '../entity/project-models.entity.js';
import { ProjectStatus, ProjectVisibility, TeamMemberRoleType, TeamType } from '../models/values.js';
import { Utils } from '../../common/utils.js';
import axios from 'axios';

const { SMTP_USER, SMTP_PASSWORD, SMTP_ALIAS, FRONT_BASE_URL, SMTP_SERVER, SMTP_PORT, SMTP_DOMAIN, MAIL_DOMAIN_WHITELIST, MAIL_EXPIRES_IN, OAUTH2_PATH_MAIL_MESSAGE, OAUTH2_PATH_MAIL_AUTH } = process.env;
if (SMTP_USER && SMTP_PASSWORD && SMTP_ALIAS && FRONT_BASE_URL && SMTP_SERVER && SMTP_PORT && SMTP_DOMAIN && MAIL_DOMAIN_WHITELIST && MAIL_EXPIRES_IN && OAUTH2_PATH_MAIL_MESSAGE && OAUTH2_PATH_MAIL_AUTH) {
} else {
    console.log(SMTP_USER, SMTP_PASSWORD, SMTP_ALIAS, FRONT_BASE_URL, SMTP_SERVER, SMTP_PORT, SMTP_DOMAIN, MAIL_DOMAIN_WHITELIST, MAIL_EXPIRES_IN, OAUTH2_PATH_MAIL_MESSAGE, OAUTH2_PATH_MAIL_AUTH);
    throw Error('環境変数が足りない');
}

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
        return ds.transaction((manager) =>
            manager.getRepository(UserEntity).findOne({ where: { email: req.body.email } }).then((user: UserEntity | null) => {
                if (user == null || !bcrypt.compareSync(req.body.password, user.passwordHash || '')) {
                    res.status(401).json({ message: '認証に失敗しました。' });
                    return;
                }
                authAfter(user, manager, 'local', { authGeneration: user.authGeneration }, req, res).then(tokenObject => {
                    res.json({ id: user.id, name: user.name, email: user.email, role: user.role });
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

    const loginHistory = new LoginHistoryEntity();
    loginHistory.userId = user.id; // ユーザー認証後に設定
    loginHistory.ipAddress = req.headers['x-real-ip'] as string || req.ip || '';
    loginHistory.deviceInfo = JSON.stringify(deviceInfo);
    loginHistory.authGeneration = user.authGeneration;
    loginHistory.createdBy = user.id;
    loginHistory.updatedBy = user.id;
    manager.getRepository(LoginHistoryEntity).save(loginHistory); // ログイン履歴登録の成否は見ずにレスポンスを返す

    const session = new SessionEntity();
    session.userId = user.id; // ユーザー認証後に設定
    session.ipAddress = req.headers['x-real-ip'] as string || req.ip || '';
    session.deviceInfo = JSON.stringify(deviceInfo);
    session.provider = provider;
    session.authInfo = JSON.stringify(authInfoObj);

    // セッション有効期限を設定
    const expirationTime = Utils.parseTimeStringToMilliseconds(REFRESH_TOKEN_EXPIRES_IN);// クッキーの有効期限をミリ秒で指定
    session.expiresAt = new Date(Date.now() + expirationTime);
    session.lastActiveAt = new Date();
    session.createdBy = user.id;
    session.updatedBy = user.id;
    const savedSession = await manager.getRepository(SessionEntity).save(session);

    // JWTの生成
    const userToken: UserToken = { type: 'user', id: user.id, authGeneration: user.authGeneration || 0 };
    const accessToken = jwt.sign(userToken, ACCESS_TOKEN_JWT_SECRET, { expiresIn: ACCESS_TOKEN_EXPIRES_IN });
    // クッキーをセット
    res.cookie('access_token', accessToken, {
        maxAge: Utils.parseTimeStringToMilliseconds(ACCESS_TOKEN_EXPIRES_IN), // ミリ秒単位で指定
        httpOnly: true, // クッキーをHTTPプロトコルのみでアクセス可能にする
        secure: true, // HTTPSでのみ送信されるようにする
        sameSite: true, // CSRF保護のためのオプション
    });
    const refreshTokenBody: RefreshToken = { type: 'refresh', sessionId: savedSession.id, userId: user.id, lastActiveAt: session.lastActiveAt, authGeneration: user.authGeneration || 0 };
    const refreshToken = jwt.sign(refreshTokenBody, REFRESH_TOKEN_JWT_SECRET, { expiresIn: REFRESH_TOKEN_EXPIRES_IN });
    res.cookie('refresh_token', refreshToken, {
        maxAge: expirationTime, // 14日間。クッキーの有効期限をミリ秒で指定
        httpOnly: true, // クッキーをHTTPプロトコルのみでアクセス可能にする
        secure: true, // HTTPSでのみ送信されるようにする
        sameSite: true, // CSRF保護のためのオプション
    });
    // res.redirect(e.pathTop);
    return { accessToken, refreshToken: savedSession.id }
}

// httpsの証明書検証スキップ用のエージェント。社内だから検証しなくていい。
import https from 'https';
const agent = new https.Agent({ rejectUnauthorized: false });
// プロキシ無しaxios
export const axiosWithoutProxy = axios.create({ proxy: false, httpAgent: false, httpsAgent: agent });
// const agent = new HttpsProxyAgent({ rejectUnauthorized: false });


export function readOAuth2Env(provider: string) {
    const uProvider = provider.toUpperCase();
    return {
        uriBase: process.env[`OAUTH2_${uProvider}_URI_BASE`],
        pathAuthorize: process.env[`OAUTH2_${uProvider}_PATH_AUTHORIZE`],
        pathAccessToken: process.env[`OAUTH2_${uProvider}_PATH_ACCESS_TOKEN`],
        pathUserInfo: process.env[`OAUTH2_${uProvider}_PATH_USER_INFO`],
        clientId: process.env[`OAUTH2_${uProvider}_CLIENT_ID`],
        scope: process.env[`OAUTH2_${uProvider}_SCOPE`],
        redirectUri: process.env[`OAUTH2_${uProvider}_REDIRECT_URI`] as string,
        requireMailAuth: process.env[`OAUTH2_${uProvider}_REQUIRE_MAIL_AUTH`], // 追加のメール認証が必要かどうか（独自認証のproviderをそのまま使うと危ないので）
        userProxy: process.env[`OAUTH2_${uProvider}_USE_PROXY`], // proxyを使うかどうか
        postType: process.env[`OAUTH2_${uProvider}_POST_TYPE`] as string, // POSTの中身をparamsでやるかbodyに書くか。
        clientSecret: process.env[`OAUTH2_${uProvider}_CLIENT_SECRET`],
        pathTop: process.env[`OAUTH2_${uProvider}_PATH_TOP`] as string,
    };
}

export const userLoginOAuth2 = [
    param('provider').trim().notEmpty(),
    validationErrorHandler,
    async (req: Request, res: Response) => {
        // OAuth2認可エンドポイントにリダイレクト
        const { provider } = req.params;
        const e = readOAuth2Env(provider);
        // console.log(e);
        const authURL = `${e.uriBase}${e.pathAuthorize}?client_id=${e.clientId}&response_type=code&redirect_uri=${encodeURIComponent(e.redirectUri)}&scope=${e.scope}`;
        res.redirect(authURL);
    }
];

/**
 * [認証不要] ユーザーログイン
 * @param req 
 * @param res 
 * @returns 
 */
export const userLoginOAuth2Callback = [
    param('provider').trim().notEmpty(),
    query('code').trim().notEmpty(),  // .withMessage('メールアドレスを入力してください。'),
    validationErrorHandler,
    async (req: Request, res: Response) => {
        const { provider } = req.params as { provider: string };
        const e = readOAuth2Env(provider);
        const code = req.query.code;
        const ipAddress = req.headers['x-real-ip'] as string || req.ip || '';
        try {
            const _axios = e.userProxy === 'true' ? axios : axiosWithoutProxy;
            const postData = { client_id: e.clientId, client_secret: e.clientSecret, grant_type: 'authorization_code', code: code, redirect_uri: e.redirectUri };
            let params = null, body = null;
            if (e.postType === 'params') {
                params = postData;
            } else {
                body = postData;
            }

            // アクセストークンを取得するためのリクエスト
            const token = await _axios.post<{ access_token: string, token_type: string, expires_in: number, scope: string, refresh_token: string, id_token: string, }>(
                `${e.uriBase}${e.pathAccessToken}`, body, { params });
            const accessToken = token.data.access_token;
            // console.log('Access token:', JSON.stringify(token.data));

            // APIを呼び出してみる
            const userInfo = await _axios.get<{ id: string, username?: string, email: string, login?: string }>(`${e.uriBase}${e.pathUserInfo}`, {
                headers: { Authorization: `Bearer ${accessToken}` }
            });
            const oAuthUserInfo = userInfo.data;
            // console.log(JSON.stringify(userInfo.data));

            // ここはちょっとキモイ。。けど複数を纏めているから仕方ない。。
            if (provider === 'box') {
                // boxはcu認証なのでcuを外してemailに入れる。
                userInfo.data.email = userInfo.data.login?.replace('@cu.', '@') || '';
            } else { }

            // emailを事実上の鍵として紐づけに行くので、メアドが変なやつじゃないかはちゃんとチェックする。
            if (MAIL_DOMAIN_WHITELIST.split(',').find(domain => userInfo.data.email.endsWith(`@${domain}`))) {
            } else {
                // whiltelist登録されているドメインのアドレス以外は登録禁止。
                throw Error(`Invalid email. "${userInfo.data.email}"`);
            }
            ds.transaction(async (manager) => {
                // console.log(oAuthUserInfo.email);
                // emailを事実上の鍵として紐づけに行く。
                let user = await manager.getRepository(UserEntity).findOne({ where: { email: oAuthUserInfo.email } });
                // console.log('LINK::');
                // console.log(user);
                if (user) {
                    // 既存ユーザーの場合は何もしない。
                } else {
                    // 新規ユーザーの場合は登録する
                    user = new UserEntity();
                    user.name = oAuthUserInfo.username;
                    // jwtの検証で取得した情報をそのまま登録する
                    user.email = oAuthUserInfo.email;
                    user.createdBy = ipAddress; // 作成者はIP
                    user.updatedBy = ipAddress; // 更新者はIP

                    // 本当はメール認証できてないのにユーザー登録してしまうのはいかがなものか、、だけどそんなに害もないし、難しくなるのでこのままにする。
                    user = await manager.getRepository(UserEntity).save(user);
                    await createUserInitial(user, manager); // ユーザー初期作成に伴う色々作成
                }
                // oAuthの一意キー
                const oAuthKey = { provider, userId: user.id, providerUserId: oAuthUserInfo.id };
                let oAuthAccount = await manager.getRepository(OAuthAccountEntity).findOne({ where: oAuthKey });
                if (oAuthAccount) {
                    // 既存の場合
                    oAuthAccount.userInfo = JSON.stringify(userInfo.data);
                } else {
                    // 新規の場合
                    oAuthAccount = new OAuthAccountEntity();
                    oAuthAccount.provider = oAuthKey.provider;
                    oAuthAccount.userId = oAuthKey.userId;
                    oAuthAccount.providerUserId = oAuthKey.providerUserId;
                    oAuthAccount.providerEmail = oAuthUserInfo.email;
                    oAuthAccount.userInfo = JSON.stringify(userInfo.data);
                    oAuthAccount.createdBy = user.id;
                }
                oAuthAccount.accessToken = token.data.access_token
                oAuthAccount.refreshToken = token.data.refresh_token;
                oAuthAccount.tokenBody = JSON.stringify(token.data);
                // 現在の時刻にexpiresInSeconds（秒）を加算して、有効期限のDateオブジェクトを作成
                if (token.data.expires_in) {
                    oAuthAccount.tokenExpiresAt = new Date(Date.now() + token.data.expires_in * 1000);
                } else { /** expiresは設定されていないこともある。 */ }
                oAuthAccount.updatedBy = user.id;

                if (e.requireMailAuth === 'false') {
                    // 追加メール認証不要
                    // 保存
                    const savedOAuthAccount = await manager.getRepository(OAuthAccountEntity).save(oAuthAccount);
                    // トークン発行
                    await authAfter(user, manager, provider, oAuthKey, req, res);
                    // レスポンス
                    res.redirect(e.pathTop);
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
                    inviteEntity.data = JSON.stringify({ name: '', email: oAuthUserInfo.email, pincode, oAuthAccountId: savedOAuthAccount.id, userId: user.id });
                    inviteEntity.limit = Date.now() + Utils.parseTimeStringToMilliseconds(MAIL_EXPIRES_IN);
                    inviteEntity.createdBy = req.headers['x-real-ip'] as string || 'dummy';
                    inviteEntity.updatedBy = req.headers['x-real-ip'] as string || 'dummy';
                    await inviteEntity.save();

                    // メール送信
                    sendMail(oAuthUserInfo.email, 'メール認証依頼', `認証要求がありました。\n${FRONT_BASE_URL}/#${OAUTH2_PATH_MAIL_AUTH}/${onetimeToken}\n\nお心当たりのない場合は無視してください。`)
                        .then(_ => {
                            // pincodeをcookieにつけておく。（同じブラウザであれば手入力しなくて済むように）
                            res.cookie('pincode', pincode, { maxAge: Utils.parseTimeStringToMilliseconds(MAIL_EXPIRES_IN), httpOnly: true, secure: true, sameSite: true, });
                            // トークン発行はせずに追加のメール認証が必要である旨のページに飛ばす
                            res.redirect(`${FRONT_BASE_URL}/#${OAUTH2_PATH_MAIL_MESSAGE}/${pincode}`);
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
            res.status(500).send('Error during authentication');
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
                    const invite = await manager.getRepository(InviteEntity).findOneOrFail({ where: { id: req.info.invite.id } });
                    const { email, pincode, oAuthAccountId, userId } = JSON.parse(invite.data);
                    if (postedPincode === pincode) {
                        // TODO inviteを閉じるのはこのタイミングが適切なのかは微妙。開いた瞬間閉じる方が良いかも？
                        await manager.getRepository(InviteEntity).findOne({ where: { id: req.info.invite.id } }).then((invite: InviteEntity | null) => {
                            if (invite) {
                                invite.status = 'used';
                                invite.save();
                            } else {
                                // エラー。起こりえないケース
                            }
                            return invite;
                        });

                        const oAuthAccount = await manager.getRepository(OAuthAccountEntity).findOneOrFail({ where: { id: oAuthAccountId } });
                        // activate
                        oAuthAccount.status = OAuthAccountStatus.ACTIVE;
                        oAuthAccount.updatedBy = req.info.invite.id; // inviteのIDを入れる
                        await manager.getRepository(OAuthAccountEntity).save(oAuthAccount);
                        const user = await manager.getRepository(UserEntity).findOneOrFail({ where: { id: userId } });
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
    crypto.getRandomValues(array);
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
        //     const token = jwt.sign(userToken, JWT_SECRET, { expiresIn: '20m' });
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
                    const currSession = await manager.getRepository(SessionEntity).findOneOrFail({ where: { id: refreshToken.sessionId } });
                    currSession.expiresAt = new Date(); // 即時expire
                    currSession.updatedBy = refreshToken.userId;
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
                const jwtToken = jwt.sign(inviteToken, ONETIME_TOKEN_JWT_SECRET, { expiresIn: ONETIME_TOKEN_EXPIRES_IN });
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
    async (req: Request, res: Response) => {

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
        inviteEntity.createdBy = req.headers['x-real-ip'] as string || 'dummy';
        inviteEntity.updatedBy = req.headers['x-real-ip'] as string || 'dummy';
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
                    return createUserInitial(user, manager);
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
        ds.getRepository(UserEntity).findOne({ where: { id: req.info.user.id } }).then((user: UserEntity | null) => {
            if (user == null) {
                res.status(400).json({ message: 'ユーザーが見つかりませんでした。' });
                return;
            } else {
                // ユーザー情報の更新（名前以外は更新できないようにしておく）
                user.name = req.body.name;
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
        ds.getRepository(UserEntity).findOne({ where: { id: req.info.user.id } }).then((user: UserEntity | null) => {
            if (user == null) {
                res.status(400).json({ message: 'ユーザーが見つかりませんでした。' });
                return;
            } else {
                // パスワードのハッシュ化
                user.passwordHash = bcrypt.hashSync(req.body.password, 10);
                user.authGeneration = user.authGeneration || 0 + 1;
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
        const myList = await ds.getRepository(DepartmentMemberEntity).find({
            where: {
                // 自分が所属している部の一覧を取る。
                // userId: req.info.user.id,
                name: req.info.user.name,
            },
        });
        const departmentIdList = myList.map((member: DepartmentMemberEntity) => member.departmentId);
        const departmentList = await ds.getRepository(DepartmentEntity).find({
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
        const myList = await ds.getRepository(DepartmentMemberEntity).find({
            where: {
                // 自分が管理者となっている部の一覧を取る。
                // userId: req.info.user.id,
                name: req.info.user.name,
                departmentRole: DepartmentRoleType.Admin,
            },
        });
        const departmentIdList = myList.map((member: DepartmentMemberEntity) => member.departmentId);
        const departmentList = await ds.getRepository(DepartmentEntity).find({
            where: { id: In(departmentIdList), },
        });
        const memberList = await ds.getRepository(DepartmentMemberEntity).find({
            where: {
                // 自分が管理者となっている部の一覧を取る。
                departmentId: In(departmentIdList),
                departmentRole: Not(DepartmentRoleType.Deputy), // Deputy（主務じゃない人）は混乱するので除外。
            },
        });
        const memberUserList = await ds.getRepository(UserEntity).find({
            where: { name: In(memberList.map((member: DepartmentMemberEntity) => member.name)) }
        });
        const memberMap = memberList.reduce((map, member) => { map[member.name] = member; return map; }, {} as { [key: string]: DepartmentMemberEntity });

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
    body('role').optional().isIn(Object.values(DepartmentRoleType)),
    body('status').optional().isIn(Object.values(UserStatus)),
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        const { role, status } = req.body;
        const myList = await ds.getRepository(DepartmentMemberEntity).find({
            where: {
                // 自分が管理者となっている部の一覧を取る。
                // userId: req.info.user.id,
                name: req.info.user.name,
                departmentRole: DepartmentRoleType.Admin,
            },
        });
        const departmentIdList = myList.map((member: DepartmentMemberEntity) => member.departmentId);
        const memberList = await ds.getRepository(DepartmentMemberEntity).find({
            where: {
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

function createUserInitial(user: UserEntity, manager: EntityManager): Promise<UserEntity> {
    // console.log(`Create Default Projects.`);
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
        // console.log(`Create Default Projects. Team fine.`);
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
                where: { userId: req.info.user.id, status: OAuthAccountStatus.ACTIVE },
                // accessTokenとかrefreshTokenは流出すると危険なので必ず絞る。
                select: ['id', 'userInfo', 'provider', 'providerUserId', 'providerEmail']
            });
            // console.log(oauthAccounts);
            res.json({ oauthAccounts });
        } catch (error) {
            console.error('Error fetching OAuth accounts:', error);
            res.status(500).json({ message: 'OAuth認証済みアカウントの取得中にエラーが発生しました。' });
        }
    }
];


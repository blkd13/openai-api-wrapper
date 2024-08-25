import { Request, Response } from 'express';
import { ds } from "../db.js";
import { OAuthAccountEntity, OAuthAccountStatus } from "../entity/auth.entity.js";
import { validationErrorHandler } from "../middleware/validation.js";
import { UserRequest } from "../models/info.js";
import { axiosWithoutProxy, readOAuth2Env } from './auth.js';
import axios from 'axios';
import { param } from 'express-validator';


/**
 * [user認証] OAuth認証済みアカウント一覧を取得
 */
export const getOAuthApiPorjects = [
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        const provider = 'gitlabnsfront';
        const e = readOAuth2Env(provider);
        try {
            const oauthAccounts = await ds.getRepository(OAuthAccountEntity).find({
                where: { userId: req.info.user.id, status: OAuthAccountStatus.ACTIVE, provider },
            });
            const _axios = e.userProxy === 'true' ? axios : axiosWithoutProxy;

            if (oauthAccounts.length > 0) {
                const projects = await _axios.get<{ access_token: string, token_type: string, expires_in: number, scope: string, refresh_token: string, id_token: string, }>(
                    `${e.uriBase}/api/v4/projects`, {
                    headers: { Authorization: `Bearer ${oauthAccounts[0].accessToken}` }
                });
                console.log(projects.data);
                // console.log(oauthAccounts);
                res.json({ projects: projects.data });
            } else {
                res.status(500).json({ message: 'OAuth認証済みアカウントの取得中にエラーが発生しました。' });
            }
        } catch (error) {
            console.error('Error fetching OAuth accounts:', error);
            res.status(500).json({ message: 'OAuth認証済みアカウントの取得中にエラーが発生しました。' });
        }
    }
];

export async function getAccessToken(userId: string, provider: string): Promise<string> {
    const oAuthAccount = await ds.getRepository(OAuthAccountEntity).findOneOrFail({
        where: { userId, status: OAuthAccountStatus.ACTIVE, provider },
    });

    const e = readOAuth2Env(provider);
    // console.log(oAuthAccount.tokenExpiresAt, new Date());
    if (oAuthAccount.tokenExpiresAt && oAuthAccount.tokenExpiresAt < new Date()) {
        // トークンリフレッシュ
        const _axios = e.userProxy === 'true' ? axios : axiosWithoutProxy;

        const postData = { client_id: e.clientId, client_secret: e.clientSecret, grant_type: 'refresh_token', refresh_token: oAuthAccount.refreshToken };
        let params = null, body = null;
        if (e.postType === 'params') {
            params = postData;
        } else {
            body = postData;
        }
        // アクセストークンを取得するためのリクエスト
        return _axios.post<{ access_token: string, token_type: string, expires_in: number, scope: string, refresh_token: string, id_token: string, }>(
            `${e.uriBase}${e.pathAccessToken}`, body, { params }).then(token => {
                oAuthAccount.accessToken = token.data.access_token;
                oAuthAccount.refreshToken = token.data.refresh_token;
                oAuthAccount.tokenBody = JSON.stringify(token.data);
                // 現在の時刻にexpiresInSeconds（秒）を加算して、有効期限のDateオブジェクトを作成
                if (token.data.expires_in) {
                    oAuthAccount.tokenExpiresAt = new Date(Date.now() + token.data.expires_in * 1000);
                } else { /** expiresは設定されていないこともある。 */ }
                oAuthAccount.updatedBy = userId;
                // 後でトランザクション化した方が良いか？
                return oAuthAccount.save();
            }).then(savedOAuthAccount => savedOAuthAccount.accessToken);
    } else {
        return Promise.resolve(oAuthAccount.accessToken);
    }
}

export const getOAuthApiProxy = [
    param('provider').trim().notEmpty(),
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        console.log(req.params);
        const provider = req.params.provider;
        const e = readOAuth2Env(provider);
        try {
            // 今のところ、1ユーザー1プロバイダ1アカウントなので複数当たることはないはず。。
            // でも複数当たる要件が出てる来るのは時間の問題なので考えておく必要はある。
            const accessToken = await getAccessToken(req.info.user.id, provider);

            const _axios = e.userProxy === 'true' ? axios : axiosWithoutProxy;

            // `req.params[0]` で `/api/proxy/` に続くパス全体を取得する
            const url = `${e.uriBase}/${req.params[0]}`;

            let response;
            const headers = { Authorization: `Bearer ${accessToken}` };
            // HTTPメソッドによって処理を分岐
            switch (req.method) {
                case 'GET':
                    response = await _axios.get(url, { params: req.query, headers });
                    break;
                case 'POST':
                    response = await _axios.post(url, req.body, { headers });
                    break;
                case 'PATCH':
                    response = await _axios.patch(url, req.body, { headers });
                    break;
                case 'PUT':
                    response = await _axios.put(url, req.body, { headers });
                    break;
                case 'DELETE':
                    response = await _axios.delete(url, { headers });
                    break;
                default:
                    res.status(405).send('Method Not Allowed');
                    return;
            }

            // console.log(response.data);
            // 外部APIからのレスポンスをそのまま返す
            res.status(response.status).send(response.data);
        } catch (error) {
            console.error('Error fetching OAuth accounts:', error);
            res.status(500).json({ message: 'OAuth認証済みアカウントの取得中にエラーが発生しました。' });
        }
    }
];


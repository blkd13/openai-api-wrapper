import { Request, Response } from 'express';
import { param } from 'express-validator';
import { createProxyMiddleware } from 'http-proxy-middleware';
import { NextFunction } from 'http-proxy-middleware/dist/types.js';
import https from 'https';
import { getAxios, getProxyUrl } from '../../common/http-client.js';
import { ExtApiClient, getExtApiClient, OAuth2TokenDto } from '../controllers/auth.js';
import { decrypt, encrypt } from '../controllers/tool-call.js';
import { ds } from "../db.js";
import { OAuthAccountEntity, OAuthAccountStatus } from "../entity/auth.entity.js";
import { validationErrorHandler } from "../middleware/validation.js";
import { OAuthUserRequest } from "../models/info.js";

export async function getAccessToken(orgKey: string, userId: string, provider: string): Promise<OAuthAccountEntity> {
    const oAuthAccount = await ds.getRepository(OAuthAccountEntity).findOneByOrFail({
        orgKey, userId, status: OAuthAccountStatus.ACTIVE, provider,
    });
    const e = await getExtApiClient(oAuthAccount.orgKey, provider);
    // console.log(oAuthAccount.tokenExpiresAt, new Date());
    if (oAuthAccount.tokenExpiresAt && oAuthAccount.tokenExpiresAt < new Date()) {
        if (oAuthAccount.refreshToken && e.oAuth2Config) {
            console.log('リフレッシュトークンを使って新しいアクセストークンを取得します。',);
            // トークンリフレッシュ
            const postData = { client_id: e.oAuth2Config.clientId, client_secret: e.oAuth2Config.clientSecret, grant_type: 'refresh_token', refresh_token: decrypt(oAuthAccount.refreshToken) };
            let params = null, body = null;
            if (e.oAuth2Config.postType === 'params') {
                params = postData;
            } else {
                body = postData;
            }

            let token = null;
            const axios = await getAxios(e.uriBase);
            // アクセストークンを取得するためのリクエスト
            if (params) {
                token = await axios.post<OAuth2TokenDto>(`${e.uriBase}${e.oAuth2Config.pathAccessToken}`, {}, { params });
            } else {
                token = await axios.post<OAuth2TokenDto>(`${e.uriBase}${e.oAuth2Config.pathAccessToken}`, body);
            }

            // console.log(token.data);
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
            oAuthAccount.updatedBy = userId;

            // 後でトランザクション化した方が良いか？
            return oAuthAccount.save();
        } else {
            throw new Error('トークンが期限切れで、リフレッシュトークンもありません。再認証してください。');
        }
    } else {
        return Promise.resolve(oAuthAccount);
    }
}

export const getOAuthApiProxy = [
    param('providerType').trim().notEmpty(),
    param('providerName').trim().notEmpty(),
    validationErrorHandler,
    async (_req: Request, res: Response, next: NextFunction) => {
        const req = _req as OAuthUserRequest;
        // console.log(req.params);
        const { providerType, providerName } = req.params as { providerType: string, providerName: string };
        const provider = `${providerType}-${providerName}`;
        const e = {} as ExtApiClient;
        try {
            Object.assign(e, await getExtApiClient(req.info.user.orgKey, provider));
        } catch (error) {
            res.status(401).json({ error: `${provider}は認証されていません。` });
            return;
        }
        // console.log(e);
        let url = '';
        try {
            const user = req.info.user;
            // エラーログ出力用に`req.params[0]` で `/api/proxy/` に続くパス全体を取得する
            url = `${e.uriBase}/${req.params[0]}`;
            const baseUrlObj = new URL(e.uriBase);
            // console.log(url);
            const pathRewrite = {} as Record<string, string>;
            pathRewrite[`^/proxy/${providerType}/${providerName}`] = '';
            const apiMap = {
                // 'access-token': e.pathAccessToken,
                'user-info': e.pathUserInfo,
            } as Record<string, string>;
            // console.log(req.params[0]);
            pathRewrite[`^/basic-api/${providerType}/${providerName}/${req.params[0]}`] = apiMap[req.params[0]];
            // console.log(pathRewrite);

            // httpsの証明書検証スキップ用のエージェント。社内だから検証しなくていい。

            // 今のところ、1ユーザー1プロバイダ1アカウントなので複数当たることはないはず。。
            // でも複数当たる要件が出てる来るのは時間の問題なので考えておく必要はある。
            let accessToken = req.info.oAuth.accessToken;
            // if (provider === 'mattermost') {
            // } else {
            //     // console.log('CONSOLE', user.id, provider);
            //     accessToken = (await getAccessToken(user.id, provider)).accessToken;
            // }
            const proxyUrl = await getProxyUrl(e.uriBase);
            const target = proxyUrl || e.uriBase;
            const MMAUTHTOKEN = req.cookies.MMAUTHTOKEN;

            // console.log(baseUrlObj);
            // console.dir(pathRewrite, { depth: null });
            // console.log(`proxyUrl=${req.url}`);

            // console.log(`target=${target}`);
            const proxy = createProxyMiddleware({
                target,
                changeOrigin: true,
                pathRewrite,
                // agent: agent,
                // TODO 晃かに無理矢理なので直す必要がある。envでon/off切替できるようにしようと思う。
                agent: baseUrlObj.hostname.includes('.') ? null : new https.Agent({ rejectUnauthorized: false }),
                // agent: new https.Agent({ rejectUnauthorized: false, }), // 自己署名証明書を許可
                // secure: true,
                selfHandleResponse: true, //  falseにしてデフォルトの挙動にさせたらチャンクが混線したのでダメ。
                ws: true,
                on: {
                    // proxyReqWs: (proxyReq, req, socket, options, head) => {
                    //     // ws用（マタモ専用）
                    //     // 何故かoriginヘッダーを消すと繋がる。
                    //     proxyReq.removeHeader('origin');
                    //     // Authorizationヘッダーだと認証が通らないのでCookieに書く。
                    //     // proxyReq.setHeader('Authorization', 'xxxxxxxxxxxxxxxxxxxx');
                    //     proxyReq.setHeader('Cookie', `MMAUTHTOKEN=${accessToken}; ` + (proxyReq.getHeader('Cookie') || ''));
                    //     console.log('ws-connetc-upgrade-start', proxyReq.path);
                    // },
                    error: async (error) => {
                        console.error(error);
                    },
                    proxyReq: async (proxyReq, req) => {
                        if (providerType === 'mattermost') {
                            proxyReq.setHeader('Cookie', `MMAUTHTOKEN=${MMAUTHTOKEN}`);
                            // console.log('mattermost-proxyReq', proxyReq.path, proxyReq.getHeader('Cookie'));
                        } else {
                            // mattermostはAuthorizationを使わずにブラウザのCookieを使う
                            proxyReq.setHeader('Authorization', `Bearer ${accessToken}`);
                            // console.log(`Authorization: Bearer ${accessToken}`);
                        }
                        if (proxyUrl) {
                            // console.log(`host=${req.headers.host} ${proxyReq.getHeaders().host}`)
                            // 二重プロキシの場合はパスにhostを埋め込む。
                            // console.log(`USE_PROXY: target=${target} path=${proxyReq.path} url=${req.url}`)
                            proxyReq.path = e.uriBase + proxyReq.path;
                            // req.url = e.uriBase + req.url;
                            proxyReq.setHeader('host', new URL(e.uriBase).host);
                            proxyReq.setHeader('origin', `https://${new URL(e.uriBase).host}`);
                            proxyReq.setHeader('referer', `https://${proxyReq.path}`);

                            // console.dir(req);
                            // console.dir(proxyReq);
                            // console.log(`USE_PROXY: target=${target} path=${proxyReq.path} url=${req.url}`)
                        } else { }
                        if (['POST', 'PUT', 'PATCH'].includes(req.method || '') && (req as any).body) {
                            const bodyData = JSON.stringify((req as any).body);
                            // proxyReq.setHeader('Content-Length', Buffer.byteLength(bodyData));
                            proxyReq.write(bodyData);
                        } else { }

                        // console.log(`proxyReq: ${req.method} ${req.url} ${target}${proxyReq.path} ${accessToken ? 'with token' : 'without token'}`);
                    },
                    proxyRes: async (proxyRes, req, res) => {
                        // // 必要に応じてヘッダーを設定
                        // res.writeHead(proxyRes.statusCode || 200, proxyRes.headers);

                        // // ストリーミングを処理
                        // proxyRes.on('data', (chunk) => {
                        //     res.write(chunk);
                        //     console.log(new String(chunk));
                        // });

                        // proxyRes.on('end', () => {
                        //     res.end();
                        // });

                        // proxyRes.on('error', (err) => {
                        //     console.error('Error during proxy response stream:', err);
                        //     res.end('Error during proxying.');
                        // });
                        // console.log(proxyRes.statusCode);
                        // console.log(proxyRes.statusMessage);
                        // console.log(req.url);

                        // TODO BOX APIがクソすぎて.pngとか.jpgを返すときにoctet-streamで返してくるのでここでごにょる
                        let ext = url.split('\?')[0].split('\.').at(-1);
                        if (ext && ['png', 'jpg', 'jpeg'].includes(ext)) {
                            ext = ext === 'jpg' ? 'jpeg' : ext;
                            proxyRes.headers['content-type'] = `image/${ext}`;
                        } else { }
                        res.writeHead(proxyRes.statusCode || 200, proxyRes.headers);
                        proxyRes.pipe(res);
                    },
                },
            });
            proxy(req, res, next);
        } catch (_error) {
            const error = _error as any;
            if (error && error.response && error.response.status) {
                // errorがresponseオブジェクトならトレースログは重いのでステータスとメッセージのみをログに書く。
                const status = error.response.status;
                console.error(`Error: ${req.info.user.id} ${provider} ${status} ${url} ${error.response.statusText}`);
            } else {
                console.error(`Error: ${req.info.user.id} ${provider} ${url}`, error);
            }
            // res.status(500).json({ message: 'API呼出中にエラーが発生しました。' });
        }
    }
];

// app.ts
// 環境変数の設定が最優先
import 'dotenv/config'; // dotenv を読み込む
import 'source-map-support/register.js';

import express, { Request, Response, Router } from 'express';
import cookieParser from 'cookie-parser';
import useragent from 'express-useragent';
import bodyParser from 'body-parser';
import cors from 'cors';
import morgan from 'morgan';
import moment, { Moment } from "moment-timezone";

import { authAdminRouter, authInviteRouter, authMaintainerRouter, authNoneRouter, authOAuthRouter, authUserRouter } from './routes.js';
import { createProxyMiddleware } from 'http-proxy-middleware';
import { getAccessToken, getOAuthApiProxy } from './api/api-proxy.js';
import { authenticateUserTokenMiddleGenerator, authenticateUserTokenWsMiddleGenerator } from './middleware/authenticate.js';

const app = express();

app.use(useragent.express());
app.use(cookieParser());

// body-parser の設定を変更して、リクエストボディのサイズ制限を拡大する
app.use(bodyParser.urlencoded({ limit: '50mb', extended: true }));
app.use(bodyParser.json({ limit: '50mb' })); // JSONパーサー
app.set('trust proxy', 1);


// これはデバッグ用
app.use(cors()); // CORS許可

// Morganのタイムスタンプをに設定
if (process.env.TZ) { morgan.token('date', (req: Request, res: Response) => moment().tz(process.env.TZ ?? '').format()); }
// app.use(morgan('dev')); // ログ出力 1トランザクション当たり20-50[ms]程度遅延
app.use(morgan('combined')); // ログ出力 1トランザクション当たり30-60[ms]程度遅延

// ルート設定開始
const rootRouter = Router();

// 認証不要ルート
rootRouter.use('/public', authNoneRouter);
// ユーザー/パスワード認証が必要なルート
rootRouter.use('/user', authUserRouter);
// admin認証が必要なルート
rootRouter.use('/admin', authAdminRouter);
// maintainer認証が必要なルート
rootRouter.use('/maintainer', authMaintainerRouter);
// ワンタイムトークン認証が必要なルート
rootRouter.use('/invite', authInviteRouter);

app.use('/api', rootRouter);
// 認証系ルート設定終了

const port = process.env.SERVER_PORT || 3000;
// サーバー起動
const server = app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
});
server.setMaxListeners(20); // 最大リスナー数を20に設定

const { OAUTH2_MATTERMOST_URI_BASE } = process.env;

server.on('upgrade', (req, res, header) => {
    // console.log(`upgrade `);
    // console.log(req.headers.cookie);
    const wsmw = authenticateUserTokenWsMiddleGenerator();
    const next = async () => {

        // /api/user/oauth/api/proxy/mattermost/sample/api/v4/websocket
        const [_0, _1, _2, _3, _4, _5, tenantKey, providerType, providerName] = req.url?.split('/') || [];
        const pathRewrite: { [key: string]: string } = {};
        pathRewrite[`/api/user/oauth/ws/proxy/${tenantKey}/${providerType}/${providerName}`] = ``;
        // console.log(`pathRewrite ${JSON.stringify(pathRewrite)}`);
        // console.log(`req.path ${req.url}`);
        // console.log(`call next`);
        try {
            const accessToken = await getAccessToken(tenantKey, (req as any).info.user.id, `${providerType}-${providerName}`);
            // console.log(`accessToken ${accessToken}`);
            createProxyMiddleware({
                target: OAUTH2_MATTERMOST_URI_BASE,
                changeOrigin: true,
                pathRewrite: pathRewrite,
                selfHandleResponse: true, //  falseにしてデフォルトの挙動にさせたらチャンクが混線したのでダメ。
                ws: true,
                on: {
                    proxyReqWs: (proxyReq, req, socket, options, head) => {
                        // ws用（マタモ専用）
                        // 何故かoriginヘッダーを消すと繋がる。
                        proxyReq.removeHeader('origin');
                        // Authorizationヘッダーだと認証が通らないのでCookieに書く。
                        // proxyReq.setHeader('Authorization', 'xxxxxxxxxxxxxxxxxxxx');
                        proxyReq.setHeader('Cookie', `MMAUTHTOKEN=${accessToken}; ` + (proxyReq.getHeader('Cookie') || ''));
                        // console.log('wsProxyReqWs:ws-connetc-upgrade-start', proxyReq.path);
                    },
                    proxyReq: (proxyReq, req) => {
                        // console.log(`wsProxyReq.path=${proxyReq.path}`);
                        proxyReq.setHeader('Authorization', `Bearer ${accessToken}`);
                        // // TODO エラーになるのでとりあえず圧縮を無効にする
                        // proxyReq.removeHeader('accept-encoding');
                    },
                    proxyRes: async (proxyRes, req, res) => {
                        // console.log(`wsProxyRes.path=${proxyRes.url}`);
                    }
                }
            }).upgrade(req, res as any, header);
        } catch (e) {
            console.error(e);
            // res.writeHead(500, { 'Content-Type': 'text/plain' });
            res.end('Internal Server Error');
        }
    };
    wsmw(req as any, res, header, next);
});

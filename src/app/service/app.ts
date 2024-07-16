// app.ts
import * as dotenv from 'dotenv';
import express, { NextFunction, Request, Response, Router } from 'express';
import bodyParser from 'body-parser';
import cors from 'cors';
import morgan from 'morgan';
import moment, { Moment } from "moment-timezone";

import { authInviteRouter, authNoneRouter, authUserRouter } from './routes.js';

// .envファイルを読み込む
dotenv.config();

const app = express();

// body-parser の設定を変更して、リクエストボディのサイズ制限を拡大する
app.use(bodyParser.urlencoded({ limit: '50mb', extended: true }));
app.use(bodyParser.json({ limit: '50mb' })); // JSONパーサー
app.set('trust proxy', 1);
// app.use((req, res, next) => {
//     console.log(req.headers['x-real-ip']);
//     next();
// });


// これはデバッグ用
app.use(cors()); // CORS許可

// Morganのタイムスタンプをに設定
if (process.env.TZ) { morgan.token('date', (req: Request, res: Response) => moment().tz(process.env.TZ ?? '').format()); }
// app.use(morgan('dev')); // ログ出力 1トランザクション当たり20-50[ms]程度遅延
app.use(morgan('combined')); // ログ出力 1トランザクション当たり30-60[ms]程度遅延

// ルート設定開始
const rootRouter = Router();

// 認証不要ルート
rootRouter.use('/', authNoneRouter);
// ユーザー/パスワード認証が必要なルート
rootRouter.use('/user', authUserRouter);
// ワンタイムトークン認証が必要なルート
rootRouter.use('/invite', authInviteRouter);

app.use('/api', rootRouter);
// 認証系ルート設定終了


// サーバー起動
app.listen(3000, () => {
    console.log('Server is running on port 3000');
});

// app.ts
import express, { NextFunction, Request, Response, Router } from 'express';
import bodyParser from 'body-parser';
import cors from 'cors';
import morgan from 'morgan';

import { authInviteRouter, authNoneRouter, authUserRouter } from './routes.js';

const app = express();

app.use(bodyParser.json()); // JSONパーサー

// これはデバッグ用
app.use(cors()); // CORS許可
app.use(morgan('dev')); // ログ出力

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

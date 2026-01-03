import { Request, Response } from 'express';
import { param } from 'express-validator';

import { ds } from '../db.js';
import { UserRequest } from '../models/info.js';
import { ApiProviderEntity, OAuthAccountEntity } from '../entity/auth.entity.js';
import { validationErrorHandler } from '../middleware/validation.js';
import { ExtApiClient, getExtApiClient } from './auth.js';

/**
 * GET /ext-api/status
 * 全ての外部APIプロバイダーの接続状態を一覧で返す
 */
export const getExtApiStatus = [
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        const orgKey = req.info.user.orgKey;
        const userId = req.info.user.id;

        try {
            // 1. 組織の登録済みプロバイダー一覧を取得
            const apiProviders = await ds.getRepository(ApiProviderEntity).find({
                where: { orgKey, isDeleted: false },
                order: { sortSeq: 'ASC' },
                select: ['type', 'name', 'label', 'authType', 'uriBase'],
            });

            // 2. ユーザーのOAuth認証状態を取得
            const oAuthAccounts = await ds.getRepository(OAuthAccountEntity).find({
                where: { orgKey, userId },
                select: ['provider', 'providerEmail', 'status'],
            });

            // 3. プロバイダー名でマッピング
            const oAuthAccountMap = oAuthAccounts.reduce((map: Record<string, OAuthAccountEntity>, account: OAuthAccountEntity) => {
                map[account.provider] = account;
                return map;
            }, {} as Record<string, OAuthAccountEntity>);

            // 4. 各プロバイダーの接続状態をマージ
            const providers = apiProviders.map((provider: ApiProviderEntity) => {
                const providerKey = `${provider.type}-${provider.name}`;
                const oAuthAccount = oAuthAccountMap[providerKey];

                return {
                    provider: providerKey,
                    label: provider.label,
                    type: provider.type,
                    authType: provider.authType,
                    connected: !!oAuthAccount,
                    status: oAuthAccount?.status || null,
                    providerEmail: oAuthAccount?.providerEmail || null,
                };
            });

            res.json({ providers });
        } catch (error) {
            console.error('getExtApiStatus error:', error);
            res.status(500).json({ error: (error as Error).message || 'Internal Server Error' });
        }
    }
];

/**
 * GET /ext-api/status/:provider/check
 * 特定プロバイダーへの接続を実際にテストする（APIを叩いて確認）
 */
export const checkExtApiConnection = [
    param('provider').isString().notEmpty(),
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        const orgKey = req.info.user.orgKey;
        const userId = req.info.user.id;
        const { provider } = req.params as { provider: string };

        try {
            // 1. プロバイダー設定を取得
            let e: ExtApiClient;
            try {
                e = await getExtApiClient(orgKey, provider);
            } catch (error) {
                res.json({
                    provider,
                    connected: false,
                    verified: false,
                    message: `${provider}は登録されていません。`,
                });
                return;
            }

            // 2. ユーザーのOAuth認証状態を確認
            const oAuthAccount = await ds.getRepository(OAuthAccountEntity).findOne({
                where: { orgKey, userId, provider },
            });

            if (!oAuthAccount) {
                res.json({
                    provider,
                    label: e.label,
                    connected: false,
                    verified: false,
                    message: '認証されていません。OAuth認証を行ってください。',
                });
                return;
            }

            // 3. 認証付きaxiosクライアントを取得してpathUserInfoにリクエスト
            try {
                const axiosGenerator = await e.axiosWithAuth;
                const axiosWithAuth = await axiosGenerator(userId);

                const url = `${e.uriBase}${e.pathUserInfo}`;
                await axiosWithAuth.get(url);

                // 4. 成功
                res.json({
                    provider,
                    label: e.label,
                    connected: true,
                    verified: true,
                    message: '接続成功',
                    providerEmail: oAuthAccount.providerEmail,
                });
            } catch (error: any) {
                // 接続エラー
                const status = error.response?.status;
                let message = error.message || '接続エラー';

                if (status === 401 || status === 403) {
                    message = '認証トークンが無効です。再認証してください。';
                } else if (status === 404) {
                    message = 'APIエンドポイントが見つかりません。';
                } else if (error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND') {
                    message = 'サーバーに接続できません。';
                }

                res.json({
                    provider,
                    label: e.label,
                    connected: true,
                    verified: false,
                    message,
                    providerEmail: oAuthAccount.providerEmail,
                });
            }
        } catch (error) {
            console.error('checkExtApiConnection error:', error);
            res.status(500).json({ error: (error as Error).message || 'Internal Server Error' });
        }
    }
];

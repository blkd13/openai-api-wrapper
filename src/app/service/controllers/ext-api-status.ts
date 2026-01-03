import { Request, Response } from 'express';
import { param } from 'express-validator';

import { ds } from '../db.js';
import { UserRequest } from '../models/info.js';
import { ApiProviderEntity, OAuthAccountEntity } from '../entity/auth.entity.js';
import { validationErrorHandler } from '../middleware/validation.js';
import { ExtApiClient, getExtApiClient } from './auth.js';

/**
 * 接続チェック結果の型定義
 */
interface ConnectionCheckResult {
    provider: string;
    label: string | null;
    type: string | null;
    authType: string | null;
    connected: boolean;
    verified: boolean;
    message: string;
    providerEmail: string | null;
}

/**
 * 外部API接続チェック共通関数
 * 実際にAPIを叩いて接続が有効かテストする
 */
async function verifyExtApiConnection(
    orgKey: string,
    userId: string,
    providerKey: string
): Promise<ConnectionCheckResult> {
    // 1. プロバイダー設定を取得
    let e: ExtApiClient;
    try {
        e = await getExtApiClient(orgKey, providerKey);
    } catch (error) {
        return {
            provider: providerKey,
            label: null,
            type: null,
            authType: null,
            connected: false,
            verified: false,
            message: `${providerKey}は登録されていません。`,
            providerEmail: null,
        };
    }

    // 2. ユーザーのOAuth認証状態を確認
    const oAuthAccount = await ds.getRepository(OAuthAccountEntity).findOne({
        where: { orgKey, userId, provider: providerKey },
    });

    if (!oAuthAccount) {
        return {
            provider: providerKey,
            label: e.label,
            type: e.type,
            authType: e.authType,
            connected: false,
            verified: false,
            message: '認証されていません。OAuth認証を行ってください。',
            providerEmail: null,
        };
    }

    // 3. 認証付きaxiosクライアントを取得してpathUserInfoにリクエスト
    try {
        const axiosGenerator = await e.axiosWithAuth;
        const axiosWithAuth = await axiosGenerator(userId);

        const url = `${e.uriBase}${e.pathUserInfo}`;
        await axiosWithAuth.get(url);

        // 4. 成功
        return {
            provider: providerKey,
            label: e.label,
            type: e.type,
            authType: e.authType,
            connected: true,
            verified: true,
            message: '接続成功',
            providerEmail: oAuthAccount.providerEmail || null,
        };
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

        return {
            provider: providerKey,
            label: e.label,
            type: e.type,
            authType: e.authType,
            connected: true,
            verified: false,
            message,
            providerEmail: oAuthAccount.providerEmail || null,
        };
    }
}

/**
 * GET /ext-api/status
 * 全ての外部APIプロバイダーの接続状態を一覧で返す（実際の接続チェック込み）
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
                select: ['type', 'name', 'label', 'authType'],
            });

            // 2. 各プロバイダーに対して接続チェックを並列実行
            const providerKeys = apiProviders.map(
                (provider: ApiProviderEntity) => `${provider.type}-${provider.name}`
            );

            const checkResults = await Promise.all(
                providerKeys.map(providerKey => verifyExtApiConnection(orgKey, userId, providerKey))
            );

            res.json({ providers: checkResults });
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
            const result = await verifyExtApiConnection(orgKey, userId, provider);
            res.json(result);
        } catch (error) {
            console.error('checkExtApiConnection error:', error);
            res.status(500).json({ error: (error as Error).message || 'Internal Server Error' });
        }
    }
];

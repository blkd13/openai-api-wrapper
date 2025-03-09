import { Request, Response } from 'express';
import { ds } from '../db.js'; // データソース
import { body, param, validationResult } from 'express-validator';
import { validationErrorHandler } from '../middleware/validation.js';
import { UserSettingEntity } from '../entity/user.entity.js';
import { UserRequest } from '../models/info.js';

/**
 * [UPSERT] ユーザー設定を作成または更新
 */
export const upsertUserSetting = [
    param('userId').isUUID(),
    param('key').isString().trim().notEmpty(),
    body('value').notEmpty(),
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        const { key } = req.params as { key: string };
        const { value } = req.body as { value: any };
        const userId = req.info.user.id;
        // console.log('userId:', userId);
        // console.log('key:', key);
        // console.log('value:', value);
        try {
            const repository = ds.getRepository(UserSettingEntity);

            // `userId` と `key` の組み合わせで既存のレコードを探す
            let setting = await repository.findOne({ where: { userId, key } });

            if (setting) {
                // 既存のレコードがある場合は更新
                setting.value = value;
            } else {
                // 新しいレコードを作成
                setting = new UserSettingEntity();
                setting.userId = userId;
                setting.key = key;
                setting.value = value;
                setting.createdBy = userId; // 作成者
                setting.createdIp = req.info.ip; // 作成IP
            }
            setting.updatedBy = userId; // 更新者
            setting.updatedIp = req.info.ip; // 更新IP

            // 作成または更新を保存
            const savedSetting = await repository.save(setting);
            res.status(200).json(savedSetting);
        } catch (error) {
            console.error('Error upserting user setting:', error);
            res.status(500).json({ message: 'ユーザー設定の作成または更新中にエラーが発生しました' });
        }
    },
];

/**
 * [READ] ユーザー設定を取得
 */
export const getUserSetting = [
    param('userId').isUUID(),
    param('key').isString().trim().notEmpty(),
    validationErrorHandler,
    async (req: Request, res: Response) => {
        const { userId, key } = req.params as { userId: string, key: string };
        try {
            const setting = await ds.getRepository(UserSettingEntity).findOne({ where: { userId, key } });
            if (!setting) {
                // return res.status(404).json({ message: 'ユーザー設定が見つかりません' });
                return res.status(200).json({});
            }
            res.status(200).json(setting);
        } catch (error) {
            console.error('Error retrieving user setting:', error);
            res.status(500).json({ message: 'ユーザー設定の取得中にエラーが発生しました' });
        }
    },
];

/**
 * [DELETE] ユーザー設定を削除
 */
export const deleteUserSetting = [
    param('userId').isUUID(),
    param('key').isString().trim().notEmpty(),
    validationErrorHandler,
    async (req: Request, res: Response) => {
        const { userId, key } = req.params as { userId: string, key: string };
        try {
            const repository = ds.getRepository(UserSettingEntity);
            const setting = await repository.findOne({ where: { userId, key } });
            if (!setting) {
                return res.status(404).json({ message: 'ユーザー設定が見つかりません' });
            }

            await repository.remove(setting);
            res.status(204).send(); // No Content
        } catch (error) {
            console.error('Error deleting user setting:', error);
            res.status(500).json({ message: 'ユーザー設定の削除中にエラーが発生しました' });
        }
    },
];

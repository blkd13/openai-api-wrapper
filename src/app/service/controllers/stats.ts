import { Request, Response } from 'express';
import { body, param, query } from 'express-validator';

import { In } from 'typeorm';
import { ds } from '../db.js';
import { DepartmentEntity, DepartmentMemberEntity, DepartmentRoleType, DivisionEntity, ScopeType, UserEntity, UserRoleEntity, UserRoleType, UserStatus } from '../entity/auth.entity.js';
import { validationErrorHandler } from '../middleware/validation.js';
import { UserRequest } from '../models/info.js';

import { Utils } from '../../common/utils.js';

/**
 * [user認証] division一覧
 */
export const getDivisionList = [
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        const user = await ds.getRepository(UserEntity).findOneOrFail({
            select: { name: true },
            where: { orgKey: req.info.user.orgKey, id: req.info.user.id },
        })
        const myList = await ds.getRepository(DepartmentMemberEntity).find({
            where: {
                orgKey: req.info.user.orgKey,
                // 自分が所属している部の一覧を取る。
                // userId: req.info.user.id,
                name: user.name,
            },
        });
        const departmentIdList = myList.map((member: DepartmentMemberEntity) => member.departmentId);
        const departmentList = await ds.getRepository(DepartmentEntity).find({
            where: { orgKey: req.info.user.orgKey, id: In(departmentIdList), },
        });
        res.json({ departmentList });
    }
];

/**
 * [user認証] 部員一覧
 */
export const getDivisionMemberStatsList = [
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;

        const where = req.info.user.roleList.filter(role =>
            [UserRoleType.Admin, UserRoleType.SuperAdmin].includes(role.role)
            && [ScopeType.DIVISION, ScopeType.ORGANIZATION].includes(role.scopeInfo.scopeType)
        ).map(role => ({
            orgKey: req.info.user.orgKey,
            scopeInfo: role.scopeInfo,
            // ユーザーIDは指定しない。自分の部門に所属しているユーザーを全て取得する。停止中のものも取る
            status: In([UserStatus.Active, UserStatus.Inactive, UserStatus.Suspended]),
        }));
        // 一応最新情報取り直す
        const isContainRole = await ds.getRepository(UserRoleEntity).find({ where });
        if (isContainRole.length === 0) {
            res.status(403).json({ error: '権限がありません。' });
            return;
        }
        // 部門一覧を取得
        const divisionWhere = {} as any;
        if (isContainRole.some(role => role.scopeInfo.scopeType === ScopeType.ORGANIZATION)) {
            // 組織スコープがある場合は組織の部門を取得
        } else if (isContainRole.some(role => role.scopeInfo.scopeType === ScopeType.DIVISION)) {
            // 部門スコープがある場合はその部門の部門を取得
            divisionWhere.id = In([...new Set(isContainRole.map(role => role.scopeInfo.scopeId))]);
        } else {
            // ここに来ることはあり得ない。
            res.status(403).json({ error: '権限がありません。' });
            return;
        }
        const divisionList = await ds.getRepository(DivisionEntity).find({
            where: { orgKey: req.info.user.orgKey, ...divisionWhere, isActive: true },
            order: { name: 'ASC' },
        });

        // 廃止済みユーザーも見れるようにするためにあえてstatus: UserStatus.Activeを指定しない。
        const memberUserList = await ds.getRepository(UserEntity).find({
            select: {
                id: true,
                name: true,
                email: true,
                createdAt: true,
                updatedAt: true,
            },
            where: { orgKey: req.info.user.orgKey, id: In([...new Set(isContainRole.map(role => role.userId))]) },
        });

        const totalCosts = await ds.query(`
            SELECT TO_CHAR(created_at,'YYYY-MM') as yyyy_mm, user_id, model, sum(cost) as cost, sum(req_token) as req_token, sum(res_token) as res_token, COUNT(*)  
            FROM predict_history_view 
            WHERE org_key = $1 
            AND user_id IN (${memberUserList.map(user => `'{${user.id}}'`).join(',')})
            GROUP BY user_id, model, ROLLUP(yyyy_mm)
            ORDER BY user_id, model, yyyy_mm;
          `, [req.info.user.orgKey]);
        type History = { user_id: string, yyyy_mm: string, model: string, cost: number, req_token: number, res_token: number };
        type HistorySummaryMap = { [userId: string]: { [yyyyMm: string]: { totalCost: number, totalReqToken: number, totalResToken: number, foreignModelReqToken: number, foreignModelResToken: number } } };
        const costMap = totalCosts.reduce((map: HistorySummaryMap, history: History) => {
            // ROLLUPを使っているのでyyyy_mmがnullの場合＝ALLということ。
            history.yyyy_mm = history.yyyy_mm || 'ALL';
            if (history.user_id in map) {
            } else {
                map[history.user_id] = {};
            }
            if (history.user_id in map && history.yyyy_mm in map[history.user_id]) {
            } else {
                map[history.user_id][history.yyyy_mm] = {
                    totalCost: 0,
                    totalReqToken: 0,
                    totalResToken: 0,
                    foreignModelReqToken: 0,
                    foreignModelResToken: 0,
                };
            }
            map[history.user_id][history.yyyy_mm].totalCost += Number(history.cost);
            map[history.user_id][history.yyyy_mm].totalReqToken += Number(history.req_token);
            map[history.user_id][history.yyyy_mm].totalResToken += Number(history.res_token);
            // 海外リージョン
            if ([
                'meta/llama3-405b-instruct-maas',
                'claude-3-5-sonnet@20240620',
                'claude-3-5-sonnet-v2@20241022',
                'claude-3-7-sonnet-thinking@20250219',
                'claude-sonnet-4@20250514',
                'claude-sonnet-4-thinking@20250514',
                'claude-opus-4@20250514',
                'claude-opus-4-thinking@20250514',
                'gemini-flash-experimental',
                'gemini-pro-experimental',
                'gemini-exp-1206',
                'gemini-2.5-pro',
                'gemini-2.5-pro-exp',
                'gemini-2.5-pro-preview',
                'gemini-2.5-flash',
                'gemini-2.5-pro-preview-05-06',
                'gemini-2.5-pro-preview-06-05',
                'gemini-2.0-flash',
                'gemini-2.0-flash-001',
                'gemini-2.0-flash-exp',
                'gemini-2.0-flash-thinking-exp-1219',
                'gemini-2.0-flash-thinking-exp-01-21',
                'o3-mini',
                'o1-preview',
                'o1-pro',
                'o1',
                'o3',
                'o4-mini',
            ].includes(history.model)) {
                map[history.user_id][history.yyyy_mm].foreignModelReqToken += Number(history.req_token);
                map[history.user_id][history.yyyy_mm].foreignModelResToken += Number(history.res_token);
            }
            return map;
        }, {} as HistorySummaryMap) as HistorySummaryMap;

        // 纏める
        const divisionMemberList = divisionList.map(division => {
            // Userロールだけに絞る。Userロールは複数所属できないようにしようと思う。そうすると課金がすっきりするので。
            const roles = isContainRole.filter(role => role.scopeInfo.scopeType === ScopeType.DIVISION && role.scopeInfo.scopeId === division.id && role.role === UserRoleType.User);
            const members = memberUserList
                .filter(user => roles.some(role => role.userId === user.id))
                .sort((a, b) => (a.name || a.email).localeCompare((b.name || b.email)))
                .map(user => {
                    const role = roles.find(role => role.userId === user.id);
                    (user as any).divisionId = division.id;
                    (user as any).status = role?.status || UserStatus.Active;
                    (user as any).cost = costMap[user.id] || {};
                    (user as any).role = role?.role || UserRoleType.User;
                    return user;
                });
            const cost = members.reduce((sum, member) => {
                if ((member as any).cost) {
                    Object.entries((member as any).cost).forEach(([period, periodCost]: [string, any]) => {
                        if (!sum[period]) {
                            sum[period] = {
                                totalCost: 0,
                                totalReqToken: 0,
                                totalResToken: 0,
                                foreignModelReqToken: 0,
                                foreignModelResToken: 0,
                            };
                        }
                        sum[period].totalCost += periodCost.totalCost;
                        sum[period].totalReqToken += periodCost.totalReqToken;
                        sum[period].totalResToken += periodCost.totalResToken;
                        sum[period].foreignModelReqToken += periodCost.foreignModelReqToken;
                        sum[period].foreignModelResToken += periodCost.foreignModelResToken;
                    });
                }
                return sum;
            }, {} as {
                [period: string]: {
                    totalCost: number,
                    totalReqToken: number,
                    totalResToken: number,
                    foreignModelReqToken: number,
                    foreignModelResToken: number,
                }
            });
            return { division, cost, members };
        });

        res.json({ divisionMemberList });
    }
];

export const getDepartmentMemberLog = [
    validationErrorHandler,
    param('userId').isUUID().notEmpty(),
    query('offset').optional().isInt({ min: 0 }).toInt(),
    query('limit').optional().isInt({ min: 1, max: 1000 }).toInt(),
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        const { userId } = req.params as { userId: string };
        const { offset = 0, limit = 100 } = req.query as { offset?: number; limit?: number };
        try {
            const where = req.info.user.roleList.filter(role => [UserRoleType.Admin, UserRoleType.SuperAdmin].includes(role.role)).map(role => ({
                orgKey: req.info.user.orgKey,
                userId: userId,
                scopeInfo: role.scopeInfo,
                status: UserStatus.Active,
            }));
            const isContainRole = await ds.getRepository(UserRoleEntity).findOneOrFail({ where });
            const targetUser = await ds.getRepository(UserEntity).findOneOrFail({ where: { orgKey: req.info.user.orgKey, id: userId } });
            const predictHistory = await ds.query(`
                SELECT created_at, model, provider, take, cost, req_token, res_token, status, idempotency_key, args_hash
                FROM predict_history_view 
                WHERE user_id = $1
                ORDER BY created_at DESC
                LIMIT $2 OFFSET $3;
            `, [userId, limit, offset]);
            // 纏める
            res.json({ predictHistory });

        } catch (error) {
            // ユーザーが見つからない場合
            res.status(404).json({ error: 'ユーザーが見つかりません。' });
            return;
        }
    }
];

// 既存のエンドポイントを修正してtotalCountも返すように
export const getDepartmentMemberLogForUser = [
    query('offset').optional().isInt({ min: 0 }).toInt(),
    query('limit').optional().isInt({ min: 1, max: 100 }).toInt(),
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;

        // 総件数を取得
        const countResult = await ds.query(`
            SELECT COUNT(*) as total_count
            FROM predict_history_view 
            WHERE org_key = $1 AND user_id = $2
        `, [req.info.user.orgKey, req.info.user.id]);

        const totalCount = parseInt(countResult[0].total_count);

        // ページングされたデータを取得
        const predictHistory = await ds.query(`
            SELECT created_at, model, provider, take, cost, req_token, res_token, status, idempotency_key, args_hash
            FROM predict_history_view 
            WHERE org_key = $1 AND user_id = $2
            ORDER BY created_at DESC
            LIMIT $3 OFFSET $4
        `, [req.info.user.orgKey, req.info.user.id, req.query.limit || 100, req.query.offset || 0]);

        res.json({ predictHistory, totalCount });
    }
];

interface MonthlySummary {
    month: string;
    totalCost: number;
    totalReqTokens: number;
    totalResTokens: number;
    count: number;
}
// 月次集計用の新しいエンドポイント
export const getDepartmentMemberLogSummaryForUser = [
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;

        // 全データを取得（集計用）
        const predictHistory = await ds.query(`
            SELECT created_at, model, provider, take, cost, req_token, res_token, status, idempotency_key, args_hash
            FROM predict_history_view 
            WHERE org_key = $1 AND user_id = $2
            ORDER BY created_at DESC
        `, [req.info.user.orgKey, req.info.user.id]);

        const summaryMap = new Map<string, MonthlySummary>();

        (predictHistory as Array<{
            created_at: string,
            model: string,
            provider: string,
            take: number,
            cost: number,
            req_token: number,
            res_token: number,
            status: string,
            idempotency_key: string,
            args_hash: string
        }>).forEach(predict => {
            const month = Utils.formatDate(new Date(predict.created_at), 'yyyy-MM');
            const summary = summaryMap.get(month) || {
                month,
                totalCost: 0,
                totalReqTokens: 0,
                totalResTokens: 0,
                count: 0
            };

            summary.totalCost += predict.cost * 150;
            summary.totalReqTokens += predict.req_token;
            summary.totalResTokens += predict.res_token;
            summary.count += 1;

            summaryMap.set(month, summary);
        });

        const monthlySummary = Array.from(summaryMap.values()).sort((a, b) => b.month.localeCompare(a.month));
        // 纏める
        res.json({ monthlySummary });
    }
];


import fg from 'fast-glob';
import { promises as fs } from 'fs';
import path from 'path';

export async function readRequestLog(
    logDir: string,
    idempotencyKey: string,
    argsHash: string,
    type: 'request' | 'response' | 'stream' = 'request'
): Promise<string> {
    // パターンにマッチするファイルを探す
    const pattern = `${logDir}*/${idempotencyKey}*.` + (type === 'stream' ? 'txt' : `${type}.json`);
    const [filePath] = await fg(pattern);
    if (!filePath) {
        throw new Error(`ログファイルが見つかりません: ${pattern}`);
    }
    // 見つかったファイルを読み込む
    const jsonString = await fs.readFile(filePath, 'utf8');
    // console.log(`readRequestLog: ${filePath}`);
    if (type === 'response') {
        const jsonObj = JSON.parse(jsonString);
        if (jsonObj.response.headers && jsonObj.response.headers['set-cookie']) {
            delete jsonObj.response.headers['set-cookie']; // set-cookieヘッダーは認証系なので削除する
        }
        return JSON.stringify(jsonObj.response); // レスポンスはresponseフィールドのみを返す
    } else {
        return jsonString;

    }
}

export const getJournal = [
    param('idempotencyKey').notEmpty().isString(),
    param('argsHash').notEmpty().isString(),
    param('type').optional().isIn(['request', 'response', 'stream']).default('request'),
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;

        try {
            // パラメータ化クエリを使用
            const count = await ds.query(`
            SELECT EXISTS (
                SELECT 1
                FROM predict_history_view
                WHERE user_id = $1 AND idempotency_key = $2 AND args_hash = $3
            ) 
        `, [req.info.user.id, req.params.idempotencyKey, req.params.argsHash]);
            if (!count[0]) {
                res.status(404).json({ error: 'ログが見つかりません。' });
                return;
            }
            const LOG_DIR = path.join('', './history');

            const logs = await Promise.all(['request', 'response', 'stream'].map(async (type) => {
                return await readRequestLog(LOG_DIR, req.params.idempotencyKey, req.params.argsHash, type as 'request' | 'response' | 'stream')
                    .then(json => ({ type, json }))
                    .catch(() => ({ type, json: null }));
            }));

            // 纏める
            res.json(Object.fromEntries(logs.map(log => [log.type, log.json])));
        } catch (error) {
            console.error('Error reading journal:', error);
            res.status(500).json({ error: 'ログの読み込みに失敗しました。' });
        }
    }
];

export const getDepartmentMemberForUser = [
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        const userId = req.info.user.id;
        const user = await ds.getRepository(UserEntity).findOneByOrFail({ orgKey: req.info.user.orgKey, id: userId, status: UserStatus.Active });
        const departmentMemberList = await ds.getRepository(DepartmentMemberEntity).find({
            select: ['departmentId', 'departmentRole', 'userId', 'name'],
            where: {
                orgKey: req.info.user.orgKey,
                name: user.name,
            },
        });
        // 纏める
        res.json({ departmentMemberList });
    }
];


/**
 * [user認証] 部員管理（主に緊急停止用）
 */
export const patchDepartmentMember = [
    validationErrorHandler,
    param('departmentId').isUUID(),
    body('role').optional().isIn(Object.values(DepartmentRoleType)),
    body('status').optional().isIn(Object.values(UserStatus)),
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        const { role, status } = req.body;
        const user = await ds.getRepository(UserEntity).findOneOrFail({
            select: { name: true },
            where: { orgKey: req.info.user.orgKey, id: req.info.user.id },
        })
        const myList = await ds.getRepository(DepartmentMemberEntity).find({
            where: {
                orgKey: req.info.user.orgKey,
                // 自分が管理者となっている部の一覧を取る。
                // userId: req.info.user.id,
                name: user.name,
                departmentRole: DepartmentRoleType.Admin,
            },
        });
        const departmentIdList = myList.map((member: DepartmentMemberEntity) => member.departmentId);
        const memberList = await ds.getRepository(DepartmentMemberEntity).find({
            where: {
                orgKey: req.info.user.orgKey,
                // 対称部員が含まれるか
                departmentId: In(departmentIdList),
                name: user.name,
                // userId: userId,
            },
        });

        // 
        const userIdSet = new Set(memberList.map((member) => member.userId));
        const userIdAry = [...userIdSet];
        if (userIdAry.length === 1) {
            // 一人だけなら
            const user = await ds.getRepository(UserEntity).findOne({ where: { orgKey: req.info.user.orgKey, id: userIdAry[0] } });
            if (user) {
                // ステータス更新
                user.status = status || user.status;
                // ロール更新
                user.role = role || user.role;
                user.updatedBy = req.info.user.id;
                user.updatedIp = req.info.ip;
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


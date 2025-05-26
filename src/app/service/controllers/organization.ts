import { body, cookie, param, query } from 'express-validator';
import { Request, Response } from 'express';

import { InviteRequest, UserRequest } from '../models/info.js';
import { UserEntity, InviteEntity, LoginHistoryEntity, UserRoleType, DepartmentMemberEntity, DepartmentRoleType, DepartmentEntity, UserStatus, SessionEntity, OAuthAccountEntity, OAuthAccountStatus, OrganizationEntity, ApiProviderEntity, ApiProviderTemplateEntity, ApiProviderAuthType, UserRoleEntity, UserRole, ScopeType } from '../entity/auth.entity.js';
import { validationErrorHandler } from '../middleware/validation.js';
import { EntityManager, In, MoreThan, Not } from 'typeorm';
import { ds } from '../db.js';


/**
 * [user認証] division一覧
 */
export const getDivisionList = [
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        const myList = await ds.getRepository(DepartmentMemberEntity).find({
            where: {
                orgKey: req.info.user.orgKey,
                // 自分が所属している部の一覧を取る。
                // userId: req.info.user.id,
                name: req.info.user.name,
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
export const getDepartment = [
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        const myList = await ds.getRepository(DepartmentMemberEntity).find({
            where: {
                orgKey: req.info.user.orgKey,
                // 自分が管理者となっている部の一覧を取る。
                // userId: req.info.user.id,
                name: req.info.user.name,
                departmentRole: DepartmentRoleType.Admin,
            },
        });
        const departmentIdList = myList.map((member: DepartmentMemberEntity) => member.departmentId);
        const departmentList = await ds.getRepository(DepartmentEntity).find({
            where: { orgKey: req.info.user.orgKey, id: In(departmentIdList), },
        });
        const memberList = await ds.getRepository(DepartmentMemberEntity).find({
            where: {
                orgKey: req.info.user.orgKey,
                // 自分が管理者となっている部の一覧を取る。
                departmentId: In(departmentIdList),
                departmentRole: DepartmentRoleType.Member, // Memberだけにする。（Adminの人はAdminとMemberの両方の行があるので大丈夫。Deputy（主務じゃない人）は混乱するので除外。）
            },
        });
        const memberUserList = await ds.getRepository(UserEntity).find({
            where: {
                orgKey: req.info.user.orgKey,
                name: In(memberList.map((member: DepartmentMemberEntity) => member.name))
            }
        });
        const memberMap = memberList.reduce((map, member) => { map[member.name] = member; return map; }, {} as { [key: string]: DepartmentMemberEntity });

        const totalCosts = await ds.query(`
            SELECT TO_CHAR(created_at,'YYYY-MM') as yyyy_mm, created_by, model, sum(cost) as cost, sum(req_token) as req_token, sum(res_token) as res_token, COUNT(*)  
            FROM predict_history_view 
            GROUP BY created_by, model, ROLLUP(yyyy_mm)
            ORDER BY created_by, model, yyyy_mm;
          `);
        type History = { created_by: string, yyyy_mm: string, model: string, cost: number, req_token: number, res_token: number };
        type HistorySummaryMap = { [createdBy: string]: { [yyyyMm: string]: { totalCost: number, totalReqToken: number, totalResToken: number, foreignModelReqToken: number, foreignModelResToken: number } } };
        const costMap = totalCosts.reduce((map: HistorySummaryMap, history: History) => {
            // ROLLUPを使っているのでyyyy_mmがnullの場合＝ALLということ。
            history.yyyy_mm = history.yyyy_mm || 'ALL';
            if (history.created_by in map) {
            } else {
                map[history.created_by] = {};
            }
            if (history.created_by in map && history.yyyy_mm in map[history.created_by]) {
            } else {
                map[history.created_by][history.yyyy_mm] = {
                    totalCost: 0,
                    totalReqToken: 0,
                    totalResToken: 0,
                    foreignModelReqToken: 0,
                    foreignModelResToken: 0,
                };
            }
            map[history.created_by][history.yyyy_mm].totalCost += Number(history.cost);
            map[history.created_by][history.yyyy_mm].totalReqToken += Number(history.req_token);
            map[history.created_by][history.yyyy_mm].totalResToken += Number(history.res_token);
            // 海外リージョン
            if ([
                'meta/llama3-405b-instruct-maas',
                'claude-3-5-sonnet@20240620',
                'claude-3-5-sonnet-v2@20241022',
                'claude-3-7-sonnet@20250219',
                'gemini-flash-experimental',
                'gemini-pro-experimental',
                'gemini-exp-1206',
                'gemini-2.5-pro',
                'gemini-2.5-pro-exp',
                'gemini-2.5-pro-preview',
                'gemini-2.5-flash',
                'gemini-2.5-pro-preview-05-06',
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
                map[history.created_by][history.yyyy_mm].foreignModelReqToken += Number(history.req_token);
                map[history.created_by][history.yyyy_mm].foreignModelResToken += Number(history.res_token);
            }
            return map;
        }, {} as HistorySummaryMap) as HistorySummaryMap;

        // 無理矢理userオブジェクトを埋め込む
        memberUserList.forEach(user => {
            (memberMap[user.name || ''] as any).user = { status: user.status, id: user.id, name: user.name, cost: costMap[user.id] };
            (memberMap[user.name || ''] as any).cost = costMap[user.id];
        });

        // 纏める
        // 纏める
        const departmentMemberList = departmentList.map((department) => {
            const members = memberList
                .filter(member => member.departmentId === department.id)
                .map(member => memberMap[member.name])
                .sort((a, b) => a.name.localeCompare(b.name));
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
            return { department, cost, members };
        });

        res.json({ departmentList: departmentMemberList });
    }
];


export const getDepartmentMemberLog = [
    validationErrorHandler,
    param('userId').isUUID().notEmpty(),
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        const { userId } = req.params as { userId: string };
        const myList = await ds.getRepository(DepartmentMemberEntity).find({
            where: {
                orgKey: req.info.user.orgKey,
                // 自分が管理者となっている部の一覧を取る。
                // userId: req.info.user.id,
                name: req.info.user.name,
                departmentRole: DepartmentRoleType.Admin,
            },
        });
        const targetUser = await ds.getRepository(UserEntity).findOneOrFail({ where: { orgKey: req.info.user.orgKey, id: userId } });
        const departmentIdList = myList.map((member: DepartmentMemberEntity) => member.departmentId);
        const departmentList = await ds.getRepository(DepartmentEntity).find({
            where: { orgKey: req.info.user.orgKey, id: In(departmentIdList), },
        });
        const memberList = await ds.getRepository(DepartmentMemberEntity).find({
            where: {
                orgKey: req.info.user.orgKey,
                // 自分が管理者となっている部の一覧を取る。
                departmentId: In(departmentList.map(department => department.id)),
                departmentRole: DepartmentRoleType.Member, // Memberだけにする。（Adminの人はAdminとMemberの両方の行があるので大丈夫。Deputy（主務じゃない人）は混乱するので除外。）
                name: targetUser.name,
            },
        });
        if (memberList.length > 0) {
        } else {
            // 何かがおかしい
            res.status(400).json({ error: '権限無し' });
            return;
        }
        // console.log(memberList);
        const predictHistory = await ds.query(`
            SELECT created_at, model, provider, take, cost, req_token, res_token, status
            FROM predict_history_view 
            WHERE name = (SELECT name FROM user_entity WHERE id='{${userId}}') ;
          `);
        // 纏める
        res.json({ predictHistory });
    }
];


export const getDepartmentMemberLogForUser = [
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        const userId = req.info.user.id;
        const predictHistory = await ds.query(`
            SELECT created_at, model, provider, take, cost, req_token, res_token, status
            FROM predict_history_view 
            WHERE name = (SELECT name FROM user_entity WHERE id='{${userId}}') ;
          `);
        // 纏める
        res.json({ predictHistory });
    }
];

export const getDepartmentMemberForUser = [
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        const userId = req.info.user.id;
        const departmentMemberList = await ds.getRepository(DepartmentMemberEntity).find({
            select: ['departmentId', 'departmentRole', 'userId', 'name'],
            where: {
                orgKey: req.info.user.orgKey,
                userId: userId,
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
        const myList = await ds.getRepository(DepartmentMemberEntity).find({
            where: {
                orgKey: req.info.user.orgKey,
                // 自分が管理者となっている部の一覧を取る。
                // userId: req.info.user.id,
                name: req.info.user.name,
                departmentRole: DepartmentRoleType.Admin,
            },
        });
        const departmentIdList = myList.map((member: DepartmentMemberEntity) => member.departmentId);
        const memberList = await ds.getRepository(DepartmentMemberEntity).find({
            where: {
                orgKey: req.info.user.orgKey,
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



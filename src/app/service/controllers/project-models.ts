import { Request, Response } from 'express';

import { ContentPartEntity, MessageEntity, MessageClusterEntity, MessageGroupEntity, ProjectEntity, TeamEntity, TeamMemberEntity, ThreadEntity, ThreadGroupEntity, } from '../entity/project-models.entity.js';
import { ds } from '../db.js';
import { body, param, query, validationResult } from 'express-validator';
import { validationErrorHandler } from '../middleware/validation.js';
import { UserRequest } from '../models/info.js';
import { EntityManager, EntityNotFoundError, In, IsNull, Not } from 'typeorm';
import { ContentPartType, MessageClusterType, MessageGroupType, ProjectStatus, ProjectVisibility, TeamMemberRoleType, TeamStatus, TeamType, ThreadGroupStatus, ThreadStatus, ThreadGroupVisibility, ThreadGroupType } from '../models/values.js';
import { FileBodyEntity, FileEntity, FileGroupEntity } from '../entity/file-models.entity.js';
import { UserEntity } from '../entity/auth.entity.js';
import { Utils } from '../../common/utils.js';
import { VertexCachedContentEntity } from '../entity/gemini-models.entity.js';
import { geminiCountTokensByContentPart } from './chat-by-project-model.js';
import { isActiveFile } from './file-manager.js';

/**
 * [user認証] チーム作成
 */
export const createTeam = [
    body('teamType').isIn(Object.values(TeamType)),
    body('name').optional().isString().trim().notEmpty(),
    body('label').optional().isString().trim().notEmpty(),
    body('description').optional().isString().trim(),
    validationErrorHandler,
    (req: Request, res: Response) => {
        const userReq = req as UserRequest;
        const { teamType } = userReq.body;

        const team = new TeamEntity();
        team.teamType = teamType;
        try {
            ds.transaction(async (transactionalEntityManager) => {
                // Aloneタイプのチームは一人一つまでしか作れない
                if (teamType === TeamType.Alone) {
                    // ユーザーが所属しているチームのIDを取得
                    const teamMembers = await transactionalEntityManager.getRepository(TeamMemberEntity).find({
                        where: { tenantKey: userReq.info.user.tenantKey, userId: userReq.info.user.id }
                    });
                    const teamIds = teamMembers.map(member => member.teamId);
                    const existingAloneTeam = await transactionalEntityManager.findOne(TeamEntity, {
                        where: { tenantKey: userReq.info.user.tenantKey, id: In(teamIds), teamType: TeamType.Alone },
                    });
                    if (existingAloneTeam) {
                        return res.status(400).json({ message: '個人用チーム定義は既に存在します' });
                    }
                }

                team.name = userReq.body.name;
                team.label = userReq.body.label;
                team.description = userReq.body.description;

                // チーム作成
                team.tenantKey = userReq.info.user.tenantKey;
                team.createdBy = userReq.info.user.id;
                team.updatedBy = userReq.info.user.id;
                team.createdIp = userReq.info.ip;
                team.updatedIp = userReq.info.ip;
                const savedTeam = await transactionalEntityManager.save(TeamEntity, team);

                // チーム作成ユーザーをメンバーとして追加
                const teamMember = new TeamMemberEntity();
                teamMember.teamId = savedTeam.id;
                teamMember.userId = userReq.info.user.id;
                teamMember.role = TeamMemberRoleType.Owner;
                teamMember.tenantKey = userReq.info.user.tenantKey;
                teamMember.createdBy = userReq.info.user.id;
                teamMember.updatedBy = userReq.info.user.id;
                teamMember.createdIp = userReq.info.ip;
                teamMember.updatedIp = userReq.info.ip;
                await transactionalEntityManager.save(TeamMemberEntity, teamMember);
                return savedTeam;
            }).then((savedTeam) => {
                if ((savedTeam as TeamEntity).id) {
                    res.status(201).json(savedTeam);
                } else {
                    // res 400で返却済み
                }
                return;
            });
        } catch (error) {
            console.error('Error creating team over:', error);
            res.status(500).json({ message: 'チームの作成中にエラーが発生しました' });
            return;
        }
    }
];

/**
 * [user認証] チーム一覧取得
 */
export const getTeamList = [
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        try {
            // ユーザーが所属しているチームのIDを取得
            const teamMembers = await ds.getRepository(TeamMemberEntity).find({
                where: { tenantKey: req.info.user.tenantKey, userId: req.info.user.id }
            });
            const teamIds = teamMembers.map(member => member.teamId);

            // チーム情報を取得
            const teams = await ds.getRepository(TeamEntity).find({
                where: { tenantKey: req.info.user.tenantKey, id: In(teamIds), status: TeamStatus.Normal }
            });

            res.status(200).json(teams);
        } catch (error) {
            console.error('Error getting team list:', JSON.stringify(error, Utils.genJsonSafer()) === '{}' ? error : JSON.stringify(error, Utils.genJsonSafer()));
            res.status(500).json({ message: 'チーム一覧の取得中にエラーが発生しました' });
        }
    }
];


/**
 * [user認証] チーム詳細取得（メンバー情報含む）
 */
export const getTeam = [
    param('id').notEmpty().isUUID(),
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        const teamId = req.params.id;

        try {
            // ユーザーがチームのメンバーであるか確認
            const teamMember = await ds.getRepository(TeamMemberEntity).findOne({
                where: {
                    tenantKey: req.info.user.tenantKey,
                    teamId: teamId,
                    userId: req.info.user.id
                }
            });

            if (!teamMember) {
                return res.status(403).json({ message: 'このチームにアクセスする権限がありません' });
            }

            // チーム情報を取得
            const team = await ds.getRepository(TeamEntity).findOneOrFail({
                where: { tenantKey: req.info.user.tenantKey, id: teamId, status: TeamStatus.Normal }
            });

            // チームメンバー情報を取得
            let teamMembers = await ds.getRepository(TeamMemberEntity).find({
                where: { tenantKey: req.info.user.tenantKey, teamId: teamId }
            });
            // ゴミが混ざると巻き込まれ死するので綺麗にしておく。
            teamMembers = teamMembers.filter(member => Utils.isUUID(member.userId));

            // チームメンバーのユーザー情報を取得
            const teamMemberNames = await ds.getRepository(UserEntity).find({
                where: { tenantKey: req.info.user.tenantKey, id: In(teamMembers.map(member => member.userId)) },
            });
            const teamMemberNamesMap = teamMemberNames.reduce((map, user) => {
                map[user.id] = user;
                return map;
            }, {} as { [key: string]: UserEntity });
            const teamMembersWitUserEntity = teamMembers.map(member => {
                // 渡す項目を絞る
                const { id, name, email, role, status } = teamMemberNamesMap[member.userId];
                (member as any).user = { id, name, email, role, status };
                return member;
            });

            // チーム情報とメンバー情報を組み合わせて返却
            const teamWithMembers = {
                ...team,
                members: teamMembersWitUserEntity
            };

            res.status(200).json(teamWithMembers);
        } catch (error) {
            console.error('Error getting team:', JSON.stringify(error, Utils.genJsonSafer()) === '{}' ? error : JSON.stringify(error, Utils.genJsonSafer()));
            if (error instanceof EntityNotFoundError) {
                res.status(404).json({ message: '指定されたチームが見つかりません' });
            } else {
                res.status(500).json({ message: 'チーム情報の取得中にエラーが発生しました' });
            }
        }
    }
];


/**
 * [user認証] チーム情報更新
 */
export const updateTeam = [
    param('id').notEmpty().isUUID(),
    // body('teamType').optional().isIn(Object.values(TeamType)),
    body('name').optional().isString().trim().notEmpty(),
    body('label').optional().isString().trim().notEmpty(),
    body('description').optional().isString().trim(),
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        const teamId = req.params.id;
        const { teamType, name, label, description } = req.body;

        let updatedTeam;
        try {
            // ユーザーがチームのオーナーまたは管理者であるか確認
            const teamMember = await ds.getRepository(TeamMemberEntity).findOne({
                where: {
                    tenantKey: req.info.user.tenantKey,
                    teamId: teamId,
                    userId: req.info.user.id,
                    role: TeamMemberRoleType.Owner // オーナーのみ許可
                }
            });

            if (!teamMember) {
                return res.status(403).json({ message: 'このチームを更新する権限がありません' });
            }

            // チーム情報を取得
            const team = await ds.getRepository(TeamEntity).findOneOrFail({
                where: { tenantKey: req.info.user.tenantKey, id: teamId }
            });

            // 更新可能なフィールドを更新
            // if (teamType !== undefined) {
            //     team.teamType = teamType;
            // }
            if (name !== undefined) {
                team.name = name;
            }
            if (label !== undefined) {
                team.label = label;
            }
            if (description !== undefined) {
                team.description = description;
            }

            // 更新者情報を記録
            team.updatedBy = req.info.user.id;
            team.updatedIp = req.info.ip;

            // 更新を保存
            updatedTeam = await ds.getRepository(TeamEntity).save(team);
            res.status(200).json(updatedTeam);
        } catch (error) {
            console.error('Error updating team:', JSON.stringify(error, Utils.genJsonSafer()) === '{}' ? error : JSON.stringify(error, Utils.genJsonSafer()));
            if (error instanceof EntityNotFoundError) {
                res.status(404).json({ message: '指定されたチームが見つかりません' });
            } else {
                res.status(500).json({ message: 'チーム情報の更新中にエラーが発生しました' });
            }
        }
    }
];


/**
 * [user認証] チーム削除
 */
export const deleteTeam = [
    param('id').notEmpty().isUUID(),
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        const teamId = req.params.id;

        try {
            // トランザクション開始
            await ds.transaction(async transactionalEntityManager => {
                // ユーザーがチームのオーナーであるか確認
                const teamMember = await transactionalEntityManager.findOne(TeamMemberEntity, {
                    where: {
                        tenantKey: req.info.user.tenantKey,
                        teamId: teamId,
                        userId: req.info.user.id,
                        role: TeamMemberRoleType.Owner
                    }
                });

                if (!teamMember) {
                    throw new Error('このチームを削除する権限がありません');
                }

                // チーム情報を取得
                const team = await transactionalEntityManager.findOneOrFail(TeamEntity, {
                    where: { tenantKey: req.info.user.tenantKey, id: teamId }
                });

                // チームを論理削除
                team.updatedBy = req.info.user.id;
                team.updatedIp = req.info.ip;
                team.status = TeamStatus.Deleted;
                await transactionalEntityManager.save(TeamEntity, team);

                // // 関連するチームメンバー情報も論理削除
                // await transactionalEntityManager.update(TeamMemberEntity,
                //     { teamId: teamId },
                // );
            });
            res.status(200).json({ message: 'チームが正常に削除されました' });
        } catch (error) {
            console.error('Error deleting team:', JSON.stringify(error, Utils.genJsonSafer()) === '{}' ? error : JSON.stringify(error, Utils.genJsonSafer()));
            if (error instanceof EntityNotFoundError) {
                res.status(404).json({ message: '指定されたチームが見つかりません' });
            } else if ((error as any).message === 'このチームを削除する権限がありません') {
                res.status(403).json({ message: (error as any).message });
            } else {
                res.status(500).json({ message: 'チームの削除中にエラーが発生しました' });
            }
        }
    }
];


/**
 * [user認証] チームメンバー追加
 */
export const addTeamMember = [
    param('teamId').notEmpty().isUUID(),
    body('userId').notEmpty().isUUID(),
    body('role').notEmpty().isIn(Object.values(TeamMemberRoleType)),
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        const { teamId } = req.params as { teamId: string };
        const { userId, role } = req.body;

        try {
            await ds.transaction(async transactionalEntityManager => {
                // ユーザーがチームのオーナーであるか確認
                const requesterMember = await transactionalEntityManager.findOne(TeamMemberEntity, {
                    where: {
                        tenantKey: req.info.user.tenantKey,
                        teamId: teamId,
                        userId: req.info.user.id,
                        role: TeamMemberRoleType.Owner
                    }
                });

                if (!requesterMember) {
                    throw new Error('このチームにメンバーを追加する権限がありません');
                }

                // チームが存在するか確認
                await transactionalEntityManager.findOneOrFail(TeamEntity, {
                    where: { tenantKey: req.info.user.tenantKey, id: teamId }
                });

                // 既にメンバーでないか確認
                const existingMember = await transactionalEntityManager.findOne(TeamMemberEntity, {
                    where: {
                        tenantKey: req.info.user.tenantKey,
                        teamId: teamId,
                        userId: userId
                    }
                });

                if (existingMember) {
                    throw new Error('このユーザーは既にチームのメンバーです');
                }

                // 新しいメンバーを追加
                const newMember = new TeamMemberEntity();
                newMember.teamId = teamId;
                newMember.userId = userId;
                newMember.role = role;

                newMember.tenantKey = req.info.user.tenantKey;
                newMember.createdBy = req.info.user.id;
                newMember.updatedBy = req.info.user.id;
                newMember.createdIp = req.info.ip;
                newMember.updatedIp = req.info.ip;

                await transactionalEntityManager.save(TeamMemberEntity, newMember);
            });
            res.status(201).json({ message: 'チームメンバーが正常に追加されました' });
        } catch (error) {
            console.error('Error adding team member:', JSON.stringify(error, Utils.genJsonSafer()) === '{}' ? error : JSON.stringify(error, Utils.genJsonSafer()));
            if (error instanceof EntityNotFoundError) {
                res.status(404).json({ message: '指定されたチームが見つかりません' });
            } else if ((error as any).message === 'このチームにメンバーを追加する権限がありません' || (error as any).message === 'このユーザーは既にチームのメンバーです') {
                res.status(400).json({ message: (error as any).message });
            } else {
                res.status(500).json({ message: 'チームメンバーの追加中にエラーが発生しました' });
            }
        }
    }
];

/**
 * [user認証] チームメンバー一覧取得
 */
export const getTeamMembers = [
    param('teamId').notEmpty().isUUID(),
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        const { teamId } = req.params;

        try {
            // リクエスト元のユーザーがチームメンバーであるか確認
            const requesterMember = await ds.getRepository(TeamMemberEntity).findOne({
                where: {
                    tenantKey: req.info.user.tenantKey,
                    teamId: teamId,
                    userId: req.info.user.id
                }
            });

            if (!requesterMember) {
                return res.status(403).json({ message: 'このチームのメンバー一覧を取得する権限がありません' });
            }

            // チームメンバー一覧を取得
            const teamMembers = await ds.getRepository(TeamMemberEntity).find({
                where: { tenantKey: req.info.user.tenantKey, teamId: teamId },
                order: { role: 'ASC', createdAt: 'ASC' }
            });

            res.status(200).json(teamMembers);
        } catch (error) {
            console.error('Error getting team members:', JSON.stringify(error, Utils.genJsonSafer()) === '{}' ? error : JSON.stringify(error, Utils.genJsonSafer()));
            if (error instanceof EntityNotFoundError) {
                res.status(404).json({ message: '指定されたチームが見つかりません' });
            } else {
                res.status(500).json({ message: 'チームメンバー一覧の取得中にエラーが発生しました' });
            }
        }
    }
];


/**
 * [user認証] チームメンバー情報更新
 */
export const updateTeamMember = [
    param('teamId').notEmpty().isUUID(),
    param('userId').notEmpty().isUUID(),
    body('role').notEmpty().isIn(Object.values(TeamMemberRoleType)),
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        const { teamId, userId } = req.params;
        const { role } = req.body;

        try {
            await ds.transaction(async transactionalEntityManager => {
                // リクエスト元のユーザーがチームのオーナーであるか確認
                const requesterMember = await transactionalEntityManager.findOne(TeamMemberEntity, {
                    where: {
                        tenantKey: req.info.user.tenantKey,
                        teamId: teamId,
                        userId: req.info.user.id,
                        role: TeamMemberRoleType.Owner
                    }
                });

                if (!requesterMember) {
                    throw new Error('このチームのメンバー情報を更新する権限がありません');
                }

                // 更新対象のメンバーが存在するか確認
                const targetMember = await transactionalEntityManager.findOne(TeamMemberEntity, {
                    where: {
                        tenantKey: req.info.user.tenantKey,
                        teamId: teamId,
                        userId: userId
                    }
                });

                if (!targetMember) {
                    throw new EntityNotFoundError(TeamMemberEntity, { teamId, userId });
                }

                // オーナーは最低1人必要なので、最後のオーナーの役割を変更しようとしている場合はエラー
                if (targetMember.role === TeamMemberRoleType.Owner && role !== TeamMemberRoleType.Owner) {
                    const ownerCount = await transactionalEntityManager.count(TeamMemberEntity, {
                        where: {
                            tenantKey: req.info.user.tenantKey,
                            teamId: teamId,
                            role: TeamMemberRoleType.Owner
                        }
                    });

                    if (ownerCount <= 1) {
                        throw new Error('チームには最低1人のオーナーが必要です');
                    }
                }

                // メンバー情報を更新
                targetMember.role = role;
                targetMember.updatedBy = req.info.user.id;
                targetMember.createdIp = req.info.ip;
                targetMember.updatedIp = req.info.ip;

                await transactionalEntityManager.save(TeamMemberEntity, targetMember);
            });

            res.status(200).json({ message: 'チームメンバー情報が正常に更新されました' });
        } catch (error) {
            console.error('Error updating team member:', JSON.stringify(error, Utils.genJsonSafer()) === '{}' ? error : JSON.stringify(error, Utils.genJsonSafer()));
            if (error instanceof EntityNotFoundError) {
                res.status(404).json({ message: '指定されたチームメンバーが見つかりません' });
            } else if ((error as any).message === 'このチームのメンバー情報を更新する権限がありません' || (error as any).message === 'チームには最低1人のオーナーが必要です') {
                res.status(400).json({ message: (error as any).message });
            } else {
                res.status(500).json({ message: 'チームメンバー情報の更新中にエラーが発生しました' });
            }
        }
    }
];

/**
 * [user認証] チームメンバー削除
 */
export const removeTeamMember = [
    param('teamId').notEmpty().isUUID(),
    param('userId').notEmpty().isUUID(),
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        const { teamId, userId } = req.params;

        try {
            await ds.transaction(async transactionalEntityManager => {
                // リクエスト元のユーザーがチームのオーナーであるか確認
                const requesterMember = await transactionalEntityManager.findOne(TeamMemberEntity, {
                    where: {
                        tenantKey: req.info.user.tenantKey,
                        teamId: teamId,
                        userId: req.info.user.id,
                        role: TeamMemberRoleType.Owner
                    }
                });

                if (!requesterMember) {
                    throw new Error('このチームのメンバーを削除する権限がありません');
                }

                // 削除対象のメンバーが存在するか確認
                const targetMember = await transactionalEntityManager.findOne(TeamMemberEntity, {
                    where: {
                        tenantKey: req.info.user.tenantKey,
                        teamId: teamId,
                        userId: userId
                    }
                });

                if (!targetMember) {
                    throw new EntityNotFoundError(TeamMemberEntity, { teamId, userId });
                }

                // 自身を削除しようとしていないか確認
                if (userId === req.info.user.id) {
                    throw new Error('自身をチームから削除することはできません');
                }

                // オーナーを削除しようとしている場合、他のオーナーが存在するか確認
                if (targetMember.role === TeamMemberRoleType.Owner) {
                    const ownerCount = await transactionalEntityManager.count(TeamMemberEntity, {
                        where: {
                            tenantKey: req.info.user.tenantKey,
                            teamId: teamId,
                            role: TeamMemberRoleType.Owner
                        }
                    });

                    if (ownerCount <= 1) {
                        throw new Error('チームには最低1人のオーナーが必要です');
                    }
                }

                // メンバーを削除（物理削除）
                targetMember.updatedBy = req.info.user.id;
                targetMember.updatedIp = req.info.ip;

                await transactionalEntityManager.remove(TeamMemberEntity, targetMember);
                // await transactionalEntityManager.save(TeamMemberEntity, targetMember);
            });

            res.status(200).json({ message: 'チームメンバーが正常に削除されました' });
        } catch (error) {
            console.error('Error removing team member:', JSON.stringify(error, Utils.genJsonSafer()) === '{}' ? error : JSON.stringify(error, Utils.genJsonSafer()));
            if (error instanceof EntityNotFoundError) {
                res.status(404).json({ message: '指定されたチームメンバーが見つかりません' });
            } else if ((error as any).message === 'このチームのメンバーを削除する権限がありません' ||
                (error as any).message === '自身をチームから削除することはできません' ||
                (error as any).message === 'チームには最低1人のオーナーが必要です') {
                res.status(400).json({ message: (error as any).message });
            } else {
                res.status(500).json({ message: 'チームメンバーの削除中にエラーが発生しました' });
            }
        }
    }
];


/**
 * [user認証] プロジェクト作成
 */
export const createProject = [
    body('name').trim().notEmpty(),
    body('visibility').trim().notEmpty(),
    body('teamId').trim().notEmpty().isUUID(),
    // body('status').trim().notEmpty(),
    body('label').trim().notEmpty(),
    validationErrorHandler,
    (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        const project = new ProjectEntity();
        project.name = req.body.name;
        project.status = ProjectStatus.InProgress;
        project.visibility = req.body.visibility;
        project.description = req.body.description || '';
        project.label = req.body.label;
        project.tenantKey = req.info.user.tenantKey;
        project.createdBy = req.info.user.id;
        project.updatedBy = req.info.user.id;
        project.createdIp = req.info.ip;
        project.updatedIp = req.info.ip;

        // 作成トランザクション
        function create() {
            ds.transaction(tx => {
                return tx.save(ProjectEntity, project);
            }).then(savedProject => {
                res.status(201).json(savedProject);
            });
        }
        // 権限チェック（チームメンバーかつオーナーであること）
        ds.getRepository(TeamMemberEntity).findOneOrFail({ where: { tenantKey: req.info.user.tenantKey, teamId: req.body.teamId, userId: req.info.user.id, role: TeamMemberRoleType.Owner } }).then((teamMember) => {
            // プロジェクトにチームIDをセット            
            project.teamId = req.body.teamId;
            if (project.visibility === ProjectVisibility.Default) {
                // Defaultプロジェクトは一人一個限定なので、既存のDefaultプロジェクトがあるか確認する
                ds.getRepository(ProjectEntity).find({ where: { tenantKey: req.info.user.tenantKey, teamId: project.teamId, visibility: ProjectVisibility.Default } }).then(projects => {
                    if (projects.length > 0) {
                        res.status(400).json({ message: `Default project already exists` });
                        return;
                    } else {
                        // 正常
                        create();
                    }
                });
            } else {
                // プロジェクト作成
                create();
            }
        }).catch((error) => {
            console.error(JSON.stringify(error, Utils.genJsonSafer()));
            res.status(error instanceof EntityNotFoundError ? 404 : 500).json({ message: `Error creating project` });
        });
    }
];

/**
 * [認証なし/user認証] プロジェクト一覧取得
 */
export const getProjectList = [
    validationErrorHandler,
    (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        if (req.info && req.info.user) {
            // ログインしている場合
            ds.getRepository(TeamMemberEntity).find({ where: { tenantKey: req.info.user.tenantKey, userId: req.info.user.id } }).then((teamMembers) => {
                return teamMembers.map((teamMember) => teamMember.teamId);
            }).then((teamIds) => {
                return ds.getRepository(ProjectEntity).find({
                    where: [
                        { tenantKey: req.info.user.tenantKey, teamId: In(teamIds), status: Not(ProjectStatus.Deleted) },
                        { visibility: ProjectVisibility.Public, status: Not(ProjectStatus.Deleted) },
                        { visibility: ProjectVisibility.Login, status: Not(ProjectStatus.Deleted) },
                    ],
                    order: { createdAt: 'ASC' }
                });
            }).then((projects) => {
                res.status(200).json(projects);
            }).catch((error) => {
                console.error(JSON.stringify(error, Utils.genJsonSafer()));
                res.status(error instanceof EntityNotFoundError ? 404 : 500).json({ message: `Error getting projects` });
            });
        } else {
            // ログインしていない場合
            ds.getRepository(ProjectEntity).find({
                where: { tenantKey: req.info.user.tenantKey, visibility: ProjectVisibility.Public, status: Not(ProjectStatus.Deleted) }
            }).then((projects) => {
                res.status(200).json(projects);
            }).catch((error) => {
                console.error(JSON.stringify(error, Utils.genJsonSafer()));
                res.status(error instanceof EntityNotFoundError ? 404 : 500).json({ message: `Error getting projects` });
            });
        }
    }
];

/**
 * [認証なし/user認証] プロジェクト取得
 */
export const getProject = [
    param('id').trim().notEmpty(),
    validationErrorHandler,
    (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        ds.getRepository(ProjectEntity).findOneOrFail({ where: { tenantKey: req.info.user.tenantKey, id: req.params.id } }).then((project) => {
            if (req.info && req.info.user) {
                if (project.visibility === ProjectVisibility.Public || project.visibility === ProjectVisibility.Login) {
                    // OK
                    res.status(200).json(project);
                } else {
                    // チームメンバーであること（ロールは問わない）
                    ds.getRepository(TeamMemberEntity).find({ where: { tenantKey: req.info.user.tenantKey, userId: req.info.user.id, teamId: project.teamId } }).then((teamMembers) => {
                        if (teamMembers.length === 0) {
                            res.status(403).json({ message: `Forbidden` });
                        } else {
                            res.status(200).json(project);
                        }
                    });
                }
            } else {
                // ログインしていない場合
                if (project.visibility === ProjectVisibility.Public) {
                    // OK
                    res.status(200).json(project);
                } else {
                    // NG
                    res.status(403).json({ message: `Forbidden` });
                }
            }
        }).catch((error) => {
            console.error(JSON.stringify(error, Utils.genJsonSafer()));
            res.status(error instanceof EntityNotFoundError ? 404 : 500).json({ message: `Error getting project ${req.params.id}` });
        });
    }
];

/**
 * [user認証] プロジェクト更新
 */
export const updateProject = [
    param('id').trim().notEmpty().isUUID(),
    validationErrorHandler,
    (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        ds.transaction(tx => {
            return tx.findOneOrFail(ProjectEntity, { where: { tenantKey: req.info.user.tenantKey, id: req.params.id } }).then(project => {
                // 権限チェック（チームメンバーかつオーナーであること）
                return tx.findOneOrFail(TeamMemberEntity, { where: { tenantKey: req.info.user.tenantKey, teamId: project.teamId, userId: req.info.user.id, role: TeamMemberRoleType.Owner } }).then(() => {
                    if (req.body.name) {
                        project.name = req.body.name;
                    }
                    if (req.body.description) {
                        project.description = req.body.description;
                    }
                    if (req.body.visibility) {
                        project.visibility = req.body.visibility;
                    }
                    if (req.body.label) {
                        project.label = req.body.label;
                    }
                    if (req.body.status) {
                        project.status = req.body.status;
                    }
                    project.updatedBy = req.info.user.id;
                    project.updatedIp = req.info.ip;
                    if (req.body.teamId) {
                        // TODO 権限持ってないチームに渡してしまうのを防ぐチェック
                        return tx.findOneOrFail(TeamMemberEntity, { where: { tenantKey: req.info.user.tenantKey, teamId: req.body.teamId, userId: req.info.user.id, role: TeamMemberRoleType.Owner } }).then(() => {
                            project.teamId = req.body.teamId;
                            return tx.save(ProjectEntity, project);
                        });
                    } else {
                        return tx.save(ProjectEntity, project);
                    }
                });
            });
        }).then(project => {
            res.status(200).json(project);
        }).catch(error => {
            console.error(JSON.stringify(error, Utils.genJsonSafer()));
            if (error instanceof EntityNotFoundError) {
                res.status(404).json({ message: `Project not found or user does not have permission to update project ${req.params.id}` });
            } else {
                res.status(500).json({ message: `Error updating project ${req.params.id}` });
            }
        });
    }
];

/**
 * [user認証] プロジェクト削除
 */
export const deleteProject = [
    param('id').trim().notEmpty().isUUID(),
    validationErrorHandler,
    (_req: Request, res: Response) => {
        const req = _req as UserRequest;

        ds.transaction(tx => {
            return tx.findOneOrFail(ProjectEntity, { where: { tenantKey: req.info.user.tenantKey, id: req.params.id } }).then(project => {
                // 権限チェック（チームメンバーかつオーナーであること）
                tx.findOneOrFail(TeamMemberEntity, { where: { tenantKey: req.info.user.tenantKey, teamId: project.teamId, userId: req.info.user.id, role: TeamMemberRoleType.Owner } }).then((teamMember) => {
                    project.status = ProjectStatus.Deleted;
                    project.updatedBy = req.info.user.id;
                    project.updatedIp = req.info.ip;
                    return project.save();
                }).catch((error) => {
                    console.error(JSON.stringify(error, Utils.genJsonSafer()));
                    res.status(error instanceof EntityNotFoundError ? 404 : 500).json({ message: `Error deleting project ${req.params.id}` });
                });
            });
        }).then(result => {
            res.status(200).json(result);
        }).catch((error) => {
            console.error(JSON.stringify(error, Utils.genJsonSafer()));
            res.status(error instanceof EntityNotFoundError ? 404 : 500).json({ message: `Error deleting project ${req.params.id}` });
        });
    }
];


/**
 * [user認証] スレッドグループ作成
 */
export const updateThreadGroupTitleAndDescription = [
    param('projectId').isUUID().notEmpty(),
    body('id').notEmpty().isUUID(),
    body('title').trim().isString(),
    body('description').trim().isString(),
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        const { id, title, description } = req.body as { id: string, title: string, description: string };
        const { projectId } = req.params;

        try {
            let savedThreadGroup;
            await ds.transaction(async transactionalEntityManager => {
                // プロジェクトの存在確認
                const project = await transactionalEntityManager.findOneOrFail(ProjectEntity, {
                    where: { tenantKey: req.info.user.tenantKey, id: projectId }
                });

                const threadGroup = await transactionalEntityManager.findOneOrFail(ThreadGroupEntity, {
                    where: { tenantKey: req.info.user.tenantKey, id }
                });

                // TODO なんか権限チェックは適当だから考え直した方がよい。本来はthreadGroupの権限も組み合わせて見るべき
                let hasPermission = false;
                switch (project.visibility) {
                    // スレ立て可否はプロジェクトの公開設定によらず、チームのロールのみで判断
                    case ProjectVisibility.Default:
                    case ProjectVisibility.Team:
                    case ProjectVisibility.Public:
                    case ProjectVisibility.Login:
                        // ユーザーがプロジェクトのチームメンバーであるか確認し、ロールを取得
                        const teamMember = await transactionalEntityManager.findOne(TeamMemberEntity, {
                            where: {
                                tenantKey: req.info.user.tenantKey,
                                teamId: project.teamId,
                                userId: req.info.user.id
                            }
                        });

                        if (teamMember && (teamMember.role === TeamMemberRoleType.Owner || teamMember.role === TeamMemberRoleType.Member)) {
                            hasPermission = true;
                        }
                        break;
                }

                if (!hasPermission) {
                    throw new Error('スレッドを作成する権限がありません');
                }

                // スレッドグループの更新
                threadGroup.title = title;
                threadGroup.description = description;
                threadGroup.updatedBy = req.info.user.id;
                threadGroup.updatedIp = req.info.ip;
                savedThreadGroup = await transactionalEntityManager.save(ThreadGroupEntity, threadGroup);
            });
            res.status(201).json(savedThreadGroup);
        } catch (error) {
            console.error('Error creating thread:', JSON.stringify(error, Utils.genJsonSafer()) === '{}' ? error : JSON.stringify(error, Utils.genJsonSafer()));
            if (error instanceof EntityNotFoundError) {
                res.status(404).json({ message: '指定されたプロジェクトが見つかりません' });
            } else if ((error as any).message === 'スレッドを作成する権限がありません' || (error as any).message === '不正なスレッド公開設定です') {
                res.status(403).json({ message: (error as any).message });
            } else {
                res.status(500).json({ message: 'スレッドの作成中にエラーが発生しました' });
            }
        }
    }
];

/**
 * [user認証] スレッドグループ作成
 */
export const upsertThreadGroup = [
    param('projectId').isUUID().notEmpty(),
    body('title').trim().isString(),
    body('type').isIn(Object.values(ThreadGroupType)),
    body('description').trim().isString(),
    body('visibility').isIn(Object.values(ThreadGroupVisibility)),
    body('threadList').isArray().notEmpty(),
    body('threadList.*.inDto').trim().notEmpty(),
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        const { id, title, type, description, threadList, visibility } = req.body as { id?: string, title: string, type: ThreadGroupType, description: string, threadList: ThreadEntity[], visibility: ThreadGroupVisibility };
        const { projectId } = req.params;

        try {
            let savedThreadGroup;
            await ds.transaction(async transactionalEntityManager => {
                // プロジェクトの存在確認
                const project = await transactionalEntityManager.findOneOrFail(ProjectEntity, {
                    where: { tenantKey: req.info.user.tenantKey, id: projectId }
                });

                let hasPermission = false;

                switch (project.visibility) {
                    // スレ立て可否はプロジェクトの公開設定によらず、チームのロールのみで判断
                    case ProjectVisibility.Default:
                    case ProjectVisibility.Team:
                    case ProjectVisibility.Public:
                    case ProjectVisibility.Login:
                        // ユーザーがプロジェクトのチームメンバーであるか確認し、ロールを取得
                        const teamMember = await transactionalEntityManager.findOne(TeamMemberEntity, {
                            where: {
                                tenantKey: req.info.user.tenantKey,
                                teamId: project.teamId,
                                userId: req.info.user.id
                            }
                        });

                        if (teamMember && (teamMember.role === TeamMemberRoleType.Owner || teamMember.role === TeamMemberRoleType.Member)) {
                            if (visibility !== ThreadGroupVisibility.Team && teamMember.role == TeamMemberRoleType.Member) {
                                // チームメンバーであっても、ロールがMemberの場合はチームスレッドのみ作成可能
                                throw new Error('不正なスレッド公開設定です');
                            } else {
                                hasPermission = true;
                            }
                        }

                        break;
                }

                if (!hasPermission) {
                    throw new Error('スレッドを作成する権限がありません');
                }

                let threadGroup;
                if (type === ThreadGroupType.Default) {
                    // デフォルトスレッド（ユーザーごとの初期設定）の場合、デフォルトプロジェクトに保存する。
                    // TODO createdByを見るのは良くない。項目としてuserIdを追加すべき
                    const defaultProject = await transactionalEntityManager.findOneOrFail(ProjectEntity, {
                        where: { tenantKey: req.info.user.tenantKey, createdBy: req.info.user.id, status: ProjectStatus.InProgress, visibility: ProjectVisibility.Default }
                    });

                    // スレッドグループの更新
                    threadGroup = await transactionalEntityManager.findOne(ThreadGroupEntity, {
                        where: { tenantKey: req.info.user.tenantKey, projectId: defaultProject.id, type: ThreadGroupType.Default, status: ThreadGroupStatus.Normal }
                    });
                    if (threadGroup) {
                        // デフォルトプロジェクトのスレッドグループが存在する場合は更新
                        // スレッドグループに紐づくスレッドは削除(論理削除)
                        await transactionalEntityManager.update(ThreadEntity,
                            { tenantKey: req.info.user.tenantKey, threadGroupId: threadGroup.id, status: Not(ThreadStatus.Deleted) },
                            { status: ThreadStatus.Deleted },
                        );
                        // await transactionalEntityManager.delete(ThreadEntity, { threadGroupId: threadGroup.id });
                    } else {
                        // デフォルトプロジェクトのスレッドグループが存在しない場合は作成
                        threadGroup = new ThreadGroupEntity();
                        threadGroup.projectId = defaultProject.id;
                        threadGroup.status = ThreadGroupStatus.Normal;
                        threadGroup.tenantKey = req.info.user.tenantKey;
                        threadGroup.createdBy = req.info.user.id;
                        threadGroup.createdIp = req.info.ip;
                    }

                } else if (id) {
                    // スレッドグループの更新
                    threadGroup = await transactionalEntityManager.findOneOrFail(ThreadGroupEntity, {
                        where: { tenantKey: req.info.user.tenantKey, id }
                    });
                    // デフォルトプロジェクトのスレッドグループが存在する場合は更新
                    // スレッドグループに紐づくスレッドは削除(論理削除)
                    await transactionalEntityManager.update(ThreadEntity,
                        { tenantKey: req.info.user.tenantKey, threadGroupId: threadGroup.id, status: Not(ThreadStatus.Deleted) },
                        { status: ThreadStatus.Deleted },
                    );
                } else {
                    threadGroup = new ThreadGroupEntity();
                    threadGroup.projectId = projectId;
                    threadGroup.status = ThreadGroupStatus.Normal;
                    threadGroup.tenantKey = req.info.user.tenantKey;
                    threadGroup.createdBy = req.info.user.id;
                    threadGroup.createdIp = req.info.ip;
                }

                threadGroup.title = title;
                threadGroup.type = type;
                threadGroup.description = description;
                threadGroup.visibility = visibility;
                threadGroup.updatedBy = req.info.user.id;
                threadGroup.updatedIp = req.info.ip;
                savedThreadGroup = await transactionalEntityManager.save(ThreadGroupEntity, threadGroup);

                const savedThreadList: ThreadEntity[] = [];
                let index = 0;
                for (let _thread of threadList) {
                    let thread;
                    // console.log('thread.id');
                    // console.log(_thread.id);
                    if (_thread.id) {
                        // スレッドの更新
                        thread = await transactionalEntityManager.findOneOrFail(ThreadEntity, {
                            where: { tenantKey: req.info.user.tenantKey, id: _thread.id }
                        });
                        // } else if (thread = await transactionalEntityManager.findOne(ThreadEntity, {
                        //     where: { threadGroupId: threadGroup.id, subSeq: index }
                        // })) {
                    } else {
                        // 新しいスレッドを作成
                        thread = new ThreadEntity();
                        thread.tenantKey = req.info.user.tenantKey;
                        thread.createdBy = req.info.user.id;
                        thread.createdIp = req.info.ip;
                    }
                    // console.log(thread.id);
                    // console.log(`thread.subSeq: ${index}`);
                    // // thread.subSeq = index;
                    thread.status = ThreadStatus.Normal;
                    thread.threadGroupId = savedThreadGroup.id;
                    thread.inDtoJson = (_thread as any).inDtoJson;
                    thread.updatedBy = req.info.user.id;
                    thread.updatedIp = req.info.ip;
                    const savedThread = await transactionalEntityManager.save(ThreadEntity, thread);
                    savedThreadList.push(savedThread);
                    index++;
                }

                (savedThreadGroup as (ThreadGroupEntity & { threadList: ThreadEntity[] })).threadList = savedThreadList;

            });
            res.status(201).json(savedThreadGroup);
        } catch (error) {
            console.error('Error creating thread:', JSON.stringify(error, Utils.genJsonSafer()) === '{}' ? error : JSON.stringify(error, Utils.genJsonSafer()));
            if (error instanceof EntityNotFoundError) {
                res.status(404).json({ message: '指定されたプロジェクトが見つかりません' });
            } else if ((error as any).message === 'スレッドを作成する権限がありません' || (error as any).message === '不正なスレッド公開設定です') {
                res.status(403).json({ message: (error as any).message });
            } else {
                res.status(500).json({ message: 'スレッドの作成中にエラーが発生しました' });
            }
        }
    }
];

/**
 * [認証なし/user認証] スレッドグループ一覧取得
 */
export const getThreadGroupList = [
    param('projectId').notEmpty().isUUID(),
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        const { projectId } = req.params;

        try {
            const project = await ds.getRepository(ProjectEntity).findOneOrFail({
                where: { tenantKey: req.info.user.tenantKey, id: projectId }
            });

            let threadGroups: ThreadGroupEntity[];
            let threads: ThreadEntity[];

            if (req.info && req.info.user) {
                // ログインしている場合
                const teamMember = await ds.getRepository(TeamMemberEntity).findOne({
                    where: {
                        tenantKey: req.info.user.tenantKey,
                        teamId: project.teamId,
                        userId: req.info.user.id
                    }
                });

                if (teamMember || project.visibility === ProjectVisibility.Public || project.visibility === ProjectVisibility.Login) {
                    // チームメンバー、または公開/ログインユーザー向けプロジェクトの場合
                    threadGroups = await ds.getRepository(ThreadGroupEntity).find({
                        where: { tenantKey: req.info.user.tenantKey, projectId, status: Not(ThreadGroupStatus.Deleted) }
                    });
                    threads = await ds.getRepository(ThreadEntity).find({
                        where: { tenantKey: req.info.user.tenantKey, threadGroupId: In(threadGroups.map(tg => tg.id)), status: Not(ThreadStatus.Deleted) },
                        order: { seq: 'ASC' }
                    });
                } else {
                    throw new Error('このプロジェクトのスレッド一覧を取得する権限がありません');
                }
            } else {
                // ログインしていない場合
                if (project.visibility === ProjectVisibility.Public) {
                    // 公開プロジェクトの場合
                    threadGroups = await ds.getRepository(ThreadGroupEntity).find({
                        where: { tenantKey: req.info.user.tenantKey, projectId, visibility: ThreadGroupVisibility.Public, status: Not(ThreadGroupStatus.Deleted) }
                    });
                    threads = await ds.getRepository(ThreadEntity).find({
                        where: { tenantKey: req.info.user.tenantKey, threadGroupId: In(threadGroups.map(tg => tg.id)), status: Not(ThreadStatus.Deleted) }
                    });
                } else {
                    throw new Error('このプロジェクトのスレッド一覧を取得する権限がありません');
                }
            }

            const responseDto = threadGroups.map(tg => ({ ...tg, threadList: threads.filter(t => t.threadGroupId === tg.id) }));
            res.status(200).json(responseDto);
        } catch (error) {
            console.error('Error getting thread list:', JSON.stringify(error, Utils.genJsonSafer()) === '{}' ? error : JSON.stringify(error, Utils.genJsonSafer()));
            if (error instanceof EntityNotFoundError) {
                res.status(404).json({ message: '指定されたプロジェクトが見つかりません' });
            } else if ((error as any).message === 'このプロジェクトのスレッド一覧を取得する権限がありません') {
                res.status(403).json({ message: (error as any).message });
            } else {
                res.status(500).json({ message: 'スレッド一覧の取得中にエラーが発生しました' });
            }
        }
    }
];

/**
 * [user認証] スレッドグループを別のプロジェクトに紐づける。
 */
export const moveThreadGroup = [
    param('id').notEmpty().isUUID(),
    body('projectId').notEmpty().isUUID(),
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        const { id } = req.params;
        const { projectId } = req.body;

        try {
            let updatedThread;
            await ds.transaction(async transactionalEntityManager => {
                const threadGroup = await transactionalEntityManager.findOneOrFail(ThreadGroupEntity, {
                    where: { tenantKey: req.info.user.tenantKey, id, status: Not(ThreadGroupStatus.Deleted) }
                });

                const projectFm = await transactionalEntityManager.findOneOrFail(ProjectEntity, {
                    where: { tenantKey: req.info.user.tenantKey, id: threadGroup.projectId }
                });
                const projectTo = await transactionalEntityManager.findOneOrFail(ProjectEntity, {
                    where: { tenantKey: req.info.user.tenantKey, id: projectId }
                });

                const teamMemberFm = await transactionalEntityManager.findOne(TeamMemberEntity, {
                    where: {
                        tenantKey: req.info.user.tenantKey,
                        teamId: projectFm.teamId,
                        userId: req.info.user.id
                    }
                });
                const teamMemberTo = await transactionalEntityManager.findOne(TeamMemberEntity, {
                    where: {
                        tenantKey: req.info.user.tenantKey,
                        teamId: projectTo.teamId,
                        userId: req.info.user.id
                    }
                });

                if ((!teamMemberFm || (teamMemberFm.role !== TeamMemberRoleType.Owner && teamMemberFm.role !== TeamMemberRoleType.Member)) ||
                    (!teamMemberTo || (teamMemberTo.role !== TeamMemberRoleType.Owner && teamMemberTo.role !== TeamMemberRoleType.Member))) {
                    throw new Error('このスレッドを更新する権限がありません');
                }

                threadGroup.projectId = projectId;

                threadGroup.updatedBy = req.info.user.id;
                threadGroup.updatedIp = req.info.ip;

                updatedThread = await transactionalEntityManager.save(ThreadGroupEntity, threadGroup);

            });
            res.status(200).json(updatedThread);
        } catch (error) {
            console.error('Error updating thread:', JSON.stringify(error, Utils.genJsonSafer()) === '{}' ? error : JSON.stringify(error, Utils.genJsonSafer()));
            if (error instanceof EntityNotFoundError) {
                res.status(404).json({ message: '指定されたスレッドまたはプロジェクトが見つかりません' });
            } else if ((error as any).message === 'このスレッドを更新する権限がありません' || (error as any).message === 'スレッド公開設定は変更できません') {
                res.status(403).json({ message: (error as any).message });
            } else {
                res.status(500).json({ message: 'スレッドの更新中にエラーが発生しました' });
            }
        }
    }
];

/**
 * [user認証] スレッドグループ削除
 */
export const deleteThreadGroup = [
    param('id').notEmpty().isUUID(),
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        const { id } = req.params;

        try {
            await ds.transaction(async transactionalEntityManager => {
                const threadGroup = await transactionalEntityManager.findOneOrFail(ThreadGroupEntity, {
                    where: { tenantKey: req.info.user.tenantKey, id, status: Not(ThreadGroupStatus.Deleted) }
                });

                const project = await transactionalEntityManager.findOneOrFail(ProjectEntity, {
                    where: { tenantKey: req.info.user.tenantKey, id: threadGroup.projectId }
                });

                const teamMember = await transactionalEntityManager.findOne(TeamMemberEntity, {
                    where: {
                        tenantKey: req.info.user.tenantKey,
                        teamId: project.teamId,
                        userId: req.info.user.id
                    }
                });

                if (!teamMember || (teamMember.role !== TeamMemberRoleType.Owner && teamMember.role !== TeamMemberRoleType.Member)) {
                    throw new Error('このスレッドを削除する権限がありません');
                }

                // 論理削除の実装
                threadGroup.status = ThreadGroupStatus.Deleted;
                threadGroup.updatedBy = req.info.user.id;
                threadGroup.updatedIp = req.info.ip;

                await transactionalEntityManager.save(ThreadGroupEntity, threadGroup);

            });
            res.status(200).json({ message: 'スレッドが正常に削除されました' });
        } catch (error) {
            console.error('Error deleting thread:', JSON.stringify(error, Utils.genJsonSafer()) === '{}' ? error : JSON.stringify(error, Utils.genJsonSafer()));
            if (error instanceof EntityNotFoundError) {
                res.status(404).json({ message: '指定されたスレッドまたはプロジェクトが見つかりません' });
            } else if ((error as any).message === 'このスレッドを削除する権限がありません') {
                res.status(403).json({ message: (error as any).message });
            } else {
                res.status(500).json({ message: 'スレッドの削除中にエラーが発生しました' });
            }
        }
    }
];


/**
 * [user認証] メッセージ、コンテンツの作成または更新
 */
export const upsertMessageWithContents = [
    param('threadId').isUUID().notEmpty(),
    // body('messageClusterId').optional().isUUID(),
    // body('messageGroupId').optional().isUUID(),
    body('messageId').optional().isUUID(),
    body('messageClusterType').isIn(Object.values(MessageClusterType)),
    body('messageGroupType').isIn(Object.values(MessageGroupType)),
    body('role').notEmpty(),
    body('label').optional().isString(),
    body('previousMessageGroupId').optional().isUUID(),
    body('cacheId').optional().isString(),
    body('contents').isArray(),
    body('contents.*.id').optional().isUUID(),
    body('contents.*.type').isIn(Object.values(ContentPartType)),
    body('contents.*.text').notEmpty(),
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        const { messageClusterId, messageGroupId, messageId, messageClusterType, messageGroupType, role, label, previousMessageGroupId, contents, cacheId } = req.body;
        const { threadId } = req.params;

        try {
            const result = await ds.transaction(async transactionalEntityManager => {
                // スレッドの存在確認
                const thread = await transactionalEntityManager.findOneOrFail(ThreadEntity, {
                    where: { tenantKey: req.info.user.tenantKey, id: threadId, status: Not(ThreadStatus.Deleted) }
                });

                // スレッドグループの取得
                const threadGroup = await transactionalEntityManager.findOneOrFail(ThreadGroupEntity, {
                    where: { tenantKey: req.info.user.tenantKey, id: thread.threadGroupId }
                });

                // プロジェクトの取得と権限チェック
                const project = await transactionalEntityManager.findOneOrFail(ProjectEntity, {
                    where: { tenantKey: req.info.user.tenantKey, id: threadGroup.projectId }
                });

                const teamMember = await transactionalEntityManager.findOne(TeamMemberEntity, {
                    where: {
                        tenantKey: req.info.user.tenantKey,
                        teamId: project.teamId,
                        userId: req.info.user.id
                    }
                });

                if (!teamMember || (teamMember.role !== TeamMemberRoleType.Owner && teamMember.role !== TeamMemberRoleType.Member)) {
                    throw new Error('このスレッドにメッセージを作成または更新する権限がありません');
                }

                let messageCluster: MessageClusterEntity;
                let messageGroup: MessageGroupEntity;
                let message: MessageEntity;

                if (messageClusterId) {
                    // 更新の場合
                    messageCluster = await transactionalEntityManager.findOneOrFail(MessageClusterEntity, {
                        where: { tenantKey: req.info.user.tenantKey, id: messageClusterId, threadId }
                    });
                } else {
                    // 新規作成の場合
                    messageCluster = new MessageClusterEntity();
                    messageCluster.threadId = threadId;
                    messageCluster.tenantKey = req.info.user.tenantKey;
                    messageCluster.createdBy = req.info.user.id;
                    messageCluster.createdIp = req.info.ip;
                }
                messageCluster.type = messageClusterType;
                messageCluster.label = label;
                messageCluster.updatedBy = req.info.user.id;
                messageCluster.updatedIp = req.info.ip;

                if (messageGroupId) {
                    // 更新の場合
                    messageGroup = await transactionalEntityManager.findOneOrFail(MessageGroupEntity, {
                        where: { tenantKey: req.info.user.tenantKey, id: messageGroupId }
                    });
                } else {
                    // 新規作成の場合
                    messageGroup = new MessageGroupEntity();
                    messageGroup.threadId = threadId;
                    messageGroup.tenantKey = req.info.user.tenantKey;
                    messageGroup.createdBy = req.info.user.id;
                    messageGroup.createdIp = req.info.ip;
                }
                messageGroup.previousMessageGroupId = previousMessageGroupId; // 変えちゃダメな気はする。
                messageGroup.type = messageGroupType;
                messageGroup.role = role;
                messageGroup.source = 'user';
                // messageGroup.argsIndex;
                messageGroup.updatedBy = req.info.user.id;
                messageGroup.updatedIp = req.info.ip;

                if (messageId) {
                    // 更新の場合
                    message = await transactionalEntityManager.findOneOrFail(MessageEntity, {
                        where: { tenantKey: req.info.user.tenantKey, id: messageId },
                    });

                    messageGroup = await transactionalEntityManager.findOneOrFail(MessageGroupEntity, {
                        where: { tenantKey: req.info.user.tenantKey, id: message.messageGroupId }
                    });

                    if (messageGroup.threadId !== threadId) {
                        throw new Error('指定されたメッセージは、このスレッドに属していません');
                    }

                    if (messageGroup.id !== messageGroupId) {
                        throw new Error('指定されたメッセージグループは存在しません');
                    }

                    // Messageの更新
                } else {
                    // 新規作成の場合
                    message = new MessageEntity();
                    message.tenantKey = req.info.user.tenantKey;
                    message.createdBy = req.info.user.id;
                    message.createdIp = req.info.ip;
                }
                message.cacheId = cacheId;
                message.label = label;
                message.updatedBy = req.info.user.id;
                message.updatedIp = req.info.ip;
                message.editedRootMessageId
                message.subSeq;
                // message.previousMessageId = previousMessageId;

                const savedMessageCluster = await transactionalEntityManager.save(MessageClusterEntity, messageCluster);
                // messageGroup.messageClusterId = savedMessageCluster.id;
                const savedMessageGroup = await transactionalEntityManager.save(MessageGroupEntity, messageGroup);
                message.messageGroupId = savedMessageGroup.id;
                const savedMessage = await transactionalEntityManager.save(MessageEntity, message);

                // 既存のContentPartsを取得（更新の場合）
                const existingContentParts = await (messageId
                    ? transactionalEntityManager.find(ContentPartEntity, {
                        where: { tenantKey: req.info.user.tenantKey, messageId: messageId },
                        order: { seq: 'ASC' }
                    })
                    : Promise.resolve([] as ContentPartEntity[]));

                // ContentPartの作成、更新、削除
                const updatedContentParts = await Promise.all((contents as ContentPartEntity[]).map(async (content, index) => {

                    let contentPart = existingContentParts.find(cp => cp.id === content.id) as ContentPartEntity;
                    if (contentPart && content.id) {
                        // 既存のContentPartを更新
                    } else {
                        // 新しいContentPartを作成
                        contentPart = new ContentPartEntity();
                        contentPart.messageId = savedMessage.id;
                        contentPart.tenantKey = req.info.user.tenantKey;
                        contentPart.createdBy = req.info.user.id;
                        contentPart.createdIp = req.info.ip;
                    }

                    contentPart.type = content.type;
                    contentPart.updatedBy = req.info.user.id;
                    contentPart.updatedIp = req.info.ip;

                    // seqは全体通番なので無編集にする
                    // contentPart.seq = index + 1;

                    switch (content.type) {
                        case ContentPartType.TEXT:
                            // textはファイル無しなので無視
                            contentPart.text = content.text;
                            break;
                        case ContentPartType.BASE64:
                            // base64のまま来てしまうのはおかしい。事前に登録されているべき。
                            break;
                        case ContentPartType.URL:
                            // TODO インターネットからコンテンツ取ってくる。後回し
                            break;
                        case ContentPartType.STORE:
                            // gs:// のファイル。
                            break;
                        case ContentPartType.FILE:
                            // fileは登録済みなので無視
                            contentPart.text = content.text;
                            contentPart.linkId = content.linkId;
                            break;
                    }
                    contentPart = await transactionalEntityManager.save(ContentPartEntity, contentPart);
                    return contentPart;
                }));

                // 不要になったContentPartsを削除
                const contentPartIdsToKeep = updatedContentParts.map(cp => cp.id);
                await transactionalEntityManager.delete(ContentPartEntity, {
                    tenantKey: req.info.user.tenantKey,
                    messageId: savedMessage.id,
                    id: Not(In(contentPartIdsToKeep))
                });

                return {
                    messageGroup: savedMessageGroup,
                    message: savedMessage,
                    contentParts: updatedContentParts,
                };
            });

            res.status(messageId ? 200 : 201).json(result);
        } catch (error) {
            console.error('Error upserting message with contents:', JSON.stringify(error, Utils.genJsonSafer()) === '{}' ? error : JSON.stringify(error, Utils.genJsonSafer()));
            if (error instanceof EntityNotFoundError) {
                res.status(404).json({ message: '指定されたスレッド、プロジェクト、またはメッセージが見つかりません' });
            } else if ((error as any).message === 'このスレッドにメッセージを作成または更新する権限がありません') {
                res.status(403).json({ message: (error as any).message });
            } else if ((error as any).message === '指定されたメッセージは、このスレッドに属していません') {
                res.status(400).json({ message: (error as any).message });
            } else {
                res.status(500).json({ message: 'メッセージの作成または更新中にエラーが発生しました' });
            }
        }
    }
];

/**
 * [user認証] メッセージ、コンテンツの作成または更新
 */
export const upsertMessageWithContents2 = [
    param('threadId').isUUID().notEmpty(),
    param('targetType').isIn(['message', 'message-group']).notEmpty(),

    body('messageGroupId').optional().isUUID(),
    body('messageGroupType').isIn(Object.values(MessageGroupType)),
    body('role').notEmpty(),
    body('previousMessageGroupId').optional().isUUID(),

    body('messageId').optional().isUUID(),
    body('messageSubSeq').isInt().notEmpty(),
    body('cacheId').optional().isString(),

    body('contents').isArray(),
    body('contents.*.id').optional().isUUID(),
    body('contents.*.type').isIn(Object.values(ContentPartType)),
    body('contents.*.text').notEmpty(),
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        const { messageGroupType, messageGroupId, role, previousMessageGroupId, messageId, messageSubSeq, label, cacheId, contents } = req.body;
        const { threadId, targetType } = req.params as { threadId: string, targetType: 'message' | 'message-group' };

        try {
            const result = await ds.transaction(async transactionalEntityManager => {
                // スレッドの存在確認
                const thread = await transactionalEntityManager.findOneOrFail(ThreadEntity, {
                    where: { tenantKey: req.info.user.tenantKey, id: threadId, status: Not(ThreadStatus.Deleted) }
                });

                // スレッドグループの取得
                const threadGroup = await transactionalEntityManager.findOneOrFail(ThreadGroupEntity, {
                    where: { tenantKey: req.info.user.tenantKey, id: thread.threadGroupId }
                });

                // プロジェクトの取得と権限チェック
                const project = await transactionalEntityManager.findOneOrFail(ProjectEntity, {
                    where: { tenantKey: req.info.user.tenantKey, id: threadGroup.projectId }
                });

                const teamMember = await transactionalEntityManager.findOne(TeamMemberEntity, {
                    where: {
                        tenantKey: req.info.user.tenantKey,
                        teamId: project.teamId,
                        userId: req.info.user.id
                    }
                });

                if (!teamMember || (teamMember.role !== TeamMemberRoleType.Owner && teamMember.role !== TeamMemberRoleType.Member)) {
                    throw new Error('このスレッドにメッセージを作成または更新する権限がありません');
                }

                let messageGroup: MessageGroupEntity;
                let message: MessageEntity;
                let editedRootMessageId: string = '';

                if (messageGroupId) {
                    // 更新の場合
                    messageGroup = await transactionalEntityManager.findOneOrFail(MessageGroupEntity, {
                        where: { tenantKey: req.info.user.tenantKey, id: messageGroupId }
                    });
                    (messageGroup as any).id = undefined;
                    (messageGroup as any).createdAt = undefined;
                    messageGroup.tenantKey = req.info.user.tenantKey;
                    messageGroup.createdBy = req.info.user.id;
                    messageGroup.createdIp = req.info.ip;
                } else {
                    // 新規作成の場合
                    messageGroup = new MessageGroupEntity();
                    messageGroup.threadId = threadId;
                    messageGroup.tenantKey = req.info.user.tenantKey;
                    messageGroup.createdBy = req.info.user.id;
                    messageGroup.createdIp = req.info.ip;
                    messageGroup.previousMessageGroupId = previousMessageGroupId; // 変えちゃダメなので新規の時だけセット
                }
                messageGroup.type = messageGroupType;
                messageGroup.role = role;
                messageGroup.source = 'user';
                // messageGroup.subSeq; // subSeqは使ってないと思う
                messageGroup.updatedBy = req.info.user.id;
                messageGroup.updatedIp = req.info.ip;

                if (messageId) {
                    // 更新の場合
                    message = await transactionalEntityManager.findOneOrFail(MessageEntity, {
                        where: { tenantKey: req.info.user.tenantKey, id: messageId },
                    });

                    messageGroup = await transactionalEntityManager.findOneOrFail(MessageGroupEntity, {
                        where: { tenantKey: req.info.user.tenantKey, id: message.messageGroupId }
                    });

                    if (messageGroup.threadId !== threadId) {
                        throw new Error('指定されたメッセージは、このスレッドに属していません');
                    }

                    if (messageGroup.id !== messageGroupId) {
                        throw new Error('指定されたメッセージグループは存在しません');
                    }

                    // Messageの更新
                } else {
                    // 新規作成の場合
                    message = new MessageEntity();
                    message.editedRootMessageId = editedRootMessageId;
                    message.tenantKey = req.info.user.tenantKey;
                    message.createdBy = req.info.user.id;
                    message.createdIp = req.info.ip;
                }
                message.cacheId = cacheId;
                message.label = label;
                message.updatedBy = req.info.user.id;
                message.updatedIp = req.info.ip;
                message.editedRootMessageId
                message.subSeq;

                // const savedMessageCluster = await transactionalEntityManager.save(MessageClusterEntity, messageCluster);
                // messageGroup.messageClusterId = savedMessageCluster.id;
                const savedMessageGroup = await transactionalEntityManager.save(MessageGroupEntity, messageGroup);

                message.messageGroupId = savedMessageGroup.id;
                const savedMessage = await transactionalEntityManager.save(MessageEntity, message);

                // 既存のContentPartsを取得（更新の場合）
                const existingContentParts = await (messageId
                    ? transactionalEntityManager.find(ContentPartEntity, {
                        where: { tenantKey: req.info.user.tenantKey, messageId: messageId },
                        order: { seq: 'ASC' }
                    })
                    : Promise.resolve([] as ContentPartEntity[]));

                // ContentPartの作成、更新、削除
                const updatedContentParts = await Promise.all((contents as ContentPartEntity[]).map(async (content, index) => {

                    let contentPart = existingContentParts.find(cp => cp.id === content.id) as ContentPartEntity;
                    if (contentPart && content.id) {
                        // 既存のContentPartを更新
                    } else {
                        // 新しいContentPartを作成
                        contentPart = new ContentPartEntity();
                        contentPart.messageId = savedMessage.id;
                        contentPart.tenantKey = req.info.user.tenantKey;
                        contentPart.createdBy = req.info.user.id;
                        contentPart.createdIp = req.info.ip;
                    }

                    contentPart.type = content.type;
                    contentPart.updatedBy = req.info.user.id;
                    contentPart.updatedIp = req.info.ip;

                    // seqは全体通番なので無編集にする
                    // contentPart.seq = index + 1;

                    switch (content.type) {
                        case ContentPartType.TEXT:
                            // textはファイル無しなので無視
                            contentPart.text = content.text;
                            break;
                        case ContentPartType.BASE64:
                            // base64のまま来てしまうのはおかしい。事前に登録されているべき。
                            break;
                        case ContentPartType.URL:
                            // TODO インターネットからコンテンツ取ってくる。後回し
                            break;
                        case ContentPartType.STORE:
                            // gs:// のファイル。
                            break;
                        case ContentPartType.FILE:
                            // fileは登録済みなので無視
                            contentPart.text = content.text;
                            contentPart.linkId = content.linkId;
                            break;
                    }
                    contentPart = await transactionalEntityManager.save(ContentPartEntity, contentPart);
                    return contentPart;
                }));

                // 不要になったContentPartsを削除
                const contentPartIdsToKeep = updatedContentParts.map(cp => cp.id);
                await transactionalEntityManager.delete(ContentPartEntity, {
                    tenantKey: req.info.user.tenantKey,
                    messageId: savedMessage.id,
                    id: Not(In(contentPartIdsToKeep))
                });

                return {
                    messageGroup: savedMessageGroup,
                    message: savedMessage,
                    contentParts: updatedContentParts,
                };
            });

            res.status(messageId ? 200 : 201).json(result);
        } catch (error) {
            console.error('Error upserting message with contents:', JSON.stringify(error, Utils.genJsonSafer()) === '{}' ? error : JSON.stringify(error, Utils.genJsonSafer()));
            if (error instanceof EntityNotFoundError) {
                res.status(404).json({ message: '指定されたスレッド、プロジェクト、またはメッセージが見つかりません' });
            } else if ((error as any).message === 'このスレッドにメッセージを作成または更新する権限がありません') {
                res.status(403).json({ message: (error as any).message });
            } else if ((error as any).message === '指定されたメッセージは、このスレッドに属していません') {
                res.status(400).json({ message: (error as any).message });
            } else {
                res.status(500).json({ message: 'メッセージの作成または更新中にエラーが発生しました' });
            }
        }
    }
];

/**
 * [user認証] メッセージ、コンテンツの作成または更新
 */
export const upsertMessageWithContents3 = [
    param('threadId').isUUID().notEmpty(),
    // param('targetType').isIn(['message', 'message-group']).notEmpty(),

    body('id').optional().isUUID(),
    body('type').isIn(Object.values(MessageGroupType)),
    body('role').notEmpty(),
    body('previousMessageGroupId').optional().isUUID(),

    body('messages').isArray(),
    body('messages.*.id').optional().isUUID(),
    body('messages.*.label').optional().isString(),
    body('messages.*.subSeq').isInt().notEmpty(),
    body('messages.*.cacheId').optional(),

    body('messages.*.contents').isArray(),
    body('messages.*.contents.*.id').optional().isUUID(),
    body('messages.*.contents.*.type').isIn(Object.values(ContentPartType)),
    body('messages.*.contents.*.text').isString(),
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;

        const { id, type, role, previousMessageGroupId, messages, } = req.body as { id: string | undefined, type: MessageGroupType, role: string, previousMessageGroupId: string | undefined, messages: { id: string | undefined, label: string, subSeq: number, cacheId: string, contents: { id: string | undefined, type: ContentPartType, text: string }[] }[] };
        const { threadId, targetType } = req.params as { threadId: string, targetType: 'message' | 'message-group' };
        const applyType = { POST: 'insert', PUT: 'update' }[req.method];

        try {
            const result = await ds.transaction(async transactionalEntityManager => {
                // スレッドの存在確認
                const thread = await transactionalEntityManager.findOneOrFail(ThreadEntity, {
                    where: { tenantKey: req.info.user.tenantKey, id: threadId, status: Not(ThreadStatus.Deleted) }
                });

                // スレッドグループの取得
                const threadGroup = await transactionalEntityManager.findOneOrFail(ThreadGroupEntity, {
                    where: { tenantKey: req.info.user.tenantKey, id: thread.threadGroupId }
                });

                // プロジェクトの取得と権限チェック
                const project = await transactionalEntityManager.findOneOrFail(ProjectEntity, {
                    where: { tenantKey: req.info.user.tenantKey, id: threadGroup.projectId }
                });

                const teamMember = await transactionalEntityManager.findOne(TeamMemberEntity, {
                    where: {
                        tenantKey: req.info.user.tenantKey,
                        teamId: project.teamId,
                        userId: req.info.user.id
                    }
                });

                if (!teamMember || (teamMember.role !== TeamMemberRoleType.Owner && teamMember.role !== TeamMemberRoleType.Member)) {
                    throw new Error('このスレッドにメッセージを作成または更新する権限がありません');
                }

                let newMessageGroup: MessageGroupEntity;

                if (id) {
                    // 更新の場合
                    const orgMessageGroup = await transactionalEntityManager.findOneOrFail(MessageGroupEntity, {
                        where: { tenantKey: req.info.user.tenantKey, id }
                    });

                    if (applyType === 'insert') {
                        // messageGroupの更新の場合、新規扱いで、もともとのデータの一部を引き継ぐ
                        // updatedAt、id、createdAt等はnullの状態じゃないとsaveしたときに正しい値が入らないので
                        newMessageGroup = new MessageGroupEntity();
                        newMessageGroup.threadId = orgMessageGroup.threadId;
                        newMessageGroup.previousMessageGroupId = orgMessageGroup.previousMessageGroupId; // 変えちゃダメなので新規の時だけセット
                        newMessageGroup.tenantKey = req.info.user.tenantKey;
                        newMessageGroup.createdBy = req.info.user.id;
                        newMessageGroup.createdIp = req.info.ip;
                    } else {
                        // updateの場合はそのまま更新掛ける
                        newMessageGroup = orgMessageGroup;
                    }
                } else {
                    // 新規作成の場合
                    newMessageGroup = new MessageGroupEntity();
                    newMessageGroup.threadId = threadId;
                    newMessageGroup.previousMessageGroupId = previousMessageGroupId; // 変えちゃダメなので新規の時だけセット
                    newMessageGroup.tenantKey = req.info.user.tenantKey;
                    newMessageGroup.createdBy = req.info.user.id;
                    newMessageGroup.createdIp = req.info.ip;
                }
                newMessageGroup.type = type;
                newMessageGroup.role = role;
                newMessageGroup.source = 'user';
                newMessageGroup.updatedBy = req.info.user.id;
                newMessageGroup.updatedIp = req.info.ip;
                if (targetType === 'message-group') {
                    if (applyType === 'insert') {
                        // 通常
                    } else if (applyType === 'update') {
                        // これはダメじゃね？
                    }
                } else if (targetType === 'message') {
                    // ターゲットがメッセージだけの場合は別メソッドに分けた方が良い
                    throw new Error('メッセージの更新は別のエンドポイントを使ってください');
                    if (applyType === 'insert') {
                    } else if (applyType === 'update') {
                    }
                }

                let savedMessageGroup = await transactionalEntityManager.save(MessageGroupEntity, newMessageGroup);
                // if (!id && applyType === 'insert') {
                //     // 完全な新規なので、editedRootMessageGroupIdを更新
                //     savedMessageGroup.editedRootMessageGroupId = savedMessageGroup.id;
                //     savedMessageGroup = await transactionalEntityManager.save(MessageGroupEntity, savedMessageGroup);
                // } else { }

                const savedMessages = await Promise.all(messages.map(async srcMessage => {

                    let newMessage: MessageEntity;
                    let editedRootMessageId: string = '';
                    if (srcMessage.id) {
                        // 更新の場合
                        const orgMessage = await transactionalEntityManager.findOneOrFail(MessageEntity, {
                            where: { tenantKey: req.info.user.tenantKey, id: srcMessage.id, messageGroupId: id },
                        });

                        const orgMessageGroup = await transactionalEntityManager.findOneOrFail(MessageGroupEntity, {
                            where: { tenantKey: req.info.user.tenantKey, id: orgMessage.messageGroupId }
                        });

                        if (orgMessageGroup.threadId !== threadId) {
                            throw new Error(`指定されたメッセージは、このスレッドに属していません ${orgMessageGroup.threadId}!=${threadId}`);
                        }

                        if (orgMessageGroup.id !== id) {
                            throw new Error(`指定されたメッセージグループは存在しません ${orgMessageGroup.id}!=${id}`);
                        }

                        // Messageの更新
                        if (applyType === 'insert') {
                            // messageの更新の場合、新規扱いなのでid, createdAtを消す
                            newMessage = new MessageEntity();
                            newMessage.editedRootMessageId = orgMessage.id;
                            newMessage.subSeq = orgMessage.subSeq; // subSeqは変更禁止なので新規の時だけセット
                            newMessage.tenantKey = req.info.user.tenantKey;
                            newMessage.createdBy = req.info.user.id;
                            newMessage.createdIp = req.info.ip;
                        } else {
                            // updateの場合はそのまま更新掛ける
                            newMessage = orgMessage;
                        }
                    } else {
                        // 新規作成の場合
                        newMessage = new MessageEntity();
                        newMessage.subSeq = srcMessage.subSeq; // subSeqは変更禁止なので新規の時だけセット
                        newMessage.tenantKey = req.info.user.tenantKey;
                        newMessage.createdBy = req.info.user.id;
                        newMessage.createdIp = req.info.ip;
                    }
                    newMessage.cacheId = srcMessage.cacheId;
                    newMessage.label = srcMessage.contents.find(content => content.type === ContentPartType.TEXT)?.text.substring(0, 250) || srcMessage.label;
                    newMessage.updatedBy = req.info.user.id;
                    newMessage.updatedIp = req.info.ip;

                    newMessage.messageGroupId = savedMessageGroup.id;
                    let savedMessage = await transactionalEntityManager.save(MessageEntity, newMessage);
                    if (!srcMessage.id && applyType === 'insert') {
                        // 完全な新規なので、editedRootMessageIdを更新
                        savedMessage.editedRootMessageId = savedMessage.id;
                        savedMessage = await transactionalEntityManager.save(MessageEntity, savedMessage);
                    }

                    // 既存のContentPartsを取得（更新の場合）
                    const existingContentParts = await (srcMessage.id
                        ? transactionalEntityManager.find(ContentPartEntity, {
                            where: { tenantKey: req.info.user.tenantKey, messageId: srcMessage.id },
                            order: { seq: 'ASC' }
                        })
                        : Promise.resolve([] as ContentPartEntity[]));

                    // ContentPartの作成、更新、削除
                    const updatedContentParts = await Promise.all((srcMessage.contents as ContentPartEntity[]).map(async (content, index) => {

                        let contentPart = existingContentParts.find(cp => cp.id === content.id) as ContentPartEntity;
                        // if (contentPart && content.id) {
                        //     // 既存のContentPartを更新
                        // } else {
                        // }
                        // 新しいContentPartを作成
                        contentPart = new ContentPartEntity();
                        contentPart.messageId = savedMessage.id;
                        contentPart.tenantKey = req.info.user.tenantKey;
                        contentPart.createdBy = req.info.user.id;
                        contentPart.createdIp = req.info.ip;

                        contentPart.type = content.type;
                        contentPart.updatedBy = req.info.user.id;
                        contentPart.updatedIp = req.info.ip;

                        // seqは全体通番なので無編集にする
                        // contentPart.seq = index + 1;

                        switch (content.type) {
                            case ContentPartType.TEXT:
                                // textはファイル無しなので無視
                                contentPart.text = content.text;
                                break;
                            case ContentPartType.BASE64:
                                // base64のまま来てしまうのはおかしい。事前に登録されているべき。
                                break;
                            case ContentPartType.URL:
                                // TODO インターネットからコンテンツ取ってくる。後回し
                                break;
                            case ContentPartType.STORE:
                                // gs:// のファイル。
                                break;
                            case ContentPartType.FILE:
                                // fileは登録済みなので無視
                                contentPart.text = content.text;
                                contentPart.linkId = content.linkId;
                                break;
                        }
                        contentPart = await transactionalEntityManager.save(ContentPartEntity, contentPart);
                        return contentPart;
                    }));

                    // トークンカウントの更新
                    await geminiCountTokensByContentPart(transactionalEntityManager, updatedContentParts);

                    // 不要になったContentPartsを削除
                    const contentPartIdsToKeep = updatedContentParts.map(cp => cp.id);
                    await transactionalEntityManager.delete(ContentPartEntity, {
                        tenantKey: req.info.user.tenantKey,
                        messageId: savedMessage.id,
                        id: Not(In(contentPartIdsToKeep))
                    });

                    // console.log('updatedContentParts', updatedContentParts);
                    // console.log('savedMessage', savedMessage);
                    return {
                        ...savedMessage,
                        contents: updatedContentParts,
                    };
                }));
                // console.log('messageGroup', messageGroup);
                // レスポンスの構築
                const response = {
                    ...savedMessageGroup,
                    messages: savedMessages,
                };
                return response;
            });

            res.status(applyType === 'update' ? 200 : 201).json(result);
        } catch (error) {
            console.error('Error upserting message with contents:', JSON.stringify(error, Utils.genJsonSafer()) === '{}' ? error : JSON.stringify(error, Utils.genJsonSafer()));
            if (error instanceof EntityNotFoundError) {
                res.status(404).json({ message: '指定されたスレッド、プロジェクト、またはメッセージが見つかりません' });
            } else if ((error as any).message === 'このスレッドにメッセージを作成または更新する権限がありません') {
                res.status(403).json({ message: (error as any).message });
            } else if ((error as any).message === '指定されたメッセージは、このスレッドに属していません') {
                res.status(400).json({ message: (error as any).message });
            } else {
                res.status(500).json({ message: 'メッセージの作成または更新中にエラーが発生しました' });
            }
        }
    }
];



/**
 * [user認証] メッセージ、コンテンツの編集（システムプロンプト以外は使わない）
 */
export const editMessageWithContents = [
    param('messageId').isUUID(), // as messageId
    body('contents').isArray(),
    body('contents.*.id').optional().isUUID(),
    body('contents.*.type').isIn(Object.values(ContentPartType)),
    body('contents.*.text').notEmpty(),
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;

        const { contents } = req.body as { contents: { id: string | undefined, type: ContentPartType, text: string, linkId?: string }[] };
        const { messageId } = req.params as { messageId: string };

        try {
            const result = await ds.transaction(async transactionalEntityManager => {
                // 更新の場合
                const orgMessage = await transactionalEntityManager.findOneOrFail(MessageEntity, {
                    where: { tenantKey: req.info.user.tenantKey, id: messageId },
                });

                // メッセージグループの確認
                const messageGroup = await transactionalEntityManager.findOneOrFail(MessageGroupEntity, {
                    where: { tenantKey: req.info.user.tenantKey, id: orgMessage.messageGroupId }
                });

                // スレッドの存在確認
                const thread = await transactionalEntityManager.findOneOrFail(ThreadEntity, {
                    where: { tenantKey: req.info.user.tenantKey, id: messageGroup.threadId, status: Not(ThreadStatus.Deleted) }
                });

                // スレッドグループの取得
                const threadGroup = await transactionalEntityManager.findOneOrFail(ThreadGroupEntity, {
                    where: { tenantKey: req.info.user.tenantKey, id: thread.threadGroupId }
                });

                // プロジェクトの取得と権限チェック
                const project = await transactionalEntityManager.findOneOrFail(ProjectEntity, {
                    where: { tenantKey: req.info.user.tenantKey, id: threadGroup.projectId }
                });

                const teamMember = await transactionalEntityManager.findOne(TeamMemberEntity, {
                    where: {
                        tenantKey: req.info.user.tenantKey,
                        teamId: project.teamId,
                        userId: req.info.user.id
                    }
                });

                if (!teamMember || (teamMember.role !== TeamMemberRoleType.Owner && teamMember.role !== TeamMemberRoleType.Member)) {
                    throw new Error('このスレッドにメッセージを作成または更新する権限がありません');
                }

                // 既存のContentPartsを取得（更新の場合）
                const existingContentParts = await transactionalEntityManager.find(ContentPartEntity, {
                    where: { tenantKey: req.info.user.tenantKey, messageId: messageId },
                    order: { seq: 'ASC' }
                });

                let label = '';
                // ContentPartの作成、更新、削除
                const updatedContentParts = await Promise.all((contents).map(async (content, index) => {

                    let contentPart = existingContentParts.find(cp => cp.id === content.id) as ContentPartEntity;
                    // if (contentPart && content.id) {
                    //     // 既存のContentPartを更新
                    // } else {
                    // }
                    // 新しいContentPartを作成
                    contentPart = new ContentPartEntity();
                    contentPart.messageId = messageId;
                    contentPart.tenantKey = req.info.user.tenantKey;
                    contentPart.createdBy = req.info.user.id;
                    contentPart.createdIp = req.info.ip;

                    contentPart.type = content.type;
                    contentPart.updatedBy = req.info.user.id;
                    contentPart.updatedIp = req.info.ip;

                    // seqは全体通番なので無編集にする
                    // contentPart.seq = index + 1;

                    switch (content.type) {
                        case ContentPartType.TEXT:
                            // textはファイル無しなので無視
                            contentPart.text = content.text;
                            label = (label + content.text).substring(0, 200);
                            break;
                        case ContentPartType.BASE64:
                            // base64のまま来てしまうのはおかしい。事前に登録されているべき。
                            break;
                        case ContentPartType.URL:
                            // TODO インターネットからコンテンツ取ってくる。後回し
                            break;
                        case ContentPartType.STORE:
                            // gs:// のファイル。
                            break;
                        case ContentPartType.FILE:
                            // fileは登録済みなので無視
                            contentPart.text = content.text;
                            contentPart.linkId = content.linkId;
                            break;
                    }
                    contentPart = await transactionalEntityManager.save(ContentPartEntity, contentPart);
                    return contentPart;
                }));

                // 不要になったContentPartsを削除
                const contentPartIdsToKeep = updatedContentParts.map(cp => cp.id);
                await transactionalEntityManager.delete(ContentPartEntity, {
                    tenantKey: req.info.user.tenantKey,
                    messageId: messageId,
                    id: Not(In(contentPartIdsToKeep))
                });

                // messageのラベルを更新
                orgMessage.updatedBy = req.info.user.id;
                orgMessage.updatedIp = req.info.ip;
                orgMessage.label = label;
                const savedMessage = await transactionalEntityManager.save(MessageEntity, orgMessage);

                return {
                    ...savedMessage,
                    contents: updatedContentParts,
                };
            });

            res.status(200).json(result);
        } catch (error) {
            console.error('Error upserting message with contents:', JSON.stringify(error, Utils.genJsonSafer()) === '{}' ? error : JSON.stringify(error, Utils.genJsonSafer()));
            if (error instanceof EntityNotFoundError) {
                res.status(404).json({ message: '指定されたスレッド、プロジェクト、またはメッセージが見つかりません' });
            } else if ((error as any).message === 'このスレッドにメッセージを作成または更新する権限がありません') {
                res.status(403).json({ message: (error as any).message });
            } else if ((error as any).message === '指定されたメッセージは、このスレッドに属していません') {
                res.status(400).json({ message: (error as any).message });
            } else {
                res.status(500).json({ message: 'メッセージの作成または更新中にエラーが発生しました' });
            }
        }
    }
];

/**
 * [user認証] スレッドのクローン
 */
export const threadCloneCore = async (req: UserRequest, transactionalEntityManager: EntityManager, threadId: string, targetThreadGroupId: string): Promise<ThreadEntity> => {
    const thread = await transactionalEntityManager.findOneOrFail(ThreadEntity, { where: { tenantKey: req.info.user.tenantKey, id: threadId } });
    // const threadGroup = await transactionalEntityManager.findOneOrFail(ThreadGroupEntity, { where: { id: thread.threadGroupId } });
    // const project = await transactionalEntityManager.findOneOrFail(ProjectEntity, { where: { id: threadGroup.projectId } });

    const newThread = new ThreadEntity();
    newThread.threadGroupId = targetThreadGroupId;
    newThread.inDtoJson = thread.inDtoJson;
    newThread.status = ThreadStatus.Normal; // 新規スレッドは常にNormal
    newThread.tenantKey = req.info.user.tenantKey;
    newThread.createdBy = req.info.user.id;
    newThread.updatedBy = req.info.user.id;
    newThread.createdIp = req.info.ip;
    newThread.updatedIp = req.info.ip;

    const savedThread = await transactionalEntityManager.save(ThreadEntity, newThread);

    const idRemapTable: {
        messageGroup: { [oldId: string]: string },
        message: { [oldId: string]: string },
        contentPart: { [oldId: string]: string },
        cache: { [oldId: string]: string },
        transaction: { [oldId: string]: string },
    } = { messageGroup: {}, message: {}, contentPart: {}, cache: {}, transaction: {} };
    const messageGroups = await transactionalEntityManager.find(MessageGroupEntity, { where: { tenantKey: req.info.user.tenantKey, threadId }, order: { seq: 'ASC' } });

    const savedObjects: { messageGroups: MessageGroupEntity[], messages: MessageEntity[], contentParts: ContentPartEntity[] } = { messageGroups: [], messages: [], contentParts: [] };

    for (const messageGroup of messageGroups) {
        const newMessageGroup = new MessageGroupEntity();
        newMessageGroup.threadId = savedThread.id;
        newMessageGroup.type = messageGroup.type;
        newMessageGroup.seq = messageGroup.seq;
        if (messageGroup.previousMessageGroupId) {
            newMessageGroup.previousMessageGroupId = idRemapTable.messageGroup[messageGroup.previousMessageGroupId];
        } else { }
        newMessageGroup.role = messageGroup.role;
        newMessageGroup.source = messageGroup.source;
        // newMessageGroup.editedRootMessageGroupId = messageGroup.editedRootMessageGroupId;
        newMessageGroup.tenantKey = req.info.user.tenantKey;
        newMessageGroup.createdBy = req.info.user.id;
        newMessageGroup.updatedBy = req.info.user.id;
        newMessageGroup.createdIp = req.info.ip;
        newMessageGroup.updatedIp = req.info.ip;

        const savedMessageGroup = await transactionalEntityManager.save(MessageGroupEntity, newMessageGroup);
        idRemapTable.messageGroup[messageGroup.id] = savedMessageGroup.id;
        savedObjects.messageGroups.push(savedMessageGroup);

        // TODO cacheIdもコピーするべきかもしれないが、一旦除外。
        const messages = await transactionalEntityManager.find(MessageEntity, { where: { tenantKey: req.info.user.tenantKey, messageGroupId: messageGroup.id } });
        for (const message of messages) {
            const newMessage = new MessageEntity();
            newMessage.messageGroupId = savedMessageGroup.id;
            // newMessage.seq = message.seq;
            newMessage.subSeq = message.subSeq;
            newMessage.cacheId = message.cacheId;
            newMessage.label = message.label;
            if (message.editedRootMessageId) {
                newMessage.editedRootMessageId = idRemapTable.message[message.editedRootMessageId];
            } else { }
            newMessage.tenantKey = req.info.user.tenantKey;
            newMessage.createdBy = req.info.user.id;
            newMessage.updatedBy = req.info.user.id;
            newMessage.createdIp = req.info.ip;
            newMessage.updatedIp = req.info.ip;

            if (message.cacheId) {
                // キャッシュあり
                if (idRemapTable.cache[message.cacheId]) {
                    // キャッシュコピー済み
                } else {
                    // キャッシュコピー
                    const vertexCachedContent = new VertexCachedContentEntity();
                    const cache = await transactionalEntityManager.findOneOrFail(VertexCachedContentEntity, { where: { tenantKey: req.info.user.tenantKey, id: message.cacheId } });
                    vertexCachedContent.id = cache.id;
                    vertexCachedContent.modelAlias = cache.modelAlias;
                    vertexCachedContent.location = cache.location;
                    vertexCachedContent.projectId = cache.projectId;
                    vertexCachedContent.title = cache.title;
                    vertexCachedContent.description = cache.description;
                    vertexCachedContent.name = cache.name;
                    vertexCachedContent.model = cache.model;
                    vertexCachedContent.createTime = cache.createTime;
                    vertexCachedContent.updateTime = cache.updateTime;
                    vertexCachedContent.expireTime = cache.expireTime;
                    vertexCachedContent.totalBillableCharacters = cache.totalBillableCharacters;
                    vertexCachedContent.totalTokens = cache.totalTokens;
                    vertexCachedContent.audio = cache.audio;
                    vertexCachedContent.image = cache.image;
                    vertexCachedContent.text = cache.text;
                    vertexCachedContent.video = cache.video;
                    vertexCachedContent.usage = cache.usage;
                    vertexCachedContent.tenantKey = req.info.user.tenantKey;
                    vertexCachedContent.createdBy = req.info.user.id;
                    vertexCachedContent.updatedBy = req.info.user.id;
                    vertexCachedContent.createdIp = req.info.ip;
                    vertexCachedContent.updatedIp = req.info.ip;

                    const savedVertexCachedContent = await transactionalEntityManager.save(VertexCachedContentEntity, vertexCachedContent);
                    idRemapTable.cache[message.cacheId] = savedVertexCachedContent.id;
                }
                newMessage.cacheId = idRemapTable.cache[message.cacheId];
            } else { /** キャッシュ無し */ }

            const savedMessage = await transactionalEntityManager.save(MessageEntity, newMessage);
            idRemapTable.message[message.id] = savedMessage.id;
            savedObjects.messages.push(savedMessage);

            const contentParts = await transactionalEntityManager.find(ContentPartEntity, { where: { tenantKey: req.info.user.tenantKey, messageId: message.id } });
            for (const contentPart of contentParts) {
                const newContentPart = new ContentPartEntity();
                // newContentPart.seq = contentPart.seq;
                newContentPart.messageId = savedMessage.id;
                newContentPart.type = contentPart.type;
                newContentPart.text = contentPart.text;
                newContentPart.tenantKey = req.info.user.tenantKey;
                newContentPart.createdBy = req.info.user.id;
                newContentPart.updatedBy = req.info.user.id;
                newContentPart.createdIp = req.info.ip;
                newContentPart.updatedIp = req.info.ip;

                if (contentPart.linkId) {
                    // ファイルあり
                    if (idRemapTable.contentPart[contentPart.linkId]) {
                        // ファイルコピー済み
                    } else {
                        // ファイルコピー
                        const fileGroup = await transactionalEntityManager.findOneOrFail(FileGroupEntity, { where: { tenantKey: req.info.user.tenantKey, id: contentPart.linkId } });
                        const newFileGroup = new FileGroupEntity();
                        newFileGroup.description = fileGroup.description;
                        newFileGroup.label = fileGroup.label;
                        newFileGroup.uploadedBy = fileGroup.uploadedBy;
                        newFileGroup.type = fileGroup.type;
                        newFileGroup.projectId = fileGroup.projectId;
                        newFileGroup.tenantKey = req.info.user.tenantKey;
                        newFileGroup.createdBy = req.info.user.id;
                        newFileGroup.updatedBy = req.info.user.id;
                        newFileGroup.createdIp = req.info.ip;
                        newFileGroup.updatedIp = req.info.ip;
                        const savedFileGroup = await transactionalEntityManager.save(FileGroupEntity, newFileGroup);
                        idRemapTable.contentPart[fileGroup.id] = savedFileGroup.id;
                        const fileList = await transactionalEntityManager.find(FileEntity, { where: { fileGroupId: fileGroup.id } });
                        for (const file of fileList) {
                            const fileBodyEntity = await transactionalEntityManager.findOneOrFail(FileBodyEntity, { where: { tenantKey: req.info.user.tenantKey, id: file.fileBodyId } });

                            const newFile = new FileEntity();
                            newFile.fileGroupId = savedFileGroup.id;
                            newFile.fileName = file.fileName;
                            newFile.filePath = file.filePath;
                            newFile.isActive = isActiveFile(fileBodyEntity.fileType, file.filePath, file.fileName);
                            newFile.projectId = file.projectId;
                            newFile.uploadedBy = file.uploadedBy;
                            newFile.fileBodyId = file.fileBodyId;
                            newFile.tenantKey = req.info.user.tenantKey;
                            newFile.createdBy = req.info.user.id;
                            newFile.updatedBy = req.info.user.id;
                            newFile.createdIp = req.info.ip;
                            newFile.updatedIp = req.info.ip;
                            const savedFile = await transactionalEntityManager.save(FileEntity, newFile);
                            idRemapTable.contentPart[file.id] = savedFile.id;
                        }
                    }
                    newContentPart.linkId = idRemapTable.contentPart[contentPart.linkId];
                } else { /** ファイル無し */ }

                const savedContentPart = await transactionalEntityManager.save(ContentPartEntity, newContentPart);
                idRemapTable.contentPart[contentPart.id] = savedContentPart.id;
                savedObjects.contentParts.push(savedContentPart);
            }
        }
    }
    // // idリマップ：メッセージグループ
    // for (const messageGroup of savedObjects.messageGroups) {
    //     if (messageGroup.previousMessageGroupId) {
    //         messageGroup.previousMessageGroupId = idRemapTable.messageGroup[messageGroup.previousMessageGroupId];
    //     } else { }
    // }
    // // idリマップ：メッセージ
    // for (const message of savedObjects.messages) {
    //     message.messageGroupId = idRemapTable.messageGroup[message.messageGroupId];
    //     if (message.editedRootMessageId) {
    //         message.editedRootMessageId = idRemapTable.message[message.editedRootMessageId];
    //     } else { }
    // }
    // // idリマップ：コンテンツ
    // for (const contentPart of savedObjects.contentParts) {
    //     contentPart.messageId = idRemapTable.message[contentPart.messageId];
    // }
    return savedThread;
}

/**
 * [user認証] スレッドのクローン
 */
export const threadClone = [
    param('threadId').isUUID().notEmpty(),
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        const { threadId } = req.params;

        try {
            const result = await ds.transaction(async transactionalEntityManager => {
                const thread = await transactionalEntityManager.findOneOrFail(ThreadEntity, { where: { tenantKey: req.info.user.tenantKey, id: threadId } });
                const threadGroup = await transactionalEntityManager.findOneOrFail(ThreadGroupEntity, { where: { tenantKey: req.info.user.tenantKey, id: thread.threadGroupId } });
                // アクセス権限チェック
                const project = await transactionalEntityManager.findOneOrFail(ProjectEntity, { where: { tenantKey: req.info.user.tenantKey, id: threadGroup.projectId } });
                const teamMember = await transactionalEntityManager.findOne(TeamMemberEntity, { where: { tenantKey: req.info.user.tenantKey, teamId: project.teamId, userId: req.info.user.id } });
                if (!teamMember || ([TeamMemberRoleType.Owner, TeamMemberRoleType.Admin, TeamMemberRoleType.Maintainer, TeamMemberRoleType.Member].indexOf(teamMember.role) === -1)) {
                    throw new Error('このスレッドにメッセージを作成または更新する権限がありません');
                }

                // スレッドのクローン
                return await threadCloneCore(req, transactionalEntityManager, threadId, threadGroup.id);
            });
            res.status(200).json(result);
        } catch (error) {
            console.error('Error cloning thread:', JSON.stringify(error, Utils.genJsonSafer()) === '{}' ? error : JSON.stringify(error, Utils.genJsonSafer()));
            if (error instanceof EntityNotFoundError) {
                res.status(404).json({ message: '指定されたスレッドが見つかりません' });
            } else {
                res.status(500).json({ message: 'スレッドのクローン中にエラーが発生しました' });
            }
        }
    }
];

/**
 * [user認証] スレッドグループのクローン
 */
export const threadGroupClone = [
    param('threadGroupId').isUUID().notEmpty(),
    body('type').optional().isIn(Object.values(ThreadGroupType)),
    body('title').optional().isString(),
    body('description').optional().isString(),
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        const { threadGroupId } = req.params;
        const { type, title, description } = req.body as { type: ThreadGroupType, title: string, description: string };

        try {
            const result = await ds.transaction(async transactionalEntityManager => {
                const threadGroup = await transactionalEntityManager.findOneOrFail(ThreadGroupEntity, { where: { tenantKey: req.info.user.tenantKey, id: threadGroupId } });
                // アクセス権限チェック
                const project = await transactionalEntityManager.findOneOrFail(ProjectEntity, { where: { tenantKey: req.info.user.tenantKey, id: threadGroup.projectId } });
                const teamMember = await transactionalEntityManager.findOne(TeamMemberEntity, { where: { tenantKey: req.info.user.tenantKey, teamId: project.teamId, userId: req.info.user.id } });
                if (!teamMember || ([TeamMemberRoleType.Owner, TeamMemberRoleType.Admin, TeamMemberRoleType.Maintainer, TeamMemberRoleType.Member].indexOf(teamMember.role) === -1)) {
                    throw new Error('このスレッドにメッセージを作成または更新する権限がありません');
                }

                // スレッドグループのクローン
                const newThreadGroup = new ThreadGroupEntity();
                newThreadGroup.projectId = project.id;
                newThreadGroup.type = type || threadGroup.type;
                newThreadGroup.title = title || threadGroup.title;
                newThreadGroup.description = description || threadGroup.description;
                newThreadGroup.status = ThreadGroupStatus.Normal; // 新規スレッドグループは常にNormal
                newThreadGroup.tenantKey = req.info.user.tenantKey;
                newThreadGroup.createdBy = req.info.user.id;
                newThreadGroup.updatedBy = req.info.user.id;
                newThreadGroup.createdIp = req.info.ip;
                newThreadGroup.updatedIp = req.info.ip;
                const savedThreadGroup = await transactionalEntityManager.save(ThreadGroupEntity, newThreadGroup);

                const threadList = await transactionalEntityManager.find(ThreadEntity, { where: { tenantKey: req.info.user.tenantKey, threadGroupId } });
                const threadCloneList = await Promise.all(threadList.map(async thread => {
                    return await threadCloneCore(req, transactionalEntityManager, thread.id, savedThreadGroup.id);
                }));

                (savedThreadGroup as (ThreadGroupEntity & { threadList: ThreadEntity[] })).threadList = threadCloneList;

                return savedThreadGroup;
            });
            res.status(200).json(result);
        } catch (error) {
            console.error('Error cloning thread:', JSON.stringify(error, Utils.genJsonSafer()) === '{}' ? error : JSON.stringify(error, Utils.genJsonSafer()));
            if (error instanceof EntityNotFoundError) {
                res.status(404).json({ message: '指定されたスレッドが見つかりません' });
            } else {
                res.status(500).json({ message: 'スレッドのクローン中にエラーが発生しました' });
            }
        }
    }
];

/**
 * [user認証] メッセージ、コンテンツの作成または更新
 */
export const updateMessageOrMessageGroupTimestamp = [
    param('type').isIn(['message', 'message-group']).notEmpty(),
    param('id').isUUID().notEmpty(),
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        const { type, id } = req.params;

        try {
            const result = await ds.transaction(async transactionalEntityManager => {
                if (type === 'message') {
                    // メッセージの存在確認
                    const message = await transactionalEntityManager.findOneOrFail(MessageEntity, {
                        where: { tenantKey: req.info.user.tenantKey, id }
                    });

                    // メッセージグループの存在確認
                    const messageGroup = await transactionalEntityManager.findOneOrFail(MessageGroupEntity, {
                        where: { tenantKey: req.info.user.tenantKey, id: message.messageGroupId }
                    });

                    // スレッドの存在確認
                    const thread = await transactionalEntityManager.findOneOrFail(ThreadEntity, {
                        where: { tenantKey: req.info.user.tenantKey, id: messageGroup.threadId, status: Not(ThreadStatus.Deleted) }
                    });

                    // スレッドグループの存在確認
                    const threadGroup = await transactionalEntityManager.findOneOrFail(ThreadGroupEntity, {
                        where: { tenantKey: req.info.user.tenantKey, id: thread.threadGroupId }
                    });

                    // プロジェクトの取得と権限チェック
                    const project = await transactionalEntityManager.findOneOrFail(ProjectEntity, {
                        where: { tenantKey: req.info.user.tenantKey, id: threadGroup.projectId }
                    });

                    // チームメンバーの存在確認
                    const teamMember = await transactionalEntityManager.findOne(TeamMemberEntity, {
                        where: {
                            tenantKey: req.info.user.tenantKey,
                            teamId: project.teamId,
                            userId: req.info.user.id
                        }
                    });

                    if (!teamMember || (teamMember.role !== TeamMemberRoleType.Owner && teamMember.role !== TeamMemberRoleType.Member)) {
                        throw new Error('このスレッドにメッセージを作成または更新する権限がありません');
                    } else { }

                    message.updatedBy = req.info.user.id;
                    message.updatedIp = req.info.ip;
                    const updatedMessage = await transactionalEntityManager.save(MessageEntity, message);
                    return updatedMessage;
                } else if (type === 'message-group') {
                    // メッセージグループの存在確認
                    const messageGroup = await transactionalEntityManager.findOneOrFail(MessageGroupEntity, {
                        where: { tenantKey: req.info.user.tenantKey, id }
                    });

                    // スレッドの存在確認
                    const thread = await transactionalEntityManager.findOneOrFail(ThreadEntity, {
                        where: { tenantKey: req.info.user.tenantKey, id: messageGroup.threadId, status: Not(ThreadStatus.Deleted) }
                    });

                    // スレッドグループの存在確認
                    const threadGroup = await transactionalEntityManager.findOneOrFail(ThreadGroupEntity, {
                        where: { tenantKey: req.info.user.tenantKey, id: thread.threadGroupId }
                    });

                    // プロジェクトの取得と権限チェック
                    const project = await transactionalEntityManager.findOneOrFail(ProjectEntity, {
                        where: { tenantKey: req.info.user.tenantKey, id: threadGroup.projectId }
                    });

                    // チームメンバーの存在確認
                    const teamMember = await transactionalEntityManager.findOne(TeamMemberEntity, {
                        where: {
                            tenantKey: req.info.user.tenantKey,
                            teamId: project.teamId,
                            userId: req.info.user.id
                        }
                    });

                    if (!teamMember || (teamMember.role !== TeamMemberRoleType.Owner && teamMember.role !== TeamMemberRoleType.Member)) {
                        throw new Error('このスレッドにメッセージを作成または更新する権限がありません');
                    } else { }

                    messageGroup.updatedBy = req.info.user.id;
                    messageGroup.updatedIp = req.info.ip;
                    messageGroup.touchCounter++;
                    const updatedMessageGroup = await transactionalEntityManager.save(MessageGroupEntity, messageGroup);
                    return updatedMessageGroup;
                }
            });
            res.status(200).json(result);
        } catch (error) {
            console.error('Error upserting message with contents:', JSON.stringify(error, Utils.genJsonSafer()) === '{}' ? error : JSON.stringify(error, Utils.genJsonSafer()));
            if (error instanceof EntityNotFoundError) {
                res.status(404).json({ message: '指定されたスレッド、プロジェクト、またはメッセージが見つかりません' });
            } else if ((error as any).message === 'このスレッドにメッセージを作成または更新する権限がありません') {
                res.status(403).json({ message: (error as any).message });
            } else if ((error as any).message === '指定されたメッセージは、このスレッドに属していません') {
                res.status(400).json({ message: (error as any).message });
            } else {
                res.status(500).json({ message: 'メッセージの作成または更新中にエラーが発生しました' });
            }
        }
    }
];

/**
 * [user認証] スレッド内のメッセージグループリスト取得
 */
export const getMessageGroupList = [
    param('threadGroupId').notEmpty().isUUID(),
    query('page').optional().isInt({ min: 1 }).toInt(),
    query('limit').optional().isInt({ min: 1, max: 1000 }).toInt(),
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        const { threadGroupId } = req.params;
        const page = req.query.page ? parseInt(req.query.page as string) : 1;
        const limit = req.query.limit ? parseInt(req.query.limit as string) : 20;

        try {
            // スレッドグループの取得
            const threadGroup = await ds.getRepository(ThreadGroupEntity).findOneOrFail({
                where: { tenantKey: req.info.user.tenantKey, id: threadGroupId, status: Not(ThreadGroupStatus.Deleted) }
            });

            // スレッドの存在確認
            const threads = await ds.getRepository(ThreadEntity).find({
                where: { tenantKey: req.info.user.tenantKey, threadGroupId, status: Not(ThreadStatus.Deleted) }
            });

            if (threads.length === 0) {
                throw new EntityNotFoundError(ThreadEntity, threadGroupId);
            }

            // プロジェクトの取得
            const project = await ds.getRepository(ProjectEntity).findOneOrFail({
                where: { tenantKey: req.info.user.tenantKey, id: threadGroup.projectId }
            });

            const teamMember = await ds.getRepository(TeamMemberEntity).findOne({
                where: {
                    tenantKey: req.info.user.tenantKey,
                    teamId: project.teamId,
                    userId: req.info.user.id
                }
            });

            if (!teamMember && project.visibility !== ProjectVisibility.Public) {
                throw new Error('このスレッドのメッセージを閲覧する権限がありません');
            }

            // メッセージグループを取得
            const [messageGroups, total] = await ds.getRepository(MessageGroupEntity).findAndCount({
                where: { tenantKey: req.info.user.tenantKey, threadId: In(threads.map(t => t.id)) },
                order: { seq: 'ASC' },
                skip: (page - 1) * limit,
                take: limit,
                // select: ['id', 'type', 'role', 'label', 'parentId', 'createdAt', 'updatedAt'],
            });

            // console.log('messageGroups:', messageGroups);
            // メッセージグループIDのリストを作成
            const messageGroupIds = messageGroups.map(group => group.id);

            // 関連するメッセージを一括で取得
            const messages = await ds.getRepository(MessageEntity).find({
                where: { tenantKey: req.info.user.tenantKey, messageGroupId: In(messageGroupIds) },
                order: { seq: 'ASC' },
                // select: ['id', 'messageGroupId', 'label', 'createdAt', 'updatedAt']
            });

            // メッセージグループとメッセージを結合
            const messageGroupsWithMessageInfo = messageGroups.map(group => {
                const relatedMessages = messages.filter(message => message.messageGroupId === group.id);
                return {
                    ...group,
                    messages: relatedMessages,
                };
            });

            res.status(200).json({
                messageGroups: messageGroupsWithMessageInfo,
                total,
                page,
                limit,
                totalPages: Math.ceil(total / limit)
            });
        } catch (error) {
            console.error('Error getting message group list:', JSON.stringify(error, Utils.genJsonSafer()) === '{}' ? error : JSON.stringify(error, Utils.genJsonSafer()));
            if (error instanceof EntityNotFoundError) {
                res.status(404).json({ message: '指定されたスレッドまたはプロジェクトが見つかりません' });
            } else if ((error as any).message === 'このスレッドのメッセージを閲覧する権限がありません') {
                res.status(403).json({ message: (error as any).message });
            } else {
                res.status(500).json({ message: 'メッセージグループリストの取得中にエラーが発生しました' });
            }
        }
    }
];


/**
 * [認証なし/user認証] メッセージグループ詳細取得
 */
export const getMessageGroupDetails = [
    param('messageGroupId').notEmpty().isUUID(),
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        const { messageGroupId } = req.params;

        try {
            // メッセージグループの取得
            const messageGroup = await ds.getRepository(MessageGroupEntity).findOneOrFail({
                where: { tenantKey: req.info.user.tenantKey, id: messageGroupId },
                // select: ['id', 'threadId', 'type', 'role', 'label', 'parentId', 'createdAt', 'updatedAt']
            });

            // スレッドの取得
            const thread = await ds.getRepository(ThreadEntity).findOneOrFail({
                where: { tenantKey: req.info.user.tenantKey, id: messageGroup.threadId, status: Not(ThreadStatus.Deleted) }
            });

            // スレッドグループの取得
            const threadGroup = await ds.getRepository(ThreadGroupEntity).findOneOrFail({
                where: { tenantKey: req.info.user.tenantKey, id: thread.threadGroupId }
            });

            // プロジェクトの取得
            const project = await ds.getRepository(ProjectEntity).findOneOrFail({
                where: { tenantKey: req.info.user.tenantKey, id: threadGroup.projectId }
            });

            let hasAccess = false;

            if (project.visibility === ProjectVisibility.Public) {
                // 公開プロジェクトの場合、誰でもアクセス可能
                hasAccess = true;
            } else if (req.info && req.info.user) {
                // ユーザーが認証されている場合
                if (project.visibility === ProjectVisibility.Login) {
                    // ログインユーザー向けプロジェクトの場合、認証されていれば誰でもアクセス可能
                    hasAccess = true;
                } else {
                    // TeamプロジェクトまたはDefaultプロジェクトの場合、チームメンバーシップを確認
                    const teamMember = await ds.getRepository(TeamMemberEntity).findOne({
                        where: {
                            tenantKey: req.info.user.tenantKey,
                            teamId: project.teamId,
                            userId: req.info.user.id
                        }
                    });
                    hasAccess = !!teamMember;
                }
            }

            if (!hasAccess) {
                throw new Error('このメッセージグループの詳細を閲覧する権限がありません');
            }

            // 関連するメッセージの取得
            const message = await ds.getRepository(MessageEntity).findOne({
                where: { tenantKey: req.info.user.tenantKey, messageGroupId: messageGroupId },
                // select: ['id', 'label', 'createdAt', 'updatedAt']
            });

            if (!message) {
                throw new Error('関連するメッセージが見つかりません');
            }

            // 関連するコンテンツパーツの取得
            const contentParts = await ds.getRepository(ContentPartEntity).find({
                where: { tenantKey: req.info.user.tenantKey, messageId: message.id },
                // select: ['id', 'type', 'content', 'seq', 'createdAt', 'updatedAt'],
                order: { seq: 'ASC' }
            });

            // レスポンスの構築
            const response = {
                messageGroup: {
                    ...messageGroup,
                    message: {
                        ...message,
                        contentParts: contentParts
                    }
                }
            };

            res.status(200).json(response);
        } catch (error) {
            console.error('Error getting message group details:', JSON.stringify(error, Utils.genJsonSafer()) === '{}' ? error : JSON.stringify(error, Utils.genJsonSafer()));
            if (error instanceof EntityNotFoundError) {
                res.status(404).json({ message: '指定されたメッセージグループ、スレッド、またはプロジェクトが見つかりません' });
            } else if ((error as any).message === 'このメッセージグループの詳細を閲覧する権限がありません') {
                res.status(403).json({ message: (error as any).message });
            } else if ((error as any).message === '関連するメッセージが見つかりません') {
                res.status(404).json({ message: (error as any).message });
            } else {
                res.status(500).json({ message: 'メッセージグループ詳細の取得中にエラーが発生しました' });
            }
        }
    }
];

/**
 * [user認証] メッセージコンテンツ部分取得
 */
export const getMessageContentParts = [
    param('messageId').notEmpty().isUUID(),
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        const messageId = req.params.messageId;

        try {
            // メッセージの存在確認とスレッドID取得
            const message = await ds.getRepository(MessageEntity).findOneOrFail({
                where: { tenantKey: req.info.user.tenantKey, id: messageId }
            });

            // メッセージグループの取得
            const messageGroup = await ds.getRepository(MessageGroupEntity).findOneOrFail({
                where: { tenantKey: req.info.user.tenantKey, id: message.messageGroupId }
            });

            // スレッドの取得（プロジェクトIDを取得するため）
            const thread = await ds.getRepository(ThreadEntity).findOneOrFail({
                where: { tenantKey: req.info.user.tenantKey, id: messageGroup.threadId, status: Not(ThreadStatus.Deleted) }
            });

            // スレッドグループの取得
            const threadGroup = await ds.getRepository(ThreadGroupEntity).findOneOrFail({
                where: { tenantKey: req.info.user.tenantKey, id: thread.threadGroupId }
            });

            // プロジェクトの取得
            const project = await ds.getRepository(ProjectEntity).findOneOrFail({
                where: { tenantKey: req.info.user.tenantKey, id: threadGroup.projectId }
            });

            let hasAccess = false;

            if (project.visibility === ProjectVisibility.Public) {
                // 公開プロジェクトの場合、誰でもアクセス可能
                hasAccess = true;
            } else if (req.info && req.info.user) {
                // ユーザーが認証されている場合
                if (project.visibility === ProjectVisibility.Login) {
                    // ログインユーザー向けプロジェクトの場合、認証されていれば誰でもアクセス可能
                    hasAccess = true;
                } else {
                    // TeamプロジェクトまたはDefaultプロジェクトの場合、チームメンバーシップを確認
                    const teamMember = await ds.getRepository(TeamMemberEntity).findOne({
                        where: {
                            tenantKey: req.info.user.tenantKey,
                            teamId: project.teamId,
                            userId: req.info.user.id
                        }
                    });
                    hasAccess = !!teamMember;
                }
            }

            if (!hasAccess) {
                return res.status(403).json({ message: 'このメッセージにアクセスする権限がありません' });
            }

            // メッセージコンテンツ部分の取得
            const contentParts = await ds.getRepository(ContentPartEntity).find({
                where: { tenantKey: req.info.user.tenantKey, messageId: messageId, text: Not('') },
                order: { seq: 'ASC' }
            });

            const fileGroups = await ds.getRepository(FileGroupEntity).find({
                where: { tenantKey: req.info.user.tenantKey, id: In(contentParts.filter(contentPart => contentPart.type === ContentPartType.FILE && contentPart.linkId).map(contentPart => contentPart.linkId)) },
            });
            contentParts.forEach(contentPart => {
                if (contentPart.type === ContentPartType.FILE && contentPart.linkId) {
                    (contentPart as any).fileGroup = fileGroups.find(fileGroup => fileGroup.id === contentPart.linkId);
                } else { }
            });
            res.status(200).json(contentParts);
        } catch (error) {
            console.error('Error getting message content parts:', JSON.stringify(error, Utils.genJsonSafer()) === '{}' ? error : JSON.stringify(error, Utils.genJsonSafer()));
            if (error instanceof EntityNotFoundError) {
                res.status(404).json({ message: '指定されたメッセージが見つかりません' });
            } else {
                res.status(500).json({ message: 'メッセージコンテンツ部分の取得中にエラーが発生しました' });
            }
        }
    }
];
/**
 * [user認証] メッセージコンテンツツリー取得
 */
export const getMessageContentParts2 = [
    param('messageId').notEmpty().isUUID(),
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        const messageId = req.params.messageId;

        try {
            // メッセージの存在確認とスレッドID取得
            const message = await ds.getRepository(MessageEntity).findOneOrFail({
                where: { tenantKey: req.info.user.tenantKey, id: messageId }
            });

            // メッセージグループの取得
            const messageGroup = await ds.getRepository(MessageGroupEntity).findOneOrFail({
                where: { tenantKey: req.info.user.tenantKey, id: message.messageGroupId }
            });

            // スレッドの取得（プロジェクトIDを取得するため）
            const thread = await ds.getRepository(ThreadEntity).findOneOrFail({
                where: { tenantKey: req.info.user.tenantKey, id: messageGroup.threadId, status: Not(ThreadStatus.Deleted) }
            });

            // スレッドグループの取得
            const threadGroup = await ds.getRepository(ThreadGroupEntity).findOneOrFail({
                where: { tenantKey: req.info.user.tenantKey, id: thread.threadGroupId }
            });

            // プロジェクトの取得
            const project = await ds.getRepository(ProjectEntity).findOneOrFail({
                where: { tenantKey: req.info.user.tenantKey, id: threadGroup.projectId }
            });

            let hasAccess = false;

            if (project.visibility === ProjectVisibility.Public) {
                // 公開プロジェクトの場合、誰でもアクセス可能
                hasAccess = true;
            } else if (req.info && req.info.user) {
                // ユーザーが認証されている場合
                if (project.visibility === ProjectVisibility.Login) {
                    // ログインユーザー向けプロジェクトの場合、認証されていれば誰でもアクセス可能
                    hasAccess = true;
                } else {
                    // TeamプロジェクトまたはDefaultプロジェクトの場合、チームメンバーシップを確認
                    const teamMember = await ds.getRepository(TeamMemberEntity).findOne({
                        where: {
                            tenantKey: req.info.user.tenantKey,
                            teamId: project.teamId,
                            userId: req.info.user.id
                        }
                    });
                    hasAccess = !!teamMember;
                }
            }

            if (!hasAccess) {
                return res.status(403).json({ message: 'このメッセージにアクセスする権限がありません' });
            }

            // メッセージコンテンツ部分の取得
            const contentParts = await ds.getRepository(ContentPartEntity).find({
                where: { tenantKey: req.info.user.tenantKey, messageId: messageId },
                order: { seq: 'ASC' }
            });

            if (contentParts.length) {
                const fileIds = contentParts.filter(cp => cp.type === ContentPartType.FILE && cp.linkId).map(f => f.id);
                const fileIdListList = Utils.toChunkArray(fileIds, 1000);
                for (const fileIdList of fileIdListList) {
                    await ds.getRepository(FileEntity).find({
                        where: { tenantKey: req.info.user.tenantKey, id: In(fileIdList) },
                    });
                }
            } else { }

            res.status(200).json(contentParts);
        } catch (error) {
            console.error('Error getting message content parts:', JSON.stringify(error, Utils.genJsonSafer()) === '{}' ? error : JSON.stringify(error, Utils.genJsonSafer()));
            if (error instanceof EntityNotFoundError) {
                res.status(404).json({ message: '指定されたメッセージが見つかりません' });
            } else {
                res.status(500).json({ message: 'メッセージコンテンツ部分の取得中にエラーが発生しました' });
            }
        }
    }
];
/**
 * [user認証] メッセージグループ削除
 */
export const deleteMessageGroup = [
    param('messageGroupId').notEmpty().isUUID(),
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        const { messageGroupId } = req.params;

        try {
            let messageGroup;
            await ds.transaction(async transactionalEntityManager => {
                // メッセージグループの取得
                const messageGroup = await transactionalEntityManager.findOneOrFail(MessageGroupEntity, {
                    where: { tenantKey: req.info.user.tenantKey, id: messageGroupId }
                });

                // スレッドの取得
                const thread = await transactionalEntityManager.findOneOrFail(ThreadEntity, {
                    where: { tenantKey: req.info.user.tenantKey, id: messageGroup.threadId, status: Not(ThreadStatus.Deleted) }
                });

                // スレッドグループの取得
                const threadGroup = await transactionalEntityManager.findOneOrFail(ThreadGroupEntity, {
                    where: { tenantKey: req.info.user.tenantKey, id: thread.threadGroupId }
                });

                // プロジェクトの取得
                const project = await transactionalEntityManager.findOneOrFail(ProjectEntity, {
                    where: { tenantKey: req.info.user.tenantKey, id: threadGroup.projectId }
                });

                // ユーザーの権限チェック
                const teamMember = await transactionalEntityManager.findOne(TeamMemberEntity, {
                    where: {
                        tenantKey: req.info.user.tenantKey,
                        teamId: project.teamId,
                        userId: req.info.user.id
                    }
                });

                if (!teamMember || (teamMember.role !== TeamMemberRoleType.Owner && teamMember.role !== TeamMemberRoleType.Member)) {
                    throw new Error('このメッセージグループを削除する権限がありません');
                }

                // 関連するメッセージの取得
                const messages = await transactionalEntityManager.find(MessageEntity, {
                    where: { tenantKey: req.info.user.tenantKey, messageGroupId: messageGroupId }
                });

                if (messages && messages.length > 0) {
                    // TODO 論理削除の実装
                    // メッセージの論理削除
                    // message.status = 'deleted';  // 適切なステータス名に置き換えてください
                    // message.updatedBy = req.info.user.id;
                    // await transactionalEntityManager.save(MessageEntity, message);
                    await transactionalEntityManager.delete(MessageEntity, { tenantKey: req.info.user.tenantKey, messageGroupId: messageGroupId });

                    // 親メッセージIDの付け替え
                    const messageIds = messages.map(message => message.id);
                    if (messageGroup.previousMessageGroupId) {
                        // 削除対象のメッセージグループに親メッセージが指定されていたら、
                        // 後続のメッセージグループの親メッセージを付け替えておく
                        await transactionalEntityManager.createQueryBuilder()
                            .update(MessageGroupEntity)
                            .set({
                                previousMessageId: () => ':newpreviousMessageId',
                                updatedBy: () => `:updatedBy`,
                                updatedIp: () => `:updatedIp`,
                            })
                            .where('tenant_key =:tenantKey AND previousMessageId IN (:...messageIds)', { tenantKey: req.info.user.tenantKey, messageIds })
                            .setParameters({
                                newpreviousMessageId: messageGroup.previousMessageGroupId,
                                updatedBy: req.info.user.id,
                                updatedIp: req.info.ip,
                            })
                            .execute();
                    } else { }

                    // 関連するメッセージの取得
                    const contents = await transactionalEntityManager.find(ContentPartEntity, {
                        where: { tenantKey: req.info.user.tenantKey, messageId: In(messageIds) }
                    });

                    // 関連するコンテンツパーツの物理削除
                    await transactionalEntityManager.delete(ContentPartEntity,
                        { tenantKey: req.info.user.tenantKey, messageId: In(messageIds) },
                        // { status: 'deleted', updatedBy: req.info.user.id }
                    );

                    // ファイルオブジェクトも削除。（ファイルボディは再利用考慮のため消さずに残しておく）
                    const fileIds = contents.filter(content => content.linkId).map(content => content.linkId);
                    await transactionalEntityManager.delete(FileEntity,
                        { tenantKey: req.info.user.tenantKey, id: In(fileIds) },
                        // { status: 'deleted', updatedBy: req.info.user.id }
                    );
                } else { }

                // メッセージグループの論理削除
                // messageGroup.status = 'deleted';  // 適切なステータス名に置き換えてください
                // messageGroup.updatedBy = req.info.user.id;
                await transactionalEntityManager.delete(MessageGroupEntity, messageGroup);
                // await transactionalEntityManager.save(MessageGroupEntity, messageGroup);

            });
            res.status(200).json({ message: 'メッセージグループが正常に削除されました', target: messageGroup });
        } catch (error) {
            console.error('Error deleting message group:', JSON.stringify(error, Utils.genJsonSafer()) === '{}' ? error : JSON.stringify(error, Utils.genJsonSafer()));
            if (error instanceof EntityNotFoundError) {
                res.status(404).json({ message: '指定されたメッセージグループ、スレッド、またはプロジェクトが見つかりません' });
            } else if ((error as any).message === 'このメッセージグループを削除する権限がありません') {
                res.status(403).json({ message: (error as any).message });
            } else {
                res.status(500).json({ message: 'メッセージグループの削除中にエラーが発生しました' });
            }
        }
    }
];

/**
 * [user認証] メッセージ削除
 */
export const deleteMessage = [
    param('messageId').notEmpty().isUUID(),
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        const { messageId } = req.params;

        try {
            await ds.transaction(async transactionalEntityManager => {
                // メッセージの取得
                const message = await transactionalEntityManager.findOneOrFail(MessageEntity, {
                    where: { tenantKey: req.info.user.tenantKey, id: messageId },
                });

                // メッセージグループの取得
                const messageGroup = await transactionalEntityManager.findOneOrFail(MessageGroupEntity, {
                    where: { tenantKey: req.info.user.tenantKey, id: message.messageGroupId }
                });

                // スレッドの取得
                const thread = await transactionalEntityManager.findOneOrFail(ThreadEntity, {
                    where: { tenantKey: req.info.user.tenantKey, id: messageGroup.threadId, status: Not(ThreadStatus.Deleted) }
                });

                // スレッドグループの取得
                const threadGroup = await transactionalEntityManager.findOneOrFail(ThreadGroupEntity, {
                    where: { tenantKey: req.info.user.tenantKey, id: thread.threadGroupId }
                });

                // プロジェクトの取得
                const project = await transactionalEntityManager.findOneOrFail(ProjectEntity, {
                    where: { tenantKey: req.info.user.tenantKey, id: threadGroup.projectId }
                });

                // ユーザーの権限チェック
                const teamMember = await transactionalEntityManager.findOne(TeamMemberEntity, {
                    where: {
                        tenantKey: req.info.user.tenantKey,
                        teamId: project.teamId,
                        userId: req.info.user.id
                    }
                });

                if (!teamMember || (teamMember.role !== TeamMemberRoleType.Owner && teamMember.role !== TeamMemberRoleType.Member)) {
                    throw new Error('このメッセージを削除する権限がありません');
                }

                // メッセージの論理削除
                // message.status = 'deleted';  // 適切なステータス名に置き換えてください
                message.updatedBy = req.info.user.id;
                message.updatedIp = req.info.ip;
                await transactionalEntityManager.save(MessageEntity, message);

                // 関連するコンテンツパーツの論理削除
                await transactionalEntityManager.delete(ContentPartEntity,
                    { tenantKey: req.info.user.tenantKey, messageId: messageId },
                    // { status: 'deleted', updatedBy: req.info.user.id }
                );

                // メッセージグループ内の他のメッセージをチェック
                const remainingMessages = await transactionalEntityManager.count(MessageEntity, {
                    where: {
                        tenantKey: req.info.user.tenantKey,
                        messageGroupId: messageGroup.id,
                        // status: Not('deleted')  // 'deleted'以外のステータスをカウント
                    }
                });

                // もし他のメッセージが存在しない場合、メッセージグループも論理削除
                if (remainingMessages === 0) {
                    await transactionalEntityManager.delete(MessageGroupEntity,
                        { tenantKey: req.info.user.tenantKey, id: messageGroup.id },
                        // { status: 'deleted', updatedBy: req.info.user.id }
                    );
                }

            });
            res.status(200).json({ message: 'メッセージが正常に削除されました' });
        } catch (error) {
            console.error('Error deleting message:', JSON.stringify(error, Utils.genJsonSafer()) === '{}' ? error : JSON.stringify(error, Utils.genJsonSafer()));
            if (error instanceof EntityNotFoundError) {
                res.status(404).json({ message: '指定されたメッセージ、スレッド、またはプロジェクトが見つかりません' });
            } else if ((error as any).message === 'このメッセージを削除する権限がありません') {
                res.status(403).json({ message: (error as any).message });
            } else {
                res.status(500).json({ message: 'メッセージの削除中にエラーが発生しました' });
            }
        }
    }
];

/**
 * [user認証] メッセージ削除
 */
export const deleteContentPart = [
    param('contentPartId').notEmpty().isUUID(),
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        const { contentPartId } = req.params;

        try {
            await ds.transaction(async transactionalEntityManager => {
                // コンテンツの取得
                const contentPart = await transactionalEntityManager.findOneOrFail(ContentPartEntity, {
                    where: { tenantKey: req.info.user.tenantKey, id: contentPartId },
                });

                // メッセージの取得
                const message = await transactionalEntityManager.findOneOrFail(MessageEntity, {
                    where: { tenantKey: req.info.user.tenantKey, id: contentPart.messageId },
                });

                // メッセージグループの取得
                const messageGroup = await transactionalEntityManager.findOneOrFail(MessageGroupEntity, {
                    where: { tenantKey: req.info.user.tenantKey, id: message.messageGroupId }
                });

                // スレッドの取得
                const thread = await transactionalEntityManager.findOneOrFail(ThreadEntity, {
                    where: { tenantKey: req.info.user.tenantKey, id: messageGroup.threadId, status: Not(ThreadStatus.Deleted) }
                });

                // スレッドグループの取得
                const threadGroup = await transactionalEntityManager.findOneOrFail(ThreadGroupEntity, {
                    where: { tenantKey: req.info.user.tenantKey, id: thread.threadGroupId }
                });

                // プロジェクトの取得
                const project = await transactionalEntityManager.findOneOrFail(ProjectEntity, {
                    where: { tenantKey: req.info.user.tenantKey, id: threadGroup.projectId }
                });

                // ユーザーの権限チェック
                const teamMember = await transactionalEntityManager.findOne(TeamMemberEntity, {
                    where: {
                        tenantKey: req.info.user.tenantKey,
                        teamId: project.teamId,
                        userId: req.info.user.id
                    }
                });

                if (!teamMember || (teamMember.role !== TeamMemberRoleType.Owner && teamMember.role !== TeamMemberRoleType.Member)) {
                    throw new Error('このメッセージを削除する権限がありません');
                }

                // メッセージの論理削除
                // message.status = 'deleted';  // 適切なステータス名に置き換えてください

                // コンテンツパーツの論理削除
                await transactionalEntityManager.delete(ContentPartEntity,
                    { tenantKey: req.info.user.tenantKey, id: contentPartId },
                    // { status: 'deleted', updatedBy: req.info.user.id }
                );

                // コンテンツ本体（files）は消さない。
            });
            res.status(200).json({ message: 'メッセージが正常に削除されました' });
        } catch (error) {
            console.error('Error deleting message:', JSON.stringify(error, Utils.genJsonSafer()) === '{}' ? error : JSON.stringify(error, Utils.genJsonSafer()));
            if (error instanceof EntityNotFoundError) {
                res.status(404).json({ message: '指定されたメッセージ、スレッド、またはプロジェクトが見つかりません' });
            } else if ((error as any).message === 'このメッセージを削除する権限がありません') {
                res.status(403).json({ message: (error as any).message });
            } else {
                res.status(500).json({ message: 'メッセージの削除中にエラーが発生しました' });
            }
        }
    }
];

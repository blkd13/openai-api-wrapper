import { NextFunction, Request, Response } from 'express';

// import { ProjectEntity, DevelopmentStageEntity, DiscussionEntity, DocumentEntity, StatementEntity, TaskEntity, } from '../entity/project-models.entity.js';
import { ContentPartEntity, MessageEntity, MessageGroupEntity, ProjectEntity, TeamEntity, TeamMemberEntity, ThreadEntity, } from '../entity/project-models.entity.js';
import { ds } from '../db.js';
import { body, param, query, validationResult } from 'express-validator';
import { validationErrorHandler } from '../middleware/validation.js';
import { UserRequest } from '../models/info.js';
import { EntityNotFoundError, In, Not } from 'typeorm';
import { ContentPartType, MessageGroupType, ProjectStatus, ProjectVisibility, TeamMemberRoleType, TeamType, ThreadStatus, ThreadVisibility } from '../models/values.js';
import { Utils } from '../../common/utils.js';
import { Subject } from 'rxjs';

/**
 * Create系は動くと思うがそれ以外は未検証
 */
// const sequencial = true;
const sequencial = false;


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

        ds.transaction(async (transactionalEntityManager) => {
            try {
                // Aloneタイプのチームは一人一つまでしか作れない
                if (teamType === TeamType.Alone) {
                    // ユーザーが所属しているチームのIDを取得
                    const teamMembers = await transactionalEntityManager.getRepository(TeamMemberEntity).find({
                        where: { userId: userReq.info.user.id }
                    });
                    const teamIds = teamMembers.map(member => member.teamId);
                    const existingAloneTeam = await transactionalEntityManager.findOne(TeamEntity, {
                        where: { id: In(teamIds), teamType: TeamType.Alone },
                    });
                    if (existingAloneTeam) {
                        return res.status(400).json({ message: '個人用チーム定義は既に存在します' });
                    }
                }

                team.name = userReq.body.name;
                team.label = userReq.body.label;
                team.description = userReq.body.description;

                // チーム作成
                team.createdBy = userReq.info.user.id;
                team.updatedBy = userReq.info.user.id;
                const savedTeam = await transactionalEntityManager.save(TeamEntity, team);

                // チーム作成ユーザーをメンバーとして追加
                const teamMember = new TeamMemberEntity();
                teamMember.teamId = savedTeam.id;
                teamMember.userId = userReq.info.user.id;
                teamMember.role = TeamMemberRoleType.Owner;
                teamMember.createdBy = userReq.info.user.id;
                teamMember.updatedBy = userReq.info.user.id;
                await transactionalEntityManager.save(TeamMemberEntity, teamMember);

                res.status(201).json(savedTeam);
            } catch (error) {
                console.error('Error creating team:', error);
                res.status(500).json({ message: 'チームの作成中にエラーが発生しました' });
            }
        });
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
                where: { userId: req.info.user.id }
            });
            const teamIds = teamMembers.map(member => member.teamId);

            // チーム情報を取得
            const teams = await ds.getRepository(TeamEntity).find({
                where: { id: In(teamIds) }
            });

            res.status(200).json(teams);
        } catch (error) {
            console.error('Error getting team list:', error);
            res.status(500).json({ message: 'チーム一覧の取得中にエラーが発生しました' });
        }
    }
];


/**
 * [user認証] チーム詳細取得（メンバー情報含む）
 */
export const getTeam = [
    param('id').isUUID(),
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        const teamId = req.params.id;

        try {
            // ユーザーがチームのメンバーであるか確認
            const teamMember = await ds.getRepository(TeamMemberEntity).findOne({
                where: {
                    teamId: teamId,
                    userId: req.info.user.id
                }
            });

            if (!teamMember) {
                return res.status(403).json({ message: 'このチームにアクセスする権限がありません' });
            }

            // チーム情報を取得
            const team = await ds.getRepository(TeamEntity).findOneOrFail({
                where: { id: teamId }
            });

            // チームメンバー情報を取得
            const teamMembers = await ds.getRepository(TeamMemberEntity).find({
                where: { teamId: teamId }
            });

            // チーム情報とメンバー情報を組み合わせて返却
            const teamWithMembers = {
                ...team,
                members: teamMembers
            };

            res.status(200).json(teamWithMembers);
        } catch (error) {
            console.error('Error getting team:', error);
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
    param('id').isUUID(),
    // body('teamType').optional().isIn(Object.values(TeamType)),
    body('name').optional().isString().trim().notEmpty(),
    body('label').optional().isString().trim().notEmpty(),
    body('description').optional().isString().trim(),
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        const teamId = req.params.id;
        const { teamType, name, label, description } = req.body;

        try {
            // ユーザーがチームのオーナーまたは管理者であるか確認
            const teamMember = await ds.getRepository(TeamMemberEntity).findOne({
                where: {
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
                where: { id: teamId }
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

            // 更新を保存
            const updatedTeam = await ds.getRepository(TeamEntity).save(team);

            res.status(200).json(updatedTeam);
        } catch (error) {
            console.error('Error updating team:', error);
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
    param('id').isUUID(),
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
                    where: { id: teamId }
                });

                // チームを論理削除
                team.updatedBy = req.info.user.id;
                await transactionalEntityManager.save(TeamEntity, team);

                // // 関連するチームメンバー情報も論理削除
                // await transactionalEntityManager.update(TeamMemberEntity,
                //     { teamId: teamId },
                // );
            });

            res.status(200).json({ message: 'チームが正常に削除されました' });
        } catch (error) {
            console.error('Error deleting team:', error);
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
    body('teamId').isUUID(),
    body('userId').isUUID(),
    body('role').isIn(Object.values(TeamMemberRoleType)),
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        const { teamId, userId, role } = req.body;

        try {
            await ds.transaction(async transactionalEntityManager => {
                // ユーザーがチームのオーナーであるか確認
                const requesterMember = await transactionalEntityManager.findOne(TeamMemberEntity, {
                    where: {
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
                    where: { id: teamId }
                });

                // 既にメンバーでないか確認
                const existingMember = await transactionalEntityManager.findOne(TeamMemberEntity, {
                    where: {
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

                newMember.createdBy = req.info.user.id;

                await transactionalEntityManager.save(TeamMemberEntity, newMember);
            });

            res.status(201).json({ message: 'チームメンバーが正常に追加されました' });
        } catch (error) {
            console.error('Error adding team member:', error);
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
    param('teamId').isUUID(),
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        const { teamId } = req.params;

        try {
            // リクエスト元のユーザーがチームメンバーであるか確認
            const requesterMember = await ds.getRepository(TeamMemberEntity).findOne({
                where: {
                    teamId: teamId,
                    userId: req.info.user.id
                }
            });

            if (!requesterMember) {
                return res.status(403).json({ message: 'このチームのメンバー一覧を取得する権限がありません' });
            }

            // チームメンバー一覧を取得
            const teamMembers = await ds.getRepository(TeamMemberEntity).find({
                where: { teamId: teamId },
                order: { role: 'ASC', createdAt: 'ASC' }
            });

            res.status(200).json(teamMembers);
        } catch (error) {
            console.error('Error getting team members:', error);
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
    param('teamId').isUUID(),
    param('userId').isUUID(),
    body('role').isIn(Object.values(TeamMemberRoleType)),
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

                await transactionalEntityManager.save(TeamMemberEntity, targetMember);
            });

            res.status(200).json({ message: 'チームメンバー情報が正常に更新されました' });
        } catch (error) {
            console.error('Error updating team member:', error);
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
    param('teamId').isUUID(),
    param('userId').isUUID(),
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        const { teamId, userId } = req.params;

        try {
            await ds.transaction(async transactionalEntityManager => {
                // リクエスト元のユーザーがチームのオーナーであるか確認
                const requesterMember = await transactionalEntityManager.findOne(TeamMemberEntity, {
                    where: {
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
                            teamId: teamId,
                            role: TeamMemberRoleType.Owner
                        }
                    });

                    if (ownerCount <= 1) {
                        throw new Error('チームには最低1人のオーナーが必要です');
                    }
                }

                // メンバーを削除（論理削除）
                targetMember.updatedBy = req.info.user.id;

                await transactionalEntityManager.save(TeamMemberEntity, targetMember);
            });

            res.status(200).json({ message: 'チームメンバーが正常に削除されました' });
        } catch (error) {
            console.error('Error removing team member:', error);
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
    body('teamId').trim().notEmpty(),
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
        project.createdBy = req.info.user.id;
        project.updatedBy = req.info.user.id;

        // 作成トランザクション
        function create() {
            ds.transaction(tx => {
                return tx.save(ProjectEntity, project);
            }).then(savedProject => {
                res.status(201).json(savedProject);
            });
        }
        // 権限チェック（チームメンバーかつオーナーであること）
        ds.getRepository(TeamMemberEntity).findOneOrFail({ where: { teamId: req.body.teamId, userId: req.info.user.id, role: TeamMemberRoleType.Owner } }).then((teamMember) => {
            // プロジェクトにチームIDをセット            
            project.teamId = req.body.teamId;
            if (project.visibility === ProjectVisibility.Default) {
                // Defaultプロジェクトは一人一個限定なので、既存のDefaultプロジェクトがあるか確認する
                ds.getRepository(ProjectEntity).find({ where: { teamId: project.teamId, visibility: ProjectVisibility.Default } }).then(projects => {
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
            console.error(error);
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
            ds.getRepository(TeamMemberEntity).find({ where: { userId: req.info.user.id } }).then((teamMembers) => {
                return teamMembers.map((teamMember) => teamMember.teamId);
            }).then((teamIds) => {
                return ds.getRepository(ProjectEntity).find({
                    where: [
                        { teamId: In(teamIds), status: Not(ProjectStatus.Deleted) },
                        { visibility: ProjectVisibility.Public, status: Not(ProjectStatus.Deleted) },
                        { visibility: ProjectVisibility.Login, status: Not(ProjectStatus.Deleted) },
                    ]
                });
            }).then((projects) => {
                res.status(200).json(projects);
            }).catch((error) => {
                console.error(error);
                res.status(error instanceof EntityNotFoundError ? 404 : 500).json({ message: `Error getting projects` });
            });
        } else {
            // ログインしていない場合
            ds.getRepository(ProjectEntity).find({
                where: { visibility: ProjectVisibility.Public, status: Not(ProjectStatus.Deleted) }
            }).then((projects) => {
                res.status(200).json(projects);
            }).catch((error) => {
                console.error(error);
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
        ds.getRepository(ProjectEntity).findOneOrFail({ where: { id: req.params.id } }).then((project) => {
            if (req.info && req.info.user) {
                if (project.visibility === ProjectVisibility.Public || project.visibility === ProjectVisibility.Login) {
                    // OK
                    res.status(200).json(project);
                } else {
                    // チームメンバーであること（ロールは問わない）
                    ds.getRepository(TeamMemberEntity).find({ where: { userId: req.info.user.id, teamId: project.teamId } }).then((teamMembers) => {
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
            console.error(error);
            res.status(error instanceof EntityNotFoundError ? 404 : 500).json({ message: `Error getting project ${req.params.id}` });
        });
    }
];

/**
 * [user認証] プロジェクト更新
 */
export const updateProject = [
    param('id').trim().notEmpty(),
    validationErrorHandler,
    (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        ds.transaction(tx => {
            return tx.findOneOrFail(ProjectEntity, { where: { id: req.params.id } }).then(project => {
                // 権限チェック（チームメンバーかつオーナーであること）
                return tx.findOneOrFail(TeamMemberEntity, { where: { teamId: project.teamId, userId: req.info.user.id, role: TeamMemberRoleType.Owner } }).then(() => {
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
                    if (req.body.teamId) {
                        // TODO 権限持ってないチームに渡してしまうのを防ぐチェック
                        return tx.findOneOrFail(TeamMemberEntity, { where: { teamId: req.body.teamId, userId: req.info.user.id, role: TeamMemberRoleType.Owner } }).then(() => {
                            project.teamId = req.body.teamId;
                            return tx.save(ProjectEntity, project);
                        });
                    } else {
                        return tx.save(ProjectEntity, project);
                    }
                });
            }).then(project => {
                res.status(200).json(project);
            });
        }).catch(error => {
            console.error(error);
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
    param('id').trim().notEmpty(),
    validationErrorHandler,
    (_req: Request, res: Response) => {
        const req = _req as UserRequest;

        ds.transaction(tx => {
            return tx.findOneOrFail(ProjectEntity, { where: { id: req.params.id } }).then(project => {
                // 権限チェック（チームメンバーかつオーナーであること）
                tx.findOneOrFail(TeamMemberEntity, { where: { teamId: project.teamId, userId: req.info.user.id, role: TeamMemberRoleType.Owner } }).then((teamMember) => {
                    project.status = ProjectStatus.Deleted;
                    return project.save();
                }).catch((error) => {
                    console.error(error);
                    res.status(error instanceof EntityNotFoundError ? 404 : 500).json({ message: `Error deleting project ${req.params.id}` });
                });
            });
        }).then(result => {
            res.status(200).json(result);
        }).catch((error) => {
            console.error(error);
            res.status(error instanceof EntityNotFoundError ? 404 : 500).json({ message: `Error deleting project ${req.params.id}` });
        });
    }
];


/**
 * [user認証] スレッド作成
 */
export const createThread = [
    body('projectId').isUUID(),
    body('title').trim().notEmpty(),
    body('description').trim().notEmpty(),
    body('argsJson').trim().notEmpty(),
    body('visibility').isIn(Object.values(ThreadVisibility)),
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        const { projectId, title, description, argsJson, visibility } = req.body;

        try {
            await ds.transaction(async transactionalEntityManager => {
                // プロジェクトの存在確認
                const project = await transactionalEntityManager.findOneOrFail(ProjectEntity, {
                    where: { id: projectId }
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
                                teamId: project.teamId,
                                userId: req.info.user.id
                            }
                        });

                        if (teamMember && (teamMember.role === TeamMemberRoleType.Owner || teamMember.role === TeamMemberRoleType.Member)) {
                            if (visibility !== ThreadVisibility.Team && teamMember.role == TeamMemberRoleType.Member) {
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

                // 新しいスレッドを作成
                const thread = new ThreadEntity();
                thread.projectId = projectId;
                thread.title = title;
                thread.description = description;
                thread.argsJson = argsJson;
                thread.visibility = visibility;
                thread.createdBy = req.info.user.id;
                thread.updatedBy = req.info.user.id;

                const savedThread = await transactionalEntityManager.save(ThreadEntity, thread);

                res.status(201).json(savedThread);
            });
        } catch (error) {
            console.error('Error creating thread:', error);
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
 * [認証なし/user認証] スレッド一覧取得
 */
export const getThreadList = [
    param('projectId').isUUID(),
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        const { projectId } = req.params;

        try {
            const project = await ds.getRepository(ProjectEntity).findOneOrFail({
                where: { id: projectId }
            });

            let threads: ThreadEntity[];

            if (req.info && req.info.user) {
                // ログインしている場合
                const teamMember = await ds.getRepository(TeamMemberEntity).findOne({
                    where: {
                        teamId: project.teamId,
                        userId: req.info.user.id
                    }
                });

                if (teamMember || project.visibility === ProjectVisibility.Public || project.visibility === ProjectVisibility.Login) {
                    // チームメンバー、または公開/ログインユーザー向けプロジェクトの場合
                    threads = await ds.getRepository(ThreadEntity).find({
                        where: { projectId: projectId }
                    });
                } else {
                    throw new Error('このプロジェクトのスレッド一覧を取得する権限がありません');
                }
            } else {
                // ログインしていない場合
                if (project.visibility === ProjectVisibility.Public) {
                    threads = await ds.getRepository(ThreadEntity).find({
                        where: {
                            projectId: projectId,
                            visibility: ThreadVisibility.Public,
                            status: Not(ThreadStatus.Deleted),
                        }
                    });
                } else {
                    throw new Error('このプロジェクトのスレッド一覧を取得する権限がありません');
                }
            }

            res.status(200).json(threads);
        } catch (error) {
            console.error('Error getting thread list:', error);
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
 * [認証なし/user認証] スレッド取得
 */
export const getThread = [
    param('id').isUUID(),
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        const { id } = req.params;

        try {
            const thread = await ds.getRepository(ThreadEntity).findOneOrFail({
                where: { id: id },
            });

            const project = await ds.getRepository(ProjectEntity).findOneOrFail({
                where: { id: thread.projectId }
            });

            let hasPermission = false;

            if (req.info && req.info.user) {
                // ログインしている場合
                const teamMember = await ds.getRepository(TeamMemberEntity).findOne({
                    where: {
                        teamId: project.teamId,
                        userId: req.info.user.id
                    }
                });

                if (teamMember || project.visibility === ProjectVisibility.Public || project.visibility === ProjectVisibility.Login) {
                    hasPermission = true;
                }
            } else {
                // ログインしていない場合
                if (project.visibility === ProjectVisibility.Public && thread.visibility === ThreadVisibility.Public) {
                    hasPermission = true;
                }
            }

            if (!hasPermission) {
                throw new Error('このスレッドを取得する権限がありません');
            }

            res.status(200).json(thread);
        } catch (error) {
            console.error('Error getting thread:', error);
            if (error instanceof EntityNotFoundError) {
                res.status(404).json({ message: '指定されたスレッドが見つかりません' });
            } else if ((error as any).message === 'このスレッドを取得する権限がありません') {
                res.status(403).json({ message: (error as any).message });
            } else {
                res.status(500).json({ message: 'スレッドの取得中にエラーが発生しました' });
            }
        }
    }
];

/**
 * [user認証] スレッド更新
 */
export const updateThread = [
    param('id').isUUID(),
    body('title').optional().trim().notEmpty(),
    body('description').optional().trim().notEmpty(),
    body('argsJson').optional().trim().notEmpty(),
    body('visibility').optional().isIn(Object.values(ThreadVisibility)),
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        const { id } = req.params;
        const { title, description, argsJson, visibility } = req.body;

        try {
            await ds.transaction(async transactionalEntityManager => {
                const thread = await transactionalEntityManager.findOneOrFail(ThreadEntity, {
                    where: { id: id }
                });

                const project = await transactionalEntityManager.findOneOrFail(ProjectEntity, {
                    where: { id: thread.projectId }
                });

                const teamMember = await transactionalEntityManager.findOne(TeamMemberEntity, {
                    where: {
                        teamId: project.teamId,
                        userId: req.info.user.id
                    }
                });

                if (!teamMember || (teamMember.role !== TeamMemberRoleType.Owner && teamMember.role !== TeamMemberRoleType.Member)) {
                    throw new Error('このスレッドを更新する権限がありません');
                }

                if (title !== undefined) {
                    thread.title = title;
                }
                if (description !== undefined) {
                    thread.description = description;
                }
                if (argsJson !== undefined) {
                    thread.argsJson = argsJson;
                }

                if (visibility !== undefined) {
                    if (visibility !== ThreadVisibility.Team && teamMember.role == TeamMemberRoleType.Member) {
                        // チームメンバーであっても、ロールがMemberの場合はチームスレッド以外の公開設定は出来ない。
                        throw new Error('スレッド公開設定は変更できません');
                    }
                    thread.visibility = visibility;
                }

                thread.updatedBy = req.info.user.id;

                const updatedThread = await transactionalEntityManager.save(ThreadEntity, thread);

                res.status(200).json(updatedThread);
            });
        } catch (error) {
            console.error('Error updating thread:', error);
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
 * [user認証] スレッド削除
 */
export const deleteThread = [
    param('id').isUUID(),
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        const { id } = req.params;

        try {
            await ds.transaction(async transactionalEntityManager => {
                const thread = await transactionalEntityManager.findOneOrFail(ThreadEntity, {
                    where: { id: id }
                });

                const project = await transactionalEntityManager.findOneOrFail(ProjectEntity, {
                    where: { id: thread.projectId }
                });

                const teamMember = await transactionalEntityManager.findOne(TeamMemberEntity, {
                    where: {
                        teamId: project.teamId,
                        userId: req.info.user.id
                    }
                });

                if (!teamMember || (teamMember.role !== TeamMemberRoleType.Owner && teamMember.role !== TeamMemberRoleType.Member)) {
                    throw new Error('このスレッドを削除する権限がありません');
                }

                // 論理削除の実装
                thread.status = ThreadStatus.Deleted;
                thread.updatedBy = req.info.user.id;

                await transactionalEntityManager.save(ThreadEntity, thread);

                res.status(200).json({ message: 'スレッドが正常に削除されました' });
            });
        } catch (error) {
            console.error('Error deleting thread:', error);
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
    body('threadId').isUUID(),
    body('messageId').optional().isUUID(),
    body('messageData.groupType').isIn(Object.values(MessageGroupType)),
    body('messageData.role').notEmpty(),
    body('messageData.label').notEmpty(),
    body('messageData.parentId').optional().isUUID(),
    body('messageData.contents').isArray(),
    body('messageData.contents.*.id').optional().isUUID(),
    body('messageData.contents.*.type').isIn(Object.values(ContentPartType)),
    body('messageData.contents.*.content').notEmpty(),
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        const { threadId, messageId, messageData } = req.body;

        try {
            const result = await ds.transaction(async transactionalEntityManager => {
                // スレッドの存在確認
                const thread = await transactionalEntityManager.findOneOrFail(ThreadEntity, {
                    where: { id: threadId }
                });

                // プロジェクトの取得と権限チェック
                const project = await transactionalEntityManager.findOneOrFail(ProjectEntity, {
                    where: { id: thread.projectId }
                });

                const teamMember = await transactionalEntityManager.findOne(TeamMemberEntity, {
                    where: {
                        teamId: project.teamId,
                        userId: req.info.user.id
                    }
                });

                if (!teamMember || (teamMember.role !== TeamMemberRoleType.Owner && teamMember.role !== TeamMemberRoleType.Member)) {
                    throw new Error('このスレッドにメッセージを作成または更新する権限がありません');
                }

                let messageGroup: MessageGroupEntity;
                let message: MessageEntity;

                if (messageId) {
                    // 更新の場合
                    message = await transactionalEntityManager.findOneOrFail(MessageEntity, {
                        where: { id: messageId },
                        relations: ['messageGroup']
                    });

                    messageGroup = await transactionalEntityManager.findOneOrFail(MessageGroupEntity, {
                        where: { id: message.messageGroupId }
                    });

                    if (messageGroup.threadId !== threadId) {
                        throw new Error('指定されたメッセージは、このスレッドに属していません');
                    }

                    // MessageGroupの更新
                    messageGroup.type = messageData.groupType;
                    messageGroup.role = messageData.role;
                    messageGroup.label = messageData.label;
                    messageGroup.parentId = messageData.parentId;
                    messageGroup.updatedBy = req.info.user.id;

                    // Messageの更新
                    message.label = messageData.label;
                    message.updatedBy = req.info.user.id;
                } else {
                    // 新規作成の場合
                    messageGroup = new MessageGroupEntity();
                    messageGroup.threadId = threadId;
                    messageGroup.type = messageData.groupType;
                    messageGroup.role = messageData.role;
                    messageGroup.label = messageData.label;
                    messageGroup.parentId = messageData.parentId;
                    messageGroup.createdBy = req.info.user.id;
                    messageGroup.updatedBy = req.info.user.id;

                    message = new MessageEntity();
                    message.label = messageData.label;
                    message.createdBy = req.info.user.id;
                    message.updatedBy = req.info.user.id;
                }

                const savedMessageGroup = await transactionalEntityManager.save(MessageGroupEntity, messageGroup);
                message.messageGroupId = savedMessageGroup.id;
                const savedMessage = await transactionalEntityManager.save(MessageEntity, message);

                // 既存のContentPartsを取得（更新の場合）
                const existingContentParts = messageId
                    ? await transactionalEntityManager.find(ContentPartEntity, { where: { messageId: messageId } })
                    : [];

                // ContentPartの作成、更新、削除
                const updatedContentParts = await Promise.all((messageData.contents as ContentPartEntity[]).map(async (content, index) => {
                    let contentPart: ContentPartEntity;

                    if (content.id) {
                        // 既存のContentPartを更新
                        contentPart = existingContentParts.find(cp => cp.id === content.id) || new ContentPartEntity();
                        contentPart.type = content.type;
                        contentPart.content = content.content;
                        contentPart.updatedBy = req.info.user.id;
                    } else {
                        // 新しいContentPartを作成
                        contentPart = new ContentPartEntity();
                        contentPart.messageId = savedMessage.id;
                        contentPart.type = content.type;
                        contentPart.content = content.content;
                        contentPart.createdBy = req.info.user.id;
                        contentPart.updatedBy = req.info.user.id;
                    }

                    contentPart.seq = index + 1;
                    return await transactionalEntityManager.save(ContentPartEntity, contentPart);
                }));

                // 不要になったContentPartsを削除
                const contentPartIdsToKeep = updatedContentParts.map(cp => cp.id);
                await transactionalEntityManager.delete(ContentPartEntity, {
                    messageId: savedMessage.id,
                    id: Not(In(contentPartIdsToKeep))
                });

                return {
                    messageGroup: savedMessageGroup,
                    message: savedMessage,
                    contentParts: updatedContentParts
                };
            });

            res.status(messageId ? 200 : 201).json(result);
        } catch (error) {
            console.error('Error upserting message with contents:', error);
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
    param('threadId').isUUID(),
    query('page').optional().isInt({ min: 1 }).toInt(),
    query('limit').optional().isInt({ min: 1, max: 100 }).toInt(),
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        const { threadId } = req.params;
        const page = req.query.page ? parseInt(req.query.page as string) : 1;
        const limit = req.query.limit ? parseInt(req.query.limit as string) : 20;

        try {
            // スレッドの存在確認
            const thread = await ds.getRepository(ThreadEntity).findOneOrFail({
                where: { id: threadId }
            });

            // プロジェクトの取得と権限チェック
            const project = await ds.getRepository(ProjectEntity).findOneOrFail({
                where: { id: thread.projectId }
            });

            const teamMember = await ds.getRepository(TeamMemberEntity).findOne({
                where: {
                    teamId: project.teamId,
                    userId: req.info.user.id
                }
            });

            if (!teamMember && project.visibility !== ProjectVisibility.Public) {
                throw new Error('このスレッドのメッセージを閲覧する権限がありません');
            }

            // メッセージグループを取得
            const [messageGroups, total] = await ds.getRepository(MessageGroupEntity).findAndCount({
                where: { threadId: threadId },
                order: { seq: 'ASC' },
                skip: (page - 1) * limit,
                take: limit,
                // select: ['id', 'type', 'role', 'label', 'parentId', 'createdAt', 'updatedAt'],
            });

            // メッセージグループIDのリストを作成
            const messageGroupIds = messageGroups.map(group => group.id);

            // 関連するメッセージを一括で取得
            const messages = await ds.getRepository(MessageEntity).find({
                where: { messageGroupId: In(messageGroupIds) },
                // select: ['id', 'messageGroupId', 'label', 'createdAt', 'updatedAt']
            });

            // メッセージグループとメッセージを結合
            const messageGroupsWithMessageInfo = messageGroups.map(group => {
                const relatedMessage = messages.find(message => message.messageGroupId === group.id);
                return {
                    ...group,
                    message: relatedMessage ? {
                        id: relatedMessage.id,
                        label: relatedMessage.label,
                        createdAt: relatedMessage.createdAt,
                        updatedAt: relatedMessage.updatedAt
                    } : null
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
            console.error('Error getting message group list:', error);
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
    param('messageGroupId').isUUID(),
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        const { messageGroupId } = req.params;

        try {
            // メッセージグループの取得
            const messageGroup = await ds.getRepository(MessageGroupEntity).findOneOrFail({
                where: { id: messageGroupId },
                // select: ['id', 'threadId', 'type', 'role', 'label', 'parentId', 'createdAt', 'updatedAt']
            });

            // スレッドの取得
            const thread = await ds.getRepository(ThreadEntity).findOneOrFail({
                where: { id: messageGroup.threadId }
            });

            // プロジェクトの取得
            const project = await ds.getRepository(ProjectEntity).findOneOrFail({
                where: { id: thread.projectId }
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
                where: { messageGroupId: messageGroupId },
                // select: ['id', 'label', 'createdAt', 'updatedAt']
            });

            if (!message) {
                throw new Error('関連するメッセージが見つかりません');
            }

            // 関連するコンテンツパーツの取得
            const contentParts = await ds.getRepository(ContentPartEntity).find({
                where: { messageId: message.id },
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
            console.error('Error getting message group details:', error);
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
 * [user認証] メッセージグループ削除
 */
export const deleteMessageGroup = [
    param('messageGroupId').isUUID(),
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        const { messageGroupId } = req.params;

        try {
            await ds.transaction(async transactionalEntityManager => {
                // メッセージグループの取得
                const messageGroup = await transactionalEntityManager.findOneOrFail(MessageGroupEntity, {
                    where: { id: messageGroupId }
                });

                // スレッドの取得
                const thread = await transactionalEntityManager.findOneOrFail(ThreadEntity, {
                    where: { id: messageGroup.threadId }
                });

                // プロジェクトの取得
                const project = await transactionalEntityManager.findOneOrFail(ProjectEntity, {
                    where: { id: thread.projectId }
                });

                // ユーザーの権限チェック
                const teamMember = await transactionalEntityManager.findOne(TeamMemberEntity, {
                    where: {
                        teamId: project.teamId,
                        userId: req.info.user.id
                    }
                });

                if (!teamMember || (teamMember.role !== TeamMemberRoleType.Owner && teamMember.role !== TeamMemberRoleType.Member)) {
                    throw new Error('このメッセージグループを削除する権限がありません');
                }

                // 関連するメッセージの取得
                const message = await transactionalEntityManager.findOne(MessageEntity, {
                    where: { messageGroupId: messageGroupId }
                });

                if (message) {
                    // TODO 論理削除の実装
                    // メッセージの論理削除
                    // message.status = 'deleted';  // 適切なステータス名に置き換えてください
                    message.updatedBy = req.info.user.id;
                    await transactionalEntityManager.save(MessageEntity, message);

                    // 関連するコンテンツパーツの論理削除
                    await transactionalEntityManager.delete(ContentPartEntity,
                        { messageId: message.id },
                        // { status: 'deleted', updatedBy: req.info.user.id }
                    );
                }

                // メッセージグループの論理削除
                // messageGroup.status = 'deleted';  // 適切なステータス名に置き換えてください
                messageGroup.updatedBy = req.info.user.id;
                await transactionalEntityManager.save(MessageGroupEntity, messageGroup);

                res.status(200).json({ message: 'メッセージグループが正常に削除されました' });
            });
        } catch (error) {
            console.error('Error deleting message group:', error);
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
    param('messageId').isUUID(),
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        const { messageId } = req.params;

        try {
            await ds.transaction(async transactionalEntityManager => {
                // メッセージの取得
                const message = await transactionalEntityManager.findOneOrFail(MessageEntity, {
                    where: { id: messageId },
                });

                // メッセージグループの取得
                const messageGroup = await transactionalEntityManager.findOneOrFail(MessageGroupEntity, {
                    where: { id: message.messageGroupId }
                });

                // スレッドの取得
                const thread = await transactionalEntityManager.findOneOrFail(ThreadEntity, {
                    where: { id: messageGroup.threadId }
                });

                // プロジェクトの取得
                const project = await transactionalEntityManager.findOneOrFail(ProjectEntity, {
                    where: { id: thread.projectId }
                });

                // ユーザーの権限チェック
                const teamMember = await transactionalEntityManager.findOne(TeamMemberEntity, {
                    where: {
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
                await transactionalEntityManager.save(MessageEntity, message);

                // 関連するコンテンツパーツの論理削除
                await transactionalEntityManager.delete(ContentPartEntity,
                    { messageId: messageId },
                    // { status: 'deleted', updatedBy: req.info.user.id }
                );

                // メッセージグループ内の他のメッセージをチェック
                const remainingMessages = await transactionalEntityManager.count(MessageEntity, {
                    where: {
                        messageGroupId: messageGroup.id,
                        // status: Not('deleted')  // 'deleted'以外のステータスをカウント
                    }
                });

                // もし他のメッセージが存在しない場合、メッセージグループも論理削除
                if (remainingMessages === 0) {
                    await transactionalEntityManager.delete(MessageGroupEntity,
                        { id: messageGroup.id },
                        // { status: 'deleted', updatedBy: req.info.user.id }
                    );
                }

                res.status(200).json({ message: 'メッセージが正常に削除されました' });
            });
        } catch (error) {
            console.error('Error deleting message:', error);
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

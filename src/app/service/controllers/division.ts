import { Request, Response } from 'express';
import { body, param, validationResult } from 'express-validator';
import { EntityManager, EntityNotFoundError, In } from 'typeorm';

import { ds } from '../db.js';
import { validationErrorHandler } from '../middleware/validation.js';
import { UserRequest } from '../models/info.js';
import {
    DivisionEntity,
    UserRoleEntity,
    UserEntity,
    UserRoleType,
    UserStatus,
    ScopeType,
    ScopeInfo
} from '../entity/auth.entity.js';
import { Utils } from '../../common/utils.js';

// =================================
// Division CRUD API
// =================================

/**
 * Organization レベルの権限チェック
 * Admin または Maintainer ロールを持つユーザーのみが新しいDivisionを作成可能
 */
const checkOrganizationPermission = async (
    userId: string,
    orgKey: string,
    manager?: EntityManager
): Promise<boolean> => {
    const userRoles = await (manager || ds).getRepository(UserRoleEntity).find({
        where: {
            orgKey,
            userId,
            status: UserStatus.Active,
            scopeInfo: {
                scopeType: ScopeType.ORGANIZATION
            },
            role: In([UserRoleType.Admin, UserRoleType.SuperAdmin])
        }
    });

    return userRoles.length > 0;
};

/**
 * Division用の権限チェック関数
 * Admin または Maintainer ロールを持つユーザーのみが Division の管理操作を実行可能
 */
const checkDivisionPermission = async (
    userId: string,
    orgKey: string,
    divisionId: string,
    manager?: EntityManager
): Promise<boolean> => {
    const userRoles = await (manager || ds).getRepository(UserRoleEntity).find({
        where: {
            orgKey,
            userId,
            status: UserStatus.Active,
            scopeInfo: {
                scopeType: ScopeType.DIVISION,
                scopeId: divisionId
            },
            role: In([UserRoleType.Admin, UserRoleType.SuperAdmin])
        }
    });

    return userRoles.length > 0;
};

/**
 * [user認証] Division詳細取得
 */
export const getDivision = [
    param('divisionId').notEmpty().isUUID(),
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        const { divisionId } = req.params;

        try {
            // リクエスト元のユーザーがDivisionメンバーであるか確認
            const requesterRole = await ds.getRepository(UserRoleEntity).findOne({
                where: {
                    orgKey: req.info.user.orgKey,
                    userId: req.info.user.id,
                    scopeInfo: {
                        scopeType: ScopeType.DIVISION,
                        scopeId: divisionId
                    },
                    status: UserStatus.Active
                }
            });

            if (!requesterRole) {
                return res.status(403).json({
                    message: 'このDivisionの詳細を取得する権限がありません'
                });
            }

            // Division詳細を取得
            const division = await ds.getRepository(DivisionEntity).findOne({
                where: {
                    orgKey: req.info.user.orgKey,
                    id: divisionId,
                    isActive: true
                }
            });

            if (!division) {
                return res.status(404).json({ message: '指定されたDivisionが見つかりません' });
            }

            // メンバー数も含めて返す
            const memberCount = await ds.getRepository(UserRoleEntity).count({
                where: {
                    orgKey: req.info.user.orgKey,
                    scopeInfo: {
                        scopeType: ScopeType.DIVISION,
                        scopeId: divisionId
                    },
                    status: UserStatus.Active
                }
            });

            const divisionWithStats = {
                ...division,
                memberCount,
                userRole: requesterRole.role
            };

            res.status(200).json(divisionWithStats);
        } catch (error) {
            console.error('Error getting division:', JSON.stringify(error, Utils.genJsonSafer()) === '{}' ? error : JSON.stringify(error, Utils.genJsonSafer()));
            res.status(500).json({ message: 'Division詳細の取得中にエラーが発生しました' });
        }
    }
];

/**
 * [user認証] Division 作成・更新（Upsert）
 * 
 * Division作成時の注意点：
 * - adminUserIdパラメーターを指定することで、最初のAdminユーザーを指定できます
 * - adminUserIdが指定されない場合は、リクエスト元ユーザーが自動的にAdminになります
 * - 少なくとも1人のAdminが必要なため、作成時には必ずAdminユーザーが設定されます
 */
export const upsertDivision = [
    param('divisionId').optional().isUUID(),
    body('name').notEmpty().isString().trim(),
    body('label').notEmpty().isString().trim(),
    body('isActive').optional().isBoolean(),
    body('adminUserId').optional().isUUID(), // division作成時の最初のAdminユーザーを指定（未指定だとリクエスト元ユーザーがAdminになる）
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        const { divisionId } = req.params;
        const { name, label, isActive = true, adminUserId = req.info.user.id } = req.body;

        try {
            const result = await ds.transaction(async transactionalEntityManager => {
                let division: DivisionEntity;
                let isCreation = false;

                if (divisionId) {
                    // 更新の場合：DivisionのAdmin/Maintainerかチェック
                    const hasUpdatePermission = await checkDivisionPermission(
                        req.info.user.id,
                        req.info.user.orgKey,
                        divisionId,
                        transactionalEntityManager
                    );

                    if (!hasUpdatePermission) {
                        throw new Error('このDivisionを更新する権限がありません');
                    }

                    // 更新対象のDivisionが存在するか確認
                    const _division = await transactionalEntityManager.findOne(DivisionEntity, {
                        where: {
                            orgKey: req.info.user.orgKey,
                            id: divisionId
                        }
                    });

                    if (!_division) {
                        throw new EntityNotFoundError(DivisionEntity, { divisionId });
                    }
                    division = _division;
                } else {
                    // 作成の場合：Organization レベルの Admin/Maintainer のみ Division を作成可能
                    const hasCreatePermission = await checkOrganizationPermission(
                        req.info.user.id,
                        req.info.user.orgKey,
                        transactionalEntityManager
                    );

                    if (!hasCreatePermission) {
                        throw new Error('Divisionを作成する権限がありません');
                    }

                    division = new DivisionEntity();
                    division.orgKey = req.info.user.orgKey;
                    division.createdBy = req.info.user.id;
                    division.createdIp = req.info.ip;
                    isCreation = true;
                }

                // 名前の重複チェック（既存のDivisionの名前と異なる場合のみ）
                if (!divisionId || name !== division.name) {
                    const existingDivision = await transactionalEntityManager.findOne(DivisionEntity, {
                        where: { orgKey: req.info.user.orgKey, name }
                    });

                    if (existingDivision && existingDivision.id !== divisionId) {
                        throw new Error('同じ名前のDivisionが既に存在します');
                    }
                }
                // Division情報を設定・更新
                division.name = name;
                division.label = label;
                division.isActive = isActive;
                division.updatedBy = req.info.user.id;
                division.updatedIp = req.info.ip;

                const savedDivision = await transactionalEntityManager.save(DivisionEntity, division);

                // 作成の場合のみ、Admin ユーザーを追加
                if (isCreation) {
                    // adminUserIdが指定されている場合は、そのユーザーをAdminとして追加
                    const targetAdminUserId = adminUserId || req.info.user.id;

                    // 指定されたユーザーが存在するか確認
                    if (adminUserId) {
                        await transactionalEntityManager.findOneOrFail(UserEntity, {
                            where: { orgKey: req.info.user.orgKey, id: adminUserId, status: UserStatus.Active }
                        });
                    }

                    const creatorRole = new UserRoleEntity();
                    creatorRole.userId = targetAdminUserId;
                    creatorRole.role = UserRoleType.Admin;
                    creatorRole.scopeInfo = new ScopeInfo();
                    creatorRole.scopeInfo.scopeType = ScopeType.DIVISION;
                    creatorRole.scopeInfo.scopeId = savedDivision.id;
                    creatorRole.priority = 0;
                    creatorRole.status = UserStatus.Active;

                    creatorRole.orgKey = req.info.user.orgKey;
                    creatorRole.createdBy = req.info.user.id;
                    creatorRole.updatedBy = req.info.user.id;
                    creatorRole.createdIp = req.info.ip;
                    creatorRole.updatedIp = req.info.ip;

                    await transactionalEntityManager.save(UserRoleEntity, creatorRole);
                }

                return { division: savedDivision, isCreation };
            });

            const statusCode = result.isCreation ? 201 : 200;
            const message = result.isCreation ? 'Divisionが正常に作成されました' : 'Division情報が正常に更新されました';
            res.status(statusCode).json({
                ...result.division,
                message
            });

        } catch (error) {
            console.error('Error upserting division:', JSON.stringify(error, Utils.genJsonSafer()) === '{}' ? error : JSON.stringify(error, Utils.genJsonSafer()));
            if (error instanceof EntityNotFoundError) {
                res.status(404).json({ message: '指定されたDivisionまたはAdminユーザーが見つかりません' });
            } else if ((error as any).message === 'Divisionを作成する権限がありません' ||
                (error as any).message === 'このDivisionを更新する権限がありません' ||
                (error as any).message === '同じ名前のDivisionが既に存在します') {
                res.status(400).json({ message: (error as any).message });
            } else {
                res.status(500).json({ message: 'Divisionの作成・更新中にエラーが発生しました' });
            }
        }
    }
];

/**
 * [user認証] Division削除（論理削除）
 */
export const deleteDivision = [
    param('divisionId').notEmpty().isUUID(),
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        const { divisionId } = req.params;

        try {
            await ds.transaction(async transactionalEntityManager => {
                // 権限チェック: DivisionのAdmin/Maintainerかチェック
                const hasPermission = await checkDivisionPermission(
                    req.info.user.id,
                    req.info.user.orgKey,
                    divisionId,
                    transactionalEntityManager
                );

                if (!hasPermission) {
                    throw new Error('このDivisionを削除する権限がありません');
                }

                // 削除対象のDivisionが存在するか確認
                const division = await transactionalEntityManager.findOne(DivisionEntity, {
                    where: {
                        orgKey: req.info.user.orgKey,
                        id: divisionId,
                        isActive: true
                    }
                });

                if (!division) {
                    throw new EntityNotFoundError(DivisionEntity, { divisionId });
                }

                // Division のメンバー数を確認
                const memberCount = await transactionalEntityManager.count(UserRoleEntity, {
                    where: {
                        orgKey: req.info.user.orgKey,
                        scopeInfo: {
                            scopeType: ScopeType.DIVISION,
                            scopeId: divisionId
                        },
                        status: UserStatus.Active
                    }
                });

                // メンバーが存在する場合は削除を禁止
                if (memberCount > 0) {
                    throw new Error('メンバーが存在するDivisionは削除できません。先にすべてのメンバーを削除してください。');
                }

                // Division を論理削除
                division.isActive = false;
                division.updatedBy = req.info.user.id;
                division.updatedIp = req.info.ip;

                await transactionalEntityManager.save(DivisionEntity, division);

                // 関連するすべてのロールも論理削除
                await transactionalEntityManager.update(
                    UserRoleEntity,
                    {
                        orgKey: req.info.user.orgKey,
                        scopeInfo: {
                            scopeType: ScopeType.DIVISION,
                            scopeId: divisionId
                        }
                    },
                    {
                        status: UserStatus.Inactive,
                        updatedBy: req.info.user.id,
                        updatedIp: req.info.ip
                    }
                );
            });

            res.status(200).json({ message: 'Divisionが正常に削除されました' });
        } catch (error) {
            console.error('Error deleting division:', JSON.stringify(error, Utils.genJsonSafer()) === '{}' ? error : JSON.stringify(error, Utils.genJsonSafer()));
            if (error instanceof EntityNotFoundError) {
                res.status(404).json({ message: '指定されたDivisionが見つかりません' });
            } else if ((error as any).message === 'このDivisionを削除する権限がありません' ||
                (error as any).message === 'メンバーが存在するDivisionは削除できません。先にすべてのメンバーを削除してください。') {
                res.status(400).json({ message: (error as any).message });
            } else {
                res.status(500).json({ message: 'Divisionの削除中にエラーが発生しました' });
            }
        }
    }
];

/**
 * [user認証] 全Division一覧取得（Organization管理者用）
 */
export const getAllDivisions = [
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;

        try {
            // Organization レベルの Admin/Maintainer 権限をチェック
            const hasPermission = await checkOrganizationPermission(
                req.info.user.id,
                req.info.user.orgKey
            );

            if (!hasPermission) {
                return res.status(403).json({
                    message: '全Division一覧を取得する権限がありません'
                });
            }

            // 全Division一覧を取得
            const divisions = await ds.getRepository(DivisionEntity).find({
                where: { orgKey: req.info.user.orgKey },
                order: { isActive: 'DESC', name: 'ASC' }
            });

            // 各Divisionのメンバー数も取得
            const divisionsWithStats = await Promise.all(
                divisions.map(async (division) => {
                    const memberCount = await ds.getRepository(UserRoleEntity).count({
                        where: {
                            orgKey: req.info.user.orgKey,
                            scopeInfo: {
                                scopeType: ScopeType.DIVISION,
                                scopeId: division.id
                            },
                            status: UserStatus.Active
                        }
                    });

                    const adminCount = await ds.getRepository(UserRoleEntity).count({
                        where: {
                            orgKey: req.info.user.orgKey,
                            scopeInfo: {
                                scopeType: ScopeType.DIVISION,
                                scopeId: division.id
                            },
                            role: In([UserRoleType.Admin, UserRoleType.SuperAdmin]),
                            status: UserStatus.Active
                        }
                    });

                    return {
                        ...division,
                        memberCount,
                        adminCount
                    };
                })
            );

            res.status(200).json(divisionsWithStats);
        } catch (error) {
            console.error('Error getting all divisions:', JSON.stringify(error, Utils.genJsonSafer()) === '{}' ? error : JSON.stringify(error, Utils.genJsonSafer()));
            res.status(500).json({ message: 'Division一覧の取得中にエラーが発生しました' });
        }
    }
];

// =================================
// Division Member Management API
// =================================

/**
 * [user認証] Division メンバー追加
 */
export const addDivisionMember = [
    param('divisionId').notEmpty().isUUID(),
    body('userId').notEmpty().isUUID(),
    body('role').notEmpty().isIn(Object.values(UserRoleType)),
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        const { divisionId } = req.params as { divisionId: string };
        const { userId, role } = req.body;

        try {
            await ds.transaction(async transactionalEntityManager => {
                // 権限チェック: リクエスト元ユーザーがDivisionのAdmin/Maintainerかチェック
                const hasPermission = await checkDivisionPermission(
                    req.info.user.id,
                    req.info.user.orgKey,
                    divisionId,
                    transactionalEntityManager
                );

                if (!hasPermission) {
                    throw new Error('このDivisionにメンバーを追加する権限がありません');
                }

                // Divisionが存在するか確認
                await transactionalEntityManager.findOneOrFail(DivisionEntity, {
                    where: { orgKey: req.info.user.orgKey, id: divisionId, isActive: true }
                });

                // 追加対象のユーザーが存在するか確認
                await transactionalEntityManager.findOneOrFail(UserEntity, {
                    where: { orgKey: req.info.user.orgKey, id: userId, status: UserStatus.Active }
                });

                // 既にメンバーでないか確認
                const existingRole = await transactionalEntityManager.findOne(UserRoleEntity, {
                    where: {
                        orgKey: req.info.user.orgKey,
                        userId: userId,
                        scopeInfo: {
                            scopeType: ScopeType.DIVISION,
                            scopeId: divisionId
                        },
                        status: UserStatus.Active
                    }
                });

                if (existingRole) {
                    throw new Error('このユーザーは既にDivisionのメンバーです');
                }

                // 新しいロールを追加
                const newRole = new UserRoleEntity();
                newRole.userId = userId;
                newRole.role = role;
                newRole.scopeInfo = new ScopeInfo();
                newRole.scopeInfo.scopeType = ScopeType.DIVISION;
                newRole.scopeInfo.scopeId = divisionId;
                newRole.priority = 0;
                newRole.status = UserStatus.Active;

                newRole.orgKey = req.info.user.orgKey;
                newRole.createdBy = req.info.user.id;
                newRole.updatedBy = req.info.user.id;
                newRole.createdIp = req.info.ip;
                newRole.updatedIp = req.info.ip;

                await transactionalEntityManager.save(UserRoleEntity, newRole);
            });

            res.status(201).json({ message: 'Divisionメンバーが正常に追加されました' });
        } catch (error) {
            console.error('Error adding division member:', JSON.stringify(error, Utils.genJsonSafer()) === '{}' ? error : JSON.stringify(error, Utils.genJsonSafer()));
            if (error instanceof EntityNotFoundError) {
                res.status(404).json({ message: '指定されたDivisionまたはユーザーが見つかりません' });
            } else if ((error as any).message === 'このDivisionにメンバーを追加する権限がありません' ||
                (error as any).message === 'このユーザーは既にDivisionのメンバーです') {
                res.status(400).json({ message: (error as any).message });
            } else {
                res.status(500).json({ message: 'Divisionメンバーの追加中にエラーが発生しました' });
            }
        }
    }
];

/**
 * [user認証] Division メンバー一覧取得
 */
export const getDivisionMembers = [
    param('divisionId').notEmpty().isUUID(),
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        const { divisionId } = req.params;

        try {
            // リクエスト元のユーザーがDivisionメンバーであるか確認
            const requesterRole = await ds.getRepository(UserRoleEntity).findOne({
                where: {
                    orgKey: req.info.user.orgKey,
                    userId: req.info.user.id,
                    scopeInfo: {
                        scopeType: ScopeType.DIVISION,
                        scopeId: divisionId
                    },
                    status: UserStatus.Active
                }
            });

            if (!requesterRole) {
                return res.status(403).json({
                    message: 'このDivisionのメンバー一覧を取得する権限がありません'
                });
            }

            // Divisionメンバー一覧を取得
            const divisionMembers = await ds.getRepository(UserRoleEntity).find({
                where: {
                    orgKey: req.info.user.orgKey,
                    scopeInfo: {
                        scopeType: ScopeType.DIVISION,
                        scopeId: divisionId
                    },
                    status: UserStatus.Active
                },
                order: { role: 'ASC', createdAt: 'ASC' }
            });

            // ユーザー情報も含めて返す
            const userIds = divisionMembers.map(member => member.userId);
            const users = await ds.getRepository(UserEntity).find({
                where: {
                    orgKey: req.info.user.orgKey,
                    id: In(userIds),
                    status: UserStatus.Active
                }
            });

            const membersWithUserInfo = divisionMembers.map(member => {
                const user = users.find(u => u.id === member.userId);
                return {
                    userId: member.userId,
                    role: member.role,
                    priority: member.priority,
                    status: member.status,
                    userName: user?.name,
                    userEmail: user?.email,
                    createdAt: member.createdAt,
                    updatedAt: member.updatedAt
                };
            });

            res.status(200).json(membersWithUserInfo);
        } catch (error) {
            console.error('Error getting division members:', JSON.stringify(error, Utils.genJsonSafer()) === '{}' ? error : JSON.stringify(error, Utils.genJsonSafer()));
            res.status(500).json({ message: 'Divisionメンバー一覧の取得中にエラーが発生しました' });
        }
    }
];

/**
 * [user認証] Division メンバー情報更新
 */
export const updateDivisionMember = [
    param('divisionId').notEmpty().isUUID(),
    param('userId').notEmpty().isUUID(),
    body('role').notEmpty().isIn(Object.values(UserRoleType)),
    body('status').optional().isIn(Object.values(UserStatus)),
    body('priority').optional().isInt({ min: 0 }),
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        const { divisionId, userId } = req.params;
        const { role, status, priority } = req.body;

        try {
            await ds.transaction(async transactionalEntityManager => {
                // 権限チェック: リクエスト元ユーザーがDivisionのAdmin/Maintainerかチェック
                const hasPermission = await checkDivisionPermission(
                    req.info.user.id,
                    req.info.user.orgKey,
                    divisionId,
                    transactionalEntityManager
                );

                if (!hasPermission) {
                    throw new Error('このDivisionのメンバー情報を更新する権限がありません');
                }

                // 更新対象のメンバーが存在するか確認
                const targetRole = await transactionalEntityManager.findOne(UserRoleEntity, {
                    where: {
                        orgKey: req.info.user.orgKey,
                        userId: userId,
                        scopeInfo: {
                            scopeType: ScopeType.DIVISION,
                            scopeId: divisionId
                        },
                        // status: UserStatus.Active
                    }
                });

                if (!targetRole) {
                    throw new EntityNotFoundError(UserRoleEntity, { divisionId, userId });
                }

                // Admin/SuperAdminは最低1人必要なので、最後のAdmin/SuperAdminの役割を変更しようとしている場合はエラー
                if ((targetRole.role === UserRoleType.Admin || targetRole.role === UserRoleType.SuperAdmin) &&
                    (role !== UserRoleType.Admin && role !== UserRoleType.SuperAdmin)) {
                    const adminCount = await transactionalEntityManager.count(UserRoleEntity, {
                        where: {
                            orgKey: req.info.user.orgKey,
                            scopeInfo: {
                                scopeType: ScopeType.DIVISION,
                                scopeId: divisionId
                            },
                            role: In([UserRoleType.Admin, UserRoleType.SuperAdmin]),
                            status: UserStatus.Active
                        }
                    });

                    if (adminCount <= 1) {
                        throw new Error('Divisionには最低1人のAdmin/SuperAdminが必要です');
                    }
                }

                // メンバー情報を更新
                targetRole.role = role;
                if (priority !== undefined) {
                    targetRole.priority = priority;
                }
                targetRole.updatedBy = req.info.user.id;
                targetRole.updatedIp = req.info.ip;

                await transactionalEntityManager.save(UserRoleEntity, targetRole);
            });

            res.status(200).json({ message: 'Divisionメンバー情報が正常に更新されました' });
        } catch (error) {
            console.error('Error updating division member:', JSON.stringify(error, Utils.genJsonSafer()) === '{}' ? error : JSON.stringify(error, Utils.genJsonSafer()));
            if (error instanceof EntityNotFoundError) {
                res.status(404).json({ message: '指定されたDivisionメンバーが見つかりません' });
            } else if ((error as any).message === 'このDivisionのメンバー情報を更新する権限がありません' ||
                (error as any).message === 'Divisionには最低1人のAdmin/Maintainerが必要です') {
                res.status(400).json({ message: (error as any).message });
            } else {
                res.status(500).json({ message: 'Divisionメンバー情報の更新中にエラーが発生しました' });
            }
        }
    }
];

/**
 * [user認証] Division メンバー追加
 */
export const upsertDivisionMember = [
    param('divisionId').notEmpty().isUUID(),
    param('userId').optional({ nullable: true }).isUUID(),
    body('userId').notEmpty().isUUID(),
    body('role').notEmpty().isIn(Object.values(UserRoleType)),
    body('status').optional().isIn(Object.values(UserStatus)),
    body('priority').optional().isInt({ min: 0 }),
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        const { divisionId } = req.params as { divisionId: string };
        const { userId, role, status, priority = 0 } = req.body;

        if (userId && req.params.userId && req.params.userId !== userId) {
            res.status(400).json({ message: 'User IDが一致しません' });
            return;
        }

        try {
            const result = await ds.transaction(async transactionalEntityManager => {
                // 権限チェック: リクエスト元ユーザーがDivisionのAdmin/SuperAdminかチェック
                const hasPermission = await checkDivisionPermission(
                    req.info.user.id,
                    req.info.user.orgKey,
                    divisionId,
                    transactionalEntityManager
                );

                if (!hasPermission) {
                    throw new Error('このDivisionのメンバーを管理する権限がありません');
                }

                // Divisionが存在するか確認
                await transactionalEntityManager.findOneOrFail(DivisionEntity, {
                    where: { orgKey: req.info.user.orgKey, id: divisionId, isActive: true }
                });

                // 追加対象のユーザーが存在するか確認
                await transactionalEntityManager.findOneOrFail(UserEntity, {
                    where: { orgKey: req.info.user.orgKey, id: userId, status: UserStatus.Active }
                });

                // 既存のロールを確認
                const existingRole = await transactionalEntityManager.findOne(UserRoleEntity, {
                    where: {
                        orgKey: req.info.user.orgKey,
                        userId: userId,
                        scopeInfo: {
                            scopeType: ScopeType.DIVISION,
                            scopeId: divisionId,
                        },
                        role: role,
                        // status: UserStatus.Active,
                    }
                });

                let isCreation = false;
                let targetRole: UserRoleEntity;

                if (existingRole) {
                    // 更新の場合：Admin/SuperAdminは最低1人必要なので、最後のAdmin/SuperAdminの役割を変更しようとしている場合はエラー
                    if ((existingRole.role === UserRoleType.Admin || existingRole.role === UserRoleType.SuperAdmin) &&
                        (role !== UserRoleType.Admin && role !== UserRoleType.SuperAdmin)) {
                        const adminCount = await transactionalEntityManager.count(UserRoleEntity, {
                            where: {
                                orgKey: req.info.user.orgKey,
                                scopeInfo: {
                                    scopeType: ScopeType.DIVISION,
                                    scopeId: divisionId
                                },
                                role: In([UserRoleType.Admin, UserRoleType.SuperAdmin]),
                                status: UserStatus.Active
                            }
                        });

                        if (adminCount <= 1) {
                            throw new Error('Divisionには最低1人のAdmin/SuperAdminが必要です');
                        }
                    }

                    // 既存ロールを更新
                    existingRole.role = role;
                    existingRole.priority = priority;
                    existingRole.updatedBy = req.info.user.id;
                    existingRole.updatedIp = req.info.ip;
                    existingRole.status = status || UserStatus.Active;
                    targetRole = existingRole;
                } else {
                    // 新規作成
                    const newRole = new UserRoleEntity();
                    newRole.userId = userId;
                    newRole.role = role;
                    newRole.scopeInfo = new ScopeInfo();
                    newRole.scopeInfo.scopeType = ScopeType.DIVISION;
                    newRole.scopeInfo.scopeId = divisionId;
                    newRole.priority = priority;
                    newRole.status = status || UserStatus.Active;

                    newRole.orgKey = req.info.user.orgKey;
                    newRole.createdBy = req.info.user.id;
                    newRole.updatedBy = req.info.user.id;
                    newRole.createdIp = req.info.ip;
                    newRole.updatedIp = req.info.ip;

                    targetRole = newRole;
                    isCreation = true;
                }

                await transactionalEntityManager.save(UserRoleEntity, targetRole);

                return { isCreation };
            });

            const statusCode = result.isCreation ? 201 : 200;
            const message = result.isCreation ?
                'Divisionメンバーが正常に追加されました' :
                'Divisionメンバー情報が正常に更新されました';

            res.status(statusCode).json({ message });
        } catch (error) {
            console.error('Error upserting division member:', JSON.stringify(error, Utils.genJsonSafer()) === '{}' ? error : JSON.stringify(error, Utils.genJsonSafer()));
            if (error instanceof EntityNotFoundError) {
                res.status(404).json({ message: '指定されたDivisionまたはユーザーが見つかりません' });
            } else if ((error as any).message === 'このDivisionのメンバーを管理する権限がありません' ||
                (error as any).message === 'Divisionには最低1人のAdmin/Maintainerが必要です') {
                res.status(400).json({ message: (error as any).message });
            } else {
                res.status(500).json({ message: 'Divisionメンバーの管理中にエラーが発生しました' });
            }
        }
    }
];
/**
 * [user認証] Division メンバー削除
 */
export const removeDivisionMember = [
    param('divisionId').notEmpty().isUUID(),
    param('userId').notEmpty().isUUID(),
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        const { divisionId, userId } = req.params;

        try {
            await ds.transaction(async transactionalEntityManager => {
                // 権限チェック: リクエスト元ユーザーがDivisionのAdmin/Maintainerかチェック
                const hasPermission = await checkDivisionPermission(
                    req.info.user.id,
                    req.info.user.orgKey,
                    divisionId,
                    transactionalEntityManager
                );

                if (!hasPermission) {
                    throw new Error('このDivisionのメンバーを削除する権限がありません');
                }

                // 削除対象のメンバーが存在するか確認
                const targetRole = await transactionalEntityManager.findOne(UserRoleEntity, {
                    where: {
                        orgKey: req.info.user.orgKey,
                        userId: userId,
                        scopeInfo: {
                            scopeType: ScopeType.DIVISION,
                            scopeId: divisionId
                        },
                        status: UserStatus.Active
                    }
                });

                if (!targetRole) {
                    throw new EntityNotFoundError(UserRoleEntity, { divisionId, userId });
                }

                // 自身を削除しようとしていないか確認
                if (userId === req.info.user.id) {
                    throw new Error('自身をDivisionから削除することはできません');
                }

                // Admin/SuperAdminを削除しようとしている場合、他のAdmin/SuperAdminが存在するか確認
                if (targetRole.role === UserRoleType.Admin || targetRole.role === UserRoleType.SuperAdmin) {
                    const adminCount = await transactionalEntityManager.count(UserRoleEntity, {
                        where: {
                            orgKey: req.info.user.orgKey,
                            scopeInfo: {
                                scopeType: ScopeType.DIVISION,
                                scopeId: divisionId
                            },
                            role: In([UserRoleType.Admin, UserRoleType.SuperAdmin]),
                            status: UserStatus.Active
                        }
                    });

                    if (adminCount <= 1) {
                        throw new Error('Divisionには最低1人のAdmin/SuperAdminが必要です');
                    }
                }

                // メンバーを削除（論理削除）
                targetRole.status = UserStatus.Inactive;
                targetRole.updatedBy = req.info.user.id;
                targetRole.updatedIp = req.info.ip;

                await transactionalEntityManager.save(UserRoleEntity, targetRole);
            });

            res.status(200).json({ message: 'Divisionメンバーが正常に削除されました' });
        } catch (error) {
            console.error('Error removing division member:', JSON.stringify(error, Utils.genJsonSafer()) === '{}' ? error : JSON.stringify(error, Utils.genJsonSafer()));
            if (error instanceof EntityNotFoundError) {
                res.status(404).json({ message: '指定されたDivisionメンバーが見つかりません' });
            } else if ((error as any).message === 'このDivisionのメンバーを削除する権限がありません' ||
                (error as any).message === '自身をDivisionから削除することはできません' ||
                (error as any).message === 'Divisionには最低1人のAdmin/Maintainerが必要です') {
                res.status(400).json({ message: (error as any).message });
            } else {
                res.status(500).json({ message: 'Divisionメンバーの削除中にエラーが発生しました' });
            }
        }
    }
];

/**
 * [user認証] Division 一覧取得
 */
export const getDivisionList = [
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;

        try {
            // ユーザーが所属しているDivisionのIDを取得
            const userRoles = await ds.getRepository(UserRoleEntity).find({
                where: {
                    orgKey: req.info.user.orgKey,
                    userId: req.info.user.id,
                    scopeInfo: {
                        scopeType: ScopeType.DIVISION
                    },
                    status: UserStatus.Active
                }
            });

            const divisionIds = userRoles.map(role => role.scopeInfo.scopeId);

            if (divisionIds.length === 0) {
                return res.status(200).json([]);
            }

            // Divisionの詳細情報を取得
            const divisions = await ds.getRepository(DivisionEntity).find({
                where: {
                    orgKey: req.info.user.orgKey,
                    id: In(divisionIds),
                    isActive: true
                },
                order: { name: 'ASC' }
            });

            // ユーザーの各Divisionでの役割情報も含めて返す
            const divisionsWithRole = divisions.map(division => {
                const userRole = userRoles.find(role => role.scopeInfo.scopeId === division.id);
                return {
                    ...division,
                    userRole: userRole?.role,
                    userPriority: userRole?.priority
                };
            });

            res.status(200).json(divisionsWithRole);
        } catch (error) {
            console.error('Error getting division list:', JSON.stringify(error, Utils.genJsonSafer()) === '{}' ? error : JSON.stringify(error, Utils.genJsonSafer()));
            res.status(500).json({ message: 'Division一覧の取得中にエラーが発生しました' });
        }
    }
];

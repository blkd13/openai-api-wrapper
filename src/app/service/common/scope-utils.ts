import { ScopeType, OrganizationEntity, DivisionEntity, UserRoleType, UserRole } from '../entity/auth.entity.js';
import { UserTokenPayloadWithRole } from '../middleware/authenticate.js';
import { safeWhere } from '../entity/base.js';
import { ds } from '../db.js';

// 共通インターフェース
export interface ScopedEntity {
    id?: string;
    name: string;
    scopeInfo: {
        scopeType: ScopeType;
        scopeId: string;
    };
    orgKey: string;
    isActive: boolean;
    createdAt?: Date;
    updatedAt?: Date;
    createdBy?: string;
    updatedBy?: string;
    updatedIp?: string;
    createdIp?: string;
}

export interface ScopeQueryOptions {
    additionalFilters?: Record<string, any>;
    includeInactive?: boolean;
    includeOverridden?: boolean;
}

/**
 * スコープ関連のユーティリティ関数群
 */
export class ScopeUtils {
    /**
     * スコープ優先順位
     * USER > DIVISION > ORGANIZATION の順で優先
     */
    static readonly SCOPE_PRIORITY = [ScopeType.USER, ScopeType.PROJECT, ScopeType.TEAM, ScopeType.DIVISION, ScopeType.ORGANIZATION, ScopeType.GLOBAL] as const;
    static readonly ADMIN_ROLE_TYPES = [UserRoleType.Admin, UserRoleType.SuperAdmin] as UserRoleType[];

    /**
     * スコープタイプに基づいてスコープIDを解決
     */
    static async resolveScopeId(
        scopeType: ScopeType,
        user: UserTokenPayloadWithRole,
        scopeId?: string
    ): Promise<string> {
        switch (scopeType) {
            case ScopeType.ORGANIZATION:
                const org = await ds.getRepository(OrganizationEntity).findOneBy(safeWhere({
                    orgKey: user.orgKey,
                }));
                if (!org) {
                    throw new Error('指定された組織が見つかりません');
                }
                return org.id;
            case ScopeType.DIVISION:
                // scopeIdが指定されている場合
                if (scopeId) {
                    // ユーザーが指定されたdivisionに管理権限を持つかチェック
                    const hasPermission = user.roleList.some(role =>
                        role.scopeInfo.scopeType === ScopeType.DIVISION &&
                        role.scopeInfo.scopeId === scopeId &&
                        ScopeUtils.ADMIN_ROLE_TYPES.includes(role.role)
                    );
                    if (!hasPermission) {
                        throw new Error('指定された部門に対する管理権限がありません');
                    }
                    return scopeId;
                }

                // scopeIdが指定されていない場合、ユーザーが管理権限を持つ部門を取得
                const divisionRoles = user.roleList.filter(role =>
                    role.scopeInfo.scopeType === ScopeType.DIVISION &&
                    ScopeUtils.ADMIN_ROLE_TYPES.includes(role.role)
                );

                if (divisionRoles.length === 0) {
                    throw new Error('管理権限を持つ部門が見つかりません');
                }

                if (divisionRoles.length > 1) {
                    throw new Error('複数の部門に管理権限があります。scopeIdパラメータで部門を指定してください');
                }

                return divisionRoles[0].scopeInfo.scopeId;

            case ScopeType.USER:
                return user.id;

            default:
                throw new Error(`未対応のスコープタイプ: ${scopeType}`);
        }
    }

    /**
     * ユーザーのロールリストからスコープ条件を生成
     */
    static generateScopeConditions(user: UserTokenPayloadWithRole, baseCriteria: any = {}): any[] {
        return user.roleList.map(role => {
            const condition = {
                ...baseCriteria,
                orgKey: user.orgKey,
                scopeInfo: {
                    scopeType: role.scopeInfo.scopeType,
                    scopeId: role.scopeInfo.scopeId,
                },
                isActive: true,
            };
            return safeWhere(condition);
        });
    }

    /**
     * エンティティ配列をスコープ優先順位でソート
     */
    static sortByScopePriority<T extends ScopedEntity>(roles: UserRole[], entities: T[]): T[] {
        const priorityMap: Record<string, number> = Object.fromEntries(
            roles.map((role, index) => [`${role.scopeInfo.scopeType}:${role.scopeInfo.scopeId}`, role.priority])
        );
        return entities.sort((a, b) => {
            const scopePriorityA = this.SCOPE_PRIORITY.indexOf(a.scopeInfo.scopeType);
            const scopePriorityB = this.SCOPE_PRIORITY.indexOf(b.scopeInfo.scopeType);
            if (scopePriorityA !== scopePriorityB) {
                return scopePriorityA - scopePriorityB;
            }
            // 同じスコープ優先順位の場合はpriorityで比較
            return priorityMap[`${b.scopeInfo.scopeType}:${b.scopeInfo.scopeId}`] - priorityMap[`${a.scopeInfo.scopeType}:${a.scopeInfo.scopeId}`];
        });
    }

    /**
     * 同名エンティティの重複排除（スコープ優先順位考慮）
     */
    static deduplicateByNameAndPriority<T extends ScopedEntity>(roles: UserRole[], entities: T[], key: string = 'name'): T[] {
        const entityMap = entities.reduce((prev, _curr) => {
            const curr = _curr as T & { [key: string]: string };
            if (!prev[curr[key]]) {
                prev[curr[key]] = [];
            }
            prev[curr[key]].push(curr);
            return prev;
        }, {} as Record<string, T[]>);

        // 各名前について優先順位でソートして最優先のものを選択
        return Object.keys(entityMap).map(name => {
            const sorted = this.sortByScopePriority(roles, entityMap[name]);
            return sorted[0];
        });
    }

    /**
     * ユーザーが指定されたスコープに対する権限を持つかチェック
     */
    static validateScopePermission(user: UserTokenPayloadWithRole, scopeType: ScopeType, scopeId?: string): boolean {
        return user.roleList.some(role => {
            if (role.scopeInfo.scopeType !== scopeType) return false;
            if (scopeId && role.scopeInfo.scopeId !== scopeId) return false;
            // 管理権限のチェック
            return ScopeUtils.ADMIN_ROLE_TYPES.includes(role.role);
        });
    }

    /**
     * ユーザーが指定されたスコープにアクセス権を持つかチェック
     */
    static async hasAccessToScope(user: UserTokenPayloadWithRole, scopeType: ScopeType, scopeId: string): Promise<boolean> {
        return user.roleList.some(role =>
            role.scopeInfo.scopeType === scopeType &&
            role.scopeInfo.scopeId === scopeId
        );
    }
}

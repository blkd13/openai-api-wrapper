import { Repository, Not } from 'typeorm';
import { ScopedEntity, ScopeQueryOptions, ScopeUtils } from './scope-utils.js';
import { UserTokenPayload } from '../middleware/authenticate.js';
import { safeWhere } from '../entity/base.js';

export interface ScopeServiceOptions extends ScopeQueryOptions {
    scopeId?: string;
}

/**
 * スコープ対応エンティティの汎用サービス
 */
export class ScopedEntityService {
    /**
     * 名前による検索（スコープ優先順位考慮）
     */
    static async findByNameWithScope<T extends ScopedEntity>(
        repository: Repository<T>,
        name: string,
        user: UserTokenPayload,
        options: ScopeQueryOptions = {}
    ): Promise<T | null> {
        const baseCriteria = {
            name,
            ...(options.additionalFilters || {}),
            ...(options.includeInactive ? {} : { isActive: true }),
        };

        const scopeConditions = ScopeUtils.generateScopeConditions(user, baseCriteria);

        const entities = await repository.find({
            where: scopeConditions,
        });

        if (entities.length === 0) {
            return null;
        }

        // スコープ優先順位でソートして最優先のものを返す
        const sorted = ScopeUtils.sortByScopePriority(entities);
        return sorted[0];
    }

    /**
     * 一覧取得（スコープ優先順位考慮、重複排除）
     */
    static async findAllWithScope<T extends ScopedEntity>(
        repository: Repository<T>,
        user: UserTokenPayload,
        options: ScopeQueryOptions = {}
    ): Promise<T[]> {
        const baseCriteria = {
            ...(options.additionalFilters || {}),
            ...(options.includeInactive ? {} : { isActive: true }),
        };

        const scopeConditions = ScopeUtils.generateScopeConditions(user, baseCriteria);

        const allEntities = await repository.find({
            where: scopeConditions,
            order: { createdAt: 'DESC' } as any,
        });

        return options.includeOverridden
            ? ScopeUtils.sortByScopePriority(allEntities) // 重複排除無し スコープ優先順位でソート
            : ScopeUtils.deduplicateByNameAndPriority(allEntities); // 重複排除（同名エンティティでスコープ優先順位を考慮）
    }

    /**
     * 重複チェック（同一スコープ内）
     */
    static async checkDuplicateInScope<T extends ScopedEntity>(
        repository: Repository<T>,
        entity: Partial<T>,
        user: UserTokenPayload,
        excludeId?: string,
        scopeId?: string
    ): Promise<T | null> {
        if (!entity.name || !entity.scopeInfo) {
            throw new Error('name と scopeInfo は必須です');
        }

        // スコープIDを解決
        const resolvedScopeId = await ScopeUtils.resolveScopeId(entity.scopeInfo.scopeType, user, scopeId);

        const conflictWhere: any = {
            name: entity.name,
            orgKey: user.orgKey,
            scopeInfo: {
                scopeType: entity.scopeInfo.scopeType,
                scopeId: resolvedScopeId,
            },
        };

        if (excludeId) {
            conflictWhere.id = Not(excludeId);
        }

        return await repository.findOne({
            where: safeWhere(conflictWhere),
        });
    }
    /**
     * スコープ情報を設定してエンティティを準備
     */
    static async prepareScopedEntity<T extends ScopedEntity>(
        entity: Partial<T>,
        user: UserTokenPayload,
        scopeId?: string
    ): Promise<Partial<T>> {
        if (!entity.scopeInfo) {
            throw new Error('scopeInfo は必須です');
        }

        // スコープIDを解決
        const resolvedScopeId = await ScopeUtils.resolveScopeId(entity.scopeInfo.scopeType, user, scopeId);

        return {
            ...entity,
            orgKey: user.orgKey,
            scopeInfo: {
                scopeType: entity.scopeInfo.scopeType,
                scopeId: resolvedScopeId,
            },
        };
    }
}

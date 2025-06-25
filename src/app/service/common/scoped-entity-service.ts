import { Repository, Not, FindOptionsWhere } from 'typeorm';
import { ScopedEntity, ScopeQueryOptions, ScopeUtils } from './scope-utils.js';
import { UserTokenPayloadWithRole } from '../middleware/authenticate.js';
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
        user: UserTokenPayloadWithRole,
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
        user: UserTokenPayloadWithRole,
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
     * @returns { entity: T | null, isActive: boolean } - 重複エンティティとそのアクティブ状態
     */
    static async checkDuplicateInScope<T extends ScopedEntity>(
        repository: Repository<T>,
        entity: Partial<T>,
        user: UserTokenPayloadWithRole,
        excludeId?: string,
        scopeId?: string
    ): Promise<{ entity: T | null; isActive: boolean }> {
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

        const conflictEntity = await repository.findOne({
            where: safeWhere(conflictWhere),
        });

        return {
            entity: conflictEntity,
            isActive: conflictEntity?.isActive ?? false
        };
    }
    /**
     * スコープ情報を設定してエンティティを準備
     */
    static async prepareScopedEntity<T extends ScopedEntity>(
        entity: Partial<T>,
        user: UserTokenPayloadWithRole,
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

    /**
     * スコープ対応のUpsert操作
     */
    static async upsertWithScope<T extends ScopedEntity>(
        repository: Repository<T>,
        user: UserTokenPayloadWithRole,
        existingId: string | undefined,
        entityData: Partial<T>,
        userIp: string,
        options: {
            uniqueFields?: string[];
            beforeSave?: (entity: T, isNew: boolean) => Promise<void> | void;
        } = {}
    ): Promise<{ entity: T; isNew: boolean }> {
        let entity: T | null = null;
        let isNew = true;

        // 既存レコードチェック
        if (existingId) {
            entity = await repository.findOne({
                where: safeWhere({ id: existingId, orgKey: user.orgKey }) as FindOptionsWhere<T>,
            });

            if (entity && entityData.scopeInfo) {
                // scopeが異なる場合は新規作成として扱う（scope immutable）
                const resolvedScopeId = await ScopeUtils.resolveScopeId(
                    entityData.scopeInfo.scopeType,
                    user,
                    entityData.scopeInfo.scopeId
                );

                if (entity.scopeInfo.scopeType !== entityData.scopeInfo.scopeType ||
                    entity.scopeInfo.scopeId !== resolvedScopeId) {
                    entity = null;
                    isNew = true;
                } else {
                    isNew = false;
                }
            }
        }        // 重複チェック（同一スコープ内）
        if (options.uniqueFields && entityData.scopeInfo) {
            for (const field of options.uniqueFields) {
                if (entityData[field as keyof T]) {
                    const conflictResult = await this.checkDuplicateInScope(
                        repository,
                        { ...entityData, [field]: entityData[field as keyof T] },
                        user,
                        existingId
                    );

                    if (conflictResult.entity) {
                        if (conflictResult.isActive) {
                            // アクティブな重複エンティティが存在する場合はエラー
                            throw new Error(`Conflict: ${field}=${entityData[field as keyof T]}の値が既にアクティブなエンティティで存在します`);
                        } else {
                            // 非アクティブな重複エンティティが存在する場合は、それを復活させる
                            console.log(`Found inactive duplicate entity, reactivating: ${conflictResult.entity.id}`);
                            entity = conflictResult.entity;
                            isNew = false;
                            // 非アクティブから復活させるため、isActiveをtrueに設定
                            entityData = { ...entityData, isActive: true } as Partial<T>;
                            break; // 最初に見つかった非アクティブエンティティを使用
                        }
                    }
                }
            }
        }

        // スコープ情報を準備
        const preparedEntity = await this.prepareScopedEntity(entityData, user);

        if (isNew) {
            // console.log('Creating new entity with scope:', preparedEntity.scopeInfo);
            // 新規作成
            entity = repository.create({
                ...preparedEntity,
                createdBy: user.id,
                createdIp: userIp,
            } as unknown as T);
        } else {
            // console.log('Updating existing entity with scope:', entity!.scopeInfo);
            // 更新 - scopeは不変なので更新しない
            Object.assign(entity!, {
                ...entityData,
                // 更新禁止項目を除外
                id: entity!.id, // 既存のIDを保持
                orgKey: entity!.orgKey, // 既存の orgKey を保持
                scopeInfo: entity!.scopeInfo, // 既存の scopeInfo を保持
                createdAt: entity!.createdAt, // 既存の createdAt を保持
                createdBy: entity!.createdBy, // 既存の createdBy を保持
                createdIp: entity!.createdIp, // 既存の createdIp を保持
            });
        }

        // カスタム処理があれば実行
        if (options.beforeSave) {
            await options.beforeSave(entity!, isNew);
        }

        // 共通フィールドの設定
        entity!.orgKey = user.orgKey;
        entity!.updatedBy = user.id;
        entity!.updatedIp = userIp;

        if (isNew) {
            entity!.createdBy = user.id;
            entity!.createdIp = userIp;
        }

        const saved = await repository.save(entity!);
        return { entity: saved, isNew };
    }

    /**
     * スコープを考慮したエンティティの削除（論理削除）
     */
    static async deleteWithScope<T extends ScopedEntity>(
        repository: Repository<T>,
        user: UserTokenPayloadWithRole,
        entityId: string,
        options: {
            userIp?: string;
            physicalDelete?: boolean; // 物理削除フラグ
        } = {}
    ): Promise<boolean> {
        const entity = await repository.findOne({
            where: safeWhere({
                id: entityId,
                orgKey: user.orgKey
            }) as FindOptionsWhere<T>
        });

        if (!entity) {
            return false;
        }

        // スコープ権限チェック
        const hasAccess = await ScopeUtils.hasAccessToScope(user, entity.scopeInfo.scopeType, entity.scopeInfo.scopeId);
        if (!hasAccess) {
            throw new Error('Access denied: この操作を実行する権限がありません');
        }

        if (options.physicalDelete) {
            // 物理削除
            await repository.delete({ id: entityId, orgKey: user.orgKey } as FindOptionsWhere<T>);
        } else {
            // 論理削除
            entity.isActive = false;
            entity.updatedBy = user.id;
            entity.updatedIp = options.userIp;
            await repository.save(entity);
        }

        return true;
    }
}

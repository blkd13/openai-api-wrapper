import fss from '../fss.js';

export interface PredictHistoryLogEntry {
    idempotencyKey: string;
    argsHash: string;
    label?: string;
    provider: string;
    model?: string;
    take?: number;
    reqToken?: number;
    resToken?: number;
    cost?: number;
    status?: string;
    message?: string;
    orgKey?: string;
    userId?: string;
    ip?: string;
    historyFile?: string;
    line?: string;
}

export interface PredictHistoryLoggerDependencies {
    dataSource?: PredictHistoryDataSource;
    entityCtor?: PredictHistoryEntityCtor;
    onError?: (error: unknown) => void;
    fileWriter?: typeof fss;
}

export type PredictHistoryDataSource = {
    transaction<T>(runInTransaction: (manager: PredictHistoryEntityManager) => Promise<T>): Promise<T>;
    getRepository?<T>(entity: PredictHistoryEntityCtor): PredictHistoryRepository<T>;
};

export type PredictHistoryEntityManager = {
    save?<T>(entity: T): Promise<T>;
    getRepository?<T>(entity: PredictHistoryEntityCtor): PredictHistoryRepository<T>;
};

export type PredictHistoryEntityCtor = new () => PredictHistoryEntity;

export type PredictHistoryEntity = {
    idempotencyKey: string;
    argsHash: string;
    label?: string;
    provider: string;
    model?: string;
    take?: number;
    reqToken?: number;
    resToken?: number;
    cost?: number;
    status?: string;
    message?: string;
    orgKey: string;
    createdBy: string;
    updatedBy: string;
    createdIp?: string;
    updatedIp?: string;
};

export interface PredictHistoryRepository<T> {
    save(entity: T): Promise<T>;
}

export class PredictHistoryLogger {
    private depsPromise?: Promise<{ dataSource: PredictHistoryDataSource, entityCtor: PredictHistoryEntityCtor }>;
    private fileWriter: typeof fss;

    constructor(private readonly overrides: PredictHistoryLoggerDependencies = {}) {
        this.fileWriter = overrides.fileWriter || fss;
    }

    async appendHistoryLine(line: string, filepath = 'history.log'): Promise<void> {
        await new Promise<void>((resolve, reject) => {
            this.fileWriter.appendFile(filepath, `${line}\n`, (err) => err ? reject(err) : resolve());
        });
    }

    async log(entry: PredictHistoryLogEntry): Promise<void> {
        if (entry.line) {
            try {
                await this.appendHistoryLine(entry.line, entry.historyFile);
            } catch (error) {
                this.overrides.onError?.(error);
            }
        }
        try {
            const { dataSource, entityCtor } = await this.resolveDependencies();
            await dataSource.transaction(async (manager) => {
                const entity = new entityCtor();
                entity.idempotencyKey = entry.idempotencyKey;
                entity.argsHash = entry.argsHash;
                entity.label = entry.label;
                entity.provider = entry.provider;
                entity.model = entry.model;
                entity.take = entry.take;
                entity.reqToken = entry.reqToken;
                entity.resToken = entry.resToken;
                entity.cost = entry.cost;
                entity.status = entry.status as any;
                entity.message = entry.message;
                entity.orgKey = entry.orgKey || 'unknown';
                entity.createdBy = entry.userId || 'batch';
                entity.updatedBy = entry.userId || 'batch';
                if (entry.ip) {
                    entity.createdIp = entry.ip;
                    entity.updatedIp = entry.ip;
                }
                await this.persistEntity(manager, dataSource, entityCtor, entity);
            });
        } catch (error) {
            if (this.overrides.onError) {
                this.overrides.onError(error);
            } else {
                console.log(error);
            }
        }
    }

    private async persistEntity(
        manager: PredictHistoryEntityManager,
        dataSource: PredictHistoryDataSource,
        entityCtor: PredictHistoryEntityCtor,
        entity: PredictHistoryEntity,
    ): Promise<void> {
        if (typeof manager.save === 'function') {
            await manager.save(entity);
            return;
        }
        if (typeof manager.getRepository === 'function') {
            await manager.getRepository(entityCtor).save(entity);
            return;
        }
        if (typeof dataSource.getRepository === 'function') {
            await dataSource.getRepository(entityCtor).save(entity);
            return;
        }
        throw new Error('PredictHistoryLogger: no repository available to save entity');
    }

    private async resolveDependencies(): Promise<{ dataSource: PredictHistoryDataSource, entityCtor: PredictHistoryEntityCtor }> {
        if (this.depsPromise) {
            return this.depsPromise;
        }
        this.depsPromise = (async () => {
            const [dbModule, entityModule] = await Promise.all([
                this.overrides.dataSource ? undefined : import('../../service/db.js'),
                this.overrides.entityCtor ? undefined : import('../../service/entity/project-models.entity.js'),
            ]);
            const dataSource = this.overrides.dataSource || (dbModule as { ds: PredictHistoryDataSource }).ds;
            const entityCtor = this.overrides.entityCtor || (entityModule as { PredictHistoryEntity: PredictHistoryEntityCtor }).PredictHistoryEntity;
            return { dataSource, entityCtor };
        })();
        return this.depsPromise;
    }
}

const defaultLogger = new PredictHistoryLogger();

export function getPredictHistoryLogger(overrides?: PredictHistoryLoggerDependencies): PredictHistoryLogger {
    if (overrides) {
        return new PredictHistoryLogger(overrides);
    }
    return defaultLogger;
}

export async function writePredictHistory(entry: PredictHistoryLogEntry, overrides?: PredictHistoryLoggerDependencies): Promise<void> {
    return getPredictHistoryLogger(overrides).log(entry);
}

export interface PredictHistoryWrapperLogEntry {
    label: string;
    provider: string;
    model: string;
    connectionId?: string;
    streamId?: string;
    messageId?: string;
    orgKey?: string;
    userId?: string;
    ip?: string;
}

export interface PredictHistoryWrapperLoggerDependencies {
    dataSource?: PredictHistoryDataSource;
    entityCtor?: PredictHistoryWrapperEntityCtor;
}

export type PredictHistoryWrapperEntityCtor = new () => PredictHistoryWrapperEntity;

export type PredictHistoryWrapperEntity = {
    connectionId?: string;
    streamId?: string;
    messageId?: string;
    label?: string;
    model: string;
    provider: string;
    orgKey: string;
    createdBy: string;
    updatedBy: string;
    createdIp?: string;
    updatedIp?: string;
};

let wrapperDepsPromise: Promise<{ dataSource: PredictHistoryDataSource, entityCtor: PredictHistoryWrapperEntityCtor }> | undefined;

async function resolveWrapperDependencies(overrides?: PredictHistoryWrapperLoggerDependencies): Promise<{ dataSource: PredictHistoryDataSource, entityCtor: PredictHistoryWrapperEntityCtor }> {
    if (wrapperDepsPromise && !overrides) {
        return wrapperDepsPromise;
    }
    const deps = (async () => {
        const [dbModule, entityModule] = await Promise.all([
            overrides?.dataSource ? undefined : import('../../service/db.js'),
            overrides?.entityCtor ? undefined : import('../../service/entity/project-models.entity.js'),
        ]);
        const dataSource = overrides?.dataSource || (dbModule as { ds: PredictHistoryDataSource }).ds;
        const entityCtor = overrides?.entityCtor || (entityModule as { PredictHistoryWrapperEntity: PredictHistoryWrapperEntityCtor }).PredictHistoryWrapperEntity;
        return { dataSource, entityCtor };
    })();
    if (!overrides) {
        wrapperDepsPromise = deps;
    }
    return deps;
}

export async function writePredictHistoryWrapper(entry: PredictHistoryWrapperLogEntry, overrides?: PredictHistoryWrapperLoggerDependencies): Promise<void> {
    const { dataSource, entityCtor } = await resolveWrapperDependencies(overrides);
    const entity = new entityCtor();
    entity.label = entry.label;
    entity.provider = entry.provider;
    entity.model = entry.model;
    entity.connectionId = entry.connectionId;
    entity.streamId = entry.streamId;
    entity.messageId = entry.messageId;
    entity.orgKey = entry.orgKey || 'unknown';
    entity.createdBy = entry.userId || 'tool';
    entity.updatedBy = entry.userId || 'tool';
    if (entry.ip) {
        entity.createdIp = entry.ip;
        entity.updatedIp = entry.ip;
    }
    if (!dataSource.getRepository) {
        throw new Error('PredictHistoryWrapper: data source repository unavailable');
    }
    const repository = (dataSource.getRepository as unknown as (ctor: PredictHistoryWrapperEntityCtor) => PredictHistoryRepository<PredictHistoryWrapperEntity>)(entityCtor);
    await repository.save(entity);
}

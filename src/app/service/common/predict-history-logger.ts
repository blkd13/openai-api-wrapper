import { writePredictHistory, PredictHistoryLogEntry, writePredictHistoryWrapper, PredictHistoryWrapperLogEntry } from '../../common/logging/predict-history.js';
import { UserRequest } from '../models/info.js';

export type ServicePredictHistoryEntry =
    Omit<PredictHistoryLogEntry, 'orgKey' | 'userId' | 'ip'> &
    Partial<Pick<PredictHistoryLogEntry, 'orgKey' | 'userId' | 'ip'>>;

export interface ServicePredictHistoryLogger {
    log(entry: ServicePredictHistoryEntry): Promise<void>;
}

export interface PredictHistoryLogContext {
    idempotencyKey: string;
    argsHash: string;
    label: string;
    provider: string;
    model: string;
    tokenCount?: { prompt?: number; completion?: number; cost?: number; };
    takeMs?: number;
    message?: string;
}

export function createPredictHistoryLogger(context?: { orgKey?: string; userId?: string; ip?: string; }): ServicePredictHistoryLogger {
    return {
        log(entry: ServicePredictHistoryEntry) {
            return writePredictHistory({
                ...entry,
                orgKey: entry.orgKey ?? context?.orgKey,
                userId: entry.userId ?? context?.userId,
                ip: entry.ip ?? context?.ip,
            });
        },
    };
}

export function getPredictHistoryLoggerForRequest(req: UserRequest): ServicePredictHistoryLogger {
    return createPredictHistoryLogger({
        orgKey: req.info.user.orgKey,
        userId: req.info.user.id,
        ip: req.info.ip,
    });
}

export async function logPredictHistoryWithContext(
    logger: ServicePredictHistoryLogger,
    context: PredictHistoryLogContext,
    status?: string,
): Promise<void> {
    return logger.log({
        idempotencyKey: context.idempotencyKey,
        argsHash: context.argsHash,
        label: context.label,
        provider: context.provider,
        model: context.model,
        take: context.takeMs,
        reqToken: context.tokenCount?.prompt,
        resToken: context.tokenCount?.completion,
        cost: context.tokenCount?.cost,
        status,
        message: context.message,
    });
}

export type ServicePredictHistoryWrapperEntry =
    Omit<PredictHistoryWrapperLogEntry, 'orgKey' | 'userId' | 'ip'> &
    Partial<Pick<PredictHistoryWrapperLogEntry, 'orgKey' | 'userId' | 'ip'>>;

export interface ServicePredictHistoryWrapperLogger {
    log(entry: ServicePredictHistoryWrapperEntry): Promise<void>;
}

export function createPredictHistoryWrapperLogger(context?: { orgKey?: string; userId?: string; ip?: string; }): ServicePredictHistoryWrapperLogger {
    return {
        log(entry: ServicePredictHistoryWrapperEntry) {
            return writePredictHistoryWrapper({
                ...entry,
                orgKey: entry.orgKey ?? context?.orgKey,
                userId: entry.userId ?? context?.userId,
                ip: entry.ip ?? context?.ip,
            });
        },
    };
}

export function getPredictHistoryWrapperLoggerForRequest(req: UserRequest): ServicePredictHistoryWrapperLogger {
    return createPredictHistoryWrapperLogger({
        orgKey: req.info.user.orgKey,
        userId: req.info.user.id,
        ip: req.info.ip,
    });
}

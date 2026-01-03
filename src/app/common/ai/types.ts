import type OpenAI from 'openai';
import { RequestOptions } from 'openai/internal/request-options.js';
import type { Subscriber } from 'rxjs';

import { AIModelEntity, AIModelPricingEntity } from '../../service/entity/ai-model-manager.entity.js';
import { Ratelimit } from '../model-definition.js';
import { AIProviderClient } from '../openai-api-wrapper.js';
import { TokenCount } from './token-cost.js';

export interface ExecutorContext {
    aiProvider: AIProviderClient;
    tokenCount: TokenCount;
    commonArgs: OpenAI.ChatCompletionCreateParams;
    options: RequestOptions;
    idempotencyKey: string;
    ratelimitObj: Ratelimit;
    logObject: { output: (stepName: string, error?: any, message?: string) => string };
    observer: Subscriber<OpenAI.ChatCompletionChunk>;
    attempts: number;
    aiModel?: AIModelEntity;
    aiPrice?: AIModelPricingEntity;
}

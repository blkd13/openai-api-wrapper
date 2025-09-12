// src/index.ts
import { OpenAI } from 'openai';
import { Observable } from 'rxjs';

import { RequestQueueManager } from './core/request-queue.js';
import { AiProviderType, getProviderForModel } from './providers/provider-factory.js';
import { IAiProvider } from './types/common.js';
import { Logger, LogLevel } from './utils/logger.js';

/**
 * Options for AI completion requests
 */
export interface CompletionOptions extends OpenAI.RequestOptions {
    /** Optional label for tracking */
    label?: string;
    /** Provider override */
    provider?: AiProviderType;
    /** User ID for tracking */
    userId?: string;
    /** IP address for tracking */
    ip?: string;
    /** Authentication type */
    authType?: string;
    /** Whether to allow access to local files */
    allowLocalFiles?: boolean;
}

/**
 * Main API wrapper for AI providers
 */
export class AIApiWrapper {
    private requestQueueManager: RequestQueueManager;
    private logger: Logger;

    /**
     * Create a new AI API wrapper
     * @param options Configuration options
     */
    constructor(options: { logLevel?: LogLevel } = {}) {
        // Configure logger
        Logger.configure({
            level: options.logLevel || LogLevel.INFO,
            logToConsole: true,
            logToFile: true,
            logDir: './logs'
        });

        this.logger = new Logger('AIApiWrapper');
        this.requestQueueManager = new RequestQueueManager();

        this.logger.info('AIApiWrapper initialized');
    }

    /**
     * Send a chat completion request and stream the response
     * @param args Chat completion parameters
     * @param options Request options
     * @returns Observable stream of completion chunks
     */
    chatCompletionStream(
        args: OpenAI.ChatCompletionCreateParams,
        options: CompletionOptions = {}
    ): Observable<OpenAI.ChatCompletionChunk> {
        // Ensure stream is enabled
        args.stream = true;

        // Get appropriate provider
        const provider = getProviderForModel(args.model, options.provider);

        this.logger.info(
            `Creating chat completion stream with model ${args.model} using ${provider.provider} provider`
        );

        // Generate idempotency key if not provided
        if (!options.idempotencyKey) {
            const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, '');
            const randomId = Math.random().toString(36).substring(2, 10);
            options.idempotencyKey = `${timestamp}-${randomId}`;

            if (options.label) {
                options.idempotencyKey += `-${options.label.replace(/[^a-zA-Z0-9-_]/g, '_')}`;
            }
        }

        // Queue the request
        return this.requestQueueManager.createCompletionObservable(
            args,
            options,
            provider
        );
    }

    /**
     * Get a specific provider
     * @param type Provider type
     * @returns Provider instance
     */
    getProvider(type: AiProviderType): IAiProvider {
        return getProviderForModel('', type);
    }
}

// Export singleton instance
export const aiApi = new AIApiWrapper();

// Export types
export * from './core/token-counter.js';
export * from './providers/provider-factory.js';
export * from './types/common.js';
export * from './utils/logger.js';


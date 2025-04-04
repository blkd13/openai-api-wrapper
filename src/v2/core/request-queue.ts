// src/core/request-queue.ts
import { Observable, Subscriber } from 'rxjs';
import { ChatCompletionCreateParamsBase, ChatCompletionChunk } from 'openai/resources/chat/completions';
import { RequestOptions } from 'openai/core';

import { IAiProvider, RateLimit } from '../types/common.js';
import { TokenCounter } from './token-counter.js';
import { Logger } from '../utils/logger.js';

/**
 * A queued API request
 */
export interface QueuedRequest {
    /** Unique identifier for the request */
    id: string;

    /** Arguments for the request */
    args: ChatCompletionCreateParamsBase;

    /** Options for the request */
    options: RequestOptions;

    /** Subscriber to receive the response */
    subscriber: Subscriber<ChatCompletionChunk>;

    /** Token counter for the request */
    tokenCounter: TokenCounter;

    /** Provider to use for the request */
    provider: IAiProvider;

    /** Number of retries attempted */
    retries: number;
}

/**
 * Manages a queue of API requests with rate limiting
 */
export class RequestQueueManager {
    /** Queued requests waiting to be processed */
    private waitQueue: Map<string, QueuedRequest[]> = new Map();

    /** Requests currently being processed */
    private inProgressQueue: Map<string, QueuedRequest[]> = new Map();

    /** Timeout IDs for rate limit resets */
    private timeoutMap: Map<string, NodeJS.Timeout | null> = new Map();

    /** Logger instance */
    private logger = new Logger('RequestQueueManager');

    /** Maximum number of retries for a request */
    private maxRetries = 5;

    /**
     * Create a queued request object
     * @param args Request arguments
     * @param options Request options
     * @param provider AI provider to use
     * @param subscriber Subscriber for the response
     * @returns A queued request object
     */
    createQueuedRequest(
        args: ChatCompletionCreateParamsBase,
        options: RequestOptions,
        provider: IAiProvider,
        subscriber: Subscriber<ChatCompletionChunk>
    ): QueuedRequest {
        // Create a token counter for the request
        const tokenCounter = new TokenCounter(args.model as any);

        // Calculate prompt tokens (simplified implementation)
        const prompts = args.messages
            .map(m => typeof m.content === 'string' ? m.content : JSON.stringify(m.content))
            .join('\n');
        const tokenEstimate = provider.estimateTokenUsage(args.model, prompts);
        tokenCounter.prompt_tokens = tokenEstimate.prompt_tokens;

        return {
            id: options.idempotencyKey as string || `req-${Date.now()}-${Math.random().toString(36).slice(2)}`,
            args,
            options,
            subscriber,
            tokenCounter,
            provider,
            retries: 0
        };
    }

    /**
     * Queue a request for processing
     * @param request The request to queue
     */
    queueRequest(request: QueuedRequest): void {
        const modelKey = request.tokenCounter.modelShort;

        // Initialize queues for this model if needed
        if (!this.waitQueue.has(modelKey)) {
            this.waitQueue.set(modelKey, []);
        }

        if (!this.inProgressQueue.has(modelKey)) {
            this.inProgressQueue.set(modelKey, []);
        }

        // Add request to wait queue
        this.waitQueue.get(modelKey)!.push(request);
        this.logger.info(`Queued request ${request.id} for model ${modelKey}`);

        // Trigger processing
        this.processQueue();
    }

    /**
     * Process the request queue
     */
    processQueue(): void {
        for (const [modelKey, queue] of this.waitQueue.entries()) {
            if (queue.length === 0) continue;

            const inProgress = this.inProgressQueue.get(modelKey) || [];

            // Get first request to check rate limits
            const firstRequest = queue[0];
            const provider = firstRequest.provider;
            const rateLimits = provider.getRateLimits(firstRequest.args.model);

            // Check if we can process more requests
            const canProcessMore = inProgress.length < rateLimits.remainingRequests &&
                rateLimits.remainingTokens >= firstRequest.tokenCounter.prompt_tokens;

            if (!canProcessMore) {
                this.scheduleRateLimitReset(modelKey, rateLimits);
                continue;
            }

            // Process as many requests as possible
            while (queue.length > 0) {
                const request = queue[0];

                // Check if we can process this request
                if (
                    inProgress.length >= rateLimits.remainingRequests ||
                    rateLimits.remainingTokens < request.tokenCounter.prompt_tokens
                ) {
                    break;
                }

                // Remove from wait queue
                queue.shift();

                // Add to in-progress queue
                inProgress.push(request);
                this.inProgressQueue.set(modelKey, inProgress);

                // Update rate limits
                rateLimits.remainingRequests--;
                rateLimits.remainingTokens -= request.tokenCounter.prompt_tokens;

                // Execute the request
                this.executeRequest(request, modelKey);
            }
        }
    }

    /**
     * Execute a request
     * @param request The request to execute
     * @param modelKey The model key for queue management
     */
    private executeRequest(request: QueuedRequest, modelKey: string): void {
        this.logger.info(`Executing request ${request.id} for model ${modelKey}`);

        try {
            // Execute the request via the provider
            request.provider.chatCompletionStream(
                request.args,
                request.options
            ).subscribe({
                next: (chunk) => {
                    // Forward the chunk to the subscriber
                    request.subscriber.next(chunk);

                    // Update token counter if usage is included
                    if (chunk.usage) {
                        request.tokenCounter.completion_tokens = chunk.usage.completion_tokens || 0;
                        request.tokenCounter.prompt_tokens = chunk.usage.prompt_tokens ||
                            request.tokenCounter.prompt_tokens;
                    }
                },
                error: (error) => {
                    this.handleError(request, modelKey, error);
                },
                complete: () => {
                    this.completeRequest(request, modelKey);
                }
            });
        } catch (error) {
            this.handleError(request, modelKey, error);
        }
    }

    /**
     * Handle an error during request execution
     * @param request The failed request
     * @param modelKey The model key for queue management
     * @param error The error that occurred
     */
    private handleError(request: QueuedRequest, modelKey: string, error: any): void {
        this.logger.error(`Error in request ${request.id}:`, error);

        // Remove from in-progress queue
        const inProgress = this.inProgressQueue.get(modelKey) || [];
        const index = inProgress.findIndex(r => r.id === request.id);
        if (index !== -1) {
            inProgress.splice(index, 1);
            this.inProgressQueue.set(modelKey, inProgress);
        }

        // Check if we should retry
        const shouldRetry = this.shouldRetryRequest(request, error);

        if (shouldRetry) {
            // Increment retry count
            request.retries++;
            this.logger.info(`Retrying request ${request.id} (attempt ${request.retries})`);

            // Re-queue at the front of the line
            const queue = this.waitQueue.get(modelKey) || [];
            queue.unshift(request);
            this.waitQueue.set(modelKey, queue);

            // Schedule retry after delay
            setTimeout(() => this.processQueue(), this.getRetryDelay(request, error));
        } else {
            // Forward error to subscriber and abandon the request
            request.subscriber.error(error);
        }

        // Continue processing the queue
        this.processQueue();
    }

    /**
     * Complete a successful request
     * @param request The completed request
     * @param modelKey The model key for queue management
     */
    private completeRequest(request: QueuedRequest, modelKey: string): void {
        // Calculate final cost
        request.tokenCounter.calcCost();

        this.logger.info(
            `Completed request ${request.id} for model ${modelKey}: ` +
            `${request.tokenCounter.prompt_tokens} prompt tokens, ` +
            `${request.tokenCounter.completion_tokens} completion tokens, ` +
            `cost $${request.tokenCounter.cost.toFixed(4)}`
        );

        // Complete the subscriber
        request.subscriber.complete();

        // Remove from in-progress queue
        const inProgress = this.inProgressQueue.get(modelKey) || [];
        const index = inProgress.findIndex(r => r.id === request.id);
        if (index !== -1) {
            inProgress.splice(index, 1);
            this.inProgressQueue.set(modelKey, inProgress);
        }

        // Continue processing the queue
        this.processQueue();
    }

    /**
     * Determine if a request should be retried
     * @param request The failed request
     * @param error The error that occurred
     * @returns Whether to retry the request
     */
    private shouldRetryRequest(request: QueuedRequest, error: any): boolean {
        // Don't retry if max retries reached
        if (request.retries >= this.maxRetries) {
            return false;
        }

        // Don't retry 400 errors (bad request)
        if (error.toString().includes('400')) {
            return false;
        }

        // Retry rate limit errors
        if (
            error.toString().includes('429') ||
            error.toString().includes('Overloaded')
        ) {
            return true;
        }

        // Retry authorization errors with Vertex AI
        if (
            error.toString().includes('401 Unauthorized') &&
            request.provider.provider.includes('vertex')
        ) {
            return true;
        }

        // Retry server errors
        if (
            error.toString().includes('500') ||
            error.toString().includes('502') ||
            error.toString().includes('503') ||
            error.toString().includes('504')
        ) {
            return true;
        }

        return false;
    }

    /**
     * Calculate retry delay based on error and attempt count
     * @param request The failed request
     * @param error The error that occurred
     * @returns Delay in milliseconds before retrying
     */
    private getRetryDelay(request: QueuedRequest, error: any): number {
        // For rate limit errors, use the retry-after header or a default value
        if (error.toString().includes('429')) {
            // Extract retry-after from error if available
            const retryAfterMatch = error.toString().match(/retry after (\d+)([ms])/i);
            if (retryAfterMatch) {
                const value = Number(retryAfterMatch[1]);
                const unit = retryAfterMatch[2];
                return unit === 's' ? value * 1000 : value;
            }

            // Use rate limit reset information
            const rateLimits = request.provider.getRateLimits(request.args.model);
            const waitMs = Number(String(rateLimits.resetRequests).replace('ms', '')) || 0;
            const waitS = Number(String(rateLimits.resetTokens).replace('s', '')) || 0;

            return waitMs > 0 ? waitMs : (waitS || 60) * 1000;
        }

        // Exponential backoff for other errors
        return Math.min(1000 * Math.pow(2, request.retries), 30000);
    }

    /**
     * Schedule a timeout to check the queue after rate limits reset
     * @param modelKey The model key for queue management
     * @param rateLimits Current rate limits
     */
    private scheduleRateLimitReset(modelKey: string, rateLimits: RateLimit): void {
        // Check if timeout already set
        if (this.timeoutMap.get(modelKey)) {
            return;
        }

        // Get wait time from rate limit info
        let waitMs = Number(String(rateLimits.resetRequests).replace('ms', '')) || 0;
        let waitS = Number(String(rateLimits.resetTokens).replace('s', '')) || 0;

        // Default to 60s if no wait time specified
        waitMs = waitMs > 0 ? waitMs : (waitS || 60) * 1000;

        this.logger.info(`Scheduling rate limit reset for ${modelKey} in ${waitMs}ms`);

        // Set timeout to retry after rate limit resets
        const timeout = setTimeout(() => {
            this.logger.info(`Rate limit reset for ${modelKey}`);
            this.timeoutMap.set(modelKey, null);

            // Reset rate limits
            const firstRequest = this.waitQueue.get(modelKey)?.[0];
            if (firstRequest) {
                const provider = firstRequest.provider;
                const rateLimits = provider.getRateLimits(firstRequest.args.model);

                // Reset to default values
                rateLimits.remainingRequests = rateLimits.limitRequests;
                rateLimits.remainingTokens = rateLimits.limitTokens;
            }

            // Process queue with reset limits
            this.processQueue();
        }, waitMs);

        this.timeoutMap.set(modelKey, timeout);
    }

    /**
     * Create an observable for a chat completion request
     * @param args Request arguments
     * @param options Request options
     * @param provider AI provider to use
     * @returns Observable for the streamed response
     */
    createCompletionObservable(
        args: ChatCompletionCreateParamsBase,
        options: RequestOptions,
        provider: IAiProvider
    ): Observable<ChatCompletionChunk> {
        return new Observable<ChatCompletionChunk>(subscriber => {
            const request = this.createQueuedRequest(
                args,
                options,
                provider,
                subscriber
            );

            this.queueRequest(request);

            // Return cleanup function
            return () => {
                // Handle cancellation by removing from queues
                const modelKey = request.tokenCounter.modelShort;

                const waitQueue = this.waitQueue.get(modelKey) || [];
                const waitIndex = waitQueue.findIndex(r => r.id === request.id);
                if (waitIndex !== -1) {
                    waitQueue.splice(waitIndex, 1);
                    this.waitQueue.set(modelKey, waitQueue);
                }

                const inProgress = this.inProgressQueue.get(modelKey) || [];
                const inProgressIndex = inProgress.findIndex(r => r.id === request.id);
                if (inProgressIndex !== -1) {
                    // Can't really cancel an in-progress request, but we can remove it from our tracking
                    inProgress.splice(inProgressIndex, 1);
                    this.inProgressQueue.set(modelKey, inProgress);
                }
            };
        });
    }
}
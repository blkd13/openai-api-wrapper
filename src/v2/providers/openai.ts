// src/providers/openai.ts
import OpenAI from 'openai';
import { Stream } from 'openai/streaming.js';
import { Observable, Subscriber } from 'rxjs';

import { SHORT_NAME } from '../config/model-definition.js';
import { TokenCounter } from '../core/token-counter.js';
import { IAiProvider, RateLimit, TokenUsage } from '../types/common.js';
import { Logger } from '../utils/logger.js';
import { normalizeMessages } from '../utils/message-formatter.js';

/**
 * OpenAI API Provider implementation
 */
export class OpenAIProvider implements IAiProvider {
    readonly provider = 'openai';
    private client: OpenAI;
    private rateLimits: Record<string, RateLimit> = {};
    private logger = new Logger('OpenAIProvider');

    /**
     * Initialize the OpenAI provider
     */
    constructor() {
        this.client = new OpenAI({
            apiKey: process.env['OPENAI_API_KEY'] || 'dummy',
        });

        // Initialize rate limit defaults
        this.initializeRateLimits();
    }

    /**
     * Initialize default rate limits for OpenAI models
     */
    private initializeRateLimits(): void {
        // Set up default rate limits for common models
        const defaultLimit: RateLimit = {
            maxTokens: 4096,
            limitRequests: 500,
            limitTokens: 150000,
            remainingRequests: 500,
            remainingTokens: 150000,
            resetRequests: '',
            resetTokens: ''
        };

        // Apply to common models
        ['gpt-3.5-turbo', 'gpt-4', 'gpt-4-turbo'].forEach(model => {
            const shortName = SHORT_NAME[model] || model;
            this.rateLimits[shortName] = { ...defaultLimit };
        });
    }

    /**
     * Stream a chat completion from OpenAI
     * @param args Chat completion parameters
     * @param options Request options
     * @returns Observable stream of completion chunks
     */
    chatCompletionStream(
        args: OpenAI.ChatCompletionCreateParams,
        options: OpenAI.RequestOptions
    ): Observable<OpenAI.ChatCompletionChunk> {
        return new Observable<OpenAI.ChatCompletionChunk>((subscriber) => {
            // Force streaming mode
            args.stream = true;
            args.stream_options = { include_usage: true };

            // Normalize messages
            normalizeMessages(args as any, false).subscribe({
                next: ({ args: normalizedArgs, countObject }) => {
                    this.executeStreamRequest(normalizedArgs, options, subscriber);
                },
                error: (error) => subscriber.error(error)
            });
        });
    }

    /**
     * Execute the streaming API request
     * @param args Normalized chat completion parameters
     * @param options Request options
     * @param subscriber Subscriber to emit results to
     */
    private executeStreamRequest(
        args: OpenAI.ChatCompletionCreateParams,
        options: OpenAI.RequestOptions,
        subscriber: Subscriber<OpenAI.ChatCompletionChunk>
    ): void {
        const modelShort = SHORT_NAME[args.model] || args.model;
        const tokenCounter = new TokenCounter(args.model as any);

        // Count input tokens
        const prompt = args.messages
            .map(message =>
                `<im_start>${message.role}\n${typeof message.content === 'string'
                    ? message.content
                    : message.content?.map(content =>
                        content.type === 'text' ? content.text : ''
                    ).join('')
                }<im_end>`
            )
            .join('\n');

        tokenCounter.prompt_tokens = tokenCounter.estimateTokens(prompt).prompt_tokens;

        this.logger.info(
            `Making request to ${args.model} with ${tokenCounter.prompt_tokens} prompt tokens`
        );

        // Make the API call
        (this.client.chat.completions.create(args, options))
            .withResponse()
            .then(response => {
                // Update rate limits from headers
                this.updateRateLimitsFromHeaders(modelShort, response.response.headers);

                // Process the streaming response
                const reader = (response.data as Stream<OpenAI.ChatCompletionChunk>).toReadableStream().getReader();
                let tokenBuilder = '';

                const readStream = async () => {
                    while (true) {
                        const { value, done } = await reader.read();

                        if (done) {
                            tokenCounter.cost = tokenCounter.calcCost();
                            this.logger.info(
                                `Completed request: ${tokenCounter.completion_tokens} completion tokens, cost: $${tokenCounter.cost.toFixed(4)}`
                            );
                            subscriber.complete();
                            break;
                        }

                        // Decode chunk and parse JSON
                        const content = new TextDecoder().decode(value);
                        if (!content) continue;

                        const chunk: OpenAI.ChatCompletionChunk = JSON.parse(content);

                        // Build token string for counting
                        tokenBuilder += chunk.choices
                            .map(choice => choice.delta?.content || '')
                            .join('');

                        tokenCounter.tokenBuilder = tokenBuilder;

                        // Update token counts from usage info
                        if (chunk.usage) {
                            tokenCounter.prompt_tokens = chunk.usage.prompt_tokens || tokenCounter.prompt_tokens;
                            tokenCounter.completion_tokens = chunk.usage.completion_tokens || 0;
                        }

                        // Emit chunk to subscriber
                        subscriber.next(chunk);
                    }
                };

                readStream().catch(error => {
                    this.logger.error('Error in stream reading', error);
                    subscriber.error(error);
                });
            })
            .catch(error => {
                this.logger.error('API request error', error);
                subscriber.error(error);
            });
    }

    /**
     * Update rate limit information from response headers
     * @param modelShort Short model name
     * @param headers Response headers
     */
    private updateRateLimitsFromHeaders(modelShort: string, headers: Headers): void {
        if (!this.rateLimits[modelShort]) {
            // Initialize if not exists
            this.rateLimits[modelShort] = {
                maxTokens: 4096,
                limitRequests: 1,
                limitTokens: 1,
                remainingRequests: 1,
                remainingTokens: 0,
                resetRequests: '',
                resetTokens: ''
            };
        }

        const limits = this.rateLimits[modelShort];

        // Update from headers if available
        headers.get('x-ratelimit-limit-requests') &&
            (limits.limitRequests = Number(headers.get('x-ratelimit-limit-requests')));

        headers.get('x-ratelimit-limit-tokens') &&
            (limits.limitTokens = Number(headers.get('x-ratelimit-limit-tokens')));

        headers.get('x-ratelimit-remaining-requests') &&
            (limits.remainingRequests = Number(headers.get('x-ratelimit-remaining-requests')));

        headers.get('x-ratelimit-remaining-tokens') &&
            (limits.remainingTokens = Number(headers.get('x-ratelimit-remaining-tokens')));

        headers.get('x-ratelimit-reset-requests') &&
            (limits.resetRequests = headers.get('x-ratelimit-reset-requests') || '');

        headers.get('x-ratelimit-reset-tokens') &&
            (limits.resetTokens = headers.get('x-ratelimit-reset-tokens') || '');
    }

    /**
     * Get current rate limit information
     * @param model Model identifier
     * @returns Current rate limits
     */
    getRateLimits(model: string): RateLimit {
        const modelShort = SHORT_NAME[model] || model;

        if (!this.rateLimits[modelShort]) {
            // Return default limits if not set
            return {
                maxTokens: 4096,
                limitRequests: 500,
                limitTokens: 150000,
                remainingRequests: 500,
                remainingTokens: 150000,
                resetRequests: '',
                resetTokens: ''
            };
        }

        return this.rateLimits[modelShort];
    }

    /**
     * Estimate token usage for a prompt
     * @param model Model identifier
     * @param prompt Prompt text
     * @returns Estimated token usage
     */
    estimateTokenUsage(model: string, prompt: string): TokenUsage {
        const counter = new TokenCounter(model as any);
        return counter.estimateTokens(prompt);
    }
}
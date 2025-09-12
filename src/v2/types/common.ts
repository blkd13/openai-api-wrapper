// src/types/common.ts
import { OpenAI } from 'openai';
import { Observable } from 'rxjs';

/**
 * Represents token usage information from AI API responses
 */
export interface TokenUsage {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
}

/**
 * Rate limiting information for AI providers
 */
export interface RateLimit {
    maxTokens: number;
    limitRequests: number;
    limitTokens: number;
    remainingRequests: number;
    remainingTokens: number;
    resetRequests: string;
    resetTokens: string;
}

/**
 * Common interface for all AI provider implementations
 */
export interface IAiProvider {
    /**
     * Provider identifier
     */
    readonly provider: string;

    /**
     * Send a chat completion request and stream the response
     * @param args The chat completion parameters
     * @param options Additional request options
     * @returns Observable stream of chat completion chunks
     */
    chatCompletionStream(
        args: OpenAI.ChatCompletionCreateParams,
        options: OpenAI.RequestOptions
    ): Observable<OpenAI.ChatCompletionChunk>;

    /**
     * Get the current rate limit information for this provider
     * @param model The model identifier
     * @returns Current rate limit information
     */
    getRateLimits(model: string): RateLimit;

    /**
     * Calculate token usage for a request
     * @param model The model identifier
     * @param prompt The prompt text
     * @returns Token usage estimate
     */
    estimateTokenUsage(model: string, prompt: string): TokenUsage;
}
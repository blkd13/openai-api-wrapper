// src/core/token-counter.ts
import { Tiktoken, TiktokenModel, encoding_for_model } from 'tiktoken';

import { TokenUsage } from '../types/common.js';
import { COST_TABLE, SHORT_NAME, GPTModels, GPT4_MODELS } from '../config/model-definition.js';

/**
 * A cache of Tiktoken encoders to avoid recreating them
 */
const encoderCache: Record<TiktokenModel, Tiktoken> = {} as any;

/**
 * Get a cached Tiktoken encoder for a model
 * @param model The model identifier
 * @returns A Tiktoken encoder for the model
 */
export function getEncoder(model: TiktokenModel): Tiktoken {
    if (encoderCache[model]) {
        return encoderCache[model];
    }

    try {
        encoderCache[model] = encoding_for_model(model);
    } catch (ex) {
        // If the tokenizer isn't registered, fall back to gpt-4
        console.warn(`Tokenizer not found for ${model}, falling back to gpt-4`);
        encoderCache[model] = encoding_for_model('gpt-4');
    }

    return encoderCache[model];
}

/**
 * Class to track token usage and calculate costs
 */
export class TokenCounter {
    /** Short model name used for display and cost lookup */
    public readonly modelShort: string;

    /** Model identifier used for token counting */
    public readonly modelTikToken: TiktokenModel;

    /** Running total cost calculation */
    public cost: number = 0;

    /** Content built from the response for token calculation */
    public tokenBuilder: string = '';

    /**
     * Create a new token counter
     * @param model The model identifier
     * @param prompt_tokens Number of tokens in the prompt
     * @param completion_tokens Number of tokens in the completion
     */
    constructor(
        public readonly model: GPTModels,
        public prompt_tokens: number = 0,
        public completion_tokens: number = 0
    ) {
        this.modelShort = SHORT_NAME[model] || model;
        this.modelTikToken = model as TiktokenModel;
    }

    /**
     * Calculate the cost based on current token usage
     * @returns The calculated cost in dollars
     */
    calcCost(): number {
        this.cost = (
            (COST_TABLE[this.modelShort]?.prompt || 0) * this.prompt_tokens +
            (COST_TABLE[this.modelShort]?.completion || 0) * this.completion_tokens
        ) / 1000;

        return this.cost;
    }

    /**
     * Add tokens and costs from another counter
     * @param other Another token counter to add
     * @returns This token counter for chaining
     */
    add(other: TokenCounter): TokenCounter {
        this.cost += other.cost;
        this.prompt_tokens += other.prompt_tokens;
        this.completion_tokens += other.completion_tokens;
        return this;
    }

    /**
     * Create a string representation for logging
     * @returns Formatted token count and cost information
     */
    toString(): string {
        return `${this.modelShort.padEnd(8)} ${this.prompt_tokens.toLocaleString().padStart(6, ' ')} ${this.completion_tokens.toLocaleString().padStart(6, ' ')} ${('$' + (Math.ceil(this.cost * 100) / 100).toFixed(2)).padStart(6, ' ')}`;
    }

    /**
     * Estimate token counts for a given text prompt
     * @param text The prompt text
     * @returns Estimated token usage
     */
    estimateTokens(text: string): TokenUsage {
        // Use the appropriate encoder based on the model
        const tikToken = getEncoder(
            (GPT4_MODELS.indexOf(this.modelTikToken as any) !== -1)
                ? 'gpt-4'
                : this.modelTikToken
        );

        const tokens = tikToken.encode(text).length;

        return {
            prompt_tokens: tokens,
            completion_tokens: 0,
            total_tokens: tokens
        };
    }
}
// src/config/model-definition.ts

/**
 * Rate limit information for a model
 */
export interface Ratelimit {
    maxTokens: number;
    limitRequests: number;
    limitTokens: number;
    remainingRequests: number;
    remainingTokens: number;
    resetRequests: string;
    resetTokens: string;
}

/**
 * Short names for models to use in logs and configuration
 */
export const SHORT_NAME: { [key: string]: string } = {
    'gpt-3.5-turbo': 'gpt-3.5',
    'gpt-3.5-turbo-0125': 'gpt-3.5',
    'gpt-3.5-turbo-0301': 'gpt-3.5',
    'gpt-3.5-turbo-0613': 'gpt-3.5',
    'gpt-3.5-turbo-1106': 'gpt-3.5',
    'gpt-3.5-turbo-16k': 'gpt-3.5',
    'gpt-3.5-turbo-16k-0613': 'gpt-3.5',
    'gpt-3.5-turbo-instruct': 'gpt-3.5',
    'gpt-4': 'gpt-4',
    'gpt-4-0314': 'gpt-4',
    'gpt-4-0613': 'gpt-4',
    'gpt-4-1106-preview': 'gpt-4t',
    'gpt-4-turbo-preview': 'gpt-4t',
    'gpt-4-0125-preview': 'gpt-4t',
    'gpt-4-vision-preview': 'gpt-4v',
    'gpt-4-1106-vision-preview': 'gpt-4v',
    'gpt-4-vision': 'gpt-4v',
    'gpt-4-32k': 'gpt-4-32k',
    'gpt-4-32k-0314': 'gpt-4-32k',
    'gpt-4-32k-0613': 'gpt-4-32k',
    'claude-instant-1.2': 'claude-i',
    'claude-2.0': 'claude-2',
    'claude-2.1': 'claude-2',
    'claude-3-haiku-20240307': 'c3-haiku',
    'claude-3-sonnet-20240229': 'c3-sonnet',
    'claude-3-opus-20240229': 'c3-opus',
    'gemini-pro': 'gemini',
    'gemini-1.0-pro': 'gemini',
    'gemini-1.5-pro': 'gemini-1.5',
    'gemini-1.5-flash': 'gemini-1.5',
    'o1': 'o1',
    'o1-mini': 'o1-mini',
    'o1-preview': 'o1',
    'o3-mini': 'o3-mini',
    'o3': 'o3',
    'mistral-tiny': 'mistral-t',
    'mistral-small': 'mistral-s',
    'mistral-medium': 'mistral-m',
    'mistral-large': 'mistral-l',
    'command-r': 'command-r',
    'command-r-plus': 'command-r+',
    'llama-3-70b-chat': 'llama3-70b',
    'llama-3-8b-chat': 'llama3-8b',
    'meta/llama3-8b-instruct': 'llama3-8b',
    'meta/llama3-70b-instruct': 'llama3-70b',
};

/**
 * Cost table for models (dollars per 1000 tokens)
 */
export const COST_TABLE: { [key: string]: { prompt: number, completion: number } } = {
    'gpt-3.5': { prompt: 0.0015, completion: 0.002 },
    'gpt-4': { prompt: 0.03, completion: 0.06 },
    'gpt-4t': { prompt: 0.01, completion: 0.03 },
    'gpt-4v': { prompt: 0.01, completion: 0.03 },
    'gpt-4-32k': { prompt: 0.06, completion: 0.12 },
    'claude-i': { prompt: 0.00163, completion: 0.00551 },
    'claude-2': { prompt: 0.01102, completion: 0.03268 },
    'c3-haiku': { prompt: 0.00025, completion: 0.00125 },
    'c3-sonnet': { prompt: 0.003, completion: 0.015 },
    'c3-opus': { prompt: 0.015, completion: 0.075 },
    'gemini': { prompt: 0.00025, completion: 0.0005 },
    'gemini-1.5': { prompt: 0.0007, completion: 0.0014 },
    'o1': { prompt: 0.015, completion: 0.075 },
    'o1-mini': { prompt: 0.002, completion: 0.01 },
    'o3': { prompt: 0.015, completion: 0.075 },
    'o3-mini': { prompt: 0.002, completion: 0.01 },
    'mistral-t': { prompt: 0.0014, completion: 0.0014 },
    'mistral-s': { prompt: 0.003, completion: 0.003 },
    'mistral-m': { prompt: 0.0075, completion: 0.0075 },
    'mistral-l': { prompt: 0.0175, completion: 0.0175 },
    'command-r': { prompt: 0.0015, completion: 0.0015 },
    'command-r+': { prompt: 0.005, completion: 0.005 },
    'llama3-8b': { prompt: 0.0001, completion: 0.0001 },
    'llama3-70b': { prompt: 0.0009, completion: 0.0009 },
};

/**
 * Default rate limits for all models
 */
export const currentRatelimit: { [key: string]: Ratelimit } = {};

/**
 * Models that support Vision API
 */
export const VISION_MODELS = [
    'gpt-4-vision-preview',
    'gpt-4-vision',
    'gpt-4-1106-vision-preview',
    'gemini-pro',
    'gemini-1.0-pro',
    'gemini-1.5-pro',
    'claude-3-opus-20240229',
    'claude-3-sonnet-20240229',
    'claude-3-haiku-20240307',
];

/**
 * Models that can be specified to return JSON
 */
export const JSON_MODELS = [
    'gpt-3.5-turbo',
    'gpt-3.5-turbo-0125',
    'gpt-3.5-turbo-1106',
    'gpt-4',
    'gpt-4-0125-preview',
    'gpt-4-1106-preview',
    'gpt-4-turbo-preview',
    'gpt-4-vision-preview',
    'gpt-4-1106-vision-preview',
];

/**
 * GPT-4 model names
 */
export const GPT4_MODELS = [
    'gpt-4',
    'gpt-4-0314',
    'gpt-4-0613',
    'gpt-4-32k',
    'gpt-4-32k-0314',
    'gpt-4-32k-0613',
    'gpt-4-1106-preview',
    'gpt-4-0125-preview',
    'gpt-4-turbo-preview',
    'gpt-4-vision-preview',
    'gpt-4-1106-vision-preview',
];

/**
 * Type definition for OpenAI models
 */
export type GPTModels =
    // GPT-3.5 models
    | 'gpt-3.5-turbo' | 'gpt-3.5-turbo-0125' | 'gpt-3.5-turbo-0301' | 'gpt-3.5-turbo-0613'
    | 'gpt-3.5-turbo-1106' | 'gpt-3.5-turbo-16k' | 'gpt-3.5-turbo-16k-0613'
    | 'gpt-3.5-turbo-instruct'
    // GPT-4 models
    | 'gpt-4' | 'gpt-4-0314' | 'gpt-4-0613' | 'gpt-4-1106-preview' | 'gpt-4-turbo-preview'
    | 'gpt-4-0125-preview' | 'gpt-4-vision-preview' | 'gpt-4-1106-vision-preview'
    | 'gpt-4-32k' | 'gpt-4-32k-0314' | 'gpt-4-32k-0613'
    // Claude models
    | 'claude-instant-1.2' | 'claude-2.0' | 'claude-2.1'
    | 'claude-3-haiku-20240307' | 'claude-3-sonnet-20240229' | 'claude-3-opus-20240229'
    // Gemini models
    | 'gemini-pro' | 'gemini-1.0-pro' | 'gemini-1.5-pro' | 'gemini-1.5-flash'
    // Other models
    | 'o1' | 'o1-mini' | 'o1-preview' | 'o3' | 'o3-mini'
    | 'mistral-tiny' | 'mistral-small' | 'mistral-medium' | 'mistral-large'
    | 'command-r' | 'command-r-plus'
    | 'llama-3-70b-chat' | 'llama-3-8b-chat'
    | 'meta/llama3-8b-instruct' | 'meta/llama3-70b-instruct'
    | 'all';
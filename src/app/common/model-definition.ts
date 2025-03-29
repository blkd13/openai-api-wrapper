import { TiktokenModel } from "tiktoken/tiktoken";

export const VISION_MODELS = ['gpt-4o-mini', 'gpt-4o-2024-07-18', 'gpt-4o', 'gpt-4o-2024-05-13', 'gpt-4-turbo', 'gpt-4-turbo-2024-04-09', 'gpt-4-turbo-preview', 'gpt-4-vision-preview', 'gemini-2.0-flash-exp', 'gemini-exp-1206', 'gemini-2.0-flash-thinking-exp-1219', 'gemini-2.0-flash-thinking-exp-01-21', 'gemini-2.0-flash-thinking-exp', 'gemini-1.5-flash-001', 'gemini-1.5-pro-001', 'gemini-1.5-flash-002', 'gemini-1.5-pro-002', 'gemini-1.0-pro-vision-001', 'gemini-1.5-flash', 'gemini-1.5-pro', 'gemini-flash-experimental', 'gemini-pro-experimental', 'gemini-1.0-pro-vision', 'claude-3-haiku-20240307', 'claude-3-5-sonnet-20240229', 'claude-3-opus-20240229', 'claude-3-5-sonnet-20240620', 'claude-3-5-sonnet-20241022', 'claude-3-5-sonnet@20240620', 'claude-3-5-sonnet-v2@20241022', 'o1-preview', 'o1', 'o1-pro', 'o3-mini', 'gemini-2.0-flash-001', 'gemini-2.0-pro-exp-02-05', 'gemini-2.0-flash-lite-preview-02-05', 'claude-3-7-sonnet', 'claude-3-7-sonnet@20250219', 'claude-3-7-sonnet-thinking@20250219'];
export const JSON_MODELS = ['gpt-4o-mini', 'gpt-4o-2024-07-18', 'gpt-4o', 'gpt-4o-2024-05-13', 'gpt-4-turbo', 'gpt-4-turbo-2024-04-09', 'gpt-4-turbo-preview', 'gpt-4-1106-preview', 'gpt-4-0125-preview', 'gpt-3.5-turbo', 'gpt-3.5-turbo-1106'];
export const GPT4_MODELS = ['gpt-4o-mini', 'gpt-4o-2024-07-18', 'gpt-4o', 'gpt-4o-2024-05-13', 'gpt-4-turbo', 'gpt-4-turbo-2024-04-09', 'gpt-4-turbo-preview', 'gpt-4-1106-preview', 'gpt-4-0125-preview'];
const azureDeployNameMap: Record<string, string> = {
    'gpt-3.5-turbo': 'gpt35',
    'gpt-4-vision-preview': 'gpt4',
    'gpt-4o': 'gpt4o',
    'o1-preview': 'o1-preview',
    'o1': 'o1',
    'o3-mini': 'o3-mini',
};
const azureDeployTpmMap: Record<string, number> = {
    'gpt-3.5-turbo': 60000,
    'gpt-4-vision-preview': 10000,
    'gpt-4o': 100000,
    'o1-preview': 500,
    'o1': 500,
    'o3-mini': 500,
};

// TiktokenModelが新モデルに追いつくまでは自己定義で対応する。
// export type GPTModels = 'gpt-4' | 'gpt-4-0314' | 'gpt-4-0613' | 'gpt-4-32k' | 'gpt-4-32k-0314' | 'gpt-4-32k-0613' | 'gpt-4-turbo-preview' | 'gpt-4-1106-preview' | 'gpt-4-0125-preview' | 'gpt-4-vision-preview' | 'gpt-3.5-turbo' | 'gpt-3.5-turbo-0301' | 'gpt-3.5-turbo-0613' | 'gpt-3.5-turbo-16k' | 'gpt-3.5-turbo-16k-0613';
export type GPTModels = TiktokenModel
    | 'gpt-4o-2024-05-13' | 'gpt-4o' | 'gpt-4o-mini-2024-07-18' | 'gpt-4o-mini' | 'o1-preview' | 'o1' | 'o1-pro' | 'o3-mini' | 'gemini-2.0-flash-001' | 'gemini-2.0-pro-exp-02-05' | 'gemini-2.0-flash-lite-preview-02-05'
    | 'llama2-70b-4096' | 'meta/llama3-405b-instruct-maas'
    | 'gemini-1.5-flash-001' | 'gemini-1.5-pro-001' | 'gemini-1.5-flash-002' | 'gemini-1.5-pro-002' | 'gemini-1.0-pro-001' | 'gemini-1.0-pro-vision-001'
    | 'gemini-1.5-flash' | 'gemini-1.5-pro' | 'gemini-1.0-pro' | 'gemini-1.0-pro-vision'
    | 'gemini-flash-experimental' | 'gemini-pro-experimental' | 'gemini-2.0-flash-exp' | 'gemini-exp-1206' | 'gemini-2.0-flash-thinking-exp-1219' | 'gemini-2.0-flash-thinking-exp-01-21' | 'gemini-2.0-flash-thinking-exp'
    | 'mixtral-8x7b-32768' | 'open-mistral-7b' | 'mistral-tiny-2312' | 'mistral-tiny' | 'open-mixtral-8x7b'
    | 'mistral-small-2312' | 'mistral-small' | 'mistral-small-2402' | 'mistral-small-latest' | 'mistral-medium-latest' | 'mistral-medium-2312' | 'mistral-medium' | 'mistral-large-latest' | 'mistral-large-2402' | 'mistral-embed'
    | 'claude-instant-1.2' | 'claude-2' | 'claude-2.1' | 'claude-3-haiku-20240307' | 'claude-3-5-sonnet-20240229' | 'claude-3-opus-20240229' | 'claude-3-5-sonnet-20240620' | 'claude-3-5-sonnet-20241022' | 'claude-3-5-sonnet@20240620' | 'claude-3-5-sonnet-v2@20241022' | 'claude-3-7-sonnet-20250219' | 'claude-3-7-sonnet-thinking-20250219' | 'claude-3-7-sonnet' | 'claude-3-7-sonnet-thinking@20250219'
    | 'deepseek-coder' | 'deepseek-chat';

export type AiProvider = 'openai' | 'azure' | 'groq' | 'mistral' | 'anthropic' | 'deepseek' | 'local' | 'vertexai' | 'anthropic_vertexai' | 'openapi_vertexai';

// モデル名とコストの対応表
export const COST_TABLE: { [key: string]: { prompt: number, completion: number } } = {
    'all     ': { prompt: 0.00000000, completion: 0.000000, },
    'gpt3.5  ': { prompt: 0.00150000, completion: 0.002000, },
    'gpt3-16k': { prompt: 0.00050000, completion: 0.001500, },
    'gpt4    ': { prompt: 0.03000000, completion: 0.060000, },
    'gpt4-32k': { prompt: 0.06000000, completion: 0.120000, },
    'gpt4-vis': { prompt: 0.01000000, completion: 0.030000, },
    'gpt4-128': { prompt: 0.01000000, completion: 0.030000, },
    'gpt4-o  ': { prompt: 0.00500000, completion: 0.015000, },
    'gpt4-om ': { prompt: 0.00015000, completion: 0.000600, },
    'o1      ': { prompt: 0.01650000, completion: 0.066000, },
    'o1-pre  ': { prompt: 0.01650000, completion: 0.066000, },
    'o1-pro  ': { prompt: 0.15000000, completion: 0.600000, },
    'o3-mini ': { prompt: 0.00110000, completion: 0.004400, },
    'cla-1.2 ': { prompt: 0.00800000, completion: 0.024000, },
    'cla-2   ': { prompt: 0.00800000, completion: 0.024000, },
    'cla-2.1 ': { prompt: 0.00800000, completion: 0.024000, },
    'cla-3-hk': { prompt: 0.00025000, completion: 0.001250, },
    'cla-3-sn': { prompt: 0.00300000, completion: 0.015000, },
    'cla-35sn': { prompt: 0.00300000, completion: 0.015000, },
    'cla-35s2': { prompt: 0.00300000, completion: 0.015000, },
    'cla-37sn': { prompt: 0.00300000, completion: 0.015000, },
    'cla-3-op': { prompt: 0.01500000, completion: 0.075000, },
    'g-mxl-87': { prompt: 0.00027000, completion: 0.000270, },
    'g-lm2-70': { prompt: 0.00070000, completion: 0.000800, },
    'msl-7b  ': { prompt: 0.00025000, completion: 0.000250, },
    'msl-87b ': { prompt: 0.00070000, completion: 0.000700, },
    'msl-sm  ': { prompt: 0.00200000, completion: 0.006000, },
    'msl-md  ': { prompt: 0.00270000, completion: 0.008100, },
    'msl-lg  ': { prompt: 0.00870000, completion: 0.024000, },
    'dps-code': { prompt: 0.00000000, completion: 0.000000, },
    'dps-chat': { prompt: 0.00000000, completion: 0.000000, },
    'gem-15fl': { prompt: 0.00001875, completion: 0.000075, },
    'gem-15pr': { prompt: 0.00031250, completion: 0.001250, },
    'gem-15f1': { prompt: 0.00001875, completion: 0.000075, },
    'gem-15p1': { prompt: 0.00031250, completion: 0.001250, },
    'gem-15f2': { prompt: 0.00001875, completion: 0.000075, },
    'gem-15p2': { prompt: 0.00031250, completion: 0.001250, },
    'gem-10pr': { prompt: 0.00012500, completion: 0.000250, },
    'gem-10pv': { prompt: 0.00012500, completion: 0.000125, },
    'gem-20fx': { prompt: 0.00001875, completion: 0.000075, },
    'gem-20f1': { prompt: 0.00003750, completion: 0.000150, },
    'gem-20px': { prompt: 0.00031250, completion: 0.001250, },
    'gem-20lp': { prompt: 0.00001875, completion: 0.000075, },
    'gem-ex12': { prompt: 0.000125, completion: 0.000125, },
    'vla31-40': { prompt: 0.000100, completion: 0.000100, },
};

export const SHORT_NAME: { [key: string]: string } = {
    // 'text-davinci-003': 'unused',
    // 'text-davinci-002': 'unused',
    // 'text-davinci-001': 'unused',
    // 'text-curie-001': 'unused',
    // 'text-babbage-001': 'unused',
    // 'text-ada-001': 'unused',
    // 'davinci': 'unused',
    // 'curie': 'unused',
    // 'babbage': 'unused',
    // 'ada': 'unused',
    // 'code-davinci-002': 'unused',
    // 'code-davinci-001': 'unused',
    // 'code-cushman-002': 'unused',
    // 'code-cushman-001': 'unused',
    // 'davinci-codex': 'unused',
    // 'cushman-codex': 'unused',
    // 'text-davinci-edit-001': 'unused',
    // 'code-davinci-edit-001': 'unused',
    // 'text-embedding-ada-002': 'unused',
    // 'text-similarity-davinci-001': 'unused',
    // 'text-similarity-curie-001': 'unused',
    // 'text-similarity-babbage-001': 'unused',
    // 'text-similarity-ada-001': 'unused',
    // 'text-search-davinci-doc-001': 'unused',
    // 'text-search-curie-doc-001': 'unused',
    // 'text-search-babbage-doc-001': 'unused',
    // 'text-search-ada-doc-001': 'unused',
    // 'code-search-babbage-code-001': 'unused',
    // 'code-search-ada-code-001': 'unused',
    // 'gpt2': 'unused',
    'gpt-4': 'gpt4    ',
    'gpt-4-0314': 'gpt4    ',
    'gpt-4-0613': 'gpt4    ',
    'gpt-4-32k': 'gpt4-32k',
    'gpt-4-32k-0314': 'gpt4-32k',
    'gpt-4-32k-0613': 'gpt4-32k',
    'gpt-4-turbo': 'gpt4-128',
    'gpt-4-turbo-2024-04-09': 'gpt4-128',
    'gpt-4-turbo-preview': 'gpt4-128',
    'gpt-4-1106-preview': 'gpt4-128',
    'gpt-4-0125-preview': 'gpt4-128',
    'gpt-4-vision-preview': 'gpt4-vis',
    'gpt-4o': 'gpt4-o  ',
    'o1': 'o1      ',
    'o1-preview': 'o1-pre  ',
    'o3-mini': 'o3-mini ',
    'gpt-4o-2024-05-13': 'gpt4-o  ',
    'gpt-3.5-turbo': 'gpt3-16k',
    'gpt-3.5-turbo-0125': 'gpt3-16k',
    'gpt-3.5-turbo-0301': 'gpt3.5  ',
    'gpt-3.5-turbo-0613': 'gpt3.5  ',
    'gpt-3.5-turbo-1106': 'gpt3-16k',
    'gpt-3.5-turbo-16k': 'gpt3-16k',
    'gpt-3.5-turbo-16k-0613	': 'gpt3-16k',
    'gpt-3.5-turbo-instruct': 'gpt3.5  ',
    'gpt-3.5-turbo-instruct-0914': 'gpt3.5  ',
    'mixtral-8x7b-32768': 'g-mxl-87',
    'llama2-70b-4096': 'g-lm2-70',
    'meta/llama3-405b-instruct-maas': 'vla31-40', // VertexAI llama3.1 405B
    'open-mistral-7b': 'msl-7b  ',
    'claude-instant-1.2': 'cla-1.2 ',
    'claude-2': 'cla-2   ',
    'claude-2.1': 'cla-2.1 ',
    'claude-3-haiku-20240307': 'cla-3-hk',
    'claude-3-5-sonnet-20240229': 'cla-3-sn',
    'claude-3-opus-20240229': 'cla-3-op',
    'claude-3-5-sonnet-20240620': 'cla-35sn',
    'claude-3-5-sonnet-20241022': 'cla-35sn',
    'mistral-tiny-2312': 'msl-tiny',
    'mistral-tiny': 'msl-tiny',
    'open-mixtral-8x7b': 'msl-87b ',
    'mistral-small-2312': 'msl-sm  ',
    'mistral-small': 'msl-sm  ',
    'mistral-small-2402': 'msl-sm  ',
    'mistral-small-latest': 'msl-sm  ',
    'mistral-medium-latest': 'msl-md  ',
    'mistral-medium-2312': 'msl-md  ',
    'mistral-medium': 'msl-md  ',
    'mistral-large-latest': 'msl-lg  ',
    'mistral-large-2402': 'msl-lg  ',
    'mistral-embed': 'msl-em  ',
    'deepseek-coder': 'dps-code',
    'deepseek-chat': 'dps-chat',
    'gemini-1.5-flash-001': 'gem-15f1',
    'gemini-1.5-pro-001': 'gem-15p1',
    'gemini-1.5-flash-002': 'gem-15f2',
    'gemini-1.5-pro-002': 'gem-15p2',
    'gemini-1.5-flash': 'gem-15f2',
    'gemini-1.5-pro': 'gem-15p2',
    'gemini-1.0-pro-001': 'gem-10pr',
    'gemini-1.0-pro-vision-001': 'gem-10pv',
    'gemini-flash-experimental': 'gem-15fl',
    'gemini-pro-experimental': 'gem-15pr',
    'gemini-2.0-flash-exp': 'gem-20fx',
    'gemini-2.0-flash-thinking-exp': 'gem-20fx',
    'gemini-2.0-flash-thinking-exp-1219': 'gem-20fx',
    'gemini-2.0-flash-thinking-exp-01-21': 'gem-20fx',
    'gemini-2.0-flash-001': 'gem-20f1',
    'gemini-2.0-pro-exp-02-05': 'gem-20px',
    'gemini-2.0-flash-lite-preview-02-05': 'gem-20lp',
    'gemini-exp-1206': 'gem-ex12',
    'gemini-1.0-pro': 'gem-10pr',
    'gemini-1.0-pro-vision': 'gem-10pv',
    'claude-3-5-sonnet@20240620': 'cla-35sn',
    'claude-3-5-sonnet-v2@20241022': 'cla-35s2',
    'claude-3-7-sonnet-20250219': 'cla-37sn',
    'claude-3-7-sonnet-thinking-20250219': 'cla-37sn',
    'claude-3-7-sonnet@20250219': 'cla-37sn',
    'claude-3-7-sonnet-thinking@20250219': 'cla-37sn',
    'claude-3-7-sonnet': 'cla-37sn',
};
// レートリミット情報
export const currentRatelimit: { [key: string]: Ratelimit } = {
    // openai
    'gpt3.5  ': { maxTokens: 4096, limitRequests: 10000, limitTokens: 1000000, remainingRequests: 10, remainingTokens: 5000000, resetRequests: '0ms', resetTokens: '0s', },
    'gpt3-16k': { maxTokens: 4096, limitRequests: 10000, limitTokens: 1000000, remainingRequests: 10, remainingTokens: 5000000, resetRequests: '0ms', resetTokens: '0s', },
    'gpt4    ': { maxTokens: 4096, limitRequests: 10000, limitTokens: 300000, remainingRequests: 10, remainingTokens: 8000, resetRequests: '0ms', resetTokens: '0s', },
    'gpt4-32k': { maxTokens: 4096, limitRequests: 10000, limitTokens: 300000, remainingRequests: 10, remainingTokens: 32000, resetRequests: '0ms', resetTokens: '0s', },
    'gpt4-128': { maxTokens: 4096, limitRequests: 10000, limitTokens: 800000, remainingRequests: 10, remainingTokens: 128000, resetRequests: '0ms', resetTokens: '0s', },
    'gpt4-vis': { maxTokens: 4096, limitRequests: 10000, limitTokens: 800000, remainingRequests: 10, remainingTokens: 128000, resetRequests: '0ms', resetTokens: '0s', },
    'gpt4-o  ': { maxTokens: 4096, limitRequests: 10000, limitTokens: 800000, remainingRequests: 10, remainingTokens: 128000, resetRequests: '0ms', resetTokens: '0s', },
    'gpt4-om ': { maxTokens: 4096, limitRequests: 10000, limitTokens: 800000, remainingRequests: 10, remainingTokens: 128000, resetRequests: '0ms', resetTokens: '0s', },
    'o1-pre  ': { maxTokens: 32768, limitRequests: 500, limitTokens: 3000000, remainingRequests: 50, remainingTokens: 128000, resetRequests: '0ms', resetTokens: '0s', },
    'o1-pro  ': { maxTokens: 100000, limitRequests: 500, limitTokens: 3000000, remainingRequests: 50, remainingTokens: 128000, resetRequests: '0ms', resetTokens: '0s', },
    'o1      ': { maxTokens: 200000, limitRequests: 500, limitTokens: 3000000, remainingRequests: 50, remainingTokens: 2280000, resetRequests: '0ms', resetTokens: '0s', },
    'o3-mini ': { maxTokens: 200000, limitRequests: 500, limitTokens: 3000000, remainingRequests: 480, remainingTokens: 3000000, resetRequests: '0ms', resetTokens: '0s', },
    // groq
    'g-mxl-87': { maxTokens: 4096, limitRequests: 10, limitTokens: 100000, remainingRequests: 10, remainingTokens: 128000, resetRequests: '0ms', resetTokens: '0s', },
    'g-lm2-70': { maxTokens: 4096, limitRequests: 10, limitTokens: 100000, remainingRequests: 10, remainingTokens: 128000, resetRequests: '0ms', resetTokens: '0s', },
    // mistral
    'msl-7b  ': { maxTokens: 4096, limitRequests: 5, limitTokens: 2000000, remainingRequests: 10, remainingTokens: 128000, resetRequests: '1000ms', resetTokens: '60s', },
    'msl-87b ': { maxTokens: 4096, limitRequests: 5, limitTokens: 2000000, remainingRequests: 10, remainingTokens: 128000, resetRequests: '1000ms', resetTokens: '60s', },
    'msl-sm  ': { maxTokens: 4096, limitRequests: 5, limitTokens: 2000000, remainingRequests: 10, remainingTokens: 128000, resetRequests: '1000ms', resetTokens: '60s', },
    'msl-md  ': { maxTokens: 4096, limitRequests: 5, limitTokens: 2000000, remainingRequests: 10, remainingTokens: 128000, resetRequests: '1000ms', resetTokens: '60s', },
    'msl-lg  ': { maxTokens: 4096, limitRequests: 5, limitTokens: 2000000, remainingRequests: 10, remainingTokens: 128000, resetRequests: '1000ms', resetTokens: '60s', },

    // vertex llama
    'vla31-40': { maxTokens: 4096, limitRequests: 5, limitTokens: 2000000, remainingRequests: 10, remainingTokens: 128000, resetRequests: '1000ms', resetTokens: '60s', },

    'cla-1.2 ': { maxTokens: 4096, limitRequests: 5, limitTokens: 2000000, remainingRequests: 10, remainingTokens: 128000, resetRequests: '1000ms', resetTokens: '60s', },
    'cla-2   ': { maxTokens: 4096, limitRequests: 5, limitTokens: 2000000, remainingRequests: 10, remainingTokens: 128000, resetRequests: '1000ms', resetTokens: '60s', },
    'cla-2.1 ': { maxTokens: 4096, limitRequests: 5, limitTokens: 2000000, remainingRequests: 10, remainingTokens: 128000, resetRequests: '1000ms', resetTokens: '60s', },
    'cla-3-hk': { maxTokens: 4096, limitRequests: 5, limitTokens: 100000, remainingRequests: 50, remainingTokens: 50000, resetRequests: '1000ms', resetTokens: '60s', },
    'cla-3-sn': { maxTokens: 4096, limitRequests: 5, limitTokens: 100000, remainingRequests: 50, remainingTokens: 50000, resetRequests: '1000ms', resetTokens: '60s', },
    'cla-35sn': { maxTokens: 8192, limitRequests: 5, limitTokens: 100000, remainingRequests: 50, remainingTokens: 50000, resetRequests: '1000ms', resetTokens: '60s', },
    'cla-35s2': { maxTokens: 8192, limitRequests: 5, limitTokens: 100000, remainingRequests: 50, remainingTokens: 50000, resetRequests: '1000ms', resetTokens: '60s', },
    'cla-37sn': { maxTokens: 64000, limitRequests: 5, limitTokens: 200000, remainingRequests: 50, remainingTokens: 50000, resetRequests: '1000ms', resetTokens: '60s', },
    'cla-3-op': { maxTokens: 4096, limitRequests: 5, limitTokens: 100000, remainingRequests: 50, remainingTokens: 50000, resetRequests: '1000ms', resetTokens: '60s', },
    'dps-code': { maxTokens: 4096, limitRequests: 5, limitTokens: 50000, remainingRequests: 10, remainingTokens: 50000, resetRequests: '1000ms', resetTokens: '60s', },
    'dps-chat': { maxTokens: 4096, limitRequests: 5, limitTokens: 50000, remainingRequests: 10, remainingTokens: 50000, resetRequests: '1000ms', resetTokens: '60s', },

    'gem-15fl': { maxTokens: 8192, limitRequests: 100, limitTokens: 1000000, remainingRequests: 10, remainingTokens: 200000, resetRequests: '1000ms', resetTokens: '60s', },
    'gem-15pr': { maxTokens: 8192, limitRequests: 100, limitTokens: 2000000, remainingRequests: 10, remainingTokens: 200000, resetRequests: '1000ms', resetTokens: '60s', },
    'gem-15f1': { maxTokens: 8192, limitRequests: 100, limitTokens: 1000000, remainingRequests: 10, remainingTokens: 200000, resetRequests: '1000ms', resetTokens: '60s', },
    'gem-15p1': { maxTokens: 8192, limitRequests: 100, limitTokens: 2000000, remainingRequests: 10, remainingTokens: 200000, resetRequests: '1000ms', resetTokens: '60s', },
    'gem-15f2': { maxTokens: 8192, limitRequests: 100, limitTokens: 32768, remainingRequests: 10, remainingTokens: 200000, resetRequests: '1000ms', resetTokens: '60s', },
    'gem-15p2': { maxTokens: 8192, limitRequests: 100, limitTokens: 2000000, remainingRequests: 10, remainingTokens: 200000, resetRequests: '1000ms', resetTokens: '60s', },
    'gem-10pr': { maxTokens: 8192, limitRequests: 100, limitTokens: 2000000, remainingRequests: 10, remainingTokens: 200000, resetRequests: '1000ms', resetTokens: '60s', },
    'gem-10pv': { maxTokens: 8192, limitRequests: 100, limitTokens: 2000000, remainingRequests: 10, remainingTokens: 200000, resetRequests: '1000ms', resetTokens: '60s', },
    'gem-20fx': { maxTokens: 8192, limitRequests: 100, limitTokens: 1000000, remainingRequests: 10, remainingTokens: 200000, resetRequests: '1000ms', resetTokens: '60s', },
    'gem-ex12': { maxTokens: 8192, limitRequests: 100, limitTokens: 1000000, remainingRequests: 10, remainingTokens: 200000, resetRequests: '1000ms', resetTokens: '60s', },

    'gem-20f1': { maxTokens: 8192, limitRequests: 100, limitTokens: 1000000, remainingRequests: 10, remainingTokens: 200000, resetRequests: '1000ms', resetTokens: '60s', },
    'gem-20px': { maxTokens: 8192, limitRequests: 100, limitTokens: 2000000, remainingRequests: 10, remainingTokens: 200000, resetRequests: '1000ms', resetTokens: '60s', },
    'gem-20lp': { maxTokens: 8192, limitRequests: 100, limitTokens: 1000000, remainingRequests: 10, remainingTokens: 200000, resetRequests: '1000ms', resetTokens: '60s', },
};

export interface Ratelimit {
    maxTokens: number;
    limitRequests: number;
    limitTokens: number;
    remainingRequests: number;
    remainingTokens: number;
    resetRequests: string;
    resetTokens: string;
}

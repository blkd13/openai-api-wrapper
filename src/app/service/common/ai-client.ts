import { createAIClient, AIClientLike, AIClientFactory, resetAIClientFactory, setAIClientFactory } from '../../common/ai/factory.js';
import { WrapperOptions } from '../../common/openai-api-wrapper.js';

export function getServiceAIClient(options?: Partial<WrapperOptions>): AIClientLike {
    return createAIClient({ wrapperOptions: { allowLocalFiles: false, ...options } });
}

export { setAIClientFactory, resetAIClientFactory } from '../../common/ai/factory.js';
export type { AIClientLike, AIClientFactory } from '../../common/ai/factory.js';
export type { WrapperOptions } from '../../common/openai-api-wrapper.js';

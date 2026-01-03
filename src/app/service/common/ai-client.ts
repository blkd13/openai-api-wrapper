import { AIClientLike, createAIClient } from '../../common/ai/factory.js';
import { WrapperOptions } from '../../common/openai-api-wrapper.js';

const aiApi = createAIClient();

export function getServiceAIClient(options?: Partial<WrapperOptions>): AIClientLike {
    return aiApi;
}

export { resetAIClientFactory, setAIClientFactory } from '../../common/ai/factory.js';
export type { AIClientFactory, AIClientLike } from '../../common/ai/factory.js';
export type { WrapperOptions } from '../../common/openai-api-wrapper.js';


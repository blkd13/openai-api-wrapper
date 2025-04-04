// src/providers/provider-factory.ts
import { IAiProvider } from '../types/common.js';
import { OpenAIProvider } from './openai.js';
// import { AnthropicProvider } from './anthropic';
// import { VertexAIProvider } from './vertexai';
// import { GeminiProvider } from './gemini';
// import { MistralProvider } from './mistral';
// import { CohereProvider } from './cohere';
// import { AzureOpenAIProvider } from './azure-openai';
// import { LocalAIProvider } from './local';

// Provider type for use in factory
export type AiProviderType =
  | 'openai'
  | 'anthropic'
  | 'vertexai'
  | 'openapi_vertexai'
  | 'gemini'
  | 'azure'
  | 'mistral'
  | 'deepseek'
  | 'groq'
  | 'cohere'
  | 'cerebras'
  | 'local'
  | 'anthropic_vertexai';

/**
 * Provider cache to avoid recreating providers
 */
const providerCache: Map<AiProviderType, IAiProvider> = new Map();

/**
 * Predict the provider type based on model name
 * @param model The model identifier
 * @param provider Optional explicit provider override
 * @returns The determined provider type
 */
export function predictProviderType(model: string, provider?: AiProviderType): AiProviderType {
  // If provider is explicitly specified, use it
  if (provider) {
    return provider;
  }

  // Otherwise, infer from model name
  if (model.startsWith('gemini-')) {
    return 'gemini';
  } else if (model.startsWith('meta/llama3-')) {
    return 'openapi_vertexai';
  } else if (model.startsWith('claude-')) {
    return 'anthropic';
  } else if (model.startsWith('gpt-') || model.startsWith('o1') || model.startsWith('o3')) {
    return 'openai';
  } else if (model.startsWith('deepseek-r1-distill-') || model.startsWith('llama-3.3-70b-')) {
    return 'groq';
  } else if (model.startsWith('llama-3.3-70b')) {
    return 'cerebras';
  } else if (model.startsWith('command-') || model.startsWith('c4ai-')) {
    return 'cohere';
  } else if (model.startsWith('deepseek-')) {
    return 'deepseek';
  } else {
    // Unknown models default to local
    return 'local';
  }
}

/**
 * Get an instance of an AI provider
 * @param providerType The provider type
 * @returns An instance of the requested provider
 */
export function getProvider(providerType: AiProviderType): IAiProvider {
  // Return cached instance if exists
  if (providerCache.has(providerType)) {
    return providerCache.get(providerType)!;
  }

  // Otherwise create and cache a new instance
  let provider: IAiProvider;

  switch (providerType) {
    case 'openai':
      provider = new OpenAIProvider();
      break;
    // case 'anthropic':
    //   provider = new AnthropicProvider();
    //   break;
    // case 'vertexai':
    //   provider = new VertexAIProvider();
    //   break;
    // case 'gemini':
    //   provider = new GeminiProvider();
    //   break;
    // case 'azure':
    //   provider = new AzureOpenAIProvider();
    //   break;
    // case 'mistral':
    //   provider = new MistralProvider();
    //   break;
    // case 'cohere':
    //   provider = new CohereProvider();
    //   break;
    // // Additional providers would be added here
    // default:
    //   provider = new LocalAIProvider();
    default:
      throw new Error(`Provider ${providerType} is not implemented`);
  }

  providerCache.set(providerType, provider);
  return provider;
}

/**
 * Factory function to get the appropriate provider for a model
 * @param model The model identifier
 * @param explicitProvider Optional provider override
 * @returns The appropriate provider for the model
 */
export function getProviderForModel(model: string, explicitProvider?: AiProviderType): IAiProvider {
  const providerType = predictProviderType(model, explicitProvider);
  return getProvider(providerType);
}
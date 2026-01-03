import { OpenAIApiWrapper, WrapperOptions } from '../openai-api-wrapper.js';
import { RunQueue } from './run-queue.js';

/**
 * Minimal contract that any AI client implementation must satisfy so that
 * BaseStepやサービス層から同じ操作感で利用できる。
 */
export type AIClientLike = Pick<OpenAIApiWrapper,
    'chatCompletionObservableStream' |
    'toolCallObservableStream' |
    'total' |
    'wrapperOptions'
> & {
    wrapperOptions: WrapperOptions;
};

export type AIClientFactoryOptions = {
    wrapperOptions?: WrapperOptions;
    runQueue?: RunQueue;
};

export type AIClientFactory = (options?: AIClientFactoryOptions) => AIClientLike;

const defaultFactory: AIClientFactory = (options?: AIClientFactoryOptions) => {
    console.log('Creating default OpenAIApiWrapper AI client');
    return new OpenAIApiWrapper(options?.wrapperOptions, options?.runQueue);
};

let currentFactory: AIClientFactory = defaultFactory;

/**
 * 任意のAIクライアント実装を登録する。テストや別実装を差し替えるときに利用する。
 */
export function setAIClientFactory(factory: AIClientFactory) {
    currentFactory = factory;
}

/**
 * 既定のOpenAIApiWrapperを使ったファクトリに戻す。
 */
export function resetAIClientFactory() {
    currentFactory = defaultFactory;
}

/**
 * 依存先からAIクライアントを取得する共通のエントリポイント。
 */
export function createAIClient(options?: WrapperOptions | AIClientFactoryOptions): AIClientLike {
    if (!options) {
        return currentFactory();
    }
    if ('allowLocalFiles' in options) {
        return currentFactory({ wrapperOptions: options as WrapperOptions });
    }
    return currentFactory(options as AIClientFactoryOptions);
}

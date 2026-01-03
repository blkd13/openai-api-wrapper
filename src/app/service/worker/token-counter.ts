import { Tiktoken, encoding_for_model } from 'tiktoken';
import { parentPort } from 'worker_threads';

// エンコーディングをキャッシュ
const encodings = new Map<string, Tiktoken>();

function getEncoding(model: string): Tiktoken {
    if (!encodings.has(model)) {
        console.log(`Loading encoding for model: ${model}`);
        const encoding = encoding_for_model(model as any);
        encodings.set(model, encoding);
    }
    return encodings.get(model)!;
}

parentPort?.on('message', (data: { text: string; model: string; id: number }) => {
    try {
        const encoding = getEncoding(data.model);
        const tokens = encoding.encode(data.text);
        const count = tokens.length;

        parentPort?.postMessage({
            id: data.id,
            count,
            error: null
        });
    } catch (error) {
        parentPort?.postMessage({
            id: data.id,
            count: null,
            error: error instanceof Error ? error.message : 'Unknown error'
        });
    }
});

// クリーンアップ
process.on('exit', () => {
    encodings.forEach(encoding => encoding.free());
});
import { encoding_for_model, Tiktoken } from 'tiktoken';

const encodings = new Map<string, Tiktoken>();

function getEncoding(model: string): Tiktoken {
    if (!encodings.has(model)) {
        console.error(`Loading encoding for model: ${model}`);
        const encoding = encoding_for_model(model as any);
        encodings.set(model, encoding);
        console.error(`Encoding loaded for model: ${model}`);
    }
    return encodings.get(model)!;
}

let tasksProcessed = 0;

process.on('message', (data: { text: string; model: string; id: number }) => {
    try {
        const startTime = Date.now();
        const encoding = getEncoding(data.model);
        const tokens = encoding.encode(data.text);
        const count = tokens.length;
        const duration = Date.now() - startTime;

        tasksProcessed++;

        if (tasksProcessed % 100 === 0) {
            console.error(`Process ${process.pid}: Processed ${tasksProcessed} tasks`);
        }

        process.send!({
            id: data.id,
            count,
            error: null
        });
    } catch (error) {
        console.error(`Error in process ${process.pid}:`, error);
        process.send!({
            id: data.id,
            count: null,
            error: error instanceof Error ? error.message : 'Unknown error'
        });
    }
});

// グレースフルシャットダウン
process.on('SIGTERM', () => {
    console.error(`Process ${process.pid}: Received SIGTERM, cleaning up...`);
    encodings.forEach(encoding => encoding.free());
    process.exit(0);
});

process.on('SIGINT', () => {
    console.error(`Process ${process.pid}: Received SIGINT, cleaning up...`);
    encodings.forEach(encoding => encoding.free());
    process.exit(0);
});

console.error(`Token counter process ${process.pid} started`);
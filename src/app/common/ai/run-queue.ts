import { Ratelimit } from '../model-definition.js';
import { TokenCount } from './token-cost.js';

export type RunBitExecute = () => Promise<void>;

export interface RunBitInit {
    executeCall: RunBitExecute;
    tokenCount: TokenCount;
}

export class RunQueue {
    waitQueue: { [key: string]: RunBitInit[] } = {};
    inProgressQueue: { [key: string]: RunBitInit[] } = {};
    timeoutMap: { [key: string]: NodeJS.Timeout | null } = {};

    constructor(private ratelimit: { [key: string]: Ratelimit }) {}

    enqueue(modelShort: string, runBit: RunBitInit) {
        if (!this.waitQueue[modelShort]) this.waitQueue[modelShort] = [], this.inProgressQueue[modelShort] = [];
        this.waitQueue[modelShort].push(runBit);
    }

    fire() {
        const waitQueue = this.waitQueue;
        const inProgressQueue = this.inProgressQueue;
        for (const key of Object.keys(waitQueue)) {
            if (!this.ratelimit[key]) this.ratelimit[key] = { maxTokens: 409600000, limitRequests: 10, limitTokens: 200000000, remainingRequests: 1000000000, remainingTokens: 100000000, resetRequests: '5s', resetTokens: '5s' };
            const ratelimitObj = this.ratelimit[key];
            for (let i = 0; i < Math.min(waitQueue[key].length, ratelimitObj.remainingRequests - inProgressQueue[key].length); i++) {
                if (waitQueue[key][i].tokenCount.prompt_tokens > ratelimitObj.remainingTokens && ratelimitObj.remainingTokens !== ratelimitObj.limitTokens) {
                    continue;
                }
                const runBit = waitQueue[key].shift();
                if (!runBit) { break; }
                inProgressQueue[key].push(runBit);
                runBit.executeCall().finally(() => {
                    inProgressQueue[key].splice(inProgressQueue[key].indexOf(runBit), 1);
                });

                ratelimitObj.remainingRequests--;
                ratelimitObj.remainingTokens -= runBit.tokenCount.prompt_tokens;
            }
            if (waitQueue[key].length > 0) {
                if (this.timeoutMap[key] == null) {
                    let waitMs = Number(String(ratelimitObj.resetRequests).replace('ms', '')) || 0;
                    let waitS = Number(String(ratelimitObj.resetTokens).replace('s', '')) || 0;
                    waitMs = waitMs === 0 ? ((waitS || 60) * 1000) : waitMs;
                    this.timeoutMap[key] = setTimeout(() => {
                        ratelimitObj.remainingRequests = ratelimitObj.limitRequests - inProgressQueue[key].length;
                        ratelimitObj.remainingTokens = ratelimitObj.limitTokens;
                        this.timeoutMap[key] = null;
                        this.fire();
                    }, waitMs);
                }
            } else {
                this.timeoutMap[key] = null;
            }
        }
    }
}

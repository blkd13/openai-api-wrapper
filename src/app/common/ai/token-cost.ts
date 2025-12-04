// import { Tiktoken, TiktokenEncoding, TiktokenModel, encoding_for_model } from 'tiktoken';

// import { COST_TABLE, SHORT_NAME, GPTModels } from '../model-definition.js';

// const encoderMap: Record<TiktokenEncoding, Tiktoken> = {} as Record<TiktokenEncoding, Tiktoken>;
// const encoderModelMap: Record<TiktokenModel, TiktokenEncoding> = {} as Record<TiktokenModel, TiktokenEncoding>;

// export function getTiktokenEncoder(model: TiktokenModel): Tiktoken {
//     if (encoderModelMap[model]) {
//         return encoderMap[encoderModelMap[model]];
//     } else {
//         try {
//             const tiktoken = encoding_for_model(model);
//             encoderModelMap[model] = tiktoken.name as TiktokenEncoding;
//             encoderMap[tiktoken.name as TiktokenEncoding] = tiktoken;
//         } catch {
//             const fallback = encoding_for_model('gpt-4o');
//             encoderModelMap[model] = fallback.name as TiktokenEncoding;
//             encoderMap[fallback.name as TiktokenEncoding] = fallback;
//         }
//     }
//     return encoderMap[encoderModelMap[model]];
// }

export class UsageClass {
    constructor(
        public model: string,
        public prompt_tokens: number = 0,
        public completion_tokens: number = 0,
        public tokenBuilder: string = '',
        public cost: number = 0,
    ) {
        // this.modelShort = TokenCount.SHORT_NAME[model] || model;
        // this.modelTikToken = model as TiktokenModel;
    }

    toString(): string {
        return `${this.model.padEnd(8)} ${this.prompt_tokens.toLocaleString().padStart(6, ' ')} ${this.completion_tokens.toLocaleString().padStart(6, ' ')} ${('$' + (Math.ceil(this.cost * 100) / 100).toFixed(2)).padStart(6, ' ')}`;
    }
}

export class TokenCount {
    // static COST_TABLE = COST_TABLE;
    // static SHORT_NAME = SHORT_NAME;

    public cost: number = 0;
    // public modelShort: string;
    // public modelTikToken: TiktokenModel;

    constructor(
        public model: string,
        public prompt_tokens: number = 0,
        public completion_tokens: number = 0,
        public tokenBuilder: string = '',
    ) {
        // this.modelShort = TokenCount.SHORT_NAME[model] || model;
        // this.modelTikToken = model as TiktokenModel;
    }

    // calcCost(): number {
    //     this.cost = (
    //         (TokenCount.COST_TABLE[this.model]?.prompt || 0) * this.prompt_tokens +
    //         (TokenCount.COST_TABLE[this.model]?.completion || 0) * this.completion_tokens
    //     ) / 1000_000;
    //     return this.cost;
    // }

    // add(obj: TokenCount): TokenCount {
    //     this.cost += obj.cost;
    //     this.prompt_tokens += obj.prompt_tokens;
    //     this.completion_tokens += obj.completion_tokens;
    //     return this;
    // }

    toString(): string {
        return `${this.model.padEnd(8)} ${this.prompt_tokens.toLocaleString().padStart(6, ' ')} ${this.completion_tokens.toLocaleString().padStart(6, ' ')} ${('$' + (Math.ceil(this.cost * 100) / 100).toFixed(2)).padStart(6, ' ')}`;
    }
}

export function calculateTokenCost(width: number, height: number, detail: 'low' | 'high' | 'auto' = 'high'): number {
    if (detail === 'low') {
        return 85;
    }

    if (width > 2048 || height > 2048) {
        const scaleFactor = Math.min(2048 / width, 2048 / height);
        width *= scaleFactor;
        height *= scaleFactor;
    }

    const scaleFactor = 768 / Math.min(width, height);
    width *= scaleFactor;
    height *= scaleFactor;

    const numSquares = Math.ceil(width / 512) * Math.ceil(height / 512);

    return 85 + numSquares * 170;
}

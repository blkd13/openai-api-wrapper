import fs from 'fs';
import { fileURLToPath } from 'url';

import { aiApi, BaseStepContext, setBaseStepDefaultContext } from '../common/base-step.js';
import { Utils } from '../common/utils.js';

const start = Date.now();
console.log(`${Utils.formatDate()} start`);

const envContext: BaseStepContext = {
    orgKey: process.env['OAW_DEFAULT_ORG_KEY'],
    userId: process.env['OAW_DEFAULT_USER_ID'],
    ip: process.env['OAW_DEFAULT_IP'],
};

setBaseStepDefaultContext(envContext);

function loadContextFromFile(contextFile?: string): BaseStepContext {
    if (!contextFile) {
        return {};
    }
    if (!fs.existsSync(contextFile)) {
        console.log(`Context file not found: ${contextFile}`);
        return {};
    }
    try {
        const parsed = JSON.parse(fs.readFileSync(contextFile, 'utf-8')) as BaseStepContext;
        return parsed ?? {};
    } catch (error) {
        console.log(`Failed to read context file ${contextFile}:`, error);
        return {};
    }
}

function applyBatchContext(overrides?: BaseStepContext & { contextFile?: string }): void {
    const { contextFile, ...directContext } = overrides || {};
    const fileContext = loadContextFromFile(contextFile);
    const merged: BaseStepContext = {
        ...envContext,
        ...fileContext,
        ...directContext,
    };
    setBaseStepDefaultContext(merged);
}

/**
 * 引数で指定されたエージェントを動かす。
 */
export async function main(agentName: string = 'null', context?: BaseStepContext & { contextFile?: string }) {
    try {
        applyBatchContext(context);
        // バッチ用はローカルファイルアクセスを許可する。
        aiApi.wrapperOptions.allowLocalFiles = true;
        // エージェントを動かす。
        await (await import(`../agent/${agentName}/runner.js`)).main();
    } catch (e) {
        console.log(e);
    }
    console.log(`${Utils.formatDate()} end ${(Date.now() - start).toLocaleString()}[ms] passed.`);

    // 課金額の合計を出力する。
    const total = aiApi.total();
    Object.keys(total).forEach(key => console.log(total[key].toString()));
}

/**
 * このファイルが直接実行された場合のコード。
 */
if (fileURLToPath(import.meta.url) === process.argv[1]) {
    main(process.argv[2]);
} else {
    // main実行じゃなかったら何もしない
}

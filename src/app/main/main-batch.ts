import { Utils } from '../common/utils.js';

const start = Date.now();
console.log(`${Utils.formatDate()} start`);

import { fileURLToPath } from 'url';

import { aiApi } from '../common/base-step.js';

/**
 * 引数で指定されたエージェントを動かす。
 */
export async function main(agentName: string = 'null') {
    try {
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

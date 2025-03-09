import { fileURLToPath } from 'url';

import { BaseStep, MultiStep, StepOutputFormat } from "../../common/base-step.js";
import { Utils } from '../../common/utils.js';
import fss from '../../common/fss.js';
import { boxDownloadCore, downloadAllFilesInFolder } from '../..//service/api/api-box.js';
const { BATCH_USER_ID } = process.env as { BATCH_USER_ID: string };


import os from 'os';

function getLocalIP() {
    const interfaces = os.networkInterfaces();
    if (interfaces) {
        for (const name of Object.keys(interfaces)) {
            if (interfaces[name]) {
                for (const iface of interfaces[name]) {
                    // IPv4 かつ内部IPアドレスでないものを探す
                    if (iface.family === 'IPv4' && !iface.internal) {
                        return iface.address;
                    }
                }
            }
        }
    } else { }
    return '0.0.0.0'; // IPアドレスが見つからなかった場合
}

const ipAddress = getLocalIP();

/**
 * 必ず main() という関数を定義する。
 * promiseチェーンで順次実行させる。
 * 
 * 1. newでオブジェクトを作る。
 * 2. initPromptでプロンプトをファイルに出力。
 * 3. run()で実行
 * 
 * 途中まで行ってたらコメントアウトして再ランする。
 * 例えば、promptを手修正したかったらinitPromptだけコメントアウトすれば手修正したファイルがそのまま飛ぶ。
 */
export async function main() {
    let obj;
    console.log(`Box Agent RUN`);

    const provider = 'box';
    const userId = BATCH_USER_ID;
    const ip = ipAddress;

    try {
        // 特定のフォルダIDから開始
        const targetFolderId = '0';

        console.log('Starting to download all files from the specified Box folder...');

        // // まず、フォルダ内の全アイテムを取得（ページングを自動処理）
        // const allItems = await getAllFolderItems(provider, targetFolderId, userId, ip);

        // console.log(`Found ${allItems.length} total items in folder`);
        // console.log(`Files: ${allItems.filter(item => item.type === 'file').length}`);
        // console.log(`Folders: ${allItems.filter(item => item.type === 'folder').length}`);

        // 全ファイルをダウンロード（再帰的にサブフォルダも処理）
        const result = await downloadAllFilesInFolder(
            provider, targetFolderId, userId, ip,
            { recursive: true, batchSize: 50 }
        );

        console.log(`Downloaded ${result.downloadedFiles.length} files successfully`);
        console.log(`Processed ${result.processedFolders.length} folders`);

        if (result.failedFiles.length > 0) {
            console.log(`Failed to download ${result.failedFiles.length} files`);
            console.log('Failed files:', result.failedFiles);
        }

    } catch (error) {
        console.error('Error in main process:', error);
    }
    console.log(`Box Agent END`);
}


/**
 * このファイルが直接実行された場合のコード。
 */
if (fileURLToPath(import.meta.url) === process.argv[1]) {
    main();
} else {
    // main実行じゃなかったら何もしない
}
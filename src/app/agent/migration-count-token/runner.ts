import { VertexAI } from '@google-cloud/vertexai/build/src/vertex_ai.js';
import * as crypto from 'crypto';
import { promises as fs } from 'fs';
import { detect } from 'jschardet/index.js';
import _ from 'lodash';
import * as path from 'path';
import { In, Not } from 'typeorm';
import { fileURLToPath } from 'url';
import { convertPptxToPdf } from '../../common/media-funcs.js';
import { MyVertexAiClient } from '../../common/my-vertexai.js';
import { genClientByProvider, getTiktokenEncoder, invalidMimeList, plainExtensions, plainMime } from '../../common/openai-api-wrapper.js';
import { convertToPdfMimeList } from '../../common/pdf-funcs.js';
import { COUNT_TOKEN_MODEL, COUNT_TOKEN_OPENAI_MODEL, geminiCountTokensByFile } from '../../service/controllers/chat-by-project-model.js';
import { ds } from '../../service/db.js';
import { UserEntity, UserRoleEntity, UserStatus } from '../../service/entity/auth.entity.js';
import { FileBodyEntity } from '../../service/entity/file-models.entity.js';
import { ContentPartEntity } from '../../service/entity/project-models.entity.js';
import { ToolCallPartCallBody, ToolCallPartCommandBody, ToolCallPartEntity, ToolCallPartResultBody, ToolCallPartType } from '../../service/entity/tool-call.entity.js';
import { UserTokenPayloadWithRole } from '../../service/middleware/authenticate.js';
import { ContentPartType } from '../../service/models/values.js';

/**
 * Get user configuration for agent scripts
 */
export async function getAgentUser(): Promise<UserTokenPayloadWithRole> {
    const { BATCH_USER_ID, BATCH_TENANT_KEY = 'public' } = process.env;

    if (!BATCH_USER_ID) {
        throw new Error('AGENT_USER_ID environment variable is required for agent scripts');
    }

    const userEntity = await ds.getRepository(UserEntity).findOneByOrFail({
        orgKey: BATCH_TENANT_KEY,
        id: BATCH_USER_ID,
        status: UserStatus.Active,
    });
    const userRoleEntity = await ds.getRepository(UserRoleEntity).findBy({
        orgKey: BATCH_TENANT_KEY,
        userId: userEntity.id,
        status: UserStatus.Active,
    });

    const user = {
        type: 'user',
        orgKey: userEntity.orgKey,
        id: userEntity.id,
        email: userEntity.email,
        name: userEntity.name,
        sid: '',
        jti: '',
        authGeneration: userEntity.authGeneration,
        roleList: userRoleEntity.map(role => ({
            role: role.role,
            scopeInfo: role.scopeInfo,
            priority: 0,
        }))
    } as UserTokenPayloadWithRole;
    return user;
}

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
    console.log(`Migration count tokens RUN`);

    try {

        // // pdfのテキストを抽出して保存する
        // const fileBodyList = await ds.getRepository(FileBodyEntity).findBy({
        //     fileType: 'application/pdf',
        // });
        // console.log(`fileBodyList.length: ${fileBodyList.length}`);
        // for (const fileBody of fileBodyList) {
        //     fileBody.innerPath = fileBody.innerPath.replaceAll(/\\/g, '/');
        //     // const pathBase = file.innerPath.split('-')[0];
        //     // const innerPath = file.innerPath;
        //     // const basename = path.basename(innerPath);
        //     const pdfPath = fileBody.innerPath.replaceAll(/\.[^.]*$/g, '') + '.pdf';
        //     console.log(`Processing PDF: ${pdfPath}`);
        //     const textFilePath = fileBody.innerPath.replaceAll(/\.[^.]*$/g, '') + '.1.txt';
        //     try {
        //         // すでにテキストファイルがある場合はスキップ
        //         await fs.access(textFilePath);
        //         console.log(`Text file already exists: ${textFilePath}`);
        //         continue;
        //     } catch {
        //         const pdfData = await extractPdfData(pdfPath);
        //         console.log("----- PDF ドキュメント情報 -----");
        //         console.log("Info:", pdfData.info);
        //         console.log("Metadata:", JSON.stringify(pdfData.metadata));

        //         console.log("----- アウトライン／目次 -----");
        //         if (pdfData.outline) {
        //             // アウトラインは階層構造になっているため、再帰的に表示することも可能です
        //             console.log(JSON.stringify(pdfData.outline));
        //         } else {
        //             console.log("アウトライン情報はありません。");
        //         }

        //         const numPages = pdfData.pdfDocument.numPages;
        //         // メタデータをDB保存しておく
        //         const isEnable = pdfData.pdfDocument.numPages <= 1000;
        //         fileBody.metaJson = { isEnable, numPages: pdfData.pdfDocument.numPages };

        //         if (isEnable) {
        //             // 1000ページ以下のドキュメントはテキストを抽出して保存する
        //             pdfData.textPages.forEach((text, index) => {
        //                 const pagePath = path.dirname(pdfPath) + '/' + path.basename(pdfPath, '.pdf') + '.' + (index + 1) + '.txt';
        //                 console.log(`----- Page ${index + 1} Chars ${text.length} -----`);
        //                 // console.log(text);
        //                 fs.writeFile(pagePath, text, 'utf-8').catch((err) => {
        //                     console.error(`Error writing text file for page ${index + 1}:`, err);
        //                 });
        //             });
        //         } else {
        //             // 1000ページ以上のドキュメントは無視する
        //         }
        //     }
        // }



        // コンテンツ
        let contents = await ds.getRepository(ContentPartEntity).find({
            where: { type: In([ContentPartType.TEXT, ContentPartType.ERROR]) },
        });
        console.log(`text time ${new Date()} texts ${contents.length}`);
        // await geminiCountTokensByContentPart(contents);
        contents = contents.filter(content => content && (!content.tokenCount || !content.tokenCount[COUNT_TOKEN_MODEL] || !(content.tokenCount[COUNT_TOKEN_MODEL].totalTokens >= 0) || !content.tokenCount[COUNT_TOKEN_OPENAI_MODEL] || !(content.tokenCount[COUNT_TOKEN_OPENAI_MODEL].totalTokens >= 0)));
        console.log(`text time ${new Date()} filtered texts ${contents.length}`);
        for (const chunkData of _.chunk(contents, 500)) {
            console.log(`text time ${new Date()} chunk ${chunkData.length}`);
            // console.dir(chunkData.map(content => ({ id: content.id, type: content.type, text: content.text?.substring(0, 20) })));
            // await geminiCountTokensByContentPart(transactionalEntityManager, chunkData);
            chunkData.forEach(content => {
                // console.log(`Processing content ID: ${content.id}, Type: ${content.type}`);
                const prompt = `${content.text}`;
                content.tokenCount = content.tokenCount || {};
                if (prompt.length === 0) {
                    content.tokenCount[COUNT_TOKEN_MODEL] = { totalTokens: 0, totalBillableCharacters: 0 };
                    content.tokenCount[COUNT_TOKEN_OPENAI_MODEL] = { totalTokens: 0 };
                } else {
                    content.tokenCount[COUNT_TOKEN_OPENAI_MODEL] = { totalTokens: getTiktokenEncoder(COUNT_TOKEN_OPENAI_MODEL).encode(prompt).length };
                }
                // console.log(`content.id: ${content.id} tokenCount: ${JSON.stringify(content.tokenCount)}`);
            });
            await ds.getRepository(ContentPartEntity).save(chunkData);
            console.log(`content.id: ${chunkData.map(content => content.id).join(', ')} tokenCount saved`);
            // console.dir(chunkData.map(content => ({ id: content.id, type: content.type, text: content.text?.substring(0, 20), tokenCount: content.tokenCount })));
        }

        // ファイル
        let files = await ds.getRepository(FileBodyEntity).find({
            where: { fileType: Not(In(invalidMimeList)) },
        });
        console.log(`file time ${new Date()} files ${files.length}`);
        const bufferMap: { [sha256: string]: Buffer } = {};
        console.log(files[0].tokenCount);
        files = files.filter(file => file && (!file.tokenCount || !file.tokenCount[COUNT_TOKEN_MODEL] || !(file.tokenCount[COUNT_TOKEN_MODEL].totalTokens >= 0) || !file.tokenCount[COUNT_TOKEN_OPENAI_MODEL] || !(file.tokenCount[COUNT_TOKEN_OPENAI_MODEL].totalTokens >= 0)));
        console.log(`file time ${new Date()} filtered files ${files.length}`);
        for (const chunkData of _.chunk(files, 500)) {

            console.log(`file time ${new Date()} chunk ${chunkData.length}`);
            const fileEntityRebuildList = chunkData.map(async file => {
                file.innerPath = file.innerPath.replaceAll(/\\/g, '/');
                const pathBase = file.innerPath.split('-')[0];
                // console.log(`time ${new Date()} ${pathBase}`);
                const outPathBase = pathBase + '-optimize';
                let fileType = file.fileType;
                const innerPath = file.innerPath;
                const basename = path.basename(innerPath);
                try {
                    await fs.readFile(innerPath);
                } catch {
                    console.log(file.id, innerPath);
                    return file;
                }

                const hashSumSha1 = crypto.createHash('sha1');

                let buffer: Buffer;
                let buffer2: Buffer;
                if (convertToPdfMimeList.includes(file.fileType)) {
                    const outputPath = innerPath.replaceAll(/\.[^.]*$/g, '.pdf');
                    try {
                        await fs.access(outputPath);
                        console.log(`Already converted. ${outputPath}`);
                    } catch (error) {
                        await convertPptxToPdf(innerPath, outputPath);
                    }
                    console.log(`time ${new Date()} ${innerPath} ${basename} ${fileType} ${outputPath}`);
                    buffer = await fs.readFile(innerPath);
                    hashSumSha1.update(buffer);
                    file.sha1 = hashSumSha1.digest('hex');

                    buffer = await fs.readFile(outputPath);
                } else {
                    buffer = await fs.readFile(innerPath);
                    hashSumSha1.update(buffer);
                    file.sha1 = hashSumSha1.digest('hex');
                }
                bufferMap[file.sha256] = buffer;

                const ext = file.innerPath.includes('.') ? `.${(file.innerPath.split('\.').pop() || '').toLowerCase()}` : ''; // 拡張子無しのパターンもある
                console.log(`time ${new Date()} ${innerPath} ${basename} ${fileType} ${ext} ${buffer.length}`);

                if (fileType.startsWith('text/') || plainExtensions.includes(innerPath) || plainMime.includes(fileType) || fileType.endsWith('+xml')) {

                    fileType = (fileType === 'application/octet-stream') ? 'text/plain' : fileType;
                    let decodedString;
                    // テキストファイルの場合はデコードしてテキストにしてしまう。
                    if (buffer && buffer.length > 0) {
                        const data = buffer;
                        try {
                            const detectedEncoding = detect(data);
                            if (detectedEncoding.encoding === 'ISO-8859-2') {
                                detectedEncoding.encoding = 'Windows-31J'; // 文字コード自動判定でSJISがISO-8859-2ことがあるので
                            } else if (!detectedEncoding.encoding) {
                                detectedEncoding.encoding = 'Windows-31J'; // nullはおかしいのでとりあえず
                            }
                            if (['UTF-8', 'ascii'].includes(detectedEncoding.encoding)) {
                            } else {
                                // 他の文字コードの場合は変換しておく
                                const decoder = new TextDecoder(detectedEncoding.encoding);
                                decodedString = decoder.decode(data);
                                buffer = Buffer.from(decodedString);
                                // console.log(`time ${new Date()} ${detectedEncoding.encoding} ${decodedString.substring(0, 20)}`);
                                // console.log(`time ${new Date()} ${ext} ${fileType} ${detectedEncoding.encoding} ${innerPath} ${pathBase}-original${ext}`);
                                // console.log(`time ${new Date()} ${ext} ${detectedEncoding.encoding} ${fileType}`);
                                await fs.rename(innerPath, `${pathBase}-original${ext}`);
                                await fs.writeFile(innerPath, decodedString);
                            }
                        } catch (error) {
                            console.error(error);
                            decodedString = '';
                            buffer = Buffer.from('');
                        }
                    } else {
                        // 空の場合はデコーダーに掛けると面倒なので直接空文字を入れる
                        decodedString = '';
                    }
                } else { }
                return file;
            });

            const updatedList = await Promise.all(fileEntityRebuildList);
            const tokenCountFileList = updatedList.map(value => {
                if (bufferMap[value.sha256]) {
                    if (value.fileType.startsWith('text/') || plainExtensions.includes(value.innerPath) || plainMime.includes(value.fileType)) {
                        console.log(`text ${value.innerPath} ${value.fileType} ${bufferMap[value.sha256].length}`);
                        // textの場合は生データを渡す
                        return { buffer: bufferMap[value.sha256].toString(), fileBodyEntity: value };
                    } else {
                        // それ以外はbase64データを渡す
                        return { base64Data: bufferMap[value.sha256].toString('base64'), fileBodyEntity: value };
                    }
                } else {
                    return null;
                }
            }).filter(Boolean) as ({ buffer: Buffer; fileBodyEntity: FileBodyEntity; base64Data?: undefined; } | { base64Data: string; fileBodyEntity: FileBodyEntity; buffer?: undefined; })[];
            await ds.transaction(async transactionalEntityManager => {
                const agentUser = await getAgentUser();
                const tokenCountedFileBodyList = await geminiCountTokensByFile(transactionalEntityManager, tokenCountFileList, agentUser);
            });

        }

        const my_vertexai = (genClientByProvider(COUNT_TOKEN_MODEL).client as MyVertexAiClient);
        const client = my_vertexai.client as VertexAI;
        const generativeModel = client.preview.getGenerativeModel({ model: COUNT_TOKEN_MODEL, safetySettings: [], });

        // toolCallPartListの取得
        const toolCallPartList = await ds.getRepository(ToolCallPartEntity).findBy({
            type: In([ToolCallPartType.CALL, ToolCallPartType.COMMAND, ToolCallPartType.RESULT])
        }) as ToolCallPartEntity[];
        console.log(`toolCallPartList.length: ${toolCallPartList.length}`);
        for (const toolTransaction of toolCallPartList) {
            const toolCallEntity = toolTransaction;

            if (toolTransaction.tokenCount) {
                // console.log(`toolTransaction.id: ${toolTransaction.id} already has tokenCount`);
                continue;
            }
            // console.log(`toolTransaction.id: ${toolTransaction.id} tokenCount not found`);

            const contentParts = { contents: [{ role: 'model', parts: [{ text: '' }] }] };
            if (toolTransaction.type === ToolCallPartType.CALL) {
                contentParts.contents[0].parts[0].text = (toolTransaction.body as ToolCallPartCallBody).function.arguments;
            } else if (toolTransaction.type === ToolCallPartType.COMMAND) {
                contentParts.contents[0].parts[0].text = (toolTransaction.body as ToolCallPartCommandBody).command;
            } else if (toolTransaction.type === ToolCallPartType.RESULT) {
                contentParts.contents[0].role = 'tool';
                contentParts.contents[0].parts[0].text = (toolTransaction.body as ToolCallPartResultBody).content;
            }
            const tokenResPromise = generativeModel.countTokens(contentParts);

            toolCallEntity.tokenCount = toolCallEntity.tokenCount || {};

            if (typeof contentParts.contents[0].parts[0].text === 'string') {
            } else {
                contentParts.contents[0].parts[0].text = JSON.stringify(contentParts.contents[0].parts[0].text);
            }

            // console.log(contentParts.contents[0].parts[0].text);
            // console.log(typeof contentParts.contents[0].parts[0].text);

            console.log(`toolTransaction.id: ${toolTransaction.id} text.length: ${contentParts.contents[0].parts[0].text.length}`);
            const openaiTokenCount = { totalTokens: getTiktokenEncoder(COUNT_TOKEN_OPENAI_MODEL).encode(contentParts.contents[0].parts[0].text).length, totalBillableCharacters: 0 };
            toolCallEntity.tokenCount[COUNT_TOKEN_OPENAI_MODEL] = openaiTokenCount;

            const vertexTokenCount = await tokenResPromise;
            toolCallEntity.tokenCount[COUNT_TOKEN_MODEL] = vertexTokenCount;
            // console.log(`toolTransaction.id: ${toolTransaction.id} tokenCount: ${JSON.stringify(toolCallEntity.tokenCount)}`);
            await ds.getRepository(ToolCallPartEntity).save(toolCallEntity);
            // console.log(`toolTransaction.id: ${toolTransaction.id} tokenCount saved`);
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
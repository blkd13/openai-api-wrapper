import { fileURLToPath } from 'url';
import _ from 'lodash';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { detect } from 'jschardet/index.js';
import { DataSource, In, IsNull, Not } from 'typeorm';
import { VertexAI } from '@google-cloud/vertexai';

import { genClientByProvider, invalidMimeList, plainExtensions, plainMime } from '../../common/openai-api-wrapper.js';
import { ContentPartEntity, MessageEntity, MessageGroupEntity } from '../../service/entity/project-models.entity.js';
import { ds } from '../../service/db.js';
import { ContentPartType } from '../../service/models/values.js';
import { geminiCountTokensByContentPart, geminiCountTokensByFile } from '../../service/controllers/chat-by-project-model.js';
import { FileBodyEntity } from '../../service/entity/file-models.entity.js';
import { convertPptxToPdf } from '../../common/media-funcs.js';
import { convertToPdfMimeList } from '../../common/pdf-funcs.js';

import { ToolCallPartCallBody, ToolCallPartCommandBody, ToolCallPartEntity, ToolCallPartResultBody } from '../../service/entity/tool-call.entity.js';
import { ToolCallPartType } from '../../service/entity/tool-call.entity.js';
import { getTiktokenEncoder } from '../../common/openai-api-wrapper.js';
import { MyVertexAiClient } from '../../common/my-vertexai.js';
import { COUNT_TOKEN_MODEL, COUNT_TOKEN_OPENAI_MODEL } from '../../service/controllers/chat-by-project-model.js';
import { UserEntity, UserStatus } from '../../service/entity/auth.entity.js';
import { UserTokenPayload } from '../../service/middleware/authenticate.js';

/**
 * Get user configuration for agent scripts
 */
async function getAgentUser(): Promise<UserTokenPayload> {
    const { AGENT_USER_ID, AGENT_ORG_KEY = 'public' } = process.env;
    
    if (!AGENT_USER_ID) {
        throw new Error('AGENT_USER_ID environment variable is required for agent scripts');
    }

    const user = await ds.getRepository(UserEntity).findOne({
        where: { orgKey: AGENT_ORG_KEY, id: AGENT_USER_ID, status: UserStatus.Active }
    });

    if (!user) {
        throw new Error(`User not found: orgKey=${AGENT_ORG_KEY}, id=${AGENT_USER_ID}`);
    }

    // Convert UserEntity to UserTokenPayload format
    return {
        type: 'user',
        orgKey: user.orgKey,
        id: user.id,
        email: user.email,
        name: user.name || user.email,
        roleList: [], // Agent scripts typically don't need specific roles
        authGeneration: user.authGeneration || 0
    };
}


// CREATE TABLE message_group_entity_bk AS SELECT * FROM message_group_entity;
// CREATE TABLE message_entity_bk AS SELECT * FROM message_entity;
// CREATE TABLE thread_entity_bk AS SELECT * FROM thread_entity;

// INSERT INTO thread_entity (created_by, updated_by, created_at, updated_at, created_ip, updated_ip, thread_group_id, in_dto_json, status) 
// SELECT created_by, updated_by, created_at, updated_at, created_ip, updated_ip, id, in_dto_json, 'Normal' FROM thread_entity_bk;

// INSERT INTO thread_group_entity (id, created_by, updated_by, created_at, updated_at, created_ip, updated_ip, project_id, visibility, title, description, last_update, status) 
// SELECT id, created_by, updated_by, created_at, updated_at, created_ip, updated_ip, project_id, visibility::text::thread_group_entity_visibility_enum, title, description, last_update, status::text::thread_group_entity_status_enum FROM thread_entity_bk;

// CREATE TABLE message_group_entity_newbk AS SELECT * FROM message_group_entity;

// UPDATE message_group_entity
// SET thread_id = (
//   SELECT id
//   FROM thread_entity
//   WHERE message_group_entity.thread_id = thread_entity.thread_group_id
// )
// WHERE EXISTS (
//   SELECT 1
//   FROM thread_entity
//   WHERE message_group_entity.thread_id = thread_entity.thread_group_id
// );


async function fileEntity() {

    // テキスト
    let contents = await ds.getRepository(ContentPartEntity).find({
        where: { type: In([ContentPartType.TEXT, ContentPartType.ERROR]) },
    });
    console.log(`text time ${new Date()} texts ${contents.length}`);
    // await geminiCountTokensByContentPart(contents);
    contents = contents.filter(content => content
        && (
            !content.tokenCount
            || !content.tokenCount[COUNT_TOKEN_MODEL]
            || !(content.tokenCount[COUNT_TOKEN_MODEL].totalTokens >= 0)
            || !content.tokenCount[COUNT_TOKEN_OPENAI_MODEL]
            || !(content.tokenCount[COUNT_TOKEN_OPENAI_MODEL].totalTokens >= 0)
        )
    );
    for (const chunkData of _.chunk(contents, 500)) {
        await ds.transaction(async transactionalEntityManager => {
            console.log(`text time ${new Date()} chunk ${chunkData.length}`);
            // console.dir(chunkData.map(content => ({ id: content.id, type: content.type, text: content.text?.substring(0, 20) })));
            const agentUser = await getAgentUser();
            await geminiCountTokensByContentPart(transactionalEntityManager, chunkData, agentUser);
            // console.dir(chunkData.map(content => ({ id: content.id, type: content.type, text: content.text?.substring(0, 20), tokenCount: content.tokenCount })));
        });
    }

    // ファイル
    let files = await ds.getRepository(FileBodyEntity).find({
        where: { fileType: Not(In(invalidMimeList)) },
    });
    console.log(`file time ${new Date()} files ${files.length}`);
    const bufferMap: { [sha256: string]: Buffer } = {};
    console.log(files[0].tokenCount);
    files = files.filter(file => file
        && (
            !file.tokenCount
            || !file.tokenCount[COUNT_TOKEN_MODEL]
            || !(file.tokenCount[COUNT_TOKEN_MODEL].totalTokens >= 0)
            || !file.tokenCount[COUNT_TOKEN_OPENAI_MODEL]
            || !(file.tokenCount[COUNT_TOKEN_OPENAI_MODEL].totalTokens >= 0)
        )
    );
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
                    fs.access(outputPath);
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


    // tool
    // toolCallPartListの取得
    const my_vertexai = (genClientByProvider(COUNT_TOKEN_MODEL).client as MyVertexAiClient);
    const client = my_vertexai.client as VertexAI;
    const generativeModel = client.preview.getGenerativeModel({ model: COUNT_TOKEN_MODEL, safetySettings: [], });
    let toolCallPartList = await ds.getRepository(ToolCallPartEntity).findBy({
        type: In([ToolCallPartType.CALL, ToolCallPartType.COMMAND, ToolCallPartType.RESULT]),
    }) as ToolCallPartEntity[];
    toolCallPartList = toolCallPartList.filter(toolTransaction => toolTransaction
        && (
            !toolTransaction.tokenCount
            || !toolTransaction.tokenCount[COUNT_TOKEN_MODEL]
            || !(toolTransaction.tokenCount[COUNT_TOKEN_MODEL].totalTokens >= 0)
            || !toolTransaction.tokenCount[COUNT_TOKEN_OPENAI_MODEL]
            || !(toolTransaction.tokenCount[COUNT_TOKEN_OPENAI_MODEL].totalTokens >= 0)
        )
    );
    console.log(`tool time ${new Date()} toolCallPartList ${toolCallPartList.length}`);
    for (const toolTransaction of toolCallPartList.filter(toolTransaction => !toolTransaction.tokenCount || !toolTransaction.tokenCount[COUNT_TOKEN_MODEL] || !(toolTransaction.tokenCount[COUNT_TOKEN_OPENAI_MODEL]))) {
        const toolCallEntity = toolTransaction;

        if (toolTransaction.tokenCount) {
            console.log(`toolTransaction.id: ${toolTransaction.id} already has tokenCount`);
            continue;
        }
        console.log(`toolTransaction.id: ${toolTransaction.id} tokenCount not found`);

        const contentParts = { contents: [{ role: 'model', parts: [{ text: '' }] }] };
        if (toolTransaction.type === ToolCallPartType.CALL) {
            contentParts.contents[0].parts[0].text = JSON.stringify((toolTransaction.body as ToolCallPartCallBody).function.arguments);
        } else if (toolTransaction.type === ToolCallPartType.COMMAND) {
            contentParts.contents[0].parts[0].text = JSON.stringify((toolTransaction.body as ToolCallPartCommandBody).command);
        } else if (toolTransaction.type === ToolCallPartType.RESULT) {
            contentParts.contents[0].role = 'tool';
            contentParts.contents[0].parts[0].text = (toolTransaction.body as ToolCallPartResultBody).content;
        }
        const tokenResPromise = generativeModel.countTokens(contentParts);

        toolCallEntity.tokenCount = toolCallEntity.tokenCount || {};

        const openaiTokenCount = { totalTokens: getTiktokenEncoder(COUNT_TOKEN_OPENAI_MODEL).encode(contentParts.contents[0].parts[0].text).length, totalBillableCharacters: 0 };
        toolCallEntity.tokenCount[COUNT_TOKEN_OPENAI_MODEL] = openaiTokenCount;

        const vertexTokenCount = await tokenResPromise;
        toolCallEntity.tokenCount[COUNT_TOKEN_MODEL] = vertexTokenCount;
        console.log(`toolTransaction.id: ${toolTransaction.id} tokenCount: ${JSON.stringify(toolCallEntity.tokenCount)}`);
        await ds.getRepository(ToolCallPartEntity).save(toolCallEntity);
        console.log(`toolTransaction.id: ${toolTransaction.id} tokenCount saved`);
    }

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
    // await ds.transaction(async transactionalEntityManager => {
    //     await fileEntity();
    // });
    await fileEntity();
    console.log('done');
}


/**
 * このファイルが直接実行された場合のコード。
 */
if (fileURLToPath(import.meta.url) === process.argv[1]) {
    main();
} else {
    // main実行じゃなかったら何もしない
}
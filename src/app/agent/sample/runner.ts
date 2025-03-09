import { fileURLToPath } from 'url';
// import { chunk } from 'lodash';
import _ from 'lodash';

import { DataSource, In, IsNull, Not } from 'typeorm';
import { MessageEntity, MessageGroupEntity } from '../../service/entity/project-models.entity.js';
import { FileBodyEntity } from '../../service/entity/file-models.entity.js';
import { ds } from '../../service/db.js';

import { convertPdf, convertToPdfMimeList } from '../../common/pdf-funcs.js';

interface OldMessageGroup {
    id: string;
    thread_id: string;
    message_cluster_id: string | null;
    type: string;
    seq: number;
    last_update: Date;
    previous_message_id: string | null;
    role: string;
    label: string;

    created_by: string;
    updated_by: string;
    created_at: Date;
    updated_at: Date;
    created_ip: string;
    updated_ip: string;
}

interface OldMessage {
    id: string;
    seq: number;
    last_update: Date;
    message_group_id: string;
    previous_message_id: string | null;
    cache_id: string | null;
    label: string;

    created_by: string;
    updated_by: string;
    created_at: Date;
    updated_at: Date;
    created_ip: string;
    updated_ip: string;
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




export async function migrateMessages(dataSource: DataSource) {
    // バックアップテーブルからデータを取得
    const oldMessageGroups = await dataSource.query(
        'SELECT * FROM message_group_entity_bk ORDER BY seq'
    ) as OldMessageGroup[];

    const oldMessages = await dataSource.query(
        'SELECT * FROM message_entity_bk ORDER BY seq'
    ) as OldMessage[];

    // メッセージグループごとにメッセージをグループ化
    const messagesByGroup: { [message_group_id: string]: OldMessage[] } = {};
    const messageMap: { [message_id: string]: OldMessage } = {};
    const messageGroupMap: { [message_group_id: string]: OldMessageGroup } = {};
    oldMessageGroups.forEach(group => {
        messageGroupMap[group.id] = group;
    });
    oldMessages.forEach(message => {
        // console.dir(message);
        // console.log(`Migrating message ${message.message_group_id} ${message.id}`);
        messageMap[message.id] = message;
        const messages = messagesByGroup[message.message_group_id] || [];
        messages.push(message);
        messagesByGroup[message.message_group_id] = messages;
        // console.log(`Migrated  message ${message.message_group_id} ${message.id}`);
    });

    // 新しいエンティティを作成して保存
    const messageGroupRepo = dataSource.getRepository(MessageGroupEntity);
    const messageRepo = dataSource.getRepository(MessageEntity);

    try {
        // トランザクション内で処理を実行
        await dataSource.transaction(async transactionalEntityManager => {
            for (const oldGroup of oldMessageGroups) {
                console.log(`Migrating message group ${oldGroup.id}`);
                const messages = messagesByGroup[oldGroup.id] || [];
                console.log(`Messages: ${messages.length}`);

                // メッセージグループの変更履歴を管理するための変数
                let previousMessageGroupId: string | null = null;

                // 新しいメッセージグループを作成
                const newGroup = new MessageGroupEntity();
                let previous_message_id = messageGroupMap[oldGroup.id].previous_message_id;
                let previous_message_group_id;
                if (previous_message_id) {
                    if (messageMap[previous_message_id]) {
                    } else {
                        console.log(`SKIP-${previous_message_id}`)
                        continue;
                    }
                    previous_message_group_id = messageMap[previous_message_id].message_group_id;
                }

                // 同じグループ内のメッセージを新しい形式に変換
                for (let i = 0; i < messages.length; i++) {
                    console.log(`Migrating message ${messages[i].id}`);
                    const message = messages[i];

                    Object.assign(newGroup, {
                        id: (i === 0 ? oldGroup.id : undefined) as any,
                        threadId: oldGroup.thread_id,
                        // messageClusterId: oldGroup.message_cluster_id,
                        type: oldGroup.type,
                        // seq: oldGroup.seq,
                        // argsIndex: 0,
                        previousMessageGroupId: previous_message_group_id,
                        role: oldGroup.role,
                        // editedRootMessageGroupId: i === 0 ? undefined : oldGroup.id, // 
                        versionNumber: i + 1,
                        isActive: i === messages.length - 1, // 最新のバージョンのみアクティブ
                        createdBy: oldGroup.created_by,
                        updatedBy: oldGroup.updated_by,
                        createdAt: oldGroup.created_at,
                        updatedAt: oldGroup.updated_at,
                        createdIp: oldGroup.created_ip,
                        updatedIp: oldGroup.updated_ip,
                    });

                    try {
                        await transactionalEntityManager.save(newGroup);
                    } catch (error) {
                        console.error('Failed to save message group:', error);
                        throw error;
                    }

                    // 新しいメッセージを作成
                    const newMessage = new MessageEntity();
                    Object.assign(newMessage, {
                        id: message.id,
                        // seq: message.seq,
                        subSeq: 0,
                        messageGroupId: newGroup.id,
                        cacheId: message.cache_id,
                        label: message.label,
                        editedRootMessageId: undefined,
                        versionNumber: 1,
                        isActive: true, // 最新のバージョンのみアクティブ
                        createdBy: message.created_by,
                        updatedBy: message.updated_by,
                        createdAt: message.created_at,
                        updatedAt: message.updated_at,
                        createdIp: message.created_ip,
                        updatedIp: message.updated_ip,
                    });

                    await transactionalEntityManager.save(newMessage);

                    console.log(`Migrated  message ${message.id}`);
                }
            }
        });

    } catch (error) {
        console.error('Migration failed:', error);
        throw error;
    }
}

// エラーハンドリング用のラッパー関数
export async function executeMigration(dataSource: DataSource) {
    try {
        await migrateMessages(dataSource);
        console.log('Migration completed successfully');
    } catch (error) {
        console.error('Migration failed:', error);
        throw error;
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
    let obj;


    // --- サンプル実行 ---
    (async () => {
        try {
            // ファイル
            let files = await ds.getRepository(FileBodyEntity).find({
                where: { fileType: In(['application/pdf', ...convertToPdfMimeList]), metaJson: {} },
            });
            console.log(`file time ${new Date()} files ${files.length}`);
            files = files.filter(file => file);


            for (const chunkData of _.chunk(files, 1)) {
                await ds.transaction(async tm => {
                    console.log(`file time ${new Date()} chunk ${chunkData.length}`);
                    for (const fileBody of chunkData) {
                        const fileBodyForSave = await convertPdf(tm, fileBody);
                        await tm.save(FileBodyEntity, fileBodyForSave);
                    }
                });
            }
        } catch (error) {
            console.error("PDF の抽出中にエラーが発生しました:", error);
        }
    })();

    // console.log('Migration started');
    // const dataSource = ds;
    // // await dataSource.initialize();
    // await executeMigration(dataSource);

    // console.log(tokenCountedFileBodyList);

    // const messageMessageGroupThreadList = await dataSource.query(`
    //     SELECT m.*, mg.*, t.* 
    //     FROM message_entity m 
    //     INNER JOIN message_group_entity mg
    //     ON mg.id::text = m.message_group_id 
    //     INNER JOIN thread_entity t
    //     ON t.id::text = mg.thread_id
    //   `);
    // for (const row of messageMessageGroupThreadList) {
    //     console.dir(`Message: ${row.id} ${row.label.replace(/\n/g, '')}---------------------------------`);
    //     console.dir(row);
    // }

    // return Promise.resolve().then(() => {
    //     obj = new Step0000_FirstStep();
    //     obj.initPrompt();
    //     return obj.run();
    // }).then(() => {
    //     obj = new Step0010_DrillDown();
    //     obj.initPrompt();
    //     return obj.run();
    // }).then(() => {
    // });
}


/**
 * このファイルが直接実行された場合のコード。
 */
if (fileURLToPath(import.meta.url) === process.argv[1]) {
    main();
} else {
    // main実行じゃなかったら何もしない
}

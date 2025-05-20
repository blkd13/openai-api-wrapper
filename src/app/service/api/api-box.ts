import { Request, Response } from 'express';
import { body, param, query } from "express-validator";
import multer from 'multer';
import crypto from 'crypto';
import path from 'path';
import { promises as fs } from 'fs';

import { validationErrorHandler } from "../middleware/validation.js";
import { OAuthUserRequest } from "../models/info.js";
import { ds } from '../db.js';
import { ExtApiClient, getExtApiClient } from '../controllers/auth.js';
import { BoxApiCollection, BoxApiCollectionItem, BoxApiCollectionList, BoxApiFolder, BoxApiItemEntry, BoxApiPathEntry, BoxCollectionEntity, BoxFileBodyEntity, BoxFileEntity, BoxItemEntity, BoxItemType } from '../entity/api-box.entity.js';
import { myDetectFile } from '../controllers/file-manager.js';
import { Utils } from '../../common/utils.js';
import { getAxios } from '../../common/http-client.js';

const { BOX_DOWNLOAD_DIR } = process.env;

const ITEM_QUERY = `fields=name,modified_at,modified_by,created_at,content_modified_at,shared_link,size,extension,lock,classification,permissions`;

export const boxApiItem = [
    param('providerName').isString().notEmpty(),
    param('types').isIn(['folders', 'collections']).notEmpty(),
    param('itemId').isString().notEmpty(),
    query('fromcache').isBoolean().optional(),
    query('offset').isNumeric().optional(),
    query('limit').isNumeric().optional(),
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as OAuthUserRequest;
        const { providerName, types, itemId } = req.params as { providerName: string, types: string, itemId: string };
        const provider = `box-${providerName}`;
        const type = types.substring(0, types.length - 1);
        const fromcache = req.query.fromcache === 'true';
        const offset = Number(req.query.offset) || 0;
        const limit = Number(req.query.limit) || 100;
        // console.log(`provider: ${provider}, itemId: ${itemId} fromcache: ${fromcache}`);
        // res.status(401).json({ error: 'Internal Server Error' });
        // return;
        try {
            if (fromcache) {
                // fromcache=trueの場合はキャッシュを返す
                try {
                    let itemEntity = await ds.getRepository(BoxItemEntity).findOneByOrFail({ orgKey: req.info.user.orgKey, userId: req.info.user.id, itemId, offset, limit });
                    // キャッシュがあればそれを先に返しておく。APIの結果が返ってきたらそれでキャッシュを上書きしておく。
                    res.json(itemEntity.data);
                    return;
                } catch (error) {
                    res.status(404).json({ error: 'Cache not found' });
                    return;
                }
            } else {
                // fromcache=falseの場合はAPIを叩いてキャッシュを更新する
                const e = {} as ExtApiClient;
                try {
                    Object.assign(e, await getExtApiClient(req.info.user.orgKey, provider));
                } catch (error) {
                    res.status(401).json({ error: `${provider}は認証されていません。` });
                    return;
                }
                // collectionsのときとfolderの時で/itemsをつけるかつけないかが変わる。クソ仕様だと思う。
                const url = `${e.uriBase}/2.0/${types}/${itemId}${type === 'collection' ? '/items' : ''}?offset=${offset}&limit=${limit}`;
                // console.log(url);

                const axios = await getAxios(url);
                const response = await axios.get<BoxApiFolder>(url, { headers: { Authorization: `Bearer ${req.info.oAuth.accessToken}`, }, });
                const folder = response.data;
                const entries = (folder as any).entries || folder.item_collection.entries;
                const total_count = (folder as any).total_count >= 0 ? (folder as any).total_count : folder.item_collection.total_count;
                // console.log(`Retrieved ${entries.length} items. Total count: ${total_count}`);
                const savedFolder = await ds.transaction(async (tm) => {
                    let itemEntity = await tm.getRepository(BoxItemEntity).findOneBy({ orgKey: req.info.user.orgKey, userId: req.info.user.id, type, itemId, offset, limit });
                    if (itemEntity) {
                    } else {
                        itemEntity = new BoxItemEntity();
                        itemEntity.orgKey = req.info.user.orgKey;
                        itemEntity.userId = req.info.user.id;
                        itemEntity.itemId = itemId;
                        itemEntity.type = type;

                        itemEntity.createdBy = req.info.user.id;
                        itemEntity.createdIp = req.info.ip;
                    }
                    itemEntity.offset = offset;
                    itemEntity.limit = limit;
                    itemEntity.data = folder;
                    itemEntity.updatedBy = req.info.user.id;
                    itemEntity.updatedIp = req.info.ip;

                    return await tm.getRepository(BoxItemEntity).save(itemEntity);
                });
                res.json(savedFolder.data);
                return;
            }

        } catch (error) {
            console.error(error);
            res.status((error as any).status || 500).json({ error: (error as any).message || 'Internal Server Error' });
        }
    }
];

// export const boxApiItem2 = [
//     param('provider').isString().notEmpty(),
//     param('types').isIn(['folders', 'collections']).notEmpty(),
//     param('itemId').isString().notEmpty(),
//     query('fromcache').isBoolean().optional(),
//     query('offset').isNumeric().optional(),
//     query('limit').isNumeric().optional(),
//     validationErrorHandler,
//     async (_req: Request, res: Response) => {
//         const req = _req as OAuthUserRequest;
//         const { provider, types, itemId } = req.params as { provider: string, types: string, itemId: string };
//         const type = types.substring(0, types.length - 1);
//         const fromcache = req.query.fromcache === 'true';
//         const offset = Number(req.query.offset) || 0;
//         const limit = Number(req.query.limit) || 100000; // クライアント側から要求された最大件数

//         try {
//             if (fromcache) {
//                 // fromcache=trueの場合はキャッシュを返す
//                 try {
//                     let itemEntity = await ds.getRepository(BoxItemEntity).findOneByOrFail({
//                         userId: req.info.user.id,
//                         itemId
//                     });
//                     // キャッシュがあればそれを先に返す
//                     res.json(itemEntity.data);
//                 } catch (e) {
//                     res.status(404).json({ error: 'Cache not found' });
//                 }
//             } else {
//                 // fromcache=falseの場合はAPIを繰り返し叩いて全データを取得
//                 const e = readOAuth2Env(provider);
//                 if (!e.uriBase) {
//                     return res.status(400).json({ error: 'Provider not found' });
//                 }

//                 // 全てのエントリを格納する配列

//                 let allEntries: (BoxApiItemEntry | BoxApiPathEntry)[] = [];
//                 let totalCount = 0;
//                 let currentOffset = offset;
//                 const maxPerPage = 100; // Box APIの1回あたりの最大取得件数

//                 // limitに達するか、全データを取得するまで繰り返す
//                 let hasMore = true;

//                 let firstPageResponse!: BoxApiFolder;
//                 while (hasMore && allEntries.length < limit) {
//                     // Box APIの呼び出し
//                     const url = `${e.uriBase}/2.0/${types}/${itemId}${type === 'collection' ? '/items' : ''}?offset=${currentOffset}&limit=${maxPerPage}`;

//                     const response = await e.axios.get<BoxApiFolder>(url, {
//                         headers: { Authorization: `Bearer ${req.info.oAuth.accessToken}` }
//                     });

//                     const folderPage = response.data;
//                     firstPageResponse = folderPage;
//                     totalCount = folderPage.item_collection.total_count || 0;

//                     // エントリを追加
//                     if (folderPage.item_collection.entries && folderPage.item_collection.entries.length > 0) {
//                         allEntries = [...allEntries, ...folderPage.item_collection.entries];
//                     }

//                     // 次のページがあるかチェック
//                     currentOffset += folderPage.item_collection.entries.length;
//                     hasMore = currentOffset < totalCount;

//                     // limitに達したか過去全件取得できたらループ終了
//                     if (allEntries.length >= limit || !hasMore) {
//                         break;
//                     }
//                 }

//                 // // 最初のレスポンスのテンプレートとして使用
//                 // const firstPageResponse = response.data;

//                 // 最終的なレスポンスデータ
//                 const completeResponse = {
//                     ...firstPageResponse,
//                     entries: allEntries.slice(0, limit), // limitに合わせて切り詰める
//                     offset,
//                     limit,
//                     total_count: totalCount,
//                     has_more: allEntries.length + offset < totalCount,
//                 };

//                 // データをキャッシュに保存
//                 const savedFolder = await ds.transaction(async (tm) => {
//                     let itemEntity = await tm.getRepository(BoxItemEntity).findOneBy({
//                         userId: req.info.user.id,
//                         type,
//                         itemId
//                     });

//                     if (!itemEntity) {
//                         itemEntity = new BoxItemEntity();
//                         itemEntity.userId = req.info.user.id;
//                         itemEntity.itemId = itemId;
//                         itemEntity.type = type;
//                         itemEntity.createdBy = req.info.user.id;
//                         itemEntity.createdIp = req.info.ip;
//                     }

//                     itemEntity.data = completeResponse;
//                     itemEntity.updatedBy = req.info.user.id;
//                     itemEntity.updatedIp = req.info.ip;

//                     return await tm.getRepository(BoxItemEntity).save(itemEntity);
//                 });

//                 res.json(completeResponse);
//             }
//         } catch (error) {
//             console.error(error);
//             res.status((error as any).status || 500).json({
//                 error: (error as any).message || 'Internal Server Error'
//             });
//         }
//     }
// ];



// 
export const upsertBoxApiCollection = [
    param('providerName').isString().notEmpty(),
    body('collectionId').isString().notEmpty(),
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as OAuthUserRequest;
        const { providerName } = req.params as { providerName: string };
        const provider = `box-${providerName}`;
        const { collectionId } = req.body as { collectionId: string };
        try {
            // fromcache=falseの場合はAPIを叩いてキャッシュを更新する
            const e = {} as ExtApiClient;
            try {
                Object.assign(e, await getExtApiClient(req.info.user.orgKey, provider));
            } catch (error) {
                res.status(401).json({ error: `${provider}は認証されていません。` });
                return;
            }
            const url = `${e.uriBase}/2.0/collections/${collectionId}`;
            const axios = await getAxios(url);
            const response = await axios.get<BoxApiCollection>(url, { headers: { Authorization: `Bearer ${req.info.oAuth.accessToken}`, }, });
            const collection = response.data;

            const urlItem = `${e.uriBase}/2.0/collections/${collectionId}/items?${ITEM_QUERY}`;
            const responseItem = await axios.get<BoxApiCollectionItem>(urlItem, { headers: { Authorization: `Bearer ${req.info.oAuth.accessToken}`, }, });
            const collectionItem = responseItem.data;

            const savedCollection = await ds.transaction(async (tm) => {
                let collectionEntity = await tm.getRepository(BoxCollectionEntity).findOneBy({ orgKey: req.info.user.orgKey, userId: req.info.user.id, collectionId });
                if (collectionEntity) {
                } else {
                    collectionEntity = new BoxCollectionEntity();
                    collectionEntity.orgKey = req.info.user.orgKey;
                    collectionEntity.userId = req.info.user.id;

                    collectionEntity.collectionId = collection.id;

                    collectionEntity.createdBy = req.info.user.id;
                    collectionEntity.createdIp = req.info.ip;
                }
                collectionEntity.type = collection.type;
                collectionEntity.collection_type = collection.collection_type;
                collectionEntity.name = collection.name;

                collectionEntity.data = collectionItem;
                collectionEntity.updatedBy = req.info.user.id;
                collectionEntity.updatedIp = req.info.ip;

                const savedEntity = await tm.getRepository(BoxCollectionEntity).save(collectionEntity);
                return { collection: collectionEntity, item: savedEntity };
            });
            res.json(savedCollection);
        } catch (error) {
            console.error(error);
            res.status((error as any).status || 500).json({ error: (error as any).message || 'Internal Server Error' });
        }
    }
];

export const boxApiCollection = [
    param('providerName').isString().notEmpty(),
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as OAuthUserRequest;
        const { providerName } = req.params as { providerName: string, collectionId: string };
        const provider = `box-${providerName}`;
        // console.log(`provider: ${provider}, collectionId: ${collectionId} fromcache: ${fromcache}`);
        try {
            // fromcache=falseの場合はAPIを叩いてキャッシュを更新する
            const e = {} as ExtApiClient;
            try {
                Object.assign(e, await getExtApiClient(req.info.user.orgKey, provider));
            } catch (error) {
                res.status(401).json({ error: `${provider}は認証されていません。` });
                return;
            }
            const url = `${e.uriBase}/2.0/collections`;
            const axios = await getAxios(url);
            const response = await axios.get<BoxApiCollectionList>(url, { headers: { Authorization: `Bearer ${req.info.oAuth.accessToken}`, }, });
            const collection = response.data;

            // 登録済みのコレクションを取得
            const collectionEntityList = await ds.getRepository(BoxCollectionEntity).findBy({ orgKey: req.info.user.orgKey, userId: req.info.user.id });
            collectionEntityList.forEach(c => {
                collection.entries.push({
                    type: c.type,
                    name: c.name,
                    collection_type: c.collection_type,
                    id: c.collectionId,
                });
            });

            res.json(collection);
        } catch (error) {
            console.error(error);
            res.status((error as any).status || 500).json({ error: (error as any).message || 'Internal Server Error' });
        }
    }
];

const upload = multer(); // multerを初期化

/**
 * OPTIONSはプロキシするのが面倒なので個別APIを用意した。
 * OPTINOSにデータのやり取りをさせる設計になっているBOX-API自体がダメだと思う。
 */
export const boxUpload = [
    param('providerName').isString().notEmpty(),
    param('fileId').optional().isString(),
    // body('name').isString().notEmpty(),
    // body('parent.id').isNumeric().notEmpty(),
    // body('size').isNumeric().notEmpty(),
    upload.single('file'), // 'file'という名前のフィールドでファイルをアップロード
    // [
    //     body('attributes') // 'attributes'フィールドのバリデーション
    //         .notEmpty()
    //         .isJSON()
    // ],
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as OAuthUserRequest;
        const { providerName, fileId } = req.params as { providerName: string, fileId: string };
        const provider = `box-${providerName}`;
        // const { name, parent, size } = req.body as { name: string, parent: { id: string }, size: number };
        // console.log(`provider: ${provider}, name: ${name} parent.id: ${parent.id} size=${size}`);

        // fromcache=falseの場合はAPIを叩いてキャッシュを更新する
        const e = {} as ExtApiClient;
        try {
            Object.assign(e, await getExtApiClient(req.info.user.orgKey, provider));
        } catch (error) {
            res.status(401).json({ error: `${provider}は認証されていません。` });
            return;
        }

        // 入力項目チェック
        type Attributes = { upload_token: string, upload_url: string };
        let attributes!: Attributes;
        try {
            attributes = JSON.parse(req.body.attributes); // attributesをJSONとしてパース
        } catch (error) {
            return res.status(400).json({ error: 'invalid attributes' }); // ファイルがない場合は400を返す
        }

        const file = req.file; // アップロードされたファイル
        if (!file) {
            return res.status(400).json({ error: 'No file uploaded' }); // ファイルがない場合は400を返す
        }

        async function post(fileId: string, file: Express.Multer.File, attributes: Attributes) {
            if (e) {
                const url = fileId ? `${e.uriBase}/2.0/files/${fileId}/content` : `${e.uriBase}/2.0/files/content`;
                console.log(url);
                const axios = await getAxios(url);
                const response = await axios.request<Attributes>({
                    url,
                    method: 'OPTIONS',
                    headers: {
                        Authorization: `Bearer ${req.info.oAuth.accessToken}`,
                        'Content-Type': 'multipart/form-data',
                    },
                    data: req.body.attributes,
                });
                const uploadInfo = response.data;
                // console.log(`Preflight Success ${JSON.stringify(response.data)}`);

                const formData = new FormData();
                formData.append('attributes', JSON.stringify(attributes));
                const uint8Array = new Uint8Array(file.buffer);
                const blob = new Blob([uint8Array], { type: file.mimetype });
                formData.append('file', blob as any, file.originalname);

                const axios2 = await getAxios(uploadInfo.upload_url);
                const uploadResponse = await axios2.post(uploadInfo.upload_url, formData, {
                    headers: {
                        Authorization: `Bearer ${req.info.oAuth.accessToken}`,
                        'Content-Type': 'multipart/form-data',
                    },
                });
                res.json(uploadResponse.data);
            } else { }
        }

        try {
            await post(fileId, file, attributes);
        } catch (error) {
            // console.error(error);
            // console.log((error as any).status);
            // console.log((error as any).response?.data);
            // console.log((error as any).code);
            // console.log((error as any).message);
            if ((error as any).status === 409) {
                // 409だった時はエラー内容のコンフリクトIDを更新する形でリトライ。
                const uploadError = (error as any).response.data as BoxUploadErrorResponse;
                try {
                    await post(uploadError.context_info.conflicts.id, file, attributes);
                } catch (error) {
                    console.error(error);
                    res.status((error as any).status || 500).json({ error: (error as any).message || 'Internal Server Error' });
                }
            } else {
                console.error(error);
                res.status((error as any).status || 500).json({ error: (error as any).message || 'Internal Server Error' });
            }
        }
    }
];

/**
 */
export const boxDownload = [
    param('providerName').isString().notEmpty(),
    param('fileId').isString().notEmpty(),
    query('format').optional().isIn(['binary', 'base64', 'pdf']),
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as OAuthUserRequest;
        const { providerName, fileId } = req.params as { providerName: string, fileId: string };
        const provider = `box-${providerName}`;
        const format = req.query.format || 'binary';
        const e = {} as ExtApiClient;
        try {
            Object.assign(e, await getExtApiClient(req.info.user.orgKey, provider));
        } catch (error) {
            res.status(401).json({ error: `${provider}は認証されていません。` });
            return;
        }

        try {
            const boxFileMetaInfo = await boxDownloadCoreOnline(e, fileId, req.info.user.id, req.info.ip);
            if (boxFileMetaInfo.status === 'skip') {
                throw new Error('極秘情報が含まれているのでダウンロードできません');
            } else { }
            if (format === 'base64') {
                const data = await fs.readFile(boxFileMetaInfo.innerPath);
                const base64Data = `data:${boxFileMetaInfo.fileType};base64,${data.toString('base64')}`;
                res.json({ fileName: boxFileMetaInfo.fileName, base64Data });
            } else if (format === 'pdf') {
                res.setHeader('Content-Type', `application/pdf`);
                res.download(Utils.replaceExtension(boxFileMetaInfo.innerPath, 'pdf'), Utils.replaceExtension(boxFileMetaInfo.fileName, 'pdf'));
            } else {
                res.setHeader('Content-Type', boxFileMetaInfo.fileType);
                res.download(boxFileMetaInfo.innerPath, boxFileMetaInfo.fileName);
            }
        } catch (error) {
            console.error(error);
            res.status((error as any).status || 500).json({ error: (error as any).message || 'Internal Server Error' });
        }
    }
];


export interface BoxFileInfo {
    type: 'file';
    id: string;
    etag: string;
    name: string;
    file_version: {
        type: 'file_version';
        id: string;
        sha1: string;
    };
    size: number;
}

export const boxBatchDownload = [
    param('providerName').isString().notEmpty(),
    param('fileId').isString().notEmpty(),
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as OAuthUserRequest;
        const { providerName, fileId } = req.params as { providerName: string, fileId: string };
        const provider = `box-${providerName}`;
        const userId = req.info.user.id;
        const ip = req.info.ip;

        // APIを呼び出してデータを取得
        const e = {} as ExtApiClient;
        try {
            Object.assign(e, await getExtApiClient(req.info.user.orgKey, provider));
        } catch (error) {
            res.status(401).json({ error: `${provider}は認証されていません。` });
            return;
        }
        await boxDownloadCore(e, fileId, userId, ip)
            .then(resBody => {
                res.json(resBody);
            })
            .catch(error => {
                res.status(400).json(Utils.errorFormattedObject(error, false));
            });
    }
];



/**
 * Box APIからフォルダやコレクションのアイテムを取得する関数（ページング対応）
 * @param provider OAuth2プロバイダー名
 * @param type 'folder'または'collection'
 * @param itemId 取得したいアイテムのID
 * @param userId ユーザーID
 * @param ip ユーザーのIPアドレス
 * @param options オプションパラメータ
 * @returns Box APIからのレスポンスデータ
 */
export async function boxApiItemCore(
    e: ExtApiClient, type: 'folder' | 'collection', itemId: string, userId: string, ip: string,
    options: { fromCache?: boolean; offset?: number; limit?: number; fields?: string[]; } = {}
): Promise<BoxItemEntity> {
    const { fromCache = true, offset = 0, limit = 100, fields = [] } = options;

    try {
        // キャッシュからデータを取得するオプションが指定されている場合
        if (fromCache) {
            try {
                const itemEntity = await ds.getRepository(BoxItemEntity).findOneByOrFail({ orgKey: e.orgKey, userId, itemId });
                console.log(`Get from cache: ${itemId} ${itemEntity.data.name}`);
                return itemEntity;
            } catch (e) {
                // throw new Error('Cache not found');
                // キャッシュに無ければ取りに行くだけ
            }
        } else { }


        // 型に応じてエンドポイントURLを構築
        const types = type === 'folder' ? 'folders' : 'collections';

        // フィールドパラメータを追加（指定がある場合）
        let fieldsParam = '';
        if (fields.length > 0) {
            fieldsParam = `&fields=${fields.join(',')}`;
        }

        const url = `${e.uriBase}/2.0/${types}/${itemId}${type === 'collection' ? '/items' : ''}?offset=${offset}&limit=${limit}${fieldsParam}`;

        console.log(`API Request URL: ${url}`);

        // API呼び出し
        // axiosWithAuth経由で認証付きリクエストを行う場合
        const axios = await e.axiosWithAuth.then(generator => generator(userId));
        const response = await axios.get<BoxApiFolder>(url);
        const folderData = response.data;

        // total_countとentriesの情報をログに出力
        console.log(`Retrieved ${folderData.item_collection.entries?.length || 0} items. Total count: ${folderData.item_collection.total_count || 'unknown'}`);

        // データをキャッシュに保存
        const itemEntity = await ds.transaction(async (tm) => {
            let itemEntity = await tm.getRepository(BoxItemEntity).findOneBy({ orgKey: e.orgKey, userId, type, itemId });
            if (!itemEntity) {
                itemEntity = new BoxItemEntity();
                itemEntity.orgKey = e.orgKey;
                itemEntity.userId = userId;
                itemEntity.itemId = itemId;
                itemEntity.type = type;
                itemEntity.orgKey = e.orgKey;
                itemEntity.createdBy = userId;
                itemEntity.createdIp = ip;
            }
            itemEntity.offset = offset;
            itemEntity.limit = limit;

            itemEntity.data = folderData;
            itemEntity.updatedBy = userId;
            itemEntity.updatedIp = ip;

            return await tm.getRepository(BoxItemEntity).save(itemEntity);
        });
        return itemEntity;
    } catch (error) {
        console.error('Box API Item Error:', error);
        throw error;
    }
}


/**
 * フォルダ内の全ファイルをダウンロードする関数（ページング対応版）
 * @param provider OAuth2プロバイダー名
 * @param folderId フォルダID
 * @param userId ユーザーID
 * @param ip ユーザーのIPアドレス
 * @param options 追加オプション
 * @returns ダウンロードしたファイルの結果
 */
export async function downloadAllFilesInFolder(
    e: ExtApiClient, folderId: string, userId: string, ip: string,
    options: { recursive?: boolean; batchSize?: number; } = {}
): Promise<{ downloadedFiles: any[]; failedFiles: any[]; processedFolders: string[]; }> {
    const { recursive = true, batchSize = 100 } = options;

    const downloadedFiles = [];
    const failedFiles = [];
    const processedFolders = [folderId]; // 処理済みフォルダを追跡

    let offset = 0;
    let hasMoreItems = true;

    // ページングを処理するループ
    while (hasMoreItems) {
        // console.log(`Fetching items from folder0 ${folderId} - offset: ${offset}, limit: ${batchSize}`);

        // フォルダの内容を取得（ページング付き）
        const itemEntity = await boxApiItemCore(
            e, 'folder', folderId, userId, ip,
            { offset, limit: batchSize }
        );
        const folderContent = itemEntity.data;

        const entries = folderContent.item_collection.entries || [];

        // このページに項目がなければループを終了
        const now = new Date(); // 現在時刻のDateオブジェクトを作成
        now.setHours(now.getHours() - 24); // 現在時刻から24時間引く
        if (entries.length === 0 || itemEntity.childrenCacheCompletedAt && itemEntity.childrenCacheCompletedAt > now) {
            hasMoreItems = false;
            break;
        }

        // このページのアイテムを処理
        for (const item of entries) {
            if (item.type === 'file') {
                // ファイルをダウンロード
                // console.log(`Downloading file: ${item.name} (${item.id})`);
                const result = await boxDownloadCore(e, item.id, userId, ip);
                downloadedFiles.push({ id: item.id, name: item.name, result });
            } else if (item.type === 'folder' && recursive) {
                // // なんとなく1秒待つ
                // await new Promise(resolve => { setTimeout(resolve, 1000); });
                // サブフォルダを再帰的に処理
                // console.log(`Processing subfolder: ${item.name} (${item.id})`);

                const subFolderResult = await downloadAllFilesInFolder(
                    e, item.id, userId, ip,
                    { recursive, batchSize }
                );

                downloadedFiles.push(...subFolderResult.downloadedFiles);
                failedFiles.push(...subFolderResult.failedFiles);
                processedFolders.push(...subFolderResult.processedFolders);
            }
            //     try {
            //     } catch (error) {
            //     console.error(`Failed to process item ${item.name} (${item.id}):`, error);
            //     failedFiles.push({ id: item.id, name: item.name, error: (error as Error).message });
            // }
        }

        // Box APIが返した総アイテム数をチェック
        const totalCount = folderContent.item_collection.total_count || 0;

        // 次のページがあるかチェック
        offset += entries.length;
        if (offset >= totalCount) {
            hasMoreItems = false;
        }
    }

    // 処理の最後に、このフォルダのchildrenCacheCompletedAtを更新
    await ds.transaction(async (tm) => {
        const itemEntity = await tm.getRepository(BoxItemEntity).findOneBy({
            orgKey: e.orgKey, userId, type: BoxItemType.FOLDER, itemId: folderId
        });

        if (itemEntity) {
            itemEntity.childrenCacheCompletedAt = new Date();
            itemEntity.updatedBy = userId;
            itemEntity.updatedIp = ip;
            await tm.getRepository(BoxItemEntity).save(itemEntity);
            console.log(`Updated childrenCacheCompletedAt for folder ${folderId}`);
        } else { }
    });
    return { downloadedFiles, failedFiles, processedFolders };
}


export async function boxDownloadCoreOnline(e: ExtApiClient, fileId: string, userId: string, ip: string): Promise<{ fileBodyId: string, innerPath: string, fileName: string, sha1Digest: string, sha256Digest: string, fileSize: number, fileType: string, status: string }> {
    if (!e.uriBase) {
        // return res.status(400).json({ error: 'Provider not found' });
        throw new Error('Provider not found');
    }

    try {
        // 1. まずファイルメタデータを取得
        const infoUrl = `${e.uriBase}/2.0/files/${fileId}?fields=file_version,name,size`;
        const metaUrl = `${e.uriBase}/2.0/files/${fileId}/metadata`;

        // 認証ヘッダー付きaxiosを生成
        const axios = await e.axiosWithAuth.then(generator => generator(userId));

        const infoResponse = await axios.get(infoUrl);
        const metaResponse = await axios.get(metaUrl);

        const infodata = infoResponse.data;
        const boxFileId = infodata.id;
        const fileName = infodata.name;
        const fileSizeFromMeta = infodata.size;
        const versionId = infodata.file_version.id || '';
        const sha1FromMeta = infodata.file_version?.sha1 || '';
        // 別項目として取得済みの項目を外して残りのものだけinfoに保存
        const infodata2 = JSON.parse(JSON.stringify(infodata));
        delete infodata2.id;
        delete infodata2.name;
        delete infodata2.size;
        delete infodata2.file_version;
        const metaData = metaResponse.data;

        // console.log(`Checking file: ${fileName}, ID: ${boxFileId}, Version: ${versionId}, SHA1: ${sha1FromMeta} Size: ${fileSizeFromMeta}`);

        // 2. fileId + versionIdの組み合わせでデータベースをチェック
        const existingBoxFile = await ds.getRepository(BoxFileEntity).findOne({
            where: { orgKey: e.orgKey, fileId: boxFileId, versionId: versionId }
        });

        if (metaData.entries && metaData.entries.length > 0) {
            let boxFile;
            if (existingBoxFile) {
                boxFile = existingBoxFile;
            } else {
                boxFile = new BoxFileEntity();
                boxFile.orgKey = e.orgKey;
                boxFile.fileId = boxFileId;
                boxFile.versionId = versionId;
                boxFile.versionSha1 = infodata.file_version?.sha1;
                boxFile.name = fileName;
                boxFile.createdBy = userId;
                boxFile.createdIp = ip;
            }
            boxFile.info = infodata2;
            boxFile.meta = metaData;
            boxFile.updatedBy = userId;
            boxFile.updatedIp = ip;
            const boxFileEntity = await ds.getRepository(BoxFileEntity).save(boxFile);
            return { fileBodyId: boxFileEntity.id, innerPath: '', fileName, sha1Digest: boxFile.versionSha1, sha256Digest: '', fileSize: 0, fileType: '', status: 'skip' };
            throw new Error('極秘情報が含まれているのでダウンロードできません');
        } else { }

        if (existingBoxFile) {
            console.log(`File already exists: ${fileName} (${boxFileId}, ${versionId})`);
            // 既にこのファイルバージョンは処理済み - 関連するファイルボディを取得
            const fileBody = await ds.getRepository(BoxFileBodyEntity).findOne({
                where: { sha1: existingBoxFile.versionSha1 }
            });

            if (fileBody) {
                return {
                    fileBodyId: fileBody.id,
                    innerPath: fileBody.innerPath,
                    fileName: existingBoxFile.name,
                    sha1Digest: fileBody.sha1,
                    sha256Digest: fileBody.sha256,
                    fileSize: fileBody.fileSize,
                    fileType: fileBody.fileType,
                    status: 'already_processed',
                };
            }
        }

        // 3. sha1ハッシュでのチェック（同一内容のファイルが別の場所にある場合）
        let existingFileBody = null;
        if (sha1FromMeta) {
            existingFileBody = await ds.getRepository(BoxFileBodyEntity).findOne({
                where: { sha1: sha1FromMeta }
            });
        }

        if (existingFileBody) {
            console.log(`File content already exists with SHA1: ${sha1FromMeta}, reusing file body`);

            // ファイル内容は既存のものを再利用し、BoxFileEntityだけ新規作成
            const newBoxFile = new BoxFileEntity();
            newBoxFile.orgKey = e.orgKey;
            newBoxFile.fileId = boxFileId;
            newBoxFile.versionId = versionId;
            newBoxFile.versionSha1 = sha1FromMeta;
            newBoxFile.name = fileName;
            newBoxFile.createdBy = userId;
            newBoxFile.updatedBy = userId;
            newBoxFile.createdIp = ip;
            newBoxFile.updatedIp = ip;
            await ds.getRepository(BoxFileEntity).save(newBoxFile);

            return {
                fileBodyId: existingFileBody.id,
                innerPath: existingFileBody.innerPath,
                fileName: fileName,
                sha1Digest: existingFileBody.sha1,
                sha256Digest: existingFileBody.sha256,
                fileSize: existingFileBody.fileSize,
                fileType: existingFileBody.fileType,
                status: 'content_reused'
            };
        }

        // 4. ここまで来たら新規ファイルなのでダウンロードする
        console.log(`Downloading new file: ${fileName}`);
        const downloadUrl = `${e.uriBase}/2.0/files/${fileId}/content`;
        const downloadResponse = await axios.get(downloadUrl, {
            responseType: 'arraybuffer'
        });

        // // なんとなくダウンロードは1秒開ける
        // await new Promise((resolve, reject) => setTimeout(() => { resolve(0) }, 1000));

        const _fileType = downloadResponse.headers['Content-Type'] as string || 'application/octet-stream';
        const fileData = Buffer.from(downloadResponse.data);
        const fileSize = fileData.length;

        console.log(`Downloaded fileType=${_fileType} fileSize=${fileSize}`);

        // 5. ハッシュ計算
        const sha1Hash = crypto.createHash('sha1');
        sha1Hash.update(fileData);
        const sha1Digest = sha1Hash.digest('hex');

        if (fileSizeFromMeta !== fileSize) {
            console.warn(`Size mismatch! Meta: ${fileSizeFromMeta}, Calculated: ${fileSize}`);
        }

        // メタデータのSHA1とダウンロードしたファイルのSHA1が一致することを確認
        if (sha1FromMeta && sha1FromMeta !== sha1Digest) {
            console.warn(`SHA1 mismatch! Meta: ${sha1FromMeta}, Calculated: ${sha1Digest}`);
        }

        const sha256Hash = crypto.createHash('sha256');
        sha256Hash.update(fileData);
        const sha256Digest = sha256Hash.digest('hex');


        const pathBase = path.join(BOX_DOWNLOAD_DIR || '.', sha256Digest.substring(0, 2), sha256Digest.substring(2, 4), sha256Digest);
        console.log(`File saved to ${pathBase} (${fileSize} bytes) from ${fileName} ${_fileType}`);
        await fs.mkdir(path.dirname(pathBase), { recursive: true });
        await fs.writeFile(pathBase, fileData);

        // shellかどうかの判定でファイル先頭の #!/ を見ているだけなので、10KB以上だったらshellとは考えにくいのでbase64展開しない。  
        const base64Data = fileData.length < 10000 ? fileData.toString('base64') : '';

        // 6. ファイルタイプの判定
        const detectedObject = await myDetectFile(_fileType, pathBase, fileName, fileData, base64Data, sha256Digest, false);
        const { fileType, innerPath, meta, ext } = detectedObject;

        // 8. データベースエンティティを保存
        const fileBodyEntity = new BoxFileBodyEntity();
        fileBodyEntity.orgKey = e.orgKey;
        fileBodyEntity.fileType = fileType;
        fileBodyEntity.fileSize = fileSize;
        fileBodyEntity.innerPath = innerPath; // カラム名が「innerPath」であることを前提
        fileBodyEntity.sha1 = sha1Digest;
        fileBodyEntity.sha256 = sha256Digest;
        // fileBodyEntity.metaJson = meta; // この行が必要な場合のみ
        fileBodyEntity.createdBy = userId;
        fileBodyEntity.updatedBy = userId;
        fileBodyEntity.createdIp = ip;
        fileBodyEntity.updatedIp = ip;
        await ds.getRepository(BoxFileBodyEntity).save(fileBodyEntity);

        const boxFile = new BoxFileEntity();
        boxFile.orgKey = e.orgKey;
        boxFile.fileId = boxFileId;
        boxFile.versionId = versionId;
        boxFile.versionSha1 = sha1Digest;
        boxFile.name = fileName;
        boxFile.info = infodata2;
        boxFile.meta = metaData;
        boxFile.createdBy = userId;
        boxFile.updatedBy = userId;
        boxFile.createdIp = ip;
        boxFile.updatedIp = ip;
        const boxFileEntity = await ds.getRepository(BoxFileEntity).save(boxFile);

        return { fileBodyId: fileBodyEntity.id, innerPath, fileName, sha1Digest, sha256Digest, fileSize, fileType, status: 'downloaded' };
    } catch (error) {
        console.error('Error:', error);
        // res.status((error as any).status || 500).json({
        //     error: (error as any).message || 'Internal Server Error'
        // });
        throw new Error((error as any).message || 'Internal Server Error');
    }
}


export async function boxDownloadCore(e: ExtApiClient, fileId: string, userId: string, ip: string): Promise<{ fileBodyId: string, innerPath: string, fileName: string, sha1Digest: string, sha256Digest: string, fileSize: number, fileType: string, status: string }> {

    if (!e.uriBase) {
        // return res.status(400).json({ error: 'Provider not found' });
        throw new Error('Provider not found');
    }

    // 2. fileId + versionIdの組み合わせでデータベースをチェック
    const existingBoxFileVersionless = await ds.getRepository(BoxFileEntity).findOne({
        where: { orgKey: e.orgKey, fileId: fileId }
    });

    if (existingBoxFileVersionless) {
        console.log(`File already processed: ${existingBoxFileVersionless.name} (${existingBoxFileVersionless.fileId}, ${existingBoxFileVersionless.versionId})`);
        // 1. まずファイルメタデータを取得
        const infoUrl = `${e.uriBase}/2.0/files/${fileId}?fields=file_version,name,size`;
        const metaUrl = `${e.uriBase}/2.0/files/${fileId}/metadata`;

        // 認証ヘッダー付きaxiosを生成
        const axios = await e.axiosWithAuth.then(generator => generator(userId));

        const infoResponse = await axios.get(infoUrl);
        const metaResponse = await axios.get(metaUrl);

        const infodata = infoResponse.data;
        // 別項目として取得済みの項目を外して残りのものだけinfoに保存
        const infodata2 = JSON.parse(JSON.stringify(infodata));
        delete infodata2.id;
        delete infodata2.name;
        delete infodata2.size;
        delete infodata2.file_version;
        const metaData = metaResponse.data;

        // 追加情報を埋める
        existingBoxFileVersionless.info = infodata2;
        existingBoxFileVersionless.meta = metaData;
        existingBoxFileVersionless.updatedBy = userId;
        existingBoxFileVersionless.updatedIp = ip;
        const boxFileEntity = await ds.getRepository(BoxFileEntity).save(existingBoxFileVersionless);

        // 既にこのファイルバージョンは処理済み - 関連するファイルボディを取得
        const fileBody = await ds.getRepository(BoxFileBodyEntity).findOne({
            where: { sha1: existingBoxFileVersionless.versionSha1 }
        });

        if (fileBody) {
            return {
                fileBodyId: fileBody.id,
                innerPath: fileBody.innerPath,
                fileName: existingBoxFileVersionless.name,
                sha1Digest: fileBody.sha1,
                sha256Digest: fileBody.sha256,
                fileSize: fileBody.fileSize,
                fileType: fileBody.fileType,
                status: 'already_processed'
            };
        }
    }
    try {
        // 1. まずファイルメタデータを取得
        const infoUrl = `${e.uriBase}/2.0/files/${fileId}?fields=file_version,name,size`;
        const metaUrl = `${e.uriBase}/2.0/files/${fileId}/metadata`;

        // 認証ヘッダー付きaxiosを生成
        const axios = await e.axiosWithAuth.then(generator => generator(userId));

        const infoResponse = await axios.get(infoUrl);
        const metaResponse = await axios.get(metaUrl);

        const infodata = infoResponse.data;
        const boxFileId = infodata.id;
        const fileName = infodata.name;
        const fileSizeFromMeta = infodata.size;
        const versionId = infodata.file_version.id || '';
        const sha1FromMeta = infodata.file_version?.sha1 || '';
        // 別項目として取得済みの項目を外して残りのものだけinfoに保存
        const infodata2 = JSON.parse(JSON.stringify(infodata));
        delete infodata2.id;
        delete infodata2.name;
        delete infodata2.size;
        delete infodata2.file_version;
        const metaData = metaResponse.data;

        if (metaData.entries && metaData.entries.length > 0) {
            const boxFile = new BoxFileEntity();
            boxFile.orgKey = e.orgKey;
            boxFile.fileId = boxFileId;
            boxFile.versionId = versionId;
            boxFile.versionSha1 = infodata.file_version?.sha1;
            boxFile.name = fileName;
            boxFile.info = infodata2;
            boxFile.meta = metaData;
            boxFile.createdBy = userId;
            boxFile.updatedBy = userId;
            boxFile.createdIp = ip;
            boxFile.updatedIp = ip;
            const boxFileEntity = await ds.getRepository(BoxFileEntity).save(boxFile);
            return { fileBodyId: boxFileEntity.id, innerPath: '', fileName, sha1Digest: boxFile.versionSha1, sha256Digest: '', fileSize: 0, fileType: '', status: 'skip' };
            throw new Error('極秘情報が含まれているのでダウンロードできません');
        } else { }

        // // 1. まずファイルメタデータを取得
        // const metaUrl = `${e.uriBase}/2.0/files/${fileId}?fields=file_version,name,size`;

        // // 認証ヘッダー付きaxiosを生成
        // const axios = await e.axiosWithAuth.then(generator => generator(userId));

        // const metaResponse = await axios.get(metaUrl);

        // const metadata = metaResponse.data;
        // const boxFileId = metadata.id;
        // const fileName = metadata.name;
        // const fileSizeFromMeta = metadata.size;
        // const versionId = metadata.file_version.id || '';
        // const sha1FromMeta = metadata.file_version?.sha1 || '';

        // console.log(`Checking file: ${fileName}, ID: ${boxFileId}, Version: ${versionId}, SHA1: ${sha1FromMeta} Size: ${fileSizeFromMeta}`);

        // 2. fileId + versionIdの組み合わせでデータベースをチェック
        const existingBoxFile = await ds.getRepository(BoxFileEntity).findOne({
            where: { orgKey: e.orgKey, fileId: boxFileId, versionId: versionId }
        });

        if (existingBoxFile) {
            console.log(`File already exists: ${fileName} (${boxFileId}, ${versionId})`);
            // 既にこのファイルバージョンは処理済み - 関連するファイルボディを取得
            const fileBody = await ds.getRepository(BoxFileBodyEntity).findOne({
                where: { sha1: existingBoxFile.versionSha1 }
            });

            if (fileBody) {
                return {
                    fileBodyId: fileBody.id,
                    innerPath: fileBody.innerPath,
                    fileName: existingBoxFile.name,
                    sha1Digest: fileBody.sha1,
                    sha256Digest: fileBody.sha256,
                    fileSize: fileBody.fileSize,
                    fileType: fileBody.fileType,
                    status: 'already_processed'
                };
            } else {
                return { fileBodyId: '', innerPath: '', fileName, sha1Digest: sha1FromMeta, sha256Digest: '', fileSize: infodata.size, fileType: '', status: 'large_file' };
            }
        }

        // 3. sha1ハッシュでのチェック（同一内容のファイルが別の場所にある場合）
        let existingFileBody = null;
        if (sha1FromMeta) {
            existingFileBody = await ds.getRepository(BoxFileBodyEntity).findOne({
                where: { sha1: sha1FromMeta }
            });
        }

        if (existingFileBody) {
            console.log(`File content already exists with SHA1: ${sha1FromMeta}, reusing file body`);

            // ファイル内容は既存のものを再利用し、BoxFileEntityだけ新規作成
            const newBoxFile = new BoxFileEntity();
            newBoxFile.orgKey = e.orgKey;
            newBoxFile.fileId = boxFileId;
            newBoxFile.versionId = versionId;
            newBoxFile.versionSha1 = sha1FromMeta;
            newBoxFile.name = fileName;
            newBoxFile.createdBy = userId;
            newBoxFile.updatedBy = userId;
            newBoxFile.createdIp = ip;
            newBoxFile.updatedIp = ip;
            await ds.getRepository(BoxFileEntity).save(newBoxFile);

            return {
                fileBodyId: existingFileBody.id,
                innerPath: existingFileBody.innerPath,
                fileName: fileName,
                sha1Digest: existingFileBody.sha1,
                sha256Digest: existingFileBody.sha256,
                fileSize: existingFileBody.fileSize,
                fileType: existingFileBody.fileType,
                status: 'content_reused'
            };
        }

        if (infodata.size > 2_147_483_648) {
            const boxFile = new BoxFileEntity();
            boxFile.orgKey = e.orgKey;
            boxFile.fileId = boxFileId;
            boxFile.versionId = versionId;
            boxFile.versionSha1 = sha1FromMeta;
            boxFile.name = fileName;
            boxFile.info = infodata2;
            boxFile.meta = metaData;
            boxFile.createdBy = userId;
            boxFile.updatedBy = userId;
            boxFile.createdIp = ip;
            boxFile.updatedIp = ip;
            const boxFileEntity = await ds.getRepository(BoxFileEntity).save(boxFile);

            return { fileBodyId: '', innerPath: '', fileName, sha1Digest: sha1FromMeta, sha256Digest: '', fileSize: infodata.size, fileType: '', status: 'large_file' };
        }

        // 4. ここまで来たら新規ファイルなのでダウンロードする
        console.log(`Downloading new file: ${fileName}`);
        const downloadUrl = `${e.uriBase}/2.0/files/${fileId}/content`;
        const downloadResponse = await axios.get(downloadUrl, {
            responseType: 'arraybuffer'
        });

        // // なんとなくダウンロードは1秒開ける
        // await new Promise((resolve, reject) => setTimeout(() => { resolve(0) }, 1000));

        const _fileType = downloadResponse.headers['Content-Type'] as string || 'application/octet-stream';
        const fileData = Buffer.from(downloadResponse.data);
        const fileSize = fileData.length;

        console.log(`Downloaded fileType=${_fileType} fileSize=${fileSize}`);

        // 5. ハッシュ計算
        const sha1Hash = crypto.createHash('sha1');
        sha1Hash.update(fileData);
        const sha1Digest = sha1Hash.digest('hex');

        if (fileSizeFromMeta !== fileSize) {
            console.warn(`Size mismatch! Meta: ${fileSizeFromMeta}, Calculated: ${fileSize}`);
        }

        // メタデータのSHA1とダウンロードしたファイルのSHA1が一致することを確認
        if (sha1FromMeta && sha1FromMeta !== sha1Digest) {
            console.warn(`SHA1 mismatch! Meta: ${sha1FromMeta}, Calculated: ${sha1Digest}`);
        }

        const sha256Hash = crypto.createHash('sha256');
        sha256Hash.update(fileData);
        const sha256Digest = sha256Hash.digest('hex');


        const pathBase = path.join(BOX_DOWNLOAD_DIR || '.', sha256Digest.substring(0, 2), sha256Digest.substring(2, 4), sha256Digest);
        console.log(`File saved to ${pathBase} (${fileSize} bytes) from ${fileName} ${_fileType}`);
        await fs.mkdir(path.dirname(pathBase), { recursive: true });
        await fs.writeFile(pathBase, fileData);

        // shellかどうかの判定でファイル先頭の #!/ を見ているだけなので、10KB以上だったらshellとは考えにくいのでbase64展開しない。  
        const base64Data = fileData.length < 10000 ? fileData.toString('base64') : '';

        // 6. ファイルタイプの判定
        const detectedObject = await myDetectFile(_fileType, pathBase, fileName, fileData, base64Data, sha256Digest, false);
        const { fileType, innerPath, meta, ext } = detectedObject;

        // 8. データベースエンティティを保存
        const fileBodyEntity = new BoxFileBodyEntity();
        fileBodyEntity.orgKey = e.orgKey;
        fileBodyEntity.fileType = fileType;
        fileBodyEntity.fileSize = fileSize;
        fileBodyEntity.innerPath = innerPath; // カラム名が「innerPath」であることを前提
        fileBodyEntity.sha1 = sha1Digest;
        fileBodyEntity.sha256 = sha256Digest;
        // fileBodyEntity.metaJson = meta; // この行が必要な場合のみ
        fileBodyEntity.createdBy = userId;
        fileBodyEntity.updatedBy = userId;
        fileBodyEntity.createdIp = ip;
        fileBodyEntity.updatedIp = ip;
        await ds.getRepository(BoxFileBodyEntity).save(fileBodyEntity);

        const boxFile = new BoxFileEntity();
        boxFile.orgKey = e.orgKey;
        boxFile.fileId = boxFileId;
        boxFile.versionId = versionId;
        boxFile.versionSha1 = sha1Digest;
        boxFile.name = fileName;
        boxFile.info = infodata2;
        boxFile.meta = metaData;
        boxFile.createdBy = userId;
        boxFile.updatedBy = userId;
        boxFile.createdIp = ip;
        boxFile.updatedIp = ip;
        const boxFileEntity = await ds.getRepository(BoxFileEntity).save(boxFile);

        return { fileBodyId: fileBodyEntity.id, innerPath, fileName, sha1Digest, sha256Digest, fileSize, fileType, status: 'downloaded' };
    } catch (error) {
        console.error('Error:', error);
        // res.status((error as any).status || 500).json({
        //     error: (error as any).message || 'Internal Server Error'
        // });
        throw new Error((error as any).message || 'Internal Server Error');
    }
}



interface BoxUploadErrorResponse {
    type: "error";
    status: number;
    code: string;
    context_info: {
        conflicts: ConflictInfo;
    };
    help_url: string;
    message: string;
    request_id: string;
}

interface ConflictInfo {
    type: "file";
    id: string;
    file_version: FileVersionInfo;
    sequence_id: string;
    etag: string;
    sha1: string;
    name: string;
}

interface FileVersionInfo {
    type: "file_version";
    id: string;
    sha1: string;
}

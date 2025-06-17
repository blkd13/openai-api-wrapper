import { NextFunction, Request, Response } from 'express';
import { body, param, query, validationResult } from 'express-validator';
import { EntityManager, EntityNotFoundError, In } from 'typeorm';
import { promises as fs } from 'fs';
import { lastValueFrom, map } from 'rxjs';
import { detect } from 'jschardet';
import * as path from 'path';
import * as crypto from 'crypto';
import sizeOf from 'image-size';

import { ds } from '../db.js';
import { FileEntity, FileTagEntity, FileVersionEntity, FileAccessEntity, FileBodyEntity, FileGroupEntity } from '../entity/file-models.entity.js';
import { ProjectEntity, TeamMemberEntity } from '../entity/project-models.entity.js';
import { FileGroupType, ProjectVisibility, TeamMemberRoleType } from '../models/values.js';
import { UserRequest } from '../models/info.js';
import { UserTokenPayload } from '../middleware/authenticate.js';
import { validationErrorHandler } from '../middleware/validation.js';
import { convertPptxToPdf, convertAndOptimizeImage, detectMimeType, getMetaDataFromFile, minimizeVideoForMinutes, normalizeAndMinimizeAudio } from '../../common/media-funcs.js';
import { Utils } from '../../common/utils.js';
import { geminiCountTokensByFile } from './chat-by-project-model.js';
import { plainMime, plainExtensions, invalidMimeList, disabledFilenameList, disabledDirectoryList } from '../../common/openai-api-wrapper.js';
import { convertPdf, convertToPdfMimeList } from '../../common/pdf-funcs.js';

export const { UPLOAD_DIR } = process.env;

// 結局使わない
const ALLOWED_MIME_TYPES = [
    'image/png', 'image/jpeg',
    'video/x-flv', 'video/mov', 'video/mpeg', 'video/mpegps', 'video/mpg', 'video/mp4', 'video/webm', 'video/wmv', 'video/3gpp',
    'audio/aac', 'audio/flac', 'audio/mp3', 'audio/m4a', 'audio/mpeg', 'audio/mpga', 'audio/mp4', 'audio/opus', 'audio/pcm', 'audio/wav', 'audio/webm',
    'application/pdf'
];

type FileGroupEntityForView = FileGroupEntity & { files: (FileEntity | { error: string, details: string })[] };
type FileBodyMapSet = {
    hashMap: { [key: string]: { buffer: Buffer, base64Data: string, fileType: string, filePath: string, sha1: string, fileBodyEntity: FileBodyEntity } },
    // pathMap: { [key: string]: string },
    hashList: string[];
};
export async function convertToMapSet(tm: EntityManager, contents: { filePath: string, base64Data: string }[], orgKey: string, userId: string, ip: string, user: UserTokenPayload): Promise<FileBodyMapSet> {
    // { filePath: string, base64Data: string }
    // ハッシュ値は編集前の状態で取得しておく。
    const mapSet = contents.reduce((_mapSet, content, currentIndex) => {
        const matches = content.base64Data.match(/^data:([A-Za-z0-9-+\/\._]+);base64,(.*)$/);
        if (!matches || matches.length !== 3) {
            console.error(matches, content.base64Data.substring(0, 100));
            throw new Error('無効なBase64データです');
        }

        let fileType = matches[1];
        // if (!ALLOWED_MIME_TYPES.includes(fileType)) {
        //     throw new Error('許可されていないファイルタイプです');
        // }

        const buffer = Buffer.from(matches[2] || '', 'base64');
        const hashSumSha256 = crypto.createHash('sha256');
        hashSumSha256.update(buffer);
        const sha256 = hashSumSha256.digest('hex');

        const hashSumSha1 = crypto.createHash('sha1');
        hashSumSha1.update(buffer);
        const sha1 = hashSumSha1.digest('hex');

        _mapSet.hashMap[sha256] = { buffer, base64Data: content.base64Data, fileType, filePath: content.filePath, sha1, fileBodyEntity: undefined as any as FileBodyEntity };
        _mapSet.hashList.push(sha256);
        return _mapSet;
    }, { hashMap: {}, hashList: [] } as FileBodyMapSet);

    const hashMap = {} as { [sha256: string]: FileBodyEntity };

    // sha256をキーに既存のファイルを取得しておく
    const existsFileBodyEntityList = await ds.getRepository(FileBodyEntity).find({ where: { sha256: In(Object.keys(mapSet.hashMap)) } });
    const existsSha256Map = Object.fromEntries(existsFileBodyEntityList.map(fileBodyEntity => [fileBodyEntity.sha256, fileBodyEntity]));
    const promises = Object.keys(mapSet.hashMap).map(async sha256 => {
        let isExists = false;
        // 既存のものが存在しない場合、もしくは既存のものとサイズが異なるものは通過
        if (existsSha256Map[sha256]) {
            if (existsSha256Map[sha256].fileSize !== mapSet.hashMap[sha256].buffer.length) {
                // 既存のものが存在してサイズが異なる場合はfalse
                console.error(`Hash collision detected: ${sha256} (size: ${existsSha256Map[sha256].fileSize} -> ${mapSet.hashMap[sha256].buffer.length})`);
                isExists = false;
            } else {
                // 既存のものが存在してサイズも一致している場合はtrue
                isExists = true;
            }
        } else {
            // 既存のものが存在しない場合はfalse
            isExists = false;
        }

        if (isExists) {
            // 処理済みにする
            // mapSet.hashMap[sha256].fileBodyEntity = fileBodyEntity;
            hashMap[sha256] = existsSha256Map[sha256];
            return existsSha256Map[sha256];
        } else {
            const _buffer = mapSet.hashMap[sha256].buffer;
            const sha1 = mapSet.hashMap[sha256].sha1;
            // TODO 本来filePathに依存してはいけないはずなのでここは間違っている。
            // そもそもはpathに依存説にmime判定できるかという問題。バイナリは出来てもソースは無理だと思うのでファイル名依存もやむなし。であればmimeはFileBodyではなくFileEntityに持つべき。
            let _fileType = mapSet.hashMap[sha256].fileType;
            const filePath = mapSet.hashMap[sha256].filePath;
            const fileSize = _buffer.length;

            const pathBase = path.join(UPLOAD_DIR || '.', sha256.substring(0, 2), sha256.substring(2, 4), sha256).replace('\\', '/'); // linuxで使えるように/にしておく
            console.log(`File saved to ${pathBase} (${fileSize} bytes) from ${filePath} ${_fileType}`);
            await fs.mkdir(path.dirname(pathBase), { recursive: true });
            await fs.writeFile(pathBase, _buffer);

            // 自作のdetect関数でextとかを判定。
            const detectedObject = await myDetectFile(_fileType, pathBase, filePath, _buffer, mapSet.hashMap[sha256].base64Data, sha256, true);
            const { fileType, innerPath, meta, ext } = detectedObject;
            mapSet.hashMap[sha256].buffer = detectedObject.buffer;
            mapSet.hashMap[sha256].base64Data = detectedObject.base64Data;

            const fileBodyEntity = new FileBodyEntity();
            fileBodyEntity.fileType = fileType;
            fileBodyEntity.fileSize = fileSize;
            fileBodyEntity.innerPath = innerPath;
            fileBodyEntity.sha1 = sha1;
            fileBodyEntity.sha256 = sha256;
            fileBodyEntity.metaJson = meta || {};
            fileBodyEntity.orgKey = orgKey;
            fileBodyEntity.createdBy = userId;
            fileBodyEntity.updatedBy = userId;
            fileBodyEntity.createdIp = ip;
            fileBodyEntity.updatedIp = ip;

            // PDF系の場合はメタ情報とかあれしとく
            if (['application/pdf', ...convertToPdfMimeList].includes(fileType)) {
                await convertPdf(tm, fileBodyEntity);
            } else { }

            const savedFileBodyEntity = await ds.getRepository(FileBodyEntity).save(fileBodyEntity);

            // 処理済みにする
            // mapSet.hashMap[sha256].fileBodyEntity = fileBodyEntity;
            mapSet.hashMap[sha256].fileType = fileType;
            hashMap[sha256] = savedFileBodyEntity;
            return savedFileBodyEntity;
        }
    });

    const fileBodyEntityList = await Promise.all(promises);
    Object.keys(mapSet.hashMap).forEach((sha256, index) => {
        // console.log(sha256, index);
        mapSet.hashMap[sha256].fileBodyEntity = fileBodyEntityList[index];
        // (mapSet.hashMap[key] as any).fileBodyEntityId = fileBodyEntityList[index].id;
    });

    const tokenCountFileList = Object.entries(hashMap).map(([sha256, value]) => {
        if (value.tokenCount && value.tokenCount['gemini-1.5-flash']) {
            // 既にトークンカウント済みの場合はスキップ
            // console.log(value.tokenCount['gemini-1.5-flash'] + ' tokens for ' + sha256);
            return null;
        } else {
            if (value.fileType.startsWith('text/') || plainExtensions.includes(value.innerPath) || plainMime.includes(value.fileType) || value.fileType.endsWith('+xml') || mapSet.hashMap[sha256].base64Data.startsWith('IyEv')) {
                // textの場合は生データを渡す
                return { buffer: mapSet.hashMap[sha256].buffer, fileBodyEntity: value };
            } else {
                // それ以外はbase64データを渡す
                return { base64Data: mapSet.hashMap[sha256].base64Data, fileBodyEntity: value };
            }
        }
    }).filter(v => v !== null) as { buffer: Buffer, fileBodyEntity: FileBodyEntity }[];

    const tokenCountedFileBodyList = await geminiCountTokensByFile(tm, tokenCountFileList, user);
    // console.dir(tokenCountedFileBodyList.map(fileBodyEntity => fileBodyEntity.tokenCount));
    console.log(tokenCountFileList.length + ' files to tokenize');

    // 全量終わるの待つ
    // console.dir(mapSet, { depth: 3 });
    return mapSet;
}

export const isZipBuffer = (buffer: Buffer): boolean => {
    // zipファイルのマジックナンバー
    const zipMagicNumbers = [
        [0x50, 0x4B, 0x03, 0x04], // 通常のzipファイル
        [0x50, 0x4B, 0x05, 0x06], // 空のディレクトリのみのzipファイル
    ];

    // バッファの先頭4バイトがマジックナンバーと一致するか確認
    return zipMagicNumbers.some(magicNumber => {
        return magicNumber.every((byte, i) => buffer[i] === byte);
    });
};

const isText = (buffer: Buffer): boolean => {
    const detected = detect(buffer);
    // 信頼度が低い場合はバイナリと判定
    if (detected.confidence < 0.8) {
        return false;
    }
    // バイナリデータによく使われる文字コードの場合はバイナリと判定
    if ([
        'ISO-8859-1', // Latin-1
        'ISO-8859-2', // Latin-2
        'Windows-1252',
        'ascii',
    ].includes(detected.encoding)) {
        return false;
    }
    // 上記以外は平文と判定
    return true;
};

export async function myDetectFile(fileType: string, pathBase: string, filePath: string, buffer: Buffer, base64Data: string, sha256: string, withConvert: boolean): Promise<{ fileType: string, innerPath: string, meta: any, ext: string, buffer: Buffer, base64Data: string }> {
    const fileName = path.basename(filePath);
    let isZip = false;
    if (fileType === 'application/octet-stream') {
        fileType = await detectMimeType(pathBase, filePath);
    }

    isZip = isZipBuffer(buffer);

    let innerPath: string;
    let meta: any = {};
    let ext = fileName.includes('.') ? `.${(fileName.split('\.').pop() || '').toLowerCase()}` : ''; // 拡張子無しのパターンもある
    // const ext = fileType.split('/')[1].replace(/.*[-+]/g, '').replace('text', 'txt');

    if (fileType === 'application/octet-stream') {
        if (isText(buffer)) {
            // テキストとして扱う
            fileType = 'text/plain';
        } else {
            // そのまま
        }
    } else if (fileType === 'application/x-apple-diskimage') {
        if (ext) {
            // 拡張子があればそのままで良い
        } else {
            // 拡張子無しであれば誤判定なのでapplication/octet-streamにする。
            fileType = `application/octet-stream`;
        }
    } else if (fileType === 'application/vnd.apple.keynote') {
        if (isZip) {
            // zipなら多分本当にkeynote
        } else {
            // zipじゃないならkeynote誤検知のただの鍵ファイル
            if (isText(buffer)) {
                // テキストとして扱う
                fileType = `text/plain`;
            } else {
                fileType = `application/octet-stream`;
            }
        }
    } else if (fileType === 'application/vnd.apple.keynote') {
    } else if (convertToPdfMimeList.includes(fileType)) {
        // } else if (fileType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') {
    } else if (fileType === 'video/mp2t') {
        if (filePath.endsWith('.ts')) {
            fileType = 'application/x-typescript';
        }
    } else if (fileType === 'application/x-msdownload') {
    } else if ([
        'application/x-x509-ca-cert',
        'application/pem-certificate-chain',
    ].includes(fileType)) {
        if (isText(buffer)) {
            // テキストとして扱う
            fileType = 'text/plain';
        } else {
            // そのまま
        }
    } else if (fileType === 'application/xml' && filePath.endsWith('.svg')) {
        fileType = 'image/svg+xml';
    } else if (fileType === 'audio/x-m4a') {
    } else { }
    // console.log(`Detected mime type = ${fileType} ${filePath}`);

    if (fileType.startsWith('application/') || fileType.startsWith('text/')) {
        innerPath = `${pathBase}-plain${ext}`;
        await fs.rename(pathBase, innerPath);
    } else if (fileType.startsWith('image/') && !fileType.startsWith('image/svg')) {
        innerPath = `${pathBase}-original${ext}`;
        await fs.rename(pathBase, innerPath);
        // innerPath = await convertAndOptimizeImage(innerPath, outPathBase);
        try {
            meta = sizeOf(buffer);
        } catch (e) {
            console.log(`エラーになるのでメタ情報取得をスキップします。pathBase=${pathBase},innerPath=${innerPath}`);
            console.log(e);
        }
    } else if (fileType.startsWith('video/')) {
        innerPath = `${pathBase}-original${ext}`;
        await fs.rename(pathBase, innerPath);
        // innerPath = await minimizeVideoForMinutes(innerPath, outPathBase);
        meta = await lastValueFrom(getMetaDataFromFile(innerPath));
    } else if (fileType.startsWith('audio/')) {
        innerPath = `${pathBase}-original${ext}`;
        await fs.rename(pathBase, innerPath);
        // innerPath = await normalizeAndMinimizeAudio(innerPath, outPathBase);
        meta = await lastValueFrom(getMetaDataFromFile(innerPath));
    } else {
        innerPath = `${pathBase}-plain${ext}`;
        await fs.rename(pathBase, innerPath);
    }




    if (fileType.startsWith('text/') || plainExtensions.includes(innerPath) || plainMime.includes(fileType) || (fileType === 'application/octet-stream' && base64Data.startsWith('IyEv'))) {
        fileType = (fileType === 'application/octet-stream') ? 'text/plain' : fileType;

        let decodedString;
        // テキストファイルの場合はデコードしてテキストにしてしまう。
        if (buffer) {
            const data = buffer;
            try {
                const detectedEncoding = detect(data);
                if (detectedEncoding.encoding === 'ISO-8859-2') {
                    detectedEncoding.encoding = 'Windows-31J'; // 文字コード自動判定でSJISがISO-8859-2ことがあるので
                } else if (!detectedEncoding.encoding) {
                    detectedEncoding.encoding = 'Windows-31J'; // nullはおかしいのでとりあえず
                }
                if (['ascii', 'UTF-8'].includes(detectedEncoding.encoding)) {
                    // そのまま
                } else {
                    console.log(`Detected encoding: ${detectedEncoding.encoding} for ${sha256} ${fileType} ${filePath} ${innerPath}`);
                    // 他の文字コードの場合は変換しておく
                    const decoder = new TextDecoder(detectedEncoding.encoding);
                    decodedString = decoder.decode(data);
                    buffer = Buffer.from(decodedString);
                    await fs.rename(innerPath, `${pathBase}-original${ext}`);
                    await fs.writeFile(innerPath, decodedString);
                }
            } catch (error) {
                console.error(error, fileType, innerPath);
            }
        } else {
            // 空の場合はデコーダーに掛けると面倒なので直接空文字を入れる
            decodedString = '';
        }
    } else { }

    // パワポとワードはPDF化しておく
    if (fileType === 'application/octet-stream') {
    } else if (fileType === 'application/vnd.apple.keynote') {
    } else if (convertToPdfMimeList.includes(fileType) && withConvert) {
        // Word,PowerPointはPDFに変換しておく
        const outputPath = innerPath.substring(0, innerPath.length - ext.length) + '.pdf';
        await convertPptxToPdf(innerPath, outputPath);
        // buffer内容もpdfのものにしておく
        buffer = await fs.readFile(outputPath);
        base64Data = buffer.toString('base64');
    } else if (fileType === 'application/x-msdownload') {
    } else if (fileType === 'application/x-x509-ca-cert') {
    } else if (fileType === 'audio/x-m4a') {
    }

    return { fileType, innerPath, meta, ext, buffer, base64Data }
}

/**
 * [user認証] ファイルアップロード (ファイルまたはBase64)
 * ファイルの有効性をチェックする
 * @param fileType ファイルタイプ
 * @param filePath ファイルパス
 * @param fileName ファイル名
 * @returns 有効なファイルの場合はtrue 無効なファイルの場合はfalse
 */
export const isActiveFile = function (fileType: string, filePath: string, fileName: string): boolean {
    let isActive = !invalidMimeList.includes(fileType) && !disabledFilenameList.includes(fileName) && !disabledFilenameList.includes(filePath);
    if (isActive) {
        const filePathWithSlash = '/' + filePath.replace(/\\/g, '/');
        // 隠しディレクトリ/ファイルは無効
        filePathWithSlash.includes('/.') && (isActive = false);
        if (isActive) {
            // その他の無効ディレクトリ
            disabledDirectoryList.find((disabledDirectory) => {
                if (filePathWithSlash.includes(`/${disabledDirectory}/`)) {
                    isActive = false;
                    return true;
                } else { }
            });
        } else { }
    } else { }
    return isActive;
}

/**
 * [user認証] ファイルアップロード (ファイルまたはBase64)
 */
export const handleFileUpload = async (filePath: string, fileBodyEntity: FileBodyEntity, projectId: string, orgKey: string, userId: string, ip: string) => {
    const fileEntity = new FileEntity();
    fileEntity.fileName = path.basename(filePath);
    fileEntity.filePath = filePath;
    fileEntity.projectId = projectId;
    fileEntity.isActive = isActiveFile(fileBodyEntity.fileType, filePath, fileEntity.fileName);
    fileEntity.uploadedBy = userId;
    fileEntity.fileBodyId = fileBodyEntity.id;
    fileEntity.orgKey = orgKey;
    fileEntity.createdBy = userId;
    fileEntity.updatedBy = userId;
    fileEntity.createdIp = ip;
    fileEntity.updatedIp = ip;

    return { fileEntity, fileBodyEntity };
};

/**
 * [user認証] ファイルアップロード (ファイルまたはBase64)
 */
export const uploadFiles = [
    // Single/Groupでファイルグループの持ち方が異なる。分かりにくくなってしまったので大人しくAPI分ければよかった。
    body('uploadType').isString().notEmpty(),
    body('projectId').notEmpty().isUUID(),
    body('contents').isArray(),
    body('contents.*.filePath').isString().notEmpty(),
    body('contents.*.base64Data').isString().notEmpty(),
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        const { uploadType, projectId, contents } = req.body as { uploadType: 'Single' | 'Group', projectId: string, contents: { filePath: string, base64Data: string }[] };
        try {
            const savedFileGroups = await uploadFileFunction(req.info.user.id, projectId, contents, uploadType, req.info.user.orgKey, req.info.ip, req.info.user);
            let successCount = 0;
            let failureCount = 0;
            // console.dir(savedFileGroups);
            // fileBodyの情報も無理矢理埋め込んでおく
            savedFileGroups.forEach(savedFileGroup => {
                savedFileGroup.files.forEach(file => {
                    successCount += (file as any).error ? 0 : 1;
                    failureCount += (file as any).error ? 1 : 0;
                })
            });

            res.status(207).json({
                message: failureCount > 0
                    ? `${successCount}個のファイルが正常にアップロードされ、${failureCount}個のファイルでエラーが発生しました。`
                    : `${successCount}個のファイルが正常にアップロードされました。`,
                results: savedFileGroups,
            });
            // if (Array.isArray(savedFileGroups)) {
            // } else {
            //     res.status(savedFileGroups.status).json({ message: savedFileGroups.message });
            // }
        } catch (error) {
            console.error('Error uploading files:', error);
            res.status(500).json({ message: 'ファイルのアップロード中にエラーが発生しました' });
        }
    }
];

export async function uploadFileFunction(userId: string, projectId: string, contents: { filePath: string, base64Data: string }[], uploadType: 'Single' | 'Group' | FileGroupType, orgKey: string, ip: string, user: UserTokenPayload, label: string = '', description: string = ''):
    Promise<FileGroupEntityForView[]> {
    const project = await ds.getRepository(ProjectEntity).findOne({ where: { orgKey, id: projectId } });
    if (!project) {
        // return { status: 404, message: '指定されたプロジェクトが見つかりません' };
        throw new Error(JSON.stringify({ status: 404, message: '指定されたプロジェクトが見つかりません' }));
    }

    const teamMember = await ds.getRepository(TeamMemberEntity).findOne({
        where: { orgKey, userId, teamId: project.teamId }
    });

    if (project.visibility !== ProjectVisibility.Public && project.visibility !== ProjectVisibility.Login && !teamMember) {
        throw new Error(JSON.stringify({ status: 403, message: 'このプロジェクトにファイルをアップロードする権限がありません' }));
    }

    const fileIdBodyMas: { [fileEntityId: string]: FileBodyEntity } = {};
    const savedFileGroups: FileGroupEntityForView[] = [];
    await ds.transaction(async transactionalEntityManager => {
        const fileBodyMapSet = await convertToMapSet(transactionalEntityManager, contents, orgKey, userId, ip, user);

        // ルートディレクトリが同じかどうかでラベルを決定する
        if (label) {
            // 強制指定がある場合はそのまま
        } else {
            // ルートディレクトリが同じ場合はラベルを設定する
            for (const content of contents) {
                const curLabel = content.filePath.split(/[\/\\]/g)[0] + (contents.length > 1 ? '/' : '');
                if (label === '') {
                    label = curLabel;
                } else if (label !== curLabel) {
                    label = `${contents.length} files`; // ラベルが混在している場合は空にする
                    break;
                }
            }
        }

        // console.log(`Uploading ${contents.length} files to ${projectId} by ${userId} (${uploadType})`);

        let savedFileGroupGroup: FileGroupEntity | undefined;
        if (['Group', 'git', 'gitlab', 'gitea'].includes(uploadType)) {
            // シングルモードと通常モードがある。通常モードは1グループに複数ファイル。
            const fileGroup = new FileGroupEntity();
            fileGroup.type = ('Group' === uploadType || 'Single' === uploadType) ? FileGroupType.UPLOAD : uploadType;
            fileGroup.uploadedBy = userId;
            fileGroup.isActive = true;
            fileGroup.label = label;
            fileGroup.description = description;
            fileGroup.projectId = projectId;
            fileGroup.orgKey = orgKey;
            fileGroup.createdBy = userId;
            fileGroup.updatedBy = userId;
            fileGroup.createdIp = ip;
            fileGroup.updatedIp = ip;
            savedFileGroupGroup = await transactionalEntityManager.save(FileGroupEntity, fileGroup);
            savedFileGroups.push(savedFileGroupGroup as FileGroupEntityForView);
        } else { }
        const savedFileList = await Promise.all(contents.map(async (content, index) => {
            try {
                let savedFileGroupSingle: FileGroupEntity | undefined;
                if (['Single'].includes(uploadType)) {
                    // シングルモードと通常モードがある。シングルモードは1グループに1ファイル。一括実行用の複数ファイルなので、ファイルグループになってしまうと意味が違う。
                    const fileGroup = new FileGroupEntity();
                    fileGroup.type = FileGroupType.UPLOAD;
                    fileGroup.uploadedBy = userId;
                    fileGroup.isActive = true;
                    fileGroup.label = content.filePath.split(/[\/\\]/g)[0];
                    fileGroup.description = description;
                    fileGroup.projectId = projectId;
                    fileGroup.orgKey = orgKey;
                    fileGroup.createdBy = userId;
                    fileGroup.updatedBy = userId;
                    fileGroup.createdIp = ip;
                    fileGroup.updatedIp = ip;
                    savedFileGroupSingle = await transactionalEntityManager.save(FileGroupEntity, fileGroup);
                    savedFileGroups.push(savedFileGroupSingle as FileGroupEntityForView);
                } else { }

                if (savedFileGroupGroup || savedFileGroupSingle) {
                } else {
                    throw new Error('エラー。起きえないけどthrowしておかないと型チェックエラーになるので');
                }

                const file = await handleFileUpload(content.filePath, fileBodyMapSet.hashMap[fileBodyMapSet.hashList[index]].fileBodyEntity, projectId, orgKey, userId, ip);
                file.fileEntity.fileGroupId = (savedFileGroupGroup || savedFileGroupSingle as FileGroupEntity).id; // 必ずどちらかはある。
                const savedFile = await transactionalEntityManager.save(FileEntity, file.fileEntity);

                if (['Single'].includes(uploadType)) {
                    // console.log(`File ${savedFile.id} (${savedFile.fileName})`);
                    (savedFileGroupSingle as FileGroupEntityForView).files = [savedFile];
                } else { }

                fileIdBodyMas[file.fileEntity.id] = file.fileBodyEntity;

                const fileAccess = new FileAccessEntity();
                fileAccess.fileId = savedFile.id;
                fileAccess.teamId = project.teamId;
                fileAccess.canRead = true;
                fileAccess.canWrite = true;
                fileAccess.canDelete = true;
                fileAccess.orgKey = orgKey;
                fileAccess.createdBy = userId;
                fileAccess.updatedBy = userId;
                fileAccess.createdIp = ip;
                fileAccess.updatedIp = ip;
                await transactionalEntityManager.save(FileAccessEntity, fileAccess);

                return savedFile;
            } catch (error) {
                console.error('Error processing file:', error);
                // return { error: 'ファイルの処理中にエラーが発生しました', details: (error as any).message };
                throw new Error(JSON.stringify({ error: 'ファイルの処理中にエラーが発生しました', details: (error as any).message }));
            }
        }));

        if (['Group', 'git', 'gitlab', 'gitea'].includes(uploadType)) {
            (savedFileGroupGroup as FileGroupEntityForView).files = savedFileList;
        } else { }
        return savedFileGroupGroup as FileGroupEntityForView;
    });

    let successCount = 0;
    let failureCount = 0;
    // console.dir(savedFileGroups);
    // fileBodyの情報も無理矢理埋め込んでおく
    savedFileGroups.forEach(savedFileGroup => {
        // console.log(`FileGroup ${savedFileGroup.id} (${savedFileGroup.label})`);
        // console.dir(savedFileGroup);
        savedFileGroup.files.forEach(file => {
            successCount += (file as any).error ? 0 : 1;
            failureCount += (file as any).error ? 1 : 0;
            (file as any).fileBody = (() => {
                const body = fileIdBodyMas[(file as FileEntity).id];
                return { fileSize: body.fileSize, fileType: body.fileType, metaJson: body.metaJson };
            });
        })
    });

    return savedFileGroups;
}

/**
 * [user認証] ファイルダウンロード (通常またはBase64)
 */
export const downloadFile = [
    param('id').notEmpty().isUUID(),
    query('format').optional().isIn(['binary', 'base64', 'pdf']),
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        const fileId = req.params.id;
        const format = req.query.format || 'binary';

        try {
            const file = await ds.getRepository(FileEntity).findOneOrFail({ where: { orgKey: req.info.user.orgKey, id: fileId } });

            const fileBody = await ds.getRepository(FileBodyEntity).findOneOrFail({ where: { orgKey: req.info.user.orgKey, id: file.fileBodyId } });

            // アクセス権のチェック
            const userTeams = await ds.getRepository(TeamMemberEntity).find({ where: { orgKey: req.info.user.orgKey, userId: req.info.user.id } });
            const userTeamIds = userTeams.map(tm => tm.teamId);

            const fileAccess = await ds.getRepository(FileAccessEntity).findOne({
                where: { orgKey: req.info.user.orgKey, fileId: file.id, teamId: In(userTeamIds), canRead: true }
            });

            if (!fileAccess) {
                return res.status(403).json({ message: 'このファイルをダウンロードする権限がありません' });
            }

            if (format === 'base64') {
                const data = await fs.readFile(fileBody.innerPath);
                const base64Data = `data:${fileBody.fileType};base64,${data.toString('base64')}`;
                res.json({ fileName: file.fileName, base64Data });
            } else if (format === 'pdf') {
                res.setHeader('Content-Type', `application/pdf`);
                res.download(Utils.replaceExtension(fileBody.innerPath, 'pdf'), Utils.replaceExtension(file.fileName, 'pdf'));
            } else {
                res.setHeader('Content-Type', fileBody.fileType);
                res.download(fileBody.innerPath, file.fileName);
            }
        } catch (error) {
            console.error('Error downloading file:', error);
            if (error instanceof EntityNotFoundError) {
                res.status(404).json({ message: '指定されたファイルが見つかりません' });
            } else {
                res.status(500).json({ message: 'ファイルのダウンロード中にエラーが発生しました' });
            }
        }
    }
];

/**
 * [user認証] ファイルダウンロード (通常またはBase64)
 */
export const fileActivate = [
    body('isActive').isBoolean().notEmpty(),
    body('ids').isArray().notEmpty(),
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        const { isActive, ids } = req.body as { isActive: boolean, ids: string[] };

        try {
            const file = await ds.getRepository(FileEntity).find({ where: { orgKey: req.info.user.orgKey, id: In(ids) } });

            const fileGroups = await ds.getRepository(FileGroupEntity).find({ where: { orgKey: req.info.user.orgKey, id: In(file.map(f => f.fileGroupId)) } });

            // アクセス権のチェック
            const userTeams = await ds.getRepository(TeamMemberEntity).find({ where: { orgKey: req.info.user.orgKey, userId: req.info.user.id } });
            const userTeamIds = userTeams.map(tm => tm.teamId);

            const fileAccess = await ds.getRepository(ProjectEntity).findOne({
                where: { orgKey: req.info.user.orgKey, id: In(fileGroups.map(fileGroup => fileGroup.projectId)), teamId: In(userTeamIds) }
            });

            if (!fileAccess) {
                return res.status(403).json({ message: 'このファイルをダウンロードする権限がありません' });
            }

            const updateResult = await ds.getRepository(FileEntity).update({ orgKey: req.info.user.orgKey, id: In(ids), isActive: !isActive }, { isActive });

            res.status(200).json({ message: 'ファイルの状態を更新しました', updateResult });
        } catch (error) {
            console.error('Error downloading file:', error);
            if (error instanceof EntityNotFoundError) {
                res.status(404).json({ message: '指定されたファイルが見つかりません' });
            } else {
                res.status(500).json({ message: 'ファイルのダウンロード中にエラーが発生しました' });
            }
        }
    }
];

/**
 * [user認証] ファイルダウンロード (通常またはBase64)
 */
export const getFileGroup = [
    param('id').notEmpty().isUUID(),
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        const fileGroupId = req.params.id;
        try {
            const fileGroup = await ds.getRepository(FileGroupEntity).findOneOrFail({ where: { orgKey: req.info.user.orgKey, id: fileGroupId } });

            // アクセス権のチェック
            const userTeams = await ds.getRepository(TeamMemberEntity).find({ where: { orgKey: req.info.user.orgKey, userId: req.info.user.id } });
            const userTeamIds = userTeams.map(tm => tm.teamId);

            const fileAccess = await ds.getRepository(ProjectEntity).findOne({
                where: { orgKey: req.info.user.orgKey, id: fileGroup.projectId, teamId: In(userTeamIds) }
            });

            if (!fileAccess) {
                return res.status(403).json({ message: 'このファイル参照する権限がありません' });
            }

            // 子オブジェクトを埋め込むfileSize
            const files = await ds.getRepository(FileEntity).find({ where: { orgKey: req.info.user.orgKey, fileGroupId }, order: { filePath: 'ASC' } });

            const fileIdBodyMas: { [fileEntityId: string]: FileBodyEntity } = {};
            const fileBodyIds = files.map(f => f.fileBodyId);
            const fileBodies = await ds.getRepository(FileBodyEntity).find({ where: { orgKey: req.info.user.orgKey, id: In(fileBodyIds) } });
            fileBodies.forEach(body => fileIdBodyMas[body.id] = body);

            // fileBodyの情報も無理矢理埋め込んでおく
            files.forEach(file => {
                const body = fileIdBodyMas[(file as FileEntity).fileBodyId];
                Object.assign(file, { fileSize: body.fileSize, fileType: body.fileType, metaJson: body.metaJson });
            });
            (fileGroup as FileGroupEntityForView).files = files;

            res.json(fileGroup);
        } catch (error) {
            console.error('Error downloading file:', error);
            if (error instanceof EntityNotFoundError) {
                res.status(404).json({ message: '指定されたファイルが見つかりません' });
            } else {
                res.status(500).json({ message: 'ファイルのダウンロード中にエラーが発生しました' });
            }
        }
    }
];

/**
 * [user認証] ファイルメタデータ更新
 */
export const updateFileMetadata = [
    param('id').notEmpty().isUUID(),
    body('fileName').optional().isString().notEmpty(),
    body('description').optional().isString(),
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        const fileId = req.params.id;
        const { fileName, description } = req.body;

        try {
            const file = await ds.getRepository(FileEntity).findOneOrFail({ where: { orgKey: req.info.user.orgKey, id: fileId } });

            // アクセス権のチェック
            const userTeams = await ds.getRepository(TeamMemberEntity).find({ where: { orgKey: req.info.user.orgKey, userId: req.info.user.id } });
            const userTeamIds = userTeams.map(tm => tm.teamId);

            const fileAccess = await ds.getRepository(FileAccessEntity).findOne({
                where: { orgKey: req.info.user.orgKey, fileId: file.id, teamId: In(userTeamIds), canWrite: true }
            });

            if (!fileAccess) {
                return res.status(403).json({ message: 'このファイルを更新する権限がありません' });
            }

            if (fileName) file.fileName = fileName;
            // if (description !== undefined) file.description = description;

            file.updatedBy = req.info.user.id;
            file.updatedIp = req.info.ip;

            const updatedFile = await ds.getRepository(FileEntity).save(file);

            res.status(200).json(updatedFile);
        } catch (error) {
            console.error('Error updating file metadata:', error);
            if (error instanceof EntityNotFoundError) {
                res.status(404).json({ message: '指定されたファイルが見つかりません' });
            } else {
                res.status(500).json({ message: 'ファイルメタデータの更新中にエラーが発生しました' });
            }
        }
    }
];

/**
 * [user認証] ファイル削除
 */
export const deleteFile = [
    param('id').notEmpty().isUUID(),
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        const fileId = req.params.id;

        try {
            const file = await ds.getRepository(FileEntity).findOneOrFail({ where: { orgKey: req.info.user.orgKey, id: fileId } });
            const fileBody = await ds.getRepository(FileBodyEntity).findOneOrFail({ where: { orgKey: req.info.user.orgKey, id: file.fileBodyId } });

            // アクセス権のチェック
            const userTeams = await ds.getRepository(TeamMemberEntity).find({ where: { orgKey: req.info.user.orgKey, userId: req.info.user.id } });
            const userTeamIds = userTeams.map(tm => tm.teamId);

            const fileAccess = await ds.getRepository(FileAccessEntity).findOne({
                where: { orgKey: req.info.user.orgKey, fileId: file.id, teamId: In(userTeamIds), canDelete: true }
            });

            if (!fileAccess) {
                return res.status(403).json({ message: 'このファイルを削除する権限がありません' });
            }

            // ファイルの物理的な削除
            await fs.unlink(fileBody.innerPath);
            if (['image', 'audio', 'video'].includes(fileBody.fileType.split('/')[0])) {
                // メディアファイル系は調整前ファイルもセットで消す。
                await fs.unlink(fileBody.innerPath.replace('-optimize.', '-original.'));
            }

            // データベースからの削除
            await ds.getRepository(FileBodyEntity).remove(fileBody);
            await ds.getRepository(FileEntity).remove(file);

            res.status(200).json({ message: 'ファイルが正常に削除されました' });
        } catch (error) {
            console.error('Error deleting file:', error);
            if (error instanceof EntityNotFoundError) {
                res.status(404).json({ message: '指定されたファイルが見つかりません' });
            } else {
                res.status(500).json({ message: 'ファイルの削除中にエラーが発生しました' });
            }
        }
    }
];

/**
 * [user認証] ファイル一覧取得
 */
export const getFileList = [
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        try {
            const userTeams = await ds.getRepository(TeamMemberEntity).find({ where: { orgKey: req.info.user.orgKey, userId: req.info.user.id } });
            const userTeamIds = userTeams.map(tm => tm.teamId);

            const fileAccesses = await ds.getRepository(FileAccessEntity).find({
                where: { orgKey: req.info.user.orgKey, teamId: In(userTeamIds), canRead: true }
            });

            const fileIds = fileAccesses.map(fa => fa.fileId);

            const files = await ds.getRepository(FileEntity).find({
                where: { orgKey: req.info.user.orgKey, id: In(fileIds) }
            });

            res.status(200).json(files);
        } catch (error) {
            console.error('Error getting file list:', error);
            res.status(500).json({ message: 'ファイル一覧の取得中にエラーが発生しました' });
        }
    }
];

/**
 * [user認証] ファイルアクセス権の更新
 */
export const updateFileAccess = [
    param('id').notEmpty().isUUID(),
    body('teamId').notEmpty().isUUID(),
    body('canRead').isBoolean(),
    body('canWrite').isBoolean(),
    body('canDelete').isBoolean(),
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        const fileId = req.params.id;
        const { teamId, canRead, canWrite, canDelete } = req.body;

        try {
            const file = await ds.getRepository(FileEntity).findOneOrFail({ where: { orgKey: req.info.user.orgKey, id: fileId } });

            // リクエスト元ユーザーがファイルのプロジェクトのオーナーであるか確認
            const isProjectOwner = await ds.getRepository(TeamMemberEntity).findOne({
                where: {
                    orgKey: req.info.user.orgKey,
                    userId: req.info.user.id,
                    teamId: file.projectId,
                    role: TeamMemberRoleType.Owner
                }
            });

            if (!isProjectOwner) {
                return res.status(403).json({ message: 'このファイルのアクセス権を変更する権限がありません' });
            }

            let fileAccess = await ds.getRepository(FileAccessEntity).findOne({
                where: { orgKey: req.info.user.orgKey, fileId: fileId, teamId: teamId }
            });

            if (!fileAccess) {
                fileAccess = new FileAccessEntity();
                fileAccess.fileId = fileId;
                fileAccess.teamId = teamId;
            }

            fileAccess.canRead = canRead;
            fileAccess.canWrite = canWrite;
            fileAccess.canDelete = canDelete;
            fileAccess.updatedBy = req.info.user.id;
            fileAccess.updatedIp = req.info.ip;

            await ds.getRepository(FileAccessEntity).save(fileAccess);

            res.status(200).json({ message: 'ファイルアクセス権が正常に更新されました' });
        } catch (error) {
            console.error('Error updating file access:', error);
            if (error instanceof EntityNotFoundError) {
                res.status(404).json({ message: '指定されたファイルが見つかりません' });
            } else {
                res.status(500).json({ message: 'ファイルアクセス権の更新中にエラーが発生しました' });
            }
        }
    }
];
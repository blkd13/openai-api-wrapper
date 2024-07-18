import { NextFunction, Request, Response } from 'express';
import { body, param, query, validationResult } from 'express-validator';
import { EntityNotFoundError, In } from 'typeorm';
import { ds } from '../db.js';
import { FileEntity, FileTagEntity, FileVersionEntity, FileAccessEntity, FileBodyEntity } from '../entity/file-models.entity.js';
import { ProjectEntity, TeamMemberEntity } from '../entity/project-models.entity.js';
import { ProjectVisibility, TeamMemberRoleType } from '../models/values.js';
import { UserRequest } from '../models/info.js';
import { validationErrorHandler } from '../middleware/validation.js';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import sizeOf from 'image-size';
import { convertAndOptimizeImage, detectMimeType, getMetaDataFromFile, minimizeVideoForMinutes, normalizeAndMinimizeAudio } from '../../common/media-funcs.js';
import { lastValueFrom } from 'rxjs';

import * as dotenv from 'dotenv';
dotenv.config();
const { UPLOAD_DIR } = process.env;

// 結局使わない
const ALLOWED_MIME_TYPES = [
    'image/png', 'image/jpeg',
    'video/x-flv', 'video/mov', 'video/mpeg', 'video/mpegps', 'video/mpg', 'video/mp4', 'video/webm', 'video/wmv', 'video/3gpp',
    'audio/aac', 'audio/flac', 'audio/mp3', 'audio/m4a', 'audio/mpeg', 'audio/mpga', 'audio/mp4', 'audio/opus', 'audio/pcm', 'audio/wav', 'audio/webm',
    'application/pdf'
];

const handleFileUpload = async (content: { filePath: string, base64Data: string }, projectId: string, userId: string) => {
    const matches = content.base64Data.match(/^data:([A-Za-z0-9-+\/]+);base64,(.+)$/);
    if (!matches || matches.length !== 3) {
        throw new Error('無効なBase64データです');
    }

    let fileType = matches[1];
    // if (!ALLOWED_MIME_TYPES.includes(fileType)) {
    //     throw new Error('許可されていないファイルタイプです');
    // }

    const buffer = Buffer.from(matches[2], 'base64');
    const hashSum = crypto.createHash('sha256');
    hashSum.update(buffer);
    const sha256 = hashSum.digest('hex');
    const fileSize = buffer.length;

    const pathBase = path.join(UPLOAD_DIR || '.', sha256.substring(0, 2), sha256.substring(2, 4), sha256);
    const outPathBase = pathBase + '-optimize';

    await fs.mkdir(path.dirname(pathBase), { recursive: true });
    await fs.writeFile(pathBase, buffer);

    if (fileType === 'application/octet-stream') {
        fileType = await detectMimeType(pathBase, content.filePath);
    }

    let innerPath: string;
    let meta: any = {};
    let ext = (content.filePath.split('\.').pop() || '').toLowerCase();
    // const ext = fileType.split('/')[1].replace(/.*[-+]/g, '').replace('text', 'txt');

    if (fileType.startsWith('application/') || fileType.startsWith('text/')) {
        innerPath = `${pathBase}-plain.${ext}`;
        await fs.rename(pathBase, innerPath);
    } else if (fileType.startsWith('image/')) {
        innerPath = `${pathBase}-original.${ext}`;
        await fs.rename(pathBase, innerPath);
        // innerPath = await convertAndOptimizeImage(innerPath, outPathBase);
        meta = sizeOf(buffer);
    } else if (fileType.startsWith('video/')) {
        innerPath = `${pathBase}-original.${ext}`;
        await fs.rename(pathBase, innerPath);
        // innerPath = await minimizeVideoForMinutes(innerPath, outPathBase);
        meta = await lastValueFrom(getMetaDataFromFile(innerPath));
    } else if (fileType.startsWith('audio/')) {
        innerPath = `${pathBase}-original.${ext}`;
        await fs.rename(pathBase, innerPath);
        // innerPath = await normalizeAndMinimizeAudio(innerPath, outPathBase);
        meta = await lastValueFrom(getMetaDataFromFile(innerPath));
    } else {
        innerPath = `${pathBase}-plain.${ext}`;
        await fs.rename(pathBase, innerPath);
    }

    let fileBodyEntity = await ds.getRepository(FileBodyEntity).findOne({ where: { sha256 } });
    if (!fileBodyEntity) {
        fileBodyEntity = new FileBodyEntity();
        fileBodyEntity.fileType = fileType;
        fileBodyEntity.fileSize = fileSize;
        fileBodyEntity.innerPath = innerPath;
        fileBodyEntity.sha256 = sha256;
        fileBodyEntity.metaJson = JSON.stringify(meta || {});
        fileBodyEntity.createdBy = userId;
        fileBodyEntity.updatedBy = userId;
        fileBodyEntity = await ds.getRepository(FileBodyEntity).save(fileBodyEntity);
    }

    const fileEntity = new FileEntity();
    fileEntity.fileName = path.basename(content.filePath);
    fileEntity.filePath = content.filePath;
    fileEntity.projectId = projectId;
    fileEntity.uploadedBy = userId;
    fileEntity.fileBodyId = fileBodyEntity.id;
    fileEntity.createdBy = userId;
    fileEntity.updatedBy = userId;

    return { fileEntity, fileBodyEntity };
};

/**
 * [user認証] ファイルアップロード (ファイルまたはBase64)
 */
export const uploadFiles = [
    body('projectId').isUUID(),
    body('contents').isArray(),
    body('contents.*.filePath').isString().notEmpty(),
    body('contents.*.base64Data').isString().notEmpty(),

    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        const { projectId, contents } = req.body as { projectId: string, contents: { filePath: string, base64Data: string }[] };

        try {
            const project = await ds.getRepository(ProjectEntity).findOne({ where: { id: projectId } });
            if (!project) {
                return res.status(404).json({ message: '指定されたプロジェクトが見つかりません' });
            }

            const teamMember = await ds.getRepository(TeamMemberEntity).findOne({
                where: { userId: req.info.user.id, teamId: project.teamId }
            });

            if (project.visibility !== ProjectVisibility.Public && project.visibility !== ProjectVisibility.Login && !teamMember) {
                return res.status(403).json({ message: 'このプロジェクトにファイルをアップロードする権限がありません' });
            }

            const fileIdBodyMas: { [key: string]: FileBodyEntity } = {};
            const savedFileList = await ds.transaction(async transactionalEntityManager => {

                return Promise.all(contents.map(async content => {
                    try {
                        const file = await handleFileUpload(content, projectId, req.info.user.id);
                        const savedFile = await transactionalEntityManager.save(FileEntity, file.fileEntity);

                        fileIdBodyMas[file.fileEntity.id] = file.fileBodyEntity;

                        const fileAccess = new FileAccessEntity();
                        fileAccess.fileId = savedFile.id;
                        fileAccess.teamId = project.teamId;
                        fileAccess.canRead = true;
                        fileAccess.canWrite = true;
                        fileAccess.canDelete = true;
                        fileAccess.createdBy = req.info.user.id;
                        fileAccess.updatedBy = req.info.user.id;
                        await transactionalEntityManager.save(FileAccessEntity, fileAccess);

                        return savedFile;
                    } catch (error) {
                        console.error('Error processing file:', error);
                        return { error: 'ファイルの処理中にエラーが発生しました', details: (error as any).message };
                    }
                }));
            });

            const successCount = savedFileList.filter(file => !(file as any).error).length;
            const failureCount = savedFileList.length - successCount;
            res.status(207).json({
                message: failureCount > 0
                    ? `${successCount}個のファイルが正常にアップロードされ、${failureCount}個のファイルでエラーが発生しました。`
                    : `${successCount}個のファイルが正常にアップロードされました。`,
                results: savedFileList.map(file => ({
                    ...file, fileBody: (() => {
                        const body = fileIdBodyMas[(file as FileEntity).id];
                        return { fileSize: body.fileSize, fileType: body.fileType, metaJson: body.metaJson };
                    })
                }))
            });
        } catch (error) {
            console.error('Error uploading files:', error);
            res.status(500).json({ message: 'ファイルのアップロード中にエラーが発生しました' });
        }
    }
];

/**
 * [user認証] ファイルダウンロード (通常またはBase64)
 */
export const downloadFile = [
    param('id').isUUID(),
    query('format').optional().isIn(['binary', 'base64']),
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        const fileId = req.params.id;
        const format = req.query.format || 'binary';

        try {
            const file = await ds.getRepository(FileEntity).findOneOrFail({ where: { id: fileId } });

            const fileBody = await ds.getRepository(FileBodyEntity).findOneOrFail({ where: { id: file.fileBodyId } });

            // アクセス権のチェック
            const userTeams = await ds.getRepository(TeamMemberEntity).find({ where: { userId: req.info.user.id } });
            const userTeamIds = userTeams.map(tm => tm.teamId);

            const fileAccess = await ds.getRepository(FileAccessEntity).findOne({
                where: { fileId: file.id, teamId: In(userTeamIds), canRead: true }
            });

            if (!fileAccess) {
                return res.status(403).json({ message: 'このファイルをダウンロードする権限がありません' });
            }

            if (format === 'base64') {
                const data = await fs.readFile(fileBody.innerPath);
                const base64Data = `data:${fileBody.fileType};base64,${data.toString('base64')}`;
                res.json({ fileName: file.fileName, base64Data });
            } else {
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
 * [user認証] ファイルメタデータ更新
 */
export const updateFileMetadata = [
    param('id').isUUID(),
    body('fileName').optional().isString().notEmpty(),
    body('description').optional().isString(),
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        const fileId = req.params.id;
        const { fileName, description } = req.body;

        try {
            const file = await ds.getRepository(FileEntity).findOneOrFail({ where: { id: fileId } });

            // アクセス権のチェック
            const userTeams = await ds.getRepository(TeamMemberEntity).find({ where: { userId: req.info.user.id } });
            const userTeamIds = userTeams.map(tm => tm.teamId);

            const fileAccess = await ds.getRepository(FileAccessEntity).findOne({
                where: { fileId: file.id, teamId: In(userTeamIds), canWrite: true }
            });

            if (!fileAccess) {
                return res.status(403).json({ message: 'このファイルを更新する権限がありません' });
            }

            if (fileName) file.fileName = fileName;
            if (description !== undefined) file.description = description;

            file.updatedBy = req.info.user.id;

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
    param('id').isUUID(),
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        const fileId = req.params.id;

        try {
            const file = await ds.getRepository(FileEntity).findOneOrFail({ where: { id: fileId } });
            const fileBody = await ds.getRepository(FileBodyEntity).findOneOrFail({ where: { id: file.fileBodyId } });

            // アクセス権のチェック
            const userTeams = await ds.getRepository(TeamMemberEntity).find({ where: { userId: req.info.user.id } });
            const userTeamIds = userTeams.map(tm => tm.teamId);

            const fileAccess = await ds.getRepository(FileAccessEntity).findOne({
                where: { fileId: file.id, teamId: In(userTeamIds), canDelete: true }
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
            const userTeams = await ds.getRepository(TeamMemberEntity).find({ where: { userId: req.info.user.id } });
            const userTeamIds = userTeams.map(tm => tm.teamId);

            const fileAccesses = await ds.getRepository(FileAccessEntity).find({
                where: { teamId: In(userTeamIds), canRead: true }
            });

            const fileIds = fileAccesses.map(fa => fa.fileId);

            const files = await ds.getRepository(FileEntity).find({
                where: { id: In(fileIds) }
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
    param('id').isUUID(),
    body('teamId').isUUID(),
    body('canRead').isBoolean(),
    body('canWrite').isBoolean(),
    body('canDelete').isBoolean(),
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        const fileId = req.params.id;
        const { teamId, canRead, canWrite, canDelete } = req.body;

        try {
            const file = await ds.getRepository(FileEntity).findOneOrFail({ where: { id: fileId } });

            // リクエスト元ユーザーがファイルのプロジェクトのオーナーであるか確認
            const isProjectOwner = await ds.getRepository(TeamMemberEntity).findOne({
                where: {
                    userId: req.info.user.id,
                    teamId: file.projectId,
                    role: TeamMemberRoleType.Owner
                }
            });

            if (!isProjectOwner) {
                return res.status(403).json({ message: 'このファイルのアクセス権を変更する権限がありません' });
            }

            let fileAccess = await ds.getRepository(FileAccessEntity).findOne({
                where: { fileId: fileId, teamId: teamId }
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
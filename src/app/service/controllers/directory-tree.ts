import * as fs from 'fs';
import * as path from 'path';
import { param } from 'express-validator';
import { Request, Response } from 'express';

import { UserRequest } from '../models/info.js';
import { validationErrorHandler } from '../middleware/validation.js';

// ディレクトリまたはファイルの情報を表すインターフェース
interface DirectoryItem {
    name: string;
    type: 'file' | 'directory';
    children?: DirectoryItem[];
}

// ディレクトリツリーを取得する関数
function readDirectory(baseDir: string, dir: string): DirectoryItem[] {
    // 絶対パスから基準パスを超えていないかチェック
    const fullPath = path.resolve(baseDir, dir);
    if (!fullPath.startsWith(path.resolve(baseDir))) {
        throw new Error("Access to the parent directory is not allowed.");
    }

    const files = fs.readdirSync(fullPath);
    const result: DirectoryItem[] = [];

    files.forEach(file => {
        const filePath = path.join(fullPath, file);
        const stats = fs.statSync(filePath);

        if (stats.isDirectory()) {
            result.push({
                name: file,
                type: 'directory',
                children: readDirectory(baseDir, path.join(dir, file))
            });
        } else {
            result.push({
                name: file,
                type: 'file'
            });
        }
    });

    return result;
}

function req2path(req: Request): string {
    let subPath;
    console.log(req.params);
    if (req.params[0]) {
        subPath = `${req.params.path}/${req.params[0]}`;
    } else {
        subPath = req.params.path; // サブパスを取得
    }
    subPath = subPath.replace(/\/+/g, '/'); // 重複するスラッシュを削除
    subPath = subPath.replace(/\/$/, ''); // 末尾のスラッシュを削除
    // ディレクトリトラバーサル対策
    if (subPath.includes('..')) {
        throw new Error("Access to the parent directory is not allowed.");
    }
    return subPath;
}

/**
 * [user認証] ディレクトリツリーの取得
 */
export const getDirectoryTree = [
    param('path').trim().notEmpty(),
    validationErrorHandler,
    (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        res.json(readDirectory(`${process.cwd()}/data/workflow/`, req2path(req)));
    }
];

/**
 * [user認証] ファイルの取得
 */
export const getFile = [
    param('path').trim().notEmpty(),
    validationErrorHandler,
    (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        res.sendFile(`${process.cwd()}/data/workflow/${req2path(req)}`);
    }
];

/**
 * [user認証] ファイルの保存
 */
export const saveFile = [
    param('path').trim().notEmpty(),
    validationErrorHandler,
    (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        fs.writeFile(`${process.cwd()}/data/workflow/${req2path(req)}`, req.body.body, (err) => {
            if (err) {
                res.status(500).json({ message: err.message });
            } else {
                res.json({ message: 'success' });
            }
        });
    }
];
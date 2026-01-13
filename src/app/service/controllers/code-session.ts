import { Request, Response } from 'express';
import { body, param, query } from 'express-validator';
import { promises as fs } from 'fs';
import * as path from 'path';
import { EntityManager } from 'typeorm';
import { ds } from '../db.js';
import { CodeSessionDataSourceEntity, DataSourceType } from '../entity/code-session.entity.js';
import { validationErrorHandler } from '../middleware/validation.js';
import { UserRequest } from '../models/info.js';

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * パスが存在するか確認
 */
async function pathExists(p: string): Promise<boolean> {
    try {
        await fs.access(p);
        return true;
    } catch {
        return false;
    }
}

/**
 * ホームディレクトリを取得（クロスプラットフォーム対応）
 */
function getHomeDir(): string {
    // Windows: USERPROFILE or HOMEDRIVE+HOMEPATH
    // Unix/Mac: HOME
    return process.env.HOME ||
        process.env.USERPROFILE ||
        (process.env.HOMEDRIVE && process.env.HOMEPATH
            ? path.join(process.env.HOMEDRIVE, process.env.HOMEPATH)
            : '');
}

/**
 * ~ をホームディレクトリに展開
 */
function expandTilde(inputPath: string): string {
    if (inputPath.startsWith('~')) {
        const homeDir = getHomeDir();
        if (homeDir) {
            return path.join(homeDir, inputPath.slice(1));
        }
    }
    return inputPath;
}

/**
 * パスの検証（セキュリティチェック）
 */
async function validateBasePath(inputPath: string): Promise<{ valid: boolean; normalizedPath?: string; error?: string }> {
    try {
        if (!inputPath || typeof inputPath !== 'string') {
            return { valid: false, error: '無効なパスです' };
        }

        // ~ をホームディレクトリに展開
        const expandedPath = expandTilde(inputPath.trim());

        // 正規化
        const normalizedPath = path.normalize(expandedPath);

        // 絶対パスチェック（Windowsでは C:\ や \\server 形式、Unixでは / 形式）
        if (!path.isAbsolute(normalizedPath)) {
            return { valid: false, error: '絶対パスを指定してください（例: C:\\Users\\...、/home/...、~/.claude/projects）' };
        }

        // 親ディレクトリ参照チェック（正規化後に残っている場合は不正）
        if (normalizedPath.includes('..')) {
            return { valid: false, error: '不正なパスです' };
        }

        // セキュリティのためのホワイトリストチェック
        // Windows: バックスラッシュをスラッシュに統一して比較
        const normalizedLower = normalizedPath.toLowerCase().replace(/\\/g, '/');

        // 許可パターン:
        // 1. 従来の .claude/projects, .gemini/sessions, .codex/sessions
        // 2. 新規: /data/container/docker-compose.{uuid}/ 形式（コンテナ連携用）
        const isAllowedPath =
            normalizedLower.includes('.claude/projects') ||
            normalizedLower.includes('.gemini/sessions') ||
            normalizedLower.includes('.codex/sessions') ||
            /^\/data\/container\/docker-compose\.[a-f0-9-]{36}(\/|$)/i.test(normalizedPath);

        if (!isAllowedPath) {
            return { valid: false, error: 'Claude Code/Gemini CLI/Codex CLIのプロジェクトディレクトリを指定してください' };
        }

        // 実在確認
        const realPath = await fs.realpath(normalizedPath).catch(() => null);
        if (!realPath) {
            return { valid: false, error: 'ディレクトリが存在しません' };
        }

        // ディレクトリ確認
        const stat = await fs.stat(realPath);
        if (!stat.isDirectory()) {
            return { valid: false, error: 'ディレクトリではありません' };
        }

        return { valid: true, normalizedPath: realPath };
    } catch (error) {
        console.error('Path validation error:', error);
        return { valid: false, error: 'パスの検証中にエラーが発生しました' };
    }
}

/**
 * プロジェクト用のデータソースを自動作成
 * コンテナ作成時に呼び出される
 */
export async function createDataSourceForProject(
    manager: EntityManager,
    projectId: string,
    userId: string,
    orgKey: string,
    ip: string
): Promise<CodeSessionDataSourceEntity> {
    // docker-composeディレクトリ内のdevuser/.claude/projectsを参照
    const basePath = `./data/container/docker-compose.${projectId}/devuser/.claude/projects`;

    // 既存のデータソースをチェック
    const existing = await manager.findOne(CodeSessionDataSourceEntity, {
        where: {
            orgKey,
            projectId,
            isActive: true,
        },
    });

    if (existing) {
        return existing;
    }

    // 新規作成
    const dataSource = new CodeSessionDataSourceEntity();
    dataSource.orgKey = orgKey;
    dataSource.userId = userId;
    dataSource.projectId = projectId;
    dataSource.name = `Container: ${projectId.slice(0, 8)}`;
    dataSource.type = DataSourceType.CLAUDE_CODE;
    dataSource.basePath = basePath;
    dataSource.isActive = true;
    dataSource.createdBy = userId;
    dataSource.updatedBy = userId;
    dataSource.createdIp = ip;
    dataSource.updatedIp = ip;

    return await manager.save(CodeSessionDataSourceEntity, dataSource);
}

/**
 * 表示名を生成
 */
function formatDisplayName(name: string, pathMapping?: Record<string, string>): string {
    let displayName = name;
    if (pathMapping) {
        for (const [from, to] of Object.entries(pathMapping)) {
            displayName = displayName.replace(from, to);
        }
    }
    return displayName.replace(/-/g, '/');
}

/**
 * プロジェクトディレクトリからプロジェクト一覧をスキャン
 */
async function scanProjectsFromFileSystem(dataSource: CodeSessionDataSourceEntity) {
    const projects: Array<{
        name: string;
        displayName: string;
        path: string;
        sessionCount: number;
        dataSourceId: string;
        dataSourceName: string;
        lastActivity?: string;
    }> = [];
    const basePath = dataSource.basePath;

    try {
        const entries = await fs.readdir(basePath, { withFileTypes: true });

        for (const entry of entries) {
            if (entry.isDirectory()) {
                const projectPath = path.join(basePath, entry.name);
                const jsonlFiles = await fs.readdir(projectPath)
                    .then(files => files.filter(f => f.endsWith('.jsonl')))
                    .catch(() => []);

                if (jsonlFiles.length > 0) {
                    // 最新のファイルの更新日時を取得
                    let lastActivity: string | undefined;
                    try {
                        const stats = await Promise.all(
                            jsonlFiles.slice(0, 5).map(async f => {
                                const stat = await fs.stat(path.join(projectPath, f));
                                return stat.mtime;
                            })
                        );
                        lastActivity = stats.sort((a, b) => b.getTime() - a.getTime())[0]?.toISOString();
                    } catch {
                        // ignore
                    }

                    projects.push({
                        name: entry.name,
                        displayName: formatDisplayName(entry.name, dataSource.pathMapping),
                        path: projectPath,
                        sessionCount: jsonlFiles.length,
                        dataSourceId: dataSource.id,
                        dataSourceName: dataSource.name,
                        lastActivity,
                    });
                }
            }
        }
    } catch (error) {
        console.error(`Error scanning ${basePath}:`, error);
    }

    return projects;
}

/**
 * プロジェクトディレクトリからセッション一覧をスキャン
 */
async function scanSessionsFromDirectory(projectPath: string, projectName: string) {
    const sessions: Array<{
        sessionId: string;
        projectName: string;
        projectPath: string;
        startTime?: string;
        endTime?: string;
        messageCount: number;
        fileSize: number;
        firstMessage?: string;
    }> = [];

    try {
        const files = await fs.readdir(projectPath);
        const jsonlFiles = files.filter(f => f.endsWith('.jsonl'));

        for (const file of jsonlFiles) {
            const sessionId = file.replace('.jsonl', '');
            const filePath = path.join(projectPath, file);

            try {
                const stat = await fs.stat(filePath);
                const content = await fs.readFile(filePath, 'utf-8');
                const lines = content.split('\n').filter(line => line.trim());

                let startTime: string | undefined;
                let endTime: string | undefined;
                let firstMessage: string | undefined;

                // ファイルのタイムスタンプを使用
                startTime = stat.birthtime.toISOString();
                endTime = stat.mtime.toISOString();

                // 最初のユーザーメッセージを探す
                if (lines.length > 0) {
                    for (const line of lines.slice(0, 10)) {
                        try {
                            const msg = JSON.parse(line);
                            if (msg.type === 'user' && msg.message?.content) {
                                const msgContent = msg.message.content;
                                if (typeof msgContent === 'string') {
                                    firstMessage = msgContent.substring(0, 50);
                                } else if (Array.isArray(msgContent)) {
                                    const textPart = msgContent.find((p: any) => p.type === 'text');
                                    if (textPart?.text) {
                                        firstMessage = textPart.text.substring(0, 50);
                                    }
                                }
                                if (firstMessage) break;
                            }
                        } catch { /* ignore */ }
                    }
                }

                sessions.push({
                    sessionId,
                    projectName,
                    projectPath: projectPath.replace(/-/g, '/'),
                    startTime,
                    endTime,
                    messageCount: lines.length,
                    fileSize: stat.size,
                    firstMessage,
                });
            } catch (error) {
                console.error(`Error reading session ${file}:`, error);
            }
        }
    } catch (error) {
        console.error(`Error scanning sessions in ${projectPath}:`, error);
    }

    // 最終更新日時でソート（新しい順）
    return sessions.sort((a, b) => {
        if (!a.endTime) return 1;
        if (!b.endTime) return -1;
        return new Date(b.endTime).getTime() - new Date(a.endTime).getTime();
    });
}

/**
 * JSONLファイルをパースしてセッションデータを返す
 */
async function parseJsonlFile(filePath: string, projectName: string, sessionId: string) {
    const content = await fs.readFile(filePath, 'utf-8');
    const lines = content.split('\n').filter(line => line.trim());
    const messages = lines.map(line => {
        try {
            return JSON.parse(line);
        } catch {
            return null;
        }
    }).filter(Boolean);

    const firstMessage = messages[0];
    const lastMessage = messages[messages.length - 1];

    return {
        sessionId,
        projectName,
        projectPath: projectName.replace(/-/g, '/'),
        startTime: firstMessage?.timestamp || new Date().toISOString(),
        endTime: lastMessage?.timestamp,
        messageCount: messages.length,
        messages,
    };
}

// ============================================================================
// Data Source Management API
// ============================================================================

/**
 * データソース一覧を取得
 */
export const getDataSources = [
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        try {
            const dataSources = await ds.getRepository(CodeSessionDataSourceEntity).find({
                where: {
                    orgKey: req.info.user.orgKey,
                    userId: req.info.user.id,
                    isActive: true,
                },
                order: { name: 'ASC' },
            });
            res.json(dataSources);
        } catch (error) {
            console.error('Error fetching data sources:', error);
            res.status(500).json({ error: 'データソースの取得に失敗しました' });
        }
    },
];

/**
 * データソースを作成/更新
 * パス検証は情報提供のみで、失敗しても保存は可能
 * （Windows/Linux両環境から同じDBを使う場合等を考慮）
 */
export const upsertDataSource = [
    param('id').optional().isUUID(),
    body('name').isString().notEmpty(),
    body('type').isIn(Object.values(DataSourceType)),
    body('basePath').isString().notEmpty(),
    body('pathMapping').optional().isObject(),
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        const { id } = req.params;

        try {
            // パス検証（失敗してもブロックしない）
            const validation = await validateBasePath(req.body.basePath);
            const pathWarning = !validation.valid ? validation.error : undefined;

            // 保存するパス：検証成功なら正規化パス、失敗なら入力パスをそのまま使用
            const pathToSave = validation.valid
                ? validation.normalizedPath!
                : expandTilde(req.body.basePath.trim());

            const result = await ds.transaction(async transactionalEntityManager => {
                let dataSource: CodeSessionDataSourceEntity;
                let isNew = true;

                if (id) {
                    const existing = await transactionalEntityManager.findOne(CodeSessionDataSourceEntity, {
                        where: { id, orgKey: req.info.user.orgKey, userId: req.info.user.id },
                    });
                    if (existing) {
                        dataSource = existing;
                        isNew = false;
                    } else {
                        throw new Error('指定されたデータソースが見つかりません');
                    }
                } else {
                    dataSource = new CodeSessionDataSourceEntity();
                    dataSource.orgKey = req.info.user.orgKey;
                    dataSource.userId = req.info.user.id;
                    dataSource.createdBy = req.info.user.id;
                    dataSource.createdIp = req.info.ip;
                }

                dataSource.name = req.body.name;
                dataSource.type = req.body.type;
                dataSource.basePath = pathToSave;
                dataSource.pathMapping = req.body.pathMapping;
                dataSource.updatedBy = req.info.user.id;
                dataSource.updatedIp = req.info.ip;

                const saved = await transactionalEntityManager.save(CodeSessionDataSourceEntity, dataSource);
                return { dataSource: saved, isNew, pathWarning };
            });

            const statusCode = result.isNew ? 201 : 200;
            // 警告がある場合はレスポンスに含める
            const response: any = { ...result.dataSource };
            if (result.pathWarning) {
                response._warning = result.pathWarning;
            }
            res.status(statusCode).json(response);
        } catch (error) {
            console.error('Error upserting data source:', error);
            res.status(500).json({ error: 'データソースの保存に失敗しました' });
        }
    },
];

/**
 * データソースの有効/無効をトグル
 */
export const toggleDataSourceActive = [
    param('id').isUUID(),
    body('isActive').isBoolean(),
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        const { id } = req.params;
        const { isActive } = req.body;

        try {
            const result = await ds.transaction(async transactionalEntityManager => {
                const dataSource = await transactionalEntityManager.findOne(CodeSessionDataSourceEntity, {
                    where: { id, orgKey: req.info.user.orgKey, userId: req.info.user.id },
                });

                if (!dataSource) {
                    throw new Error('指定されたデータソースが見つかりません');
                }

                dataSource.isActive = isActive;
                dataSource.updatedBy = req.info.user.id;
                dataSource.updatedIp = req.info.ip;

                return await transactionalEntityManager.save(CodeSessionDataSourceEntity, dataSource);
            });

            res.json(result);
        } catch (error) {
            console.error('Error toggling data source:', error);
            res.status(500).json({ error: 'データソースの更新に失敗しました' });
        }
    },
];

/**
 * データソースを削除（論理削除）
 */
export const deleteDataSource = [
    param('id').isUUID(),
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        const { id } = req.params;

        try {
            const result = await ds.transaction(async transactionalEntityManager => {
                const dataSource = await transactionalEntityManager.findOne(CodeSessionDataSourceEntity, {
                    where: { id, orgKey: req.info.user.orgKey, userId: req.info.user.id },
                });

                if (!dataSource) {
                    throw new Error('指定されたデータソースが見つかりません');
                }

                dataSource.isActive = false;
                dataSource.updatedBy = req.info.user.id;
                dataSource.updatedIp = req.info.ip;

                return await transactionalEntityManager.save(CodeSessionDataSourceEntity, dataSource);
            });

            res.json({ message: 'データソースを削除しました', dataSource: result });
        } catch (error) {
            console.error('Error deleting data source:', error);
            res.status(500).json({ error: 'データソースの削除に失敗しました' });
        }
    },
];

/**
 * データソースのパス検証
 */
export const validateDataSourcePath = [
    body('basePath').isString().notEmpty(),
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;

        try {
            const validation = await validateBasePath(req.body.basePath);
            if (!validation.valid) {
                return res.status(400).json({ valid: false, error: validation.error });
            }

            // プロジェクト数をカウント
            let projectCount = 0;
            try {
                const entries = await fs.readdir(validation.normalizedPath!, { withFileTypes: true });
                for (const entry of entries) {
                    if (entry.isDirectory()) {
                        const projectPath = path.join(validation.normalizedPath!, entry.name);
                        const files = await fs.readdir(projectPath).catch(() => []);
                        if (files.some(f => f.endsWith('.jsonl'))) {
                            projectCount++;
                        }
                    }
                }
            } catch {
                // ignore
            }

            res.json({
                valid: true,
                normalizedPath: validation.normalizedPath,
                projectCount,
            });
        } catch (error) {
            console.error('Error validating path:', error);
            res.status(500).json({ valid: false, error: 'パスの検証中にエラーが発生しました' });
        }
    },
];

// ============================================================================
// Session Data API
// ============================================================================

/**
 * プロジェクト一覧を取得
 */
export const getProjects = [
    query('dataSourceId').optional().isUUID(),
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        const { dataSourceId } = req.query as { dataSourceId?: string };

        try {
            const whereClause: any = {
                orgKey: req.info.user.orgKey,
                userId: req.info.user.id,
                isActive: true,
            };
            if (dataSourceId) {
                whereClause.id = dataSourceId;
            }

            const dataSources = await ds.getRepository(CodeSessionDataSourceEntity).find({
                where: whereClause,
            });

            const allProjects: any[] = [];
            for (const dataSource of dataSources) {
                const projects = await scanProjectsFromFileSystem(dataSource);
                allProjects.push(...projects);
            }

            res.json(allProjects);
        } catch (error) {
            console.error('Error fetching projects:', error);
            res.status(500).json({ error: 'プロジェクト一覧の取得に失敗しました' });
        }
    },
];

/**
 * セッション一覧を取得
 */
export const getSessions = [
    param('projectName').isString().notEmpty(),
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        const { projectName } = req.params;

        try {
            const dataSources = await ds.getRepository(CodeSessionDataSourceEntity).find({
                where: {
                    orgKey: req.info.user.orgKey,
                    userId: req.info.user.id,
                    isActive: true,
                },
            });

            for (const dataSource of dataSources) {
                const projectPath = path.join(dataSource.basePath, projectName);
                if (await pathExists(projectPath)) {
                    const sessions = await scanSessionsFromDirectory(projectPath, projectName);
                    return res.json(sessions);
                }
            }

            res.status(404).json({ error: 'プロジェクトが見つかりません' });
        } catch (error) {
            console.error('Error fetching sessions:', error);
            res.status(500).json({ error: 'セッション一覧の取得に失敗しました' });
        }
    },
];

/**
 * セッション詳細を取得
 */
export const getSessionDetail = [
    param('projectName').isString().notEmpty(),
    param('sessionId').isString().notEmpty(),
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        const { projectName, sessionId } = req.params;

        try {
            const dataSources = await ds.getRepository(CodeSessionDataSourceEntity).find({
                where: {
                    orgKey: req.info.user.orgKey,
                    userId: req.info.user.id,
                    isActive: true,
                },
            });

            for (const dataSource of dataSources) {
                const sessionPath = path.join(
                    dataSource.basePath,
                    projectName,
                    `${sessionId}.jsonl`
                );

                if (await pathExists(sessionPath)) {
                    const sessionData = await parseJsonlFile(sessionPath, projectName, sessionId);
                    return res.json(sessionData);
                }
            }

            res.status(404).json({ error: 'セッションが見つかりません' });
        } catch (error) {
            console.error('Error fetching session detail:', error);
            res.status(500).json({ error: 'セッション詳細の取得に失敗しました' });
        }
    },
];

/**
 * プロジェクトに紐づくデータソースを取得
 */
export const getDataSourceByProject = [
    param('projectId').isUUID(),
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        const { projectId } = req.params;

        try {
            const dataSource = await ds.getRepository(CodeSessionDataSourceEntity).findOne({
                where: {
                    orgKey: req.info.user.orgKey,
                    projectId: projectId,
                    isActive: true,
                },
            });

            if (!dataSource) {
                return res.status(404).json({ error: 'データソースが見つかりません' });
            }

            res.json(dataSource);
        } catch (error) {
            console.error('Error fetching data source by project:', error);
            res.status(500).json({ error: 'データソースの取得に失敗しました' });
        }
    },
];

/**
 * 特定プロジェクト（コンテナ）に紐づくCode Sessionプロジェクト一覧
 */
export const getProjectsByProjectId = [
    param('projectId').isUUID(),
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        const { projectId } = req.params;

        try {
            // projectIdが設定されているデータソースのみ取得
            const dataSources = await ds.getRepository(CodeSessionDataSourceEntity).find({
                where: {
                    orgKey: req.info.user.orgKey,
                    projectId: projectId,
                    isActive: true,
                },
            });

            const allProjects: any[] = [];
            for (const dataSource of dataSources) {
                const projects = await scanProjectsFromFileSystem(dataSource);
                allProjects.push(...projects);
            }

            res.json(allProjects);
        } catch (error) {
            console.error('Error fetching projects by projectId:', error);
            res.status(500).json({ error: 'プロジェクト一覧の取得に失敗しました' });
        }
    },
];

import { Request, Response } from "express";
import { body, param } from "express-validator";
import { validationErrorHandler } from "../middleware/validation.js";
import { UserRequest } from "../models/info.js";
import { ds } from '../db.js';
import { MCPServerEntity, MCPConnectionType } from '../entity/mcp-server.entity.js';

export const getMCPServers = [
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        try {
            const servers = await ds.getRepository(MCPServerEntity).find({
                where: { orgKey: req.info.user.orgKey, isActive: true },
                order: { name: 'ASC' }
            });
            res.json(servers);
        } catch (error) {
            console.error('Error fetching MCP servers:', error);
            res.status(500).json({ error: 'MCPサーバーの取得に失敗しました' });
        }
    }
];

export const upsertMCPServer = [
    param('serverId').optional().isUUID(),
    body('name').isString().notEmpty(),
    body('connectionType').isIn(Object.values(MCPConnectionType)),
    body('connectionPath').optional().isString(),
    body('config').optional().isObject(),
    body('environment').optional().isObject(),
    body('headers').optional().isObject(),
    body('isActive').optional().isBoolean(),
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        const { serverId } = req.params;
        
        try {
            const result = await ds.transaction(async transactionalEntityManager => {
                let server: MCPServerEntity;
                let isNew = true;

                if (serverId) {
                    const existing = await transactionalEntityManager.findOne(MCPServerEntity, {
                        where: { id: serverId, orgKey: req.info.user.orgKey }
                    });
                    if (existing) {
                        server = existing;
                        isNew = false;
                    } else {
                        throw new Error('指定されたMCPサーバーが見つかりません');
                    }
                } else {
                    server = new MCPServerEntity();
                    server.orgKey = req.info.user.orgKey;
                    server.createdBy = req.info.user.id;
                    server.createdIp = req.info.ip;
                }

                // 共通フィールドの更新
                server.name = req.body.name;
                server.connectionType = req.body.connectionType;
                server.connectionPath = req.body.connectionPath;
                server.config = req.body.config;
                server.environment = req.body.environment;
                server.headers = req.body.headers;
                server.isActive = req.body.isActive ?? true;
                server.updatedBy = req.info.user.id;
                server.updatedIp = req.info.ip;

                const saved = await transactionalEntityManager.save(MCPServerEntity, server);
                return { server: saved, isNew };
            });

            const statusCode = result.isNew ? 201 : 200;
            res.status(statusCode).json(result.server);
        } catch (error) {
            console.error('Error upserting MCP server:', error);
            res.status(500).json({ error: 'MCPサーバーの保存に失敗しました' });
        }
    }
];

export const deleteMCPServer = [
    param('serverId').isUUID(),
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        const { serverId } = req.params;
        
        try {
            const result = await ds.transaction(async transactionalEntityManager => {
                const server = await transactionalEntityManager.findOne(MCPServerEntity, {
                    where: { id: serverId, orgKey: req.info.user.orgKey }
                });

                if (!server) {
                    throw new Error('指定されたMCPサーバーが見つかりません');
                }

                // 論理削除（isActiveをfalseに設定）
                server.isActive = false;
                server.updatedBy = req.info.user.id;
                server.updatedIp = req.info.ip;

                return await transactionalEntityManager.save(MCPServerEntity, server);
            });

            res.json({ message: 'MCPサーバーを削除しました', server: result });
        } catch (error) {
            console.error('Error deleting MCP server:', error);
            res.status(500).json({ error: 'MCPサーバーの削除に失敗しました' });
        }
    }
];

export const testMCPServerConnection = [
    param('serverId').isUUID(),
    validationErrorHandler,
    async (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        const { serverId } = req.params;
        
        try {
            const server = await ds.getRepository(MCPServerEntity).findOne({
                where: { id: serverId, orgKey: req.info.user.orgKey, isActive: true }
            });

            if (!server) {
                return res.status(404).json({ error: 'MCPサーバーが見つかりません' });
            }

            // 動的インポートでMCPクライアントを取得
            const { MCPClient } = await import('../../common/mcp-client.js');
            
            const client = new MCPClient(server);
            
            try {
                await client.connect();
                const tools = await client.getTools();
                client.disconnect();
                
                res.json({ 
                    success: true, 
                    message: '接続成功',
                    toolCount: tools.length,
                    tools: tools.map(tool => ({ name: tool.name, description: tool.description }))
                });
            } catch (connectionError) {
                client.disconnect();
                throw connectionError;
            }
        } catch (error) {
            console.error('Error testing MCP server connection:', error);
            res.status(500).json({ 
                success: false, 
                error: 'MCPサーバーへの接続テストに失敗しました',
                details: error instanceof Error ? error.message : '不明なエラー'
            });
        }
    }
];

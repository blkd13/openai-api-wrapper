import { MyToolType } from "../../common/openai-api-wrapper.js";
import { UserRequest } from "../models/info.js";
import { MessageEntity, MessageGroupEntity } from "../entity/project-models.entity.js";
import { ContentPartEntity } from "../entity/project-models.entity.js";
import { MessageArgsSet } from "../controllers/chat-by-project-model.js";
import { MCPClient } from "../../common/mcp-client.js";
import { MCPServerEntity } from "../entity/mcp-server.entity.js";
import { ds } from "../db.js";

// MCPクライアントインスタンスのキャッシュ
const mcpClientCache = new Map<string, MCPClient>();

export async function mcpFunctionDefinitions(
    providerName: string,
    obj: { 
        inDto: MessageArgsSet; 
        messageSet: { 
            messageGroup: MessageGroupEntity; 
            message: MessageEntity; 
            contentParts: ContentPartEntity[]; 
        }; 
    },
    req: UserRequest, 
    aiApi: any, 
    connectionId: string, 
    streamId: string, 
    message: MessageEntity, 
    label: string,
): Promise<MyToolType[]> {
    try {
        // MCPサーバー設定を取得
        const mcpServer = await ds.getRepository(MCPServerEntity).findOne({
            where: { 
                orgKey: req.info.user.orgKey, 
                name: providerName, 
                isActive: true 
            }
        });

        if (!mcpServer) {
            console.warn(`MCPサーバー '${providerName}' が見つかりません`);
            return [];
        }

        // クライアントを取得またはキャッシュから復元
        let mcpClient = mcpClientCache.get(mcpServer.id);
        if (!mcpClient) {
            mcpClient = new MCPClient(mcpServer);
            await mcpClient.connect();
            mcpClientCache.set(mcpServer.id, mcpClient);
        }

        // MCPサーバーから利用可能なツールを取得
        const mcpTools = await mcpClient.getTools();
        
        return mcpTools.map(tool => ({
            info: { 
                group: `mcp-${providerName}`, 
                isActive: true, 
                isInteractive: false, 
                label: `MCP: ${tool.name}`,
                responseType: 'text'
            },
            definition: {
                type: 'function',
                function: {
                    name: `mcp_${providerName}_${tool.name}`,
                    description: tool.description,
                    parameters: tool.inputSchema
                }
            },
            handler: async (args: any): Promise<string> => {
                try {
                    const result = await mcpClient!.callTool(tool.name, args);
                    return typeof result === 'string' ? result : JSON.stringify(result, null, 2);
                } catch (error) {
                    console.error(`MCPツール '${tool.name}' の実行エラー:`, error);
                    return `エラー: ${error instanceof Error ? error.message : '不明なエラー'}`;
                }
            }
        }));
    } catch (error) {
        console.error(`MCPプロバイダ '${providerName}' の初期化エラー:`, error);
        return [];
    }
}

// プロセス終了時にMCPクライアントを適切に切断
process.on('exit', () => {
    mcpClientCache.forEach(client => client.disconnect());
});

process.on('SIGINT', () => {
    mcpClientCache.forEach(client => client.disconnect());
    process.exit();
});

process.on('SIGTERM', () => {
    mcpClientCache.forEach(client => client.disconnect());
    process.exit();
});

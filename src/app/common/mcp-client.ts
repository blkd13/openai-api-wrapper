import { spawn, ChildProcess } from 'child_process';
import { MCPServerEntity, MCPConnectionType } from '../service/entity/mcp-server.entity.js';

export interface MCPMessage {
    jsonrpc: '2.0';
    id?: number;
    method: string;
    params?: any;
    result?: any;
    error?: any;
}

export interface MCPTool {
    name: string;
    description: string;
    inputSchema: any;
}

export class MCPClient {
    private requestId = 0;
    private pendingRequests = new Map<number, { resolve: Function, reject: Function }>();

    // stdio用
    private process?: ChildProcess;

    // sse用
    private eventSource?: EventSource;
    private baseUrl?: string;
    private headers?: Record<string, string>;

    constructor(private serverConfig: MCPServerEntity) { }

    async connect(): Promise<void> {
        if (this.serverConfig.connectionType === MCPConnectionType.STDIO) {
            await this.connectStdio();
        } else if (this.serverConfig.connectionType === MCPConnectionType.SSE) {
            await this.connectSSE();
        }

        // 初期化
        await this.sendRequest('initialize', {
            protocolVersion: '2024-11-05',
            capabilities: { tools: {} },
            clientInfo: { name: 'openai-api-wrapper', version: '1.0.0' }
        });
    }

    private async connectStdio(): Promise<void> {
        if (!this.serverConfig.connectionPath) {
            throw new Error('stdio接続にはconnectionPathが必要です');
        }

        this.process = spawn(this.serverConfig.connectionPath, [], {
            stdio: ['pipe', 'pipe', 'pipe'],
            env: { ...process.env, ...this.serverConfig.environment }
        });

        this.process.stdout?.on('data', (data) => {
            this.handleResponse(data.toString());
        });

        this.process.stderr?.on('data', (data) => {
            console.error('MCP Server Error:', data.toString());
        });

        this.process.on('error', (error) => {
            console.error('MCP Server Process Error:', error);
        });
    }

    private async connectSSE(): Promise<void> {
        if (!this.serverConfig.connectionPath) {
            throw new Error('sse接続にはconnectionPathが必要です');
        }

        this.baseUrl = this.serverConfig.connectionPath;
        this.headers = this.serverConfig.headers || {};

        // SSE接続の実装
        this.eventSource = new EventSource(`${this.baseUrl}/sse`, {
            // headers: this.headers
        });

        this.eventSource.onmessage = (event) => {
            this.handleResponse(event.data);
        };

        this.eventSource.onerror = (error) => {
            console.error('MCP SSE Error:', error);
        };
    }

    async getTools(): Promise<MCPTool[]> {
        const response = await this.sendRequest('tools/list', {});
        return response.tools || [];
    }

    async callTool(name: string, arguments_: any): Promise<any> {
        return await this.sendRequest('tools/call', {
            name,
            arguments: arguments_
        });
    }

    private async sendRequest(method: string, params: any): Promise<any> {
        const id = ++this.requestId;
        const request: MCPMessage = {
            jsonrpc: '2.0',
            id,
            method,
            params
        };

        return new Promise((resolve, reject) => {
            this.pendingRequests.set(id, { resolve, reject });

            if (this.serverConfig.connectionType === MCPConnectionType.STDIO) {
                this.process?.stdin?.write(JSON.stringify(request) + '\n');
            } else if (this.serverConfig.connectionType === MCPConnectionType.SSE) {
                // HTTP POST でリクエスト送信
                fetch(`${this.baseUrl}/request`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        ...this.headers
                    },
                    body: JSON.stringify(request)
                }).catch(reject);
            }
        });
    }

    private handleResponse(data: string): void {
        const lines = data.trim().split('\n');
        for (const line of lines) {
            try {
                const response: MCPMessage = JSON.parse(line);
                if (response.id !== undefined) {
                    const pending = this.pendingRequests.get(response.id);
                    if (pending) {
                        this.pendingRequests.delete(response.id);
                        if (response.error) {
                            pending.reject(new Error(response.error.message));
                        } else {
                            pending.resolve(response.result);
                        }
                    }
                }
            } catch (error) {
                console.error('Failed to parse MCP response:', error);
            }
        }
    }

    disconnect(): void {
        if (this.process) {
            this.process.kill();
        }
        if (this.eventSource) {
            this.eventSource.close();
        }
    }
}

import { Entity, Column } from 'typeorm';
import { MyBaseEntity } from './base.js';

export enum MCPConnectionType {
    STDIO = 'stdio',
    SSE = 'sse'
}

@Entity('mcp_servers')
export class MCPServerEntity extends MyBaseEntity {
    @Column()
    name!: string;

    @Column({ type: 'enum', enum: MCPConnectionType })
    connectionType!: MCPConnectionType;

    // stdio接続の場合: 実行可能ファイルのパス
    // sse接続の場合: エンドポイントURL
    @Column({ nullable: true })
    connectionPath?: string;

    @Column('json', { nullable: true })
    config?: any; // サーバー固有の設定

    @Column('json', { nullable: true })
    environment?: Record<string, string>; // stdio用の環境変数

    @Column('json', { nullable: true })
    headers?: Record<string, string>; // sse用のヘッダー

    @Column({ default: true })
    isActive!: boolean;
}

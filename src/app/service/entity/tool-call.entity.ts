import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, OneToMany, ManyToMany, JoinTable, OneToOne, JoinColumn, BaseEntity, Generated, UpdateDateColumn, PrimaryColumn, Index, ViewEntity, ViewColumn, EntityManager } from 'typeorm';

import { MyBaseEntity } from './base.js';
import { ChatCompletionChunk, ChatCompletionToolMessageParam } from 'openai/resources/index.js';
import { MyToolInfo } from '../../common/openai-api-wrapper.js';

export enum ToolCallPartType {
    INFO = 'info',
    CALL = 'call',
    COMMAND = 'command',
    RESULT = 'result',
}

export enum ToolCallGroupStatus {
    Normal = 'Normal',
    Deleted = 'Deleted',
}

export enum ToolCallPartStatus {
    Normal = 'Normal',
    Deleted = 'Deleted',
}

@Entity()
export class ToolCallGroupEntity extends MyBaseEntity {
    @Column({ type: 'integer' })
    @Generated('increment')
    seq!: number;

    @Column()
    projectId!: string; // 参照範囲チェックのため

    @Column({ type: 'enum', enum: ToolCallGroupStatus, default: ToolCallGroupStatus.Normal })
    status!: ToolCallGroupStatus;
}

@Entity()
export class ToolCallPartEntity extends MyBaseEntity {
    @Column({ type: 'integer' })
    @Generated('increment')
    seq!: number;

    @Index() // インデックス
    @Column()
    toolCallGroupId!: string;

    @Index() // インデックス
    @Column()
    toolCallId!: string;

    @Column({ type: 'enum', enum: ToolCallPartType })
    type!: ToolCallPartType;

    @Column({ type: 'jsonb' })
    body!: ToolCallPartBody; // JSON型を保存

    @Column({ type: 'enum', enum: ToolCallPartStatus, default: ToolCallPartStatus.Normal })
    status!: ToolCallPartStatus;
}

// 情報用のinterface
export interface ToolCallPartInfoBody extends MyToolInfo {
    isActive: boolean;
    group: string;
    name: string;
    label: string;
    isInteractive: boolean; // ユーザーの入力を要するもの
}

// isActive: boolean;
// group: string;
// name?: string;
// label: string;
// isInteractive?: boolean; // ユーザーの入力を要するもの

// 呼び出し用のinterface
export interface ToolCallPartCallBody {
    index: number;
    id: string;
    function: {
        arguments: any;
        name: string;
    };
    type: string;
}

// 入力用のinterface
export interface ToolCallPartCommandBody {
    command: 'execute' | 'cancel'; // コマンド
    input?: unknown; // ユーザーの入力
    arguments?: unknown; // argumentsを強制的に上書きする場合
}

// 結果用のinterface
export interface ToolCallPartResultBody {
    tool_call_id: string;
    role: string;
    content: any;
}

// 合成型
export type ToolCallPartBody =
    | ToolCallPartInfoBody // original
    | ToolCallPartCallBody | ChatCompletionChunk.Choice.Delta.ToolCall
    | ToolCallPartCommandBody // original
    | ToolCallPartResultBody | ChatCompletionToolMessageParam;

interface ToolCallPartBase {
    seq?: number;
    toolCallGroupId?: string;
    toolCallId: string;
}
export interface ToolCallPartInfo extends ToolCallPartBase {
    type: ToolCallPartType.INFO;
    body: ToolCallPartInfoBody;
}

export interface ToolCallPartCall extends ToolCallPartBase {
    type: ToolCallPartType.CALL;
    body: ToolCallPartCallBody;
}

export interface ToolCallPartCommand extends ToolCallPartBase {
    type: ToolCallPartType.COMMAND;
    body: ToolCallPartCommandBody;
}

export interface ToolCallPartResult extends ToolCallPartBase {
    type: ToolCallPartType.RESULT;
    body: ToolCallPartResultBody;
}

export type ToolCallPart = (ToolCallPartInfo | ToolCallPartCall | ToolCallPartCommand | ToolCallPartResult);

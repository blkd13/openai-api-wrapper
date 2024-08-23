import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, OneToMany, ManyToMany, JoinTable, OneToOne, JoinColumn, BaseEntity, Generated, UpdateDateColumn, PrimaryColumn, Index, ViewEntity, ViewColumn } from 'typeorm';

import { MyBaseEntity } from './base.js';
import { ContentPartType, MessageGroupType, PredictHistoryStatus, ProjectStatus, ProjectVisibility, TeamMemberRoleType, TeamStatus, TeamType, ThreadStatus, ThreadVisibility } from '../models/values.js';

@Entity()
export class TeamEntity extends MyBaseEntity {
    @PrimaryGeneratedColumn('uuid')
    id!: string;

    @Column({ nullable: false })
    name!: string;

    @Column({ nullable: false })
    label!: string;

    @Column({ nullable: true, type: 'text' })
    description?: string;

    @Column({ nullable: false, type: 'enum', enum: TeamType, })
    teamType!: TeamType;

    @Column({ nullable: false, type: 'enum', enum: TeamStatus, default: TeamStatus.Normal })
    status!: TeamStatus;
}


@Entity()
export class TeamMemberEntity extends MyBaseEntity {
    @PrimaryGeneratedColumn('uuid')
    id!: string;

    @Index() // インデックス
    @Column({ nullable: false })
    teamId!: string;

    @Index() // インデックス
    @Column({ nullable: false })
    userId!: string;

    @Column({ nullable: false, type: 'enum', enum: TeamMemberRoleType, })
    role!: TeamMemberRoleType;
}

@Entity()
export class PredictHistoryEntity extends MyBaseEntity {
    // このテーブルへの登録がミスるとメッセージが消えるので登録条件ゆるゆるにしておく。
    @PrimaryGeneratedColumn()
    id!: number;

    @Column()
    idempotencyKey!: string;

    @Column()
    argsHash!: string;

    @Column({ nullable: true })
    label?: string;

    @Column({ nullable: true })
    model?: string;

    @Column()
    provider!: string;

    @Column({ nullable: true, type: 'integer' })
    take?: number;

    @Column({ nullable: true, type: 'integer' })
    reqToken?: number;

    @Column({ nullable: true, type: 'integer' })
    resToken?: number;

    @Column({ nullable: true, type: 'float' })
    cost?: number;

    @Column({ nullable: true, type: 'enum', enum: PredictHistoryStatus })
    status?: PredictHistoryStatus;
}
@Entity()
export class PredictHistoryWrapperEntity extends MyBaseEntity {
    @PrimaryGeneratedColumn()
    id!: number;

    @Column({ nullable: true })
    connectionId?: string;

    @Column({ nullable: true })
    streamId?: string;

    @Column({ nullable: true })
    messageId?: string;

    @Column({ nullable: true })
    label?: string;

    @Column({ nullable: false })
    model!: string;

    @Column({ nullable: false })
    provider!: string;
}

// @ViewEntity({
//     name: 'predict_history_view', // ビューの名前
//     expression: `
//         SELECT 
//             p1.id, label, model, provider
//             idempotency_key, args_hash, 
//             take, req_token, res_token, cost, status, 
//             connection_id, stream_id, message_id,
//             COALESCE(p2.created_by, p1.created_by) AS created_by, 
//             COALESCE(p2.created_at, p1.created_at) AS created_at,
//             COALESCE(p2.updated_by, p1.updated_by) AS updated_by,
//             COALESCE(p2.updated_at, p1.updated_at) AS updated_at 
//         FROM predict_history_entity p1 
//         LEFT OUTER JOIN predict_history_wrapper_entity p2
//         USING (label, model, provider)
//         WHERE status IN ('fine', 'error')
//     `
// })
// export class PredictHistoryView {
//     @ViewColumn()
//     id!: string;

//     @ViewColumn()
//     label!: string;

//     @ViewColumn()
//     model!: string;

//     @ViewColumn()
//     provider!: string;

//     @ViewColumn()
//     idempotencyKey!: string;

//     @ViewColumn()
//     argsHash!: string;

//     @ViewColumn()
//     take!: number;

//     @ViewColumn()
//     reqToken!: string;

//     @ViewColumn()
//     resToken!: string;

//     @ViewColumn()
//     cost!: number;

//     @ViewColumn()
//     status!: string;

//     @ViewColumn()
//     connectionId?: string;

//     @ViewColumn()
//     streamId?: string;

//     @ViewColumn()
//     messageId?: string;

//     @ViewColumn()
//     createdBy!: string;

//     @ViewColumn()
//     createdAt!: Date;

//     @ViewColumn()
//     updatedBy!: string;

//     @ViewColumn()
//     updatedAt!: Date;
// }

@Entity()
export class ProjectEntity extends MyBaseEntity {
    @PrimaryGeneratedColumn('uuid')
    id!: string;

    @Column({ nullable: false, type: 'enum', enum: ProjectVisibility, })
    visibility!: ProjectVisibility;

    @Index() // インデックス
    @Column({ nullable: false })
    teamId!: string;

    @Column({ nullable: false })
    name!: string;

    @Column({ nullable: false })
    label!: string;

    @Column({ nullable: true, type: 'text' })
    description?: string;

    @Column({ nullable: false })
    status!: ProjectStatus;
}

@Entity()
export class ThreadEntity extends MyBaseEntity {
    @PrimaryGeneratedColumn('uuid')
    id!: string;

    @Index() // インデックス
    @Column({ nullable: false })
    projectId!: string;

    @Column({ nullable: false, type: 'enum', enum: ThreadVisibility, })
    visibility!: ThreadVisibility;

    @Column({ nullable: false })
    title!: string;

    @Column({ nullable: false, type: 'text' })
    description!: string;

    @UpdateDateColumn()
    lastUpdate!: Date;

    @Column({ nullable: false, type: 'text' })
    inDtoJson!: string;

    @Column({ nullable: true, type: 'enum', enum: ThreadStatus })
    status?: string;
}

@Entity()
export class MessageGroupEntity extends MyBaseEntity {
    @PrimaryGeneratedColumn('uuid')
    id!: string;

    @Index() // インデックス
    @Column({ nullable: false })
    threadId!: string;

    @Column({ nullable: false, type: 'enum', enum: MessageGroupType, })
    type!: MessageGroupType;

    @Column({ type: 'integer', nullable: false })
    @Generated('increment')
    seq!: number;

    @UpdateDateColumn()
    lastUpdate!: Date;

    @Column({ nullable: true })
    previousMessageId?: string; // 先行するメッセージのID.メッセージグループIDではないことに注意。グループIDで紐づけるとグループ内のどのメッセージに紐づくか分からなくなってしまうので。

    @Column({ nullable: false })
    role!: string;

    @Column({ nullable: false })
    label!: string;
}


@Entity()
export class MessageEntity extends MyBaseEntity {
    @PrimaryGeneratedColumn('uuid')
    id!: string;

    @Column({ type: 'integer', nullable: false })
    @Generated('increment')
    seq!: number;

    @UpdateDateColumn()
    lastUpdate!: Date;

    @Index() // インデックス
    @Column({ nullable: false })
    messageGroupId!: string;

    @Column({ nullable: true })
    cacheId?: string;

    @Column({ nullable: false })
    label!: string;
}

@Entity()
export class ContentPartEntity extends MyBaseEntity {
    @PrimaryGeneratedColumn('uuid')
    id!: string;

    @Column({ type: 'integer', nullable: false })
    @Generated('increment')
    seq!: number;

    @Index() // インデックス
    @Column({ nullable: false })
    messageId!: string;

    @Column({ nullable: false, type: 'enum', enum: ContentPartType, })
    type!: ContentPartType;

    @Column({ nullable: true, type: 'text' })
    text?: string;

    @Column({ nullable: true })
    fileId?: string;
}
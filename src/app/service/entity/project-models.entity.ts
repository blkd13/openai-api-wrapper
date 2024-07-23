import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, OneToMany, ManyToMany, JoinTable, OneToOne, JoinColumn, BaseEntity, Generated, UpdateDateColumn, PrimaryColumn, Index } from 'typeorm';

import { MyBaseEntity } from './base.js';
import { ContentPartType, MessageGroupType, PredictHistoryStatus, ProjectStatus, ProjectVisibility, TeamMemberRoleType, TeamType, ThreadStatus, ThreadVisibility } from '../models/values.js';

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
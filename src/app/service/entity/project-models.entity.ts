import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, OneToMany, ManyToMany, JoinTable, OneToOne, JoinColumn, BaseEntity, Generated, UpdateDateColumn, PrimaryColumn, Index, ViewEntity, ViewColumn, EntityManager } from 'typeorm';

import { MyBaseEntity } from './base.js';
import { ContentPartType, MessageGroupType, MessageClusterType, PredictHistoryStatus, ProjectStatus, ProjectVisibility, TeamMemberRoleType, TeamStatus, TeamType, ThreadStatus, ThreadGroupVisibility, ThreadGroupStatus, ThreadGroupType, ContentPartStatus } from '../models/values.js';
import { CountTokensResponse } from '@google-cloud/vertexai/build/src/index.js';
import { ChatCompletionCreateParams } from 'openai/resources.js';

@Entity()
export class TeamEntity extends MyBaseEntity {
    // @PrimaryGeneratedColumn('uuid')
    // id!: string;

    @Column()
    name!: string;

    @Column()
    label!: string;

    @Column({ nullable: true, type: 'text' })
    description?: string;

    @Column({ type: 'enum', enum: TeamType, })
    teamType!: TeamType;

    @Column({ type: 'enum', enum: TeamStatus, default: TeamStatus.Normal })
    status!: TeamStatus;
}


@Entity()
@Index(['orgKey', 'teamId']) // インデックスを追加
@Index(['orgKey', 'userId']) // インデックスを追加
export class TeamMemberEntity extends MyBaseEntity {
    // @PrimaryGeneratedColumn('uuid')
    // id!: string;

    @Column({ type: 'uuid' })
    teamId!: string;

    @Column({ type: 'uuid' })
    userId!: string;

    @Column({ type: 'enum', enum: TeamMemberRoleType, })
    role!: TeamMemberRoleType;
}

@Entity()
export class PredictHistoryEntity extends MyBaseEntity {
    // // このテーブルへの登録がミスるとメッセージが消えるので登録条件ゆるゆるにしておく。
    // @PrimaryGeneratedColumn()
    // id!: number;

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

    @Column({ nullable: true, type: 'float' }) // 画像とかが小数点トークン扱いになることがあるので
    reqToken?: number;

    @Column({ nullable: true, type: 'integer' })
    resToken?: number;

    @Column({ nullable: true, type: 'float' })
    cost?: number;

    @Column({ nullable: true, type: 'enum', enum: PredictHistoryStatus })
    status?: PredictHistoryStatus;

    @Column({ nullable: true })
    message?: string;
}
@Entity()
export class PredictHistoryWrapperEntity extends MyBaseEntity {
    // @PrimaryGeneratedColumn()
    // id!: number;

    @Column({ nullable: true, type: 'uuid' })
    connectionId?: string;

    @Column({ nullable: true, type: 'uuid' })
    streamId?: string;

    @Column({ nullable: true, type: 'uuid' })
    messageId?: string;

    @Column({ nullable: true })
    label?: string;

    @Column()
    model!: string;

    @Column()
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
@Index(['orgKey', 'teamId']) // インデックスを追加
export class ProjectEntity extends MyBaseEntity {
    // @PrimaryGeneratedColumn('uuid')
    // id!: string;

    @Column({ type: 'enum', enum: ProjectVisibility, })
    visibility!: ProjectVisibility;

    @Column({ type: 'uuid' })
    teamId!: string;

    @Column()
    name!: string;

    @Column()
    label!: string;

    @Column({ nullable: true, type: 'text' })
    description?: string;

    @Column()
    status!: ProjectStatus;
}

@Entity()
@Index(['orgKey', 'projectId']) // インデックスを追加
export class ThreadGroupEntity extends MyBaseEntity {
    // @PrimaryGeneratedColumn('uuid')
    // id!: string;

    @Column({ type: 'uuid' })
    projectId!: string;

    @Column({ type: 'enum', enum: ThreadGroupVisibility, default: ThreadGroupVisibility.Team })
    visibility!: ThreadGroupVisibility;

    @Column({ type: 'enum', enum: ThreadGroupType, default: ThreadGroupType.Normal })
    type!: ThreadGroupType;

    @Column()
    title!: string;

    @Column({ type: 'text' })
    description!: string;

    @UpdateDateColumn({ type: 'timestamptz' })
    lastUpdate!: Date;

    // @Column({ type: 'text' })
    // inDtoJson!: string;

    @Column({ type: 'enum', enum: ThreadGroupStatus, default: ThreadGroupStatus.Normal })
    status!: ThreadGroupStatus;
}


@Entity()
@Index(['orgKey', 'threadGroupId']) // インデックスを追加
export class ThreadEntity extends MyBaseEntity {
    // @PrimaryGeneratedColumn('uuid')
    // id!: string;

    @Column({ type: 'uuid' })
    threadGroupId!: string;

    @Column({ type: 'integer' })
    @Generated('increment')
    seq!: number;

    // @Column({ type: 'integer', default: 0 })
    // subSeq!: number; // グループ内での順番

    @Column({ type: 'jsonb' })
    inDto!: { args: Omit<ChatCompletionCreateParams, 'messages'> };

    @Column({ type: 'enum', enum: ThreadStatus, default: ThreadStatus.Normal })
    status!: ThreadStatus;
}

@Entity()
@Index(['orgKey', 'threadId']) // インデックスを追加
export class MessageClusterEntity extends MyBaseEntity {

    @Column({ type: 'uuid' })
    threadId!: string;

    @Column({ type: 'integer' })
    @Generated('increment')
    seq!: number;

    @Column({ type: 'enum', enum: MessageClusterType, default: MessageClusterType.Single })
    type!: MessageClusterType;

    @Column({ type: 'uuid', nullable: true })
    previousMessageClusterId?: string; // 先行するメッセージのID.メッセージグループIDではないことに注意。グループIDで紐づけるとグループ内のどのメッセージに紐づくか分からなくなってしまうので。

    @Column()
    label!: string;
}

@Entity()
@Index(['orgKey', 'threadId']) // インデックスを追加
export class MessageGroupEntity extends MyBaseEntity {
    // @PrimaryGeneratedColumn('uuid')
    // id!: string;

    @Column({ type: 'uuid' })
    threadId!: string;

    @Column({ type: 'enum', enum: MessageGroupType, default: MessageGroupType.Single })
    type!: MessageGroupType;

    @Column({ type: 'integer' })
    @Generated('increment')
    seq!: number;

    @UpdateDateColumn({ type: 'timestamptz' })
    lastUpdate!: Date;

    @Column({ type: 'uuid', nullable: true })
    previousMessageGroupId?: string; // 先行するメッセージのID.メッセージグループIDではないことに注意。グループIDで紐づけるとグループ内のどのメッセージに紐づくか分からなくなってしまうので。

    @Column()
    role!: string;

    @Column({ type: 'integer', default: 0 })
    touchCounter!: number; // タッチカウンター（TypeORMのせいで更新時刻だけを更新したいときに変更されたプロパティが無いと更新が反映されないから）

    @Column({ nullable: true })
    source?: string; // ソース情報（user/AIモデル名）。本来はnullableにすべきではなかったが後からではどうにもならなかったので。

    // @Column({ nullable: true })
    // editedRootMessageGroupId!: string;
}


@Entity()
@Index(['orgKey', 'messageGroupId']) // インデックスを追加
export class MessageEntity extends MyBaseEntity {
    // @PrimaryGeneratedColumn('uuid')
    // id!: string;

    @Column({ type: 'uuid' })
    messageGroupId!: string;

    @Column({ type: 'integer' })
    @Generated('increment')
    seq!: number;

    @Column({ type: 'integer', default: 0 })
    subSeq!: number; // グループ内での順番

    @UpdateDateColumn({ type: 'timestamptz' })
    lastUpdate!: Date;

    // @Column({ nullable: true })
    // previousMessageId?: string; // 先行するメッセージのID.メッセージグループIDではないことに注意。グループIDで紐づけるとグループ内のどのメッセージに紐づくか分からなくなってしまうので。

    @Column({ type: 'uuid', nullable: true })
    cacheId?: string;

    @Column()
    label!: string;

    @Column({ type: 'uuid', nullable: true })
    editedRootMessageId?: string;

    // @Column()
    // versionNumber!: number;

    // @Column()
    // isActive!: boolean;
}

@Entity()
@Index(['orgKey', 'messageId']) // インデックスを追加
export class ContentPartEntity extends MyBaseEntity {
    // @PrimaryGeneratedColumn('uuid')
    // id!: string;

    @Column({ type: 'integer' })
    @Generated('increment')
    seq!: number;

    @Column({ type: 'integer', default: 0 })
    subSeq!: number; // バージョン（更新のたびにカウントアップ）

    @Column({ type: 'uuid' })
    messageId!: string;

    @Column({ type: 'enum', enum: ContentPartType, default: ContentPartType.TEXT })
    type!: ContentPartType;

    @Column({ nullable: true, type: 'text' })
    text?: string;

    @Column({ nullable: true, type: 'uuid' })
    linkId?: string;

    @Column({ nullable: true, type: 'jsonb' })
    tokenCount?: { [modelId: string]: CountTokensResponse }; // JSON型を保存

    @Column({ type: 'enum', enum: ContentPartStatus, default: ContentPartStatus.Normal })
    status!: ContentPartStatus;
}


// -- 最初にテーブル再作成
// -- バックアップを取る
// CREATE TABLE content_part_entity_bk AS SELECT * FROM content_part_entity;

//   DELETE FROM content_part_entity WHERE id IN (
//     SELECT DISTINCT tr.id as tr_id
//     FROM content_part_entity tc
//     JOIN content_part_entity tr 
//       ON tr.text::jsonb->>'tool_call_id' = ((tc.text::jsonb->>'call')::jsonb)->>'id'
//     WHERE tc.type = 'tool'
//       AND tr.type = 'tool_result'
//     ORDER BY tr_id
//   );

//   WITH tool_data AS (
//   SELECT DISTINCT 
//     tc.id, tc.created_by, tr.updated_by, tc.created_at, tr.updated_at, tc.created_ip, tr.updated_ip, tc.seq, 
//     tc.message_id, tc.type, tc.text, tc.file_group_id, tc.sub_seq, tc.file_id, tc.status, tc.token_count,
//     tc.text::jsonb AS call_data,
//     tr.text::jsonb AS result_data
//   FROM content_part_entity tc
//   JOIN content_part_entity tr 
//     ON tr.text::jsonb->>'tool_call_id' = tc.text::jsonb->>'id'
//   WHERE tc.type = 'tool_call'
//     AND tr.type = 'tool_result'
//   )
//   SELECT
//     id, created_by, updated_by, created_at, updated_at, created_ip, updated_ip, seq, 
//     message_id, 'tool' as type, 
//     jsonb_build_object('call', call_data) || jsonb_build_object('result', result_data) AS text, 
//     file_group_id, sub_seq, file_id, status, token_count
//   FROM tool_data;

// SELECT jsonb_build_object('call', text::jsonb)  FROM content_part_entity WHERE
// type IN ('tool_call') AND text LIKE '{"index%'
// ;
// UPDATE content_part_entity SET text = jsonb_build_object('call', text::jsonb) , type='tool' WHERE 
// type IN ('tool_call') AND text LIKE '{"index%'
// ;

// SELECT jsonb_build_object('call', text::jsonb)  FROM content_part_entity WHERE type IN ('tool_call') ;
// UPDATE content_part_entity SET type='text' WHERE type IN ('tool_call') ;  

// -----------
// UPDATE content_part_entity SET link_id = file_group_id WHERE type = 'file';
// UPDATE content_part_entity SET link_id = file_id WHERE type = 'file';
// UPDATE content_part_entity SET link_id = text::jsonb->>'tool_call_id' WHERE type = 'tool';
// UPDATE content_part_entity SET link_id = text::jsonb->>'tool_call_id' WHERE type = 'tool_call';
// UPDATE content_part_entity SET link_id = text::jsonb->>'tool_call_id' WHERE type = 'tool_result';

// LINK_IDに修正する
// UPDATE content_part_entity SET link_id = file_group_id WHERE type = 'file';
// CREATE TABLE content_part_entity_backup AS
// SELECT * FROM content_part_entity;
// DROP TABLE  content_part_entity;
// INSERT INTO content_part_entity (
//     id, created_by, updated_by, created_at, updated_at, created_ip, updated_ip,
//     seq, message_id, type, text, sub_seq, status,
//     token_count, link_id
// )
// SELECT
//     id, created_by, updated_by, created_at, updated_at, created_ip, updated_ip,
//     seq, message_id, type, text, sub_seq, status,
//     token_count, file_group_id
// FROM content_part_entity_backup;
// SELECT last_value FROM content_part_entity_seq_seq;
// SELECT SETVAL('content_part_entity_seq_seq', 5251, FALSE);

// INSERT INTO user_role_entity (org_key,created_by,updated_by,created_at,updated_at,created_ip,updated_ip,user_id,scope_info_scope_type,scope_info_scope_id) 
// SELECT org_key,created_by,updated_by,created_at,updated_at,created_ip,updated_ip,id,'ORGANIZATION','{xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx}' FROM user_entity; 

// SELECT COUNT(*) FROM Team_Member_Entity WHERE NOT (user_Id IS NULL OR user_Id ~* '^[0-9a-fA-F-]{36}$' AND user_Id::uuid IS NOT NULL);

// ALTER TABLE Team_Member_Entity ALTER COLUMN user_Id TYPE uuid USING user_Id::uuid;
// ALTER TABLE Team_Member_Entity ALTER COLUMN team_Id TYPE uuid USING team_Id::uuid;
// ALTER TABLE git_project_commit_Entity ALTER COLUMN file_group_Id TYPE uuid USING file_group_Id::uuid;
// ALTER TABLE mm_timeline_Entity ALTER COLUMN user_Id TYPE uuid USING user_Id::uuid;
// ALTER TABLE mm_timeline_channel_Entity ALTER COLUMN timeline_Id TYPE uuid USING timeline_Id::uuid;
// ALTER TABLE box_item_Entity ALTER COLUMN user_Id TYPE uuid USING user_Id::uuid;
// ALTER TABLE box_collection_Entity ALTER COLUMN user_Id TYPE uuid USING user_Id::uuid;
// ALTER TABLE file_group_Entity ALTER COLUMN project_Id TYPE uuid USING project_Id::uuid;
// ALTER TABLE file_Entity ALTER COLUMN project_Id TYPE uuid USING project_Id::uuid;
// ALTER TABLE file_Entity ALTER COLUMN file_body_Id TYPE uuid USING file_body_Id::uuid;
// ALTER TABLE file_Entity ALTER COLUMN file_group_Id TYPE uuid USING file_group_Id::uuid;
// ALTER TABLE file_tag_Entity ALTER COLUMN file_Id TYPE uuid USING file_Id::uuid;
// ALTER TABLE file_version_Entity ALTER COLUMN file_Id TYPE uuid USING file_Id::uuid;
// ALTER TABLE file_access_Entity ALTER COLUMN file_Id TYPE uuid USING file_Id::uuid;
// ALTER TABLE file_access_Entity ALTER COLUMN team_Id TYPE uuid USING team_Id::uuid;
// ALTER TABLE vertex_cached_content_Entity ALTER COLUMN project_Id TYPE uuid USING project_Id::uuid;
// DROP VIEW predict_history_view;
// ALTER TABLE predict_history_wrapper_Entity ALTER COLUMN message_Id TYPE uuid USING message_Id::uuid;
// ALTER TABLE predict_history_wrapper_Entity ALTER COLUMN stream_Id TYPE uuid USING stream_Id::uuid;
// ALTER TABLE predict_history_wrapper_Entity ALTER COLUMN connection_Id TYPE uuid USING connection_Id::uuid;
// ALTER TABLE project_Entity ALTER COLUMN team_Id TYPE uuid USING team_Id::uuid;
// ALTER TABLE thread_group_Entity ALTER COLUMN project_Id TYPE uuid USING project_Id::uuid;
// ALTER TABLE thread_Entity ALTER COLUMN thread_group_Id TYPE uuid USING thread_group_Id::uuid;
// ALTER TABLE message_cluster_Entity ALTER COLUMN thread_Id TYPE uuid USING thread_Id::uuid;
// ALTER TABLE message_cluster_Entity ALTER COLUMN previous_message_cluster_Id TYPE uuid USING previous_message_cluster_Id::uuid;
// ALTER TABLE message_group_Entity ALTER COLUMN thread_Id TYPE uuid USING thread_Id::uuid;
// ALTER TABLE message_group_Entity ALTER COLUMN previous_message_group_Id TYPE uuid USING previous_message_group_Id::uuid;
// ALTER TABLE message_Entity ALTER COLUMN message_group_Id TYPE uuid USING message_group_Id::uuid;
// ALTER TABLE message_Entity ALTER COLUMN cache_Id TYPE uuid USING cache_Id::uuid;
// ALTER TABLE message_Entity ALTER COLUMN edited_root_message_Id TYPE uuid USING edited_root_message_Id::uuid;
// ALTER TABLE content_part_Entity ALTER COLUMN message_Id TYPE uuid USING message_Id::uuid;
// ALTER TABLE content_part_Entity ALTER COLUMN link_id TYPE uuid USING link_id::uuid;
// ALTER TABLE tool_call_group_Entity ALTER COLUMN project_id TYPE uuid USING project_id::uuid;
// ALTER TABLE tool_call_part_Entity ALTER COLUMN tool_call_group_id TYPE uuid USING tool_call_group_id::uuid;
// ALTER TABLE user_setting_Entity ALTER COLUMN user_id TYPE uuid USING user_id::uuid;
// ALTER TABLE thread_Entity ALTER COLUMN in_dto_json TYPE jsonb USING in_dto_json::jsonb;
// ALTER TABLE thread_Entity RENAME COLUMN in_dto_json TO in_dto;
// ALTER TABLE department_member_Entity ALTER COLUMN department_id TYPE uuid USING department_id::uuid;
// ALTER TABLE department_member_Entity ALTER COLUMN user_id TYPE uuid USING user_id::uuid;
// ALTER TABLE o_auth_account_Entity ALTER COLUMN user_id TYPE uuid USING user_id::uuid;

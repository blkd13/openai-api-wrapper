import { BaseEntity, UpdateDateColumn, CreateDateColumn, Column, BeforeInsert, BeforeUpdate, PrimaryGeneratedColumn, Index, PrimaryColumn } from 'typeorm';
// sqlite3の場合、timestamp型はサポートされていないので、text型で代用する
// const timestamp = 'datetime' || 'timestamp';
// const timestamp = 'timestamp';

export class MyBaseEntity extends BaseEntity {
    @PrimaryGeneratedColumn('uuid')
    id!: string;

    @PrimaryColumn()
    tenantKey!: string; // テナント単位の識別子

    @Column({ nullable: false })
    createdBy!: string;

    @Column({ nullable: false })
    updatedBy!: string;

    @CreateDateColumn({ type: 'timestamptz' })
    createdAt!: Date;

    @UpdateDateColumn({ type: 'timestamptz' })
    updatedAt!: Date;

    // IPアドレスを保存するカラムを追加
    @Column({ type: 'inet', nullable: true })  // PostgreSQLのINET型を使用
    createdIp!: string;

    @Column({ type: 'inet', nullable: true })  // PostgreSQLのINET型を使用
    updatedIp!: string;

    // @BeforeInsert()
    // setCreatedAt() {
    //     this.createdAt = new Date();
    //     this.updatedAt = new Date();
    // }

    // @BeforeUpdate()
    // setUpdatedAt() {
    //     this.updatedAt = new Date();
    // }
}


// SELECT table_name
// FROM information_schema.columns
// WHERE column_name = 'tenant_key'
//   AND table_schema = 'ribbon'

// CREATE TABLE mm_user_entity_bk AS SELECT * FROM mm_user_entity;
// CREATE TABLE mm_user_pre_entity_bk AS SELECT * FROM mm_user_pre_entity;
// CREATE TABLE box_collection_entity_bk AS SELECT * FROM box_collection_entity;
// CREATE TABLE box_file_body_entity_bk AS SELECT * FROM box_file_body_entity;
// CREATE TABLE box_file_entity_bk AS SELECT * FROM box_file_entity;
// CREATE TABLE box_item_entity_bk AS SELECT * FROM box_item_entity;
// CREATE TABLE content_part_entity_bk AS SELECT * FROM content_part_entity;
// CREATE TABLE department_entity_bk AS SELECT * FROM department_entity;
// CREATE TABLE department_member_entity_bk AS SELECT * FROM department_member_entity;
// CREATE TABLE file_access_entity_bk AS SELECT * FROM file_access_entity;
// CREATE TABLE file_body_entity_bk AS SELECT * FROM file_body_entity;
// CREATE TABLE file_entity_bk AS SELECT * FROM file_entity;
// CREATE TABLE file_group_entity_bk AS SELECT * FROM file_group_entity;
// CREATE TABLE file_tag_entity_bk AS SELECT * FROM file_tag_entity;
// CREATE TABLE file_version_entity_bk AS SELECT * FROM file_version_entity;
// CREATE TABLE git_project_commit_entity_bk AS SELECT * FROM git_project_commit_entity;
// CREATE TABLE git_project_entity_bk AS SELECT * FROM git_project_entity;
// CREATE TABLE invite_entity_bk AS SELECT * FROM invite_entity;
// CREATE TABLE login_history_entity_bk AS SELECT * FROM login_history_entity;
// CREATE TABLE message_cluster_entity_bk AS SELECT * FROM message_cluster_entity;
// CREATE TABLE message_entity_bk AS SELECT * FROM message_entity;
// CREATE TABLE message_group_entity_bk AS SELECT * FROM message_group_entity;
// CREATE TABLE mm_file_entity_bk AS SELECT * FROM mm_file_entity;
// CREATE TABLE mm_timeline_channel_entity_bk AS SELECT * FROM mm_timeline_channel_entity;
// CREATE TABLE mm_timeline_entity_bk AS SELECT * FROM mm_timeline_entity;
// CREATE TABLE o_auth_account_entity_bk AS SELECT * FROM o_auth_account_entity;
// CREATE TABLE o_auth_provider_entity_bk AS SELECT * FROM o_auth_provider_entity;
// CREATE TABLE predict_history_entity_bk AS SELECT * FROM predict_history_entity;
// CREATE TABLE predict_history_wrapper_entity_bk AS SELECT * FROM predict_history_wrapper_entity;
// CREATE TABLE project_entity_bk AS SELECT * FROM project_entity;
// CREATE TABLE session_entity_bk AS SELECT * FROM session_entity;
// CREATE TABLE team_entity_bk AS SELECT * FROM team_entity;
// CREATE TABLE team_member_entity_bk AS SELECT * FROM team_member_entity;
// CREATE TABLE tenant_entity_bk AS SELECT * FROM tenant_entity;
// CREATE TABLE thread_entity_bk AS SELECT * FROM thread_entity;
// CREATE TABLE thread_group_entity_bk AS SELECT * FROM thread_group_entity;
// CREATE TABLE tool_call_group_entity_bk AS SELECT * FROM tool_call_group_entity;
// CREATE TABLE tool_call_part_entity_bk AS SELECT * FROM tool_call_part_entity;
// CREATE TABLE user_entity_bk AS SELECT * FROM user_entity;
// CREATE TABLE user_setting_entity_bk AS SELECT * FROM user_setting_entity;
// CREATE TABLE vertex_cached_content_entity_bk AS SELECT * FROM vertex_cached_content_entity;

// INSERT INTO mm_user_entity SELECT * FROM mm_user_pre_entity;




// update file_group_entity SET tenant_key='public';
// update file_body_entity SET tenant_key='public';
// update git_project_entity SET tenant_key='public';
// update content_part_entity SET tenant_key='public';
// update tool_call_group_entity SET tenant_key='public';
// update mm_file_entity SET tenant_key='public';
// update login_history_entity SET tenant_key='public';
// update user_entity SET tenant_key='public';
// update session_entity SET tenant_key='public';
// update invite_entity SET tenant_key='public';
// update department_entity SET tenant_key='public';
// update department_member_entity SET tenant_key='public';
// update o_auth_account_entity SET tenant_key='public';
// update team_entity SET tenant_key='public';
// update team_member_entity SET tenant_key='public';
// update predict_history_wrapper_entity SET tenant_key='public';
// update project_entity SET tenant_key='public';
// update message_cluster_entity SET tenant_key='public';
// update tool_call_part_entity SET tenant_key='public';
// update api_provider_entity SET tenant_key='public';
// update api_provider_template_entity SET tenant_key='public';
// update tenant_entity SET tenant_key='public';
// update box_item_entity SET tenant_key='public';
// update file_tag_entity SET tenant_key='public';
// update file_version_entity SET tenant_key='public';
// update file_access_entity SET tenant_key='public';
// update vertex_cached_content_entity SET tenant_key='public';
// update mm_timeline_entity SET tenant_key='public';
// update mm_timeline_channel_entity SET tenant_key='public';
// update predict_history_entity SET tenant_key='public';
// update message_group_entity SET tenant_key='public';
// update message_entity SET tenant_key='public';
// update box_file_entity SET tenant_key='public';
// update box_file_body_entity SET tenant_key='public';
// update thread_group_entity SET tenant_key='public';
// update thread_entity SET tenant_key='public';
// update box_collection_entity SET tenant_key='public';
// update user_setting_entity SET tenant_key='public';
// update git_project_commit_entity SET tenant_key='public';
// update file_entity SET tenant_key='public';


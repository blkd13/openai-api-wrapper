import { Entity, PrimaryGeneratedColumn, Column, Index } from 'typeorm';
import { MyBaseEntity } from './base.js';
import { FileGroupType } from '../models/values.js';
import { CountTokensResponse } from '@google-cloud/vertexai/build/src/index.js';

@Entity()
export class FileGroupEntity extends MyBaseEntity {
    // @PrimaryGeneratedColumn('uuid')
    // id!: string;

    @Column({ type: 'uuid' })
    projectId!: string;

    @Column({ type: 'enum', enum: FileGroupType, default: FileGroupType.UPLOAD })
    type!: FileGroupType;

    @Column()
    label!: string;

    @Column({ nullable: true })
    description?: string;

    @Column()
    uploadedBy!: string;

    @Column({ default: true })
    isActive!: boolean;
}

@Entity()
@Index(['orgKey', 'fileGroupId'])
export class FileEntity extends MyBaseEntity {
    // @PrimaryGeneratedColumn('uuid')
    // id!: string;

    @Column({ type: 'uuid' })
    fileGroupId!: string;

    @Column()
    fileName!: string;

    @Column()
    filePath!: string;

    @Column({ type: 'uuid' })
    projectId!: string;

    @Column()
    uploadedBy!: string;

    @Column({ type: 'uuid' })
    fileBodyId!: string;

    @Column({ default: true })
    isActive!: boolean;
}

@Entity()
export class FileBodyEntity extends MyBaseEntity {
    // @PrimaryGeneratedColumn('uuid')
    // id!: string;

    @Column()
    fileType!: string;

    @Column()
    fileSize!: number;

    @Column()
    innerPath!: string;

    @Column() @Index()     // ユニーク制約を付けない（衝突しても大丈夫なように）
    sha1!: string;

    @Column({ unique: true }) // ユニーク制約を付ける
    sha256!: string;

    @Column({ nullable: true, type: 'jsonb' })
    tokenCount?: { [modelId: string]: CountTokensResponse }; // JSON型を保存

    @Column({ nullable: true, type: 'jsonb' })
    metaJson?: { [key: string]: any };
}

@Entity()
export class FileTagEntity extends MyBaseEntity {
    // @PrimaryGeneratedColumn('uuid')
    // id!: string;

    @Column()
    name!: string;

    @Column({ type: 'uuid' })
    fileId!: string;
}

@Entity()
export class FileVersionEntity extends MyBaseEntity {
    // @PrimaryGeneratedColumn('uuid')
    // id!: string;

    @Column({ type: 'uuid' })
    fileId!: string;

    @Column()
    versionNumber!: number;

    @Column()
    filePath!: string;

    @Column()
    uploadedBy!: string;
}

@Entity()
export class FileAccessEntity extends MyBaseEntity {
    // @PrimaryGeneratedColumn('uuid')
    // id!: string;

    @Column({ type: 'uuid' })
    fileId!: string;

    @Column({ type: 'uuid' })
    teamId!: string;

    @Column()
    canRead!: boolean;

    @Column()
    canWrite!: boolean;

    @Column()
    canDelete!: boolean;
}



// CREATE TABLE file_entity_bk AS SELECT * FROM file_entity;
// DROP TABLE file_entity;
// -- ここでテーブル再作成
// INSERT INTO file_entity (
//   id,created_by,updated_by,created_at,updated_at,created_ip,updated_ip,file_group_id,file_name,file_path,project_id,uploaded_by,file_body_id,is_active
// )
// SELECT id,created_by,updated_by,created_at,updated_at,created_ip,updated_ip,transaction_id,file_name,file_path,project_id,uploaded_by,file_body_id,is_active
// FROM file_entity_bk
// ;

// -- FileEntity のデータから FileGroupEntity を作成する
// INSERT INTO file_group_entity (
//   id,
//   created_by,
//   updated_by,
//   created_at,
//   updated_at,
//   created_ip,
//   updated_ip,
//   project_id,
//   type,
//   label,
//   description,
//   uploaded_by,
//   is_active
// )
// SELECT
//   file_group_id::uuid AS id,                                 -- file_group_id を UUID として使用
//   MIN(created_by) AS created_by,                             -- 最小の created_by（BaseEntity 拡張）
//   MIN(updated_by) AS updated_by,                             -- 最小の updated_by（BaseEntity 拡張）
//   MIN(created_at) AS created_at,                             -- 最小の created_at
//   MIN(updated_at) AS updated_at,                             -- 最小の updated_at
//   MIN(created_ip) AS created_ip,                             -- 最小の created_at
//   MIN(updated_ip) AS updated_ip,                             -- 最小の updated_at
//   project_id,                                                -- file_entity.project_id
//   'upload' AS type,                                          -- type を小文字の 'upload' に設定
//   CASE
//       WHEN COUNT(DISTINCT SPLIT_PART(file_path, '/', 1)) > 1
//           THEN ''                                        -- トップレベルが複数ある場合
//       ELSE MAX(SPLIT_PART(file_path, '/', 1))                -- トップレベルが1つの場合、その名前
//   END AS label,
//   NULL AS description,                                       -- description は初期値 NULL
//   uploaded_by,                                               -- file_entity.uploaded_by
//   TRUE AS is_active                                         -- デフォルト値
// FROM
//   file_entity
// WHERE
//   file_group_id IS NOT NULL                                  -- file_group_id が NULL でないデータ
// GROUP BY
//   file_group_id, project_id, uploaded_by;                    -- file_group_id 単位で集約


import { Entity, Column, PrimaryColumn, Index, PrimaryGeneratedColumn, Unique } from 'typeorm';
import { MyBaseEntity } from './base.js';

export enum BoxItemType {
    FOLDER = 'folder',
    COLLECTION = 'collection',
}

@Entity() // テーブル名を指定
@Unique(['userId', 'type', 'itemId', 'offset', 'limit']) // ここで複合ユニーク制約を設定
export class BoxItemEntity extends MyBaseEntity {

    @Column()
    userId!: string;

    @Column({ type: 'enum', enum: BoxItemType })
    type!: string;

    @Column()
    itemId!: string;

    @Column({ default: 0 })
    offset!: number;

    @Column({ default: 100 })
    limit!: number;

    @Column({ type: 'jsonb' })
    data!: BoxApiFolder; // または interface で型を定義

    @Column({ type: 'timestamptz', nullable: true })
    childrenCacheCompletedAt?: Date;
}

@Entity() // テーブル名を指定
@Unique(["userId", "collectionId"]) // ここで複合ユニーク制約を設定
@Index(['tenantKey', 'userId']) // インデックスを追加
export class BoxCollectionEntity extends MyBaseEntity {

    @Column() @Index()
    userId!: string;

    @Column()
    collectionId!: string;

    @Column()
    type!: string;
    @Column()
    name!: string;
    @Column()
    collection_type!: string;
    // @Column()
    // id!: string;

    @Column({ type: 'jsonb' })
    data!: BoxApiCollectionItem; // または interface で型を定義
}


@Entity() // テーブル名を指定
@Unique(['tenantKey', 'fileId', 'versionId']) // ここで複合ユニーク制約を設定
@Index(['tenantKey', 'fileId']) // インデックスを追加
export class BoxFileEntity extends MyBaseEntity {

    @Column()
    fileId!: string;

    @Column()
    versionId!: string;

    @Column()
    @Index()
    versionSha1!: string;

    @Column()
    name!: string;

    @Column({ type: 'jsonb', nullable: true })
    info?: any;

    @Column({ type: 'jsonb', nullable: true })
    meta?: BoxMetaData;
}

@Entity() // テーブル名を指定
export class BoxFileBodyEntity extends MyBaseEntity {

    @Column()
    fileType!: string;

    @Column()
    fileSize!: number;

    @Column()
    innerPath!: string;

    @Column()
    @Index({ unique: true })
    sha1!: string;

    @Column()
    @Index({ unique: true })
    sha256!: string;
}





export interface BoxApiUser {
    type: 'user';
    id: string;
    name: string;
    login: string;
}

export interface BoxApiPathEntry {
    type: 'folder';
    id: string;
    sequence_id: string | null;
    etag: string | null;
    name: string;
}

export interface BoxApiFileVersion {
    type: 'file_version';
    id: string;
    sha1: string;
}

export interface BoxApiItemEntry {
    type: 'file';
    id: string;
    file_version: BoxApiFileVersion;
    sequence_id: string;
    etag: string;
    sha1: string;
    name: string;
}

export interface BoxApiPathCollection {
    total_count: number;
    entries: BoxApiPathEntry[];
}

export interface BoxApiItemCollection {
    total_count: number;
    entries: (BoxApiItemEntry | BoxApiPathEntry)[];
    offset: number;
    limit: number;
    order: { by: string; direction: 'ASC' | 'DESC' }[];
}

export interface BoxApiFolder {
    type: 'folder';
    id: string;
    sequence_id: string;
    etag: string;
    name: string;
    created_at: string;
    modified_at: string;
    description: string;
    size: number;
    path_collection: BoxApiPathCollection;
    created_by: BoxApiUser;
    modified_by: BoxApiUser;
    trashed_at: string | null;
    purged_at: string | null;
    content_created_at: string;
    content_modified_at: string;
    owned_by: BoxApiUser;
    shared_link: string | null;
    folder_upload_email: string | null;
    parent: BoxApiPathEntry;
    item_status: 'active' | string;  // 他の状態がある場合はここに追加
    item_collection: BoxApiItemCollection;
}

// --------------------------------------------------
export interface BoxApiCollection {
    type: string;
    name: string;
    collection_type: string;
    id: string;
}

export interface BoxApiCollectionItem {
    total_count: number;
    entries: BoxApiCollectionItemEntry[];
    limit: number;
    offset: number;
}

export interface BoxApiCollectionItemEntry {
    type: string; // "folder" | other types if applicable
    id: string;
    sequence_id: string;
    etag: string;
    name: string;
}


export interface BoxApiCollectionList {
    total_count: number;
    limit: number;
    offset: number;
    entries: BoxApiCollection[];
}

export interface BoxMetaData {
    entries: {
        $id: string,
        $version: number,
        $type: string,
        $parent: string,
        $typeVersion: number,
        $template: string,
        $scope: string,
        Box__Security__Classification__Key: string,
        $canEdit: boolean,
    }[];
    limit: number;
}

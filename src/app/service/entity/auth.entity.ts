import { Column, CreateDateColumn, Entity, Generated, In, Index, PrimaryGeneratedColumn } from 'typeorm';
import { MyBaseEntity } from './base.js';
export enum UserStatus {
    // アクティブ系
    Active = "Active",                // アクティブ状態
    Inactive = "Inactive",            // 非アクティブ状態

    // セキュリティ系
    Suspended = "Suspended",          // アクセス停止
    Locked = "Locked",                // アカウントロック
    Banned = "Banned",                // アクセス禁止

    // アカウントの状態系
    Deleted = "Deleted",              // 削除済み
    Archived = "Archived",            // アーカイブ済み
}

export enum UserRoleType {
    Maintainer = 'Maintainer', // メンテナ
    User = 'User', // ユーザー

    Owner = 'Owner', // 所有者
    BizAdmin = 'BizAdmin', // ビジネス管理者
    SysAdmin = 'SysAdmin', // システム管理者
    Admin = 'Admin', // 管理者（
    Member = 'Member', // メンバー（スレッドの作成、編集、削除ができる）
    Viewer = 'Viewer', // 閲覧者（スレッドの閲覧のみ）
    Guest = 'Guest', // ゲスト（スレッドの閲覧のみ）
}
// CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
// SELECT uuid_generate_v4();
@Entity()
export class UserEntity extends MyBaseEntity {
    // @PrimaryGeneratedColumn('uuid')
    // id!: string;

    @Column({ type: 'integer', nullable: false })
    @Generated('increment')
    seq!: number;

    @Column()
    name?: string;

    @Column()
    email!: string;

    @Column({ type: 'enum', enum: UserRoleType, default: UserRoleType.User })
    role!: UserRoleType;

    @Column({ type: 'enum', enum: UserStatus, default: UserStatus.Active })
    status!: UserStatus;

    @Column({ nullable: true })
    passwordHash?: string;

    @Column({ type: 'integer', default: 0 })
    authGeneration?: number;
}


@Entity()
export class InviteEntity extends MyBaseEntity {
    // @PrimaryGeneratedColumn('uuid')
    // id!: string;

    @Column({ type: 'integer', nullable: false })
    @Generated('increment')
    seq!: number;

    @Column()
    email!: string;

    @Column()
    type!: string;

    @Column()
    onetimeToken!: string;

    @Column()
    data!: string;

    @Column()
    status!: string;

    @Column({ type: 'bigint' })
    limit!: number;
}

@Entity()
export class LoginHistoryEntity extends MyBaseEntity {
    // @PrimaryGeneratedColumn('uuid')
    // id!: string;

    @Column()
    userId!: string;

    @CreateDateColumn({ type: 'timestamptz' })
    loginDate!: Date;

    @Column()
    ipAddress!: string;

    @Column({ nullable: true })
    deviceInfo!: string;

    @Column({ type: 'integer', default: 0 })
    authGeneration?: number;
}

@Entity()
export class SessionEntity extends MyBaseEntity {
    // @PrimaryGeneratedColumn('uuid')
    // id!: string;  // UUIDとしてセッションを一意に識別

    @Column()
    userId!: string;  // ユーザーID

    @CreateDateColumn({ type: 'timestamptz' })
    loginDate!: Date;  // ログイン日時

    @Column()
    ipAddress!: string;  // IPアドレス

    @Column()
    provider!: string;  // 認証プロバイダ（local, mattermost, boxなど）

    @Column()
    authInfo!: string;  // 認証に関連する追加情報（トークンIDや認証世代など）

    @Column({ nullable: true, type: 'timestamptz' })
    expiresAt?: Date;  // セッションの有効期限（無効化された場合は現在の日時に設定）

    @Column({ type: 'timestamptz' })
    lastActiveAt!: Date;  // 最後のアクティビティ日時

    @Column({ nullable: true })
    deviceInfo?: string;  // デバイス情報
}

// TODO ユーザー登録内容変更履歴管理テーブル。いつか作りたいけど今はログがあるから後回し。
// @Entity()
export class UserAuditEntity extends MyBaseEntity {
    // @PrimaryGeneratedColumn('uuid')
    // id!: string;

    @Column()
    userId!: string;

    @Column()
    action!: string;  // 例: 'CREATE', 'UPDATE', 'DELETE', etc.

    @Column({ nullable: true })
    oldStatus?: string;  // 変更前のステータス

    @Column({ nullable: true })
    newStatus?: string;  // 変更後のステータス

    @Column({ nullable: true })
    oldRole?: string;  // 変更前の役割

    @Column({ nullable: true })
    newRole?: string;  // 変更後の役割

    @Column()
    changedBy!: string;  // 変更を行ったユーザーのID（管理者など）

    @Column({ nullable: true, type: 'text' })
    changeReason?: string;  // 変更理由
}

export enum DepartmentRoleType {
    Maintainer = 'Maintainer', // メンテナ

    Owner = 'Owner', // 所有者
    Admin = 'Admin', // 管理者（オーナーに統合したので今は使わない）
    Member = 'Member', // メンバー（スレッドの作成、編集、削除ができる）
    Deputy = 'Deputy', // 主務じゃない
}

@Entity()
export class DepartmentEntity extends MyBaseEntity {
    // @PrimaryGeneratedColumn('uuid')
    // id!: string;

    @Column()
    name!: string;

    @Column({ nullable: true }) // 未設定の場合も許容する。（その場合はデフォルトプロジェクトに振り分ける）
    gcpProjectId!: string;

    @Column()
    label!: string;
}

@Entity()
export class DepartmentMemberEntity extends MyBaseEntity {
    // @PrimaryGeneratedColumn('uuid')
    // id!: string;

    @Column()
    departmentId!: string;

    @Column({ nullable: true })
    userId?: string; // 登録する経路が無いから最初は空である。。。

    @Column()
    name!: string;

    @Column()
    label!: string;

    @Column({ type: 'enum', enum: DepartmentRoleType, default: DepartmentRoleType.Member })
    departmentRole!: DepartmentRoleType;
}
export enum OAuthAccountStatus {
    // TODO ACTIVE以外のステータスは未作成
    ACTIVE = 'ACTIVE', // アクティブ状態で、トークンが有効で使用可能
    EXPIRED = 'EXPIRED', // トークンが期限切れの状態
    REVOKED = 'REVOKED', // トークンが取り消された状態
    PENDING = 'PENDING', // アカウントがまだ完全に設定されていない、または確認中の状態
    ERROR = 'ERROR', // トークンの取得や更新に問題が発生した状態
    DISCONNECTED = 'DISCONNECTED', // ユーザーがアカウントの接続を解除した状態
}

@Entity()
@Index(['tenantKey', 'userId', 'provider', 'providerUserId'], { unique: true })
export class OAuthAccountEntity extends MyBaseEntity {
    // @PrimaryGeneratedColumn('uuid')
    // id!: string;

    @Column()
    userId!: string;

    @Column({ nullable: true })
    label?: string;

    @Column()
    provider!: string; // mattermost, box, gitlab,,,

    @Column()
    providerUserId!: string;

    @Column({ nullable: true })
    providerEmail?: string;

    @Column()
    accessToken!: string;

    @Column({ nullable: true })
    refreshToken?: string;

    @Column({ nullable: true })
    tokenExpiresAt?: Date;

    @Column({ nullable: true })
    tokenBody!: string;

    @Column({ nullable: true })
    userInfo!: string;

    @Column({ type: 'enum', enum: OAuthAccountStatus, default: OAuthAccountStatus.ACTIVE })
    status!: OAuthAccountStatus;
}

export interface OAuth2Config extends OAuth2ConfigTemplate {
    clientId: string;
    clientSecret: string;
    requireMailAuth: boolean;
}

export enum ApiProviderAuthType {
    OAuth2 = 'OAuth2',
    APIKey = 'APIKey',
}

export enum ApiProviderPostType {
    json = 'json',
    params = 'params',
    form = 'form',
}
export interface OAuth2ConfigTemplate {
    pathAuthorize: string;
    pathAccessToken: string;
    pathTop: string;
    scope: string;
    postType: ApiProviderPostType;
    redirectUri: string;
}

@Entity()
// @Index(['tenantKey', 'type', 'uriBase'], { unique: true }) // テナントごとに一意
@Index(['tenantKey', 'type', 'name'], { unique: true }) // テナントごとに一意
export class ApiProviderEntity extends MyBaseEntity {

    @Column()
    type!: string; // 'gitlab' | 'gitea' | etc

    @Column()
    name!: string; // 'gitlab-local' | etc

    @Column()
    label!: string; // 'GitLab' | 'Gitea' | etc

    @Column({ type: 'enum', enum: ApiProviderAuthType, default: ApiProviderAuthType.OAuth2 })
    authType!: ApiProviderAuthType;

    @Column()
    uriBase!: string;

    @Column({ nullable: true })
    uriBaseAuth?: string;

    @Column()
    pathUserInfo!: string;

    @Column({ nullable: true, type: 'jsonb' })
    oAuth2Config?: OAuth2Config;

    @Column({ nullable: true })
    description?: string;

    @Column({ type: 'integer' })
    @Generated('increment')
    sortSeq!: number;

    @Column({ default: false })
    isDeleted!: boolean;
}

@Entity()
export class ApiProviderTemplateEntity extends MyBaseEntity {

    @Index({ unique: true })
    @Column()
    name!: string; // 'gitlab' | 'gitea' | etc

    @Column({ type: 'enum', enum: ApiProviderAuthType, default: ApiProviderAuthType.OAuth2 })
    authType!: ApiProviderAuthType;

    @Column()
    pathUserInfo!: string;

    @Column()
    uriBaseAuth?: string;

    @Column({ nullable: true, type: 'jsonb' })
    oAuth2Config?: OAuth2ConfigTemplate;

    @Column({ nullable: true })
    description?: string;

    @Column({ default: false })
    isDeleted!: boolean;
}

export interface SiteConfig {
    theme?: string;
    logoUrl?: string;
    contactEmail?: string;
    supportUrl?: string;
    privacyPolicyUrl?: string;
    termsOfServiceUrl?: string;
    oauth2RedirectUriList?: string[];
    pathTop?: string;
}

@Entity()
export class TenantEntity extends MyBaseEntity {
    @Column()
    name!: string;

    @Column({ nullable: true })
    description?: string;

    @Column({ nullable: true, type: 'jsonb' })
    siteConfig!: SiteConfig;

    @Column({ default: true })
    isActive!: boolean;
}



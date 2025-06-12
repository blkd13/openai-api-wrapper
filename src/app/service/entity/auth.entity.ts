import { Column, CreateDateColumn, Entity, Generated, In, Index, ManyToOne, OneToMany, PrimaryGeneratedColumn } from 'typeorm';
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

    Member = 'Member', // メンバー（スレッドの作成、編集、削除ができる）
    Viewer = 'Viewer', // 閲覧者（スレッドの閲覧のみ）
    Guest = 'Guest', // ゲスト（スレッドの閲覧のみ）

    UserAdmin = 'UserAdmin', // ユーザー管理者
    AIIntegrationAdmin = 'AIIntegrationAdmin', // ユーザー管理者
    SystemIntegrationAdmin = 'SystemIntegrationAdmin', // ユーザー管理者

    Auditor = 'Auditor', // 監査者
    Admin = 'Admin', // 管理者
    SuperAdmin = 'SuperAdmin', // スーパーユーザー
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

export enum ScopeType {
    USER = 'USER', DIVISION = 'DIVISION', ORGANIZATION = 'ORGANIZATION',
    PROJECT = 'PROJECT', TEAM = 'TEAM', GLOBAL = 'GLOBAL',
}
export class ScopeInfo {
    @Column({ type: 'enum', enum: ScopeType })
    scopeType!: ScopeType;

    @Column({ type: 'uuid' })
    scopeId!: string;
}

export interface UserRole {
    orgKey: string;
    userId: string;
    scopeInfo: ScopeInfo;
    role: UserRoleType;
}

@Entity()
@Index(['orgKey', 'userId'])
@Index(['orgKey', 'userId', 'role', 'scopeInfo.scopeType', 'scopeInfo.scopeId'], { unique: true })
export class UserRoleEntity extends MyBaseEntity implements UserRole {
    @Column({ type: 'uuid' })
    userId!: string;

    @Column(type => ScopeInfo)
    scopeInfo!: ScopeInfo;

    @Column({ type: 'enum', enum: UserRoleType, default: UserRoleType.User })
    role!: UserRoleType;       // 'ADMIN' | 'MEMBER' …

    @Column({ default: 0 })
    priority!: number; // 複数divisionのroleを持つことがあるのでその優先度。数値が大きいほど優先される。

    @Column({ type: 'enum', enum: UserStatus, default: UserStatus.Active })
    status!: UserStatus;
}
// INSERT INTO ribbon.role_binding_entity(org_key,created_by,updated_by,created_at,updated_at,created_ip,updated_ip,user_id,role,scope_info_scope_type,scope_info_scope_id) 
// SELECT org_key,created_by,updated_by,created_at,updated_at,created_ip,updated_ip,id,'ORGANIZATION','{95051ea1-c8f6-4485-a407-f5b19c3245bc}'FROM user_entity;

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

    @Column({ type: 'uuid' })
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

    @Column({ type: 'uuid' })
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

    @Column({ type: 'uuid' })
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

export enum DivisionRoleType {
    Maintainer = 'Maintainer', // メンテナ
    Owner = 'Owner', // 所有者
    Admin = 'Admin', // 管理者
    Member = 'Member', // メンバー
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
@Index(['orgKey', 'departmentId'])
@Index(['orgKey', 'departmentId', 'userId'])
export class DepartmentMemberEntity extends MyBaseEntity {
    // @PrimaryGeneratedColumn('uuid')
    // id!: string;

    @Column({ type: 'uuid' })
    departmentId!: string;

    @Column({ nullable: true, type: 'uuid' })
    userId?: string; // 登録する経路が無いから最初は空である。。。

    @Column()
    name!: string;

    @Column()
    label!: string;

    @Column({ type: 'enum', enum: DepartmentRoleType, default: DepartmentRoleType.Member })
    departmentRole!: DepartmentRoleType;
}

// divisions.entity.ts
@Entity()
@Index(['orgKey'])
@Index(['orgKey', 'name'], { unique: true })
export class DivisionEntity extends MyBaseEntity {
    @Column()
    name!: string;

    @Column()
    label!: string;

    @Column({ type: 'text', nullable: true })
    description?: string;

    @Column({ default: true })
    isActive!: boolean; // 有効/無効フラグ
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
@Index(['orgKey', 'userId', 'provider', 'providerUserId'], { unique: true })
export class OAuthAccountEntity extends MyBaseEntity {
    // @PrimaryGeneratedColumn('uuid')
    // id!: string;

    @Column({ type: 'uuid' })
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
// @Index(['orgKey', 'type', 'uriBase'], { unique: true }) // テナントごとに一意
@Index(['orgKey', 'type', 'name'], { unique: true }) // テナントごとに一意
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

export interface OrganizationSiteConfig {
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
export class OrganizationEntity extends MyBaseEntity {
    @Column({ type: 'uuid', nullable: true })
    parentId!: string | null;   // ここで多層化を実現

    @Column()
    @Index({ unique: true })
    key!: string;

    @Column()
    label!: string;

    @Column({ nullable: true })
    description?: string;

    @Column({ nullable: true, type: 'jsonb' })
    siteConfig!: OrganizationSiteConfig;

    @Column({ default: true })
    isActive!: boolean;
}

// // 各Enumは適宜定義してください
// export enum PlanType { FREE = 'free', PRO = 'pro', ENTERPRISE = 'enterprise' }

// @Entity()
// export class OrganizationEntity extends MyBaseEntity {
//     @Column()
//     name!: string;

//     @Column({ type: 'enum', enum: PlanType })
//     plan!: PlanType;
// }

// @Entity()
// export class OrganizationMembershipEntity extends MyBaseEntity {
//     @Column()
//     organizationId!: string;

//     @Column()
//     userId!: string;

//     @Column({ type: 'enum', enum: UserRoleType })
//     role!: UserRoleType;

//     @Column({ type: 'timestamptz' })
//     joinedAt!: Date;
// }

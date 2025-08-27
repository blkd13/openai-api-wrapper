import { Column, CreateDateColumn, Entity, Generated, Index } from 'typeorm';
import { MyBaseEntity } from './base.js';
export enum UserStatus {
    // アクティブ系
    Active = 'Active',                // アクティブ状態
    Inactive = 'Inactive',            // 非アクティブ状態

    // セキュリティ系
    Suspended = 'Suspended',          // アクセス停止
    Locked = 'Locked',                // アカウントロック
    Banned = 'Banned',                // アクセス禁止

    // アカウントの状態系
    Deleted = 'Deleted',              // 削除済み
    Archived = 'Archived',            // アーカイブ済み
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

export enum SessionStatus {
    Active = 'Active', // アクティブ状態で、トークンが有効で使用可能
    Expired = 'Expired', // トークンが期限切れの状態
    Revoked = 'Revoked', // トークンが取り消された状態
    Error = 'Error', // トークンの取得や更新に問題が発生した状態
    // PENDING = 'PENDING', // アカウントがまだ完全に設定されていない、または確認中の状態
    // DISCONNECTED = 'DISCONNECTED', // ユーザーがアカウントの接続を解除した状態
}
export enum OnetimeStatus {
    Unused = 'Unused',
    Used = 'Used',                // 使用済み
    Expired = 'Expired',          // 期限切れ
    Revoked = 'Revoked',          // 取り消し済み
}
//   CREATE TABLE invite_entity_bk AS SELECT * FROM invite_entity;
//   INSERT INTO invite_entity (id,created_by,updated_by,created_at,updated_at,created_ip,updated_ip,seq,email,type,onetime_token,data,"limit",org_key,status) SELECT id,created_by,updated_by,created_at,updated_at,created_ip,updated_ip,seq,email,type,onetime_token,data::jsonb,"limit",org_key,status FROM invite_entity_bk;
//   DROP TABLE invite_entity_bk;

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
    authGeneration!: number;
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
    scopeInfo: ScopeInfo;
    role: UserRoleType;
    priority: number; // 複数divisionのroleを持つことがあるのでその優先度。数値が大きいほど優先される。
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

// CREATE TABLE invite_entity_bk AS SELECT id,org_key,created_by,updated_by,created_at,updated_at,created_ip,updated_ip,seq,email,type,onetime_token,data,status,"limit" FROM invite_entity;
// DROP   TABLE invite_entity;
// INSERT INTO invite_entity(id,org_key,created_by,updated_by,created_at,updated_at,created_ip,updated_ip,seq,email,type,onetime_token,data,status,expires_at) 
// SELECT id,org_key,created_by,updated_by,created_at,updated_at,created_ip,updated_ip,seq,email,type,onetime_token,data::jsonb,status,to_timestamp("limit" / 1000.0)::timestamptz FROM invite_entity_bk;
// DROP   TABLE invite_entity_bk;
@Entity()
export class InviteEntity extends MyBaseEntity {
    @Column({ type: 'integer', nullable: false })
    @Generated('increment')
    seq!: number;

    @Column()
    email!: string;

    @Column()
    type!: string;

    @Column()
    onetimeToken!: string;

    @Column({ type: 'jsonb', nullable: true })
    data!: Record<string, any> | null; // UAやIPのハッシュ等

    @Column({ type: 'enum', enum: OnetimeStatus, default: OnetimeStatus.Unused })
    status!: OnetimeStatus;

    @Column({ type: 'timestamptz' })
    expiresAt!: Date;
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
    authGeneration!: number;
}

//   CREATE TABLE session_entity_bk AS 
//   SELECT id,org_key,created_by,updated_by,created_at,updated_at,created_ip,updated_ip,user_id,login_date,provider,auth_info,expires_at,last_active_at,device_info,status::text FROM session_entity;
//   DROP TABLE session_entity;
//   INSERT INTO session_entity(id,org_key,created_by,updated_by,created_at,updated_at,created_ip,updated_ip,user_id,login_date,provider,auth_info,expires_at,last_active_at,device_info)
//   SELECT id,org_key,created_by,updated_by,created_at,updated_at,created_ip,updated_ip,user_id,login_date,provider,auth_info::jsonb,expires_at,last_active_at,device_info::jsonb FROM session_entity_bk;

@Entity()
@Index(['orgKey', 'userId'])
export class SessionEntity extends MyBaseEntity {
    @Column({ type: 'uuid' })
    userId!: string;  // ユーザーID

    @CreateDateColumn({ type: 'timestamptz' })
    loginDate!: Date;  // ログイン日時

    @Column()
    provider!: string;  // 認証プロバイダ（local, mattermost, boxなど）

    @Column({ type: 'jsonb' })
    authInfo!: Record<string, any> | null; // 認証に関する追加情報（UAやIPのハッシュ等）

    @Column({ nullable: true, type: 'timestamptz' })
    expiresAt?: Date;  // セッションの有効期限（無効化された場合は現在の日時に設定）

    @Column({ type: 'timestamptz' })
    lastActiveAt!: Date;  // 最後のアクティビティ日時

    @Column({ type: 'jsonb', nullable: true })
    deviceInfo?: Record<string, any> | null; // デバイス情報

    @Column({ type: 'enum', enum: SessionStatus, default: SessionStatus.Active })
    status!: SessionStatus;
}

@Entity()
@Index(['orgKey', 'userId', 'sid'])
@Index(['orgKey', 'jti'])
export class SessionRefreshEntity extends MyBaseEntity {
    @Column({ type: 'uuid' })
    userId!: string;

    @Column({ type: 'uuid' })
    sid!: string;

    @Column()
    jti!: string;

    @Column()
    hash!: string; // refreshトークンのハッシュ

    @Column()
    salt!: string; // per-token salt

    @Column({ type: 'integer', default: 0 })
    authGeneration!: number;

    @Column({ default: true })
    current!: boolean; // 最新トークンかどうか

    @Column({ default: false })
    revoked!: boolean; // 失効済みフラグ

    @Column({ type: 'timestamptz', nullable: true })
    rotatedAt!: Date | null;

    @Column({ type: 'timestamptz' })
    expiresAt!: Date; // 最大存続期限

    @Column({ type: 'jsonb', nullable: true })
    deviceInfo?: Record<string, any> | null; // デバイス情報
}

@Entity()
export class OAuthStateEntity extends MyBaseEntity {
    @Column({ type: 'uuid' })
    @Index()
    state!: string;

    @Column()
    provider!: string; // mattermost, box, gitlab,,,

    @Column({ type: 'uuid', nullable: true })
    userId?: string | null;

    @Column({ type: 'timestamptz' })
    expiresAt!: Date; // 最大存続期限

    @Column({ type: 'jsonb' })
    meta!: Record<string, any> | null; // UAやIPのハッシュ等

    @Column({ type: 'enum', enum: OnetimeStatus, default: OnetimeStatus.Unused })
    status!: OnetimeStatus;
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

//   CREATE TABLE o_auth_account_entity_bk AS
//   SELECT id,created_by,updated_by,created_at,updated_at,created_ip,updated_ip,user_id,provider,provider_user_id,provider_email,access_token,refresh_token,token_expires_at,token_body,user_info,status,label,org_key,id_token FROM o_auth_account_entity; 

//   DROP TABLE o_auth_account_entity;
//   INSERT INTO o_auth_account_entity(id,created_by,updated_by,created_at,updated_at,created_ip,updated_ip,user_id,provider,provider_user_id,provider_email,access_token,refresh_token,token_expires_at,token_body,user_info,status,label,org_key,id_token) 
//   SELECT id,created_by,updated_by,created_at,updated_at,created_ip,updated_ip,user_id,provider,provider_user_id,provider_email,access_token,refresh_token,token_expires_at,token_body::jsonb,user_info::jsonb,status,label,org_key,id_token FROM o_auth_account_entity_bk; 
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
    idToken?: string;

    @Column({ nullable: true })
    tokenExpiresAt?: Date;

    @Column({ type: 'jsonb', nullable: true })
    tokenBody!: Record<string, any> | null;

    @Column({ type: 'jsonb', nullable: true })
    userInfo!: Record<string, any> | null;

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

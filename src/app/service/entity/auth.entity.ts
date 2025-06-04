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

export interface OpenAIConfig {
    apiKey: string; // OpenAI APIキー
    baseURL?: string; // オプション：カスタムベースURL（例：https://api.openai.com/v1/）
    apiVersion?: string; // オプション：APIバージョン（例：2023-05-15）
    // modelIds?: { [modelAlias: string]: string }; // 任意のモデルエイリアスとOpenAIモデル名の対応
    httpAgent?: any; // オプション：HTTPエージェント（例：プロキシ設定など）
    // proxy?: {
    //     host: string; // プロキシホスト
    //     port: number; // プロキシポート
    //     auth?: {
    //         username: string; // プロキシ認証ユーザー名
    //         password: string; // プロキシ認証パスワード
    //     };
    // };
}

export interface AzureOpenAIConfig {
    // resource_name: string; // Azure上のリソース名
    // default_deployment?: string; // オプション：省略時のデフォルト
    baseURL: string; // オプション：カスタムベースURL（例：https://<resource_name>.openai.azure.com/）
    apiKey: string; // オプション：APIキー（あれば）
    apiVersion?: string; // APIバージョン（例：2023-05-15）
}

export interface VertexAIConfig {
    project: string;               // GCP プロジェクトID
    location: string;                 // リージョン（例：us-central1）
    // model_ids?: {
    //     [modelAlias: string]: string; // 任意のモデルエイリアスとVertexモデル名の対応
    // };
    apiEndpoint: string; // APIエンドポイント（例：us-central1-aiplatform.googleapis.com）
    httpAgent?: any; // オプション：HTTPエージェント（例：プロキシ設定など）
}

export interface AnthropicVertexAIConfig {
    projectId: string;               // GCP プロジェクトID
    region: string;                   // リージョン（例：us-central1）
    // model_ids?: {
    //     [modelAlias: string]: string; // 任意のモデルエイリアスとVertexモデル名の対応
    // };
    baseURL?: string; // オプション：カスタムベースURL（例：https://us-central1-aiplatform.googleapis.com/）
    httpAgent?: any;
}

export type CredentialMetadata =
    | AzureOpenAIConfig
    | VertexAIConfig
    | AnthropicVertexAIConfig
    | Record<string, any>; // その他（未定義プロバイダやローカルLLM）

export function isAzureMetadata(meta: CredentialMetadata): meta is AzureOpenAIConfig {
    return (meta as AzureOpenAIConfig).baseURL !== undefined;
}

export function isVertexMetadata(meta: CredentialMetadata): meta is VertexAIConfig {
    return (meta as VertexAIConfig).project !== undefined;
}
export enum CredentialType { API_KEY = 'api_key', SERVICE_ACCOUNT = 'service_account', OAUTH_TOKEN = 'oauth_token' }
export enum AIProviderType {
    OPENAI = 'openai',
    AZURE_OPENAI = 'azure_openai',
    // AZURE = 'azure',
    GROQ = 'groq',
    MISTRAL = 'mistral',
    ANTHROPIC = 'anthropic',
    DEEPSEEK = 'deepseek',
    LOCAL = 'local',
    OPENAI_COMPATIBLE = 'openai_compatible', // OpenAI互換のローカルLLM
    VERTEXAI = 'vertexai',
    ANTHROPIC_VERTEXAI = 'anthropic_vertexai',
    OPENAPI_VERTEXAI = 'openapi_vertexai',
    CEREBRAS = 'cerebras',
    COHERE = 'cohere',
    GEMINI = 'gemini',
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
export enum ProviderCategory {
    AI = 'AI',
    API = 'API', // APIプロバイダ（GitHub, GitLabなど）
}
@Entity()
@Index(['orgKey', 'providerCategory'])
export class ProviderCredentialRelationEntity extends MyBaseEntity {
    @Column({ type: 'uuid' })
    credentialId!: string; // CredentialEntityのIDを参照
    @Column({ type: 'uuid' })
    providerId!: string; // AIProviderEntity/APIProviderEntityのIDを参照
    @Column({ type: 'enum', enum: ProviderCategory })
    providerCategory!: ProviderCategory; // AIプロバイダのタイプ
    @Column({ default: true })
    isActive!: boolean; // 有効/無効フラグ
}

@Entity()
@Index(['orgKey', 'scopeInfo.scopeType', 'scopeInfo.scopeId'])
export class CredentialEntity extends MyBaseEntity {
    @Column({ type: 'enum', enum: CredentialType })
    credentialType!: CredentialType;

    @Column({ type: 'text' })
    keyValue!: string; // 暗号化はアプリケーション層で実施

    @Column(type => ScopeInfo)
    scopeInfo!: ScopeInfo;

    @Column()
    label!: string;

    @Column({ type: 'timestamptz', nullable: true })
    expiresAt?: Date;

    @Column({ type: 'jsonb', nullable: true })
    metadata?: CredentialMetadata;

    @Column({ default: true })
    isActive!: boolean;
}

export enum AIModelStatus {
    ACTIVE = 'active',
    DEPRECATED = 'deprecated',
    EXPERIMENTAL = 'experimental',
}

export enum Modality {
    TEXT = 'text',
    PDF = 'pdf',
    IMAGE = 'image',
    AUDIO = 'audio',
    VIDEO = 'video',
}

export enum AIModelPricingUnit {
    USD_1M_TOKENS = 'USD/1Mtokens', // 1Mトークンあたりの価格
    USD_1M_CHARS = 'USD/1MCHARS', // 1M文字あたりの価格
    USD_1M_TOKENS_PER_SECOND = 'USD/1Mtokens/sec', // 1Mトークンあたりの価格
    USD_1M_CHARS_PER_SECOND = 'USD/1MCHARS/sec', // 1M文字あたりの価格
}
@Entity()
@Index(['orgKey', 'modelId'])
export class AIModelPricingEntity extends MyBaseEntity {
    @Column({ type: 'uuid' })
    modelId!: string; // ModelのIDを参照する

    @Column('decimal', { precision: 10, scale: 6 })
    inputPricePerUnit!: number;

    @Column('decimal', { precision: 10, scale: 6 })
    outputPricePerUnit!: number;

    @Column({ type: 'varchar', default: 'USD/1Mtokens' })
    unit!: string;

    @Column({ type: 'timestamptz' })
    validFrom!: Date;
}

@Entity()
@Index(['orgKey', 'scopeInfo.scopeType', 'scopeInfo.scopeId'])
@Index(['orgKey', 'provider']) // プロバイダ検索に備える
export class AIProviderTemplateEntity extends MyBaseEntity {
    @Column({ type: 'enum', enum: AIProviderType })

    provider!: AIProviderType;

    @Column(type => ScopeInfo)
    scopeInfo!: ScopeInfo;

    @Column()
    label!: string;

    @Column({ type: 'jsonb', nullable: true })
    metadata?: CredentialMetadata;

    @Column({ default: true })
    isActive!: boolean;
}

type AIProviderConfigMap = {
    [AIProviderType.OPENAI]: OpenAIConfig;
    [AIProviderType.AZURE_OPENAI]: AzureOpenAIConfig;
    [AIProviderType.GROQ]: OpenAIConfig;
    [AIProviderType.MISTRAL]: OpenAIConfig;
    [AIProviderType.ANTHROPIC]: OpenAIConfig;
    [AIProviderType.DEEPSEEK]: OpenAIConfig;
    [AIProviderType.LOCAL]: OpenAIConfig; // ローカルLLMの設定
    [AIProviderType.OPENAI_COMPATIBLE]: { apiKey: string, baseURL: string }; // OpenAI互換のローカルLLM
    [AIProviderType.VERTEXAI]: VertexAIConfig;
    [AIProviderType.ANTHROPIC_VERTEXAI]: AnthropicVertexAIConfig; // Vertex AI上のAnthropicモデル
    [AIProviderType.OPENAPI_VERTEXAI]: VertexAIConfig; // Vertex AI上のOpenAI互換モデル
    [AIProviderType.CEREBRAS]: OpenAIConfig; // Cerebrasの設定
    [AIProviderType.COHERE]: OpenAIConfig; // Cohereの設定
    [AIProviderType.GEMINI]: OpenAIConfig; // Geminiの設定
};

export type AIProviderConfig = AIProviderConfigMap[keyof AIProviderConfigMap];

@Entity()
@Index(['orgKey', 'scopeInfo.scopeType', 'scopeInfo.scopeId'])
@Index(['orgKey', 'scopeInfo.scopeType', 'scopeInfo.scopeId', 'name'], { unique: true })
@Index(['orgKey', 'type'])
@Index(['orgKey', 'name'])
export class AIProviderEntity extends MyBaseEntity {
    @Column({ type: 'enum', enum: AIProviderType })
    type!: AIProviderType;

    @Column()
    name!: string;

    @Column(type => ScopeInfo)
    scopeInfo!: ScopeInfo;

    @Column()
    label!: string;

    @Column({ type: 'jsonb' })
    config!: AIProviderConfig[]; // 複数ある時はラウンドロビン

    @Column({ default: true })
    isActive!: boolean;
}
// 型ガードを単独関数に分離
export function getAIProviderConfig<T extends AIProviderType>(
    provider: AIProviderEntity,
    type: T
): AIProviderConfigMap[T][] {
    return provider.config as AIProviderConfigMap[T][];
}


@Entity()
@Index(['orgKey', 'scopeInfo.scopeType', 'scopeInfo.scopeId'])
@Index(['orgKey', 'modelId', 'scopeInfo.scopeType', 'scopeInfo.scopeId']) // モデル検索に備える
export class AIModelOverrideEntity extends MyBaseEntity {

    @Column({ type: 'uuid' })
    modelId!: string;

    @Column({ type: 'uuid' })
    credentialId!: string;

    @Column(type => ScopeInfo)
    scopeInfo!: ScopeInfo;

    @Column()
    alias!: string;

    @Column({ nullable: true })
    endpointOverride?: string;

    @Column('jsonb', { nullable: true })
    metadata?: Record<string, any>;

    @Column({ default: true })
    isActive!: boolean;
}




@Entity()
@Index(['orgKey', 'provider', 'providerModelId'], { unique: true })
export class AIModelEntity extends MyBaseEntity {

    @Column({ type: 'enum', enum: AIProviderType })
    provider!: AIProviderType;

    @Column()
    providerModelId!: string;

    @Column()
    name!: string;

    @Column({ nullable: true, length: 8, })
    shortName!: string;

    @Column({ nullable: true })
    throttleKey!: string;

    // @Column()
    // version!: string;

    @Column({ type: 'enum', enum: AIModelStatus, default: AIModelStatus.ACTIVE })
    status!: AIModelStatus;

    @Column({ type: 'text', nullable: true })
    description?: string;

    @Column('text', { array: true, nullable: true })
    details?: string[];

    @Column('text', { array: true, default: '{}' })
    modalities!: Modality[];

    @Column('int')
    maxContextTokens!: number;

    @Column('int')
    maxOutputTokens!: number;

    @Column({ default: true })
    isStream!: boolean;

    @Column('text', { array: true, nullable: true })
    inputFormats!: Modality[];

    @Column('text', { array: true, nullable: true })
    outputFormats!: Modality[];

    @Column('jsonb', { nullable: true })
    defaultParameters?: Record<string, any>;

    @Column('jsonb', { nullable: true })
    capabilities?: Record<string, any>;

    @Column('jsonb', { nullable: true })
    metadata?: Record<string, any>;

    @Column({ nullable: true })
    endpointTemplate?: string;

    @Column({ nullable: true })
    documentationUrl?: string;

    @Column({ nullable: true })
    licenseType?: string;

    @Column({ type: 'date', nullable: true })
    knowledgeCutoff?: Date;

    @Column({ type: 'date', nullable: true })
    releaseDate?: Date;

    @Column({ type: 'date', nullable: true })
    deprecationDate?: Date;

    @Column('text', { array: true, nullable: true })
    tags?: string[];

    @Column({ type: 'int', nullable: true })
    uiOrder?: number;

    @Column({ default: true })
    isActive!: boolean;
}

@Entity()
@Index(['orgKey', 'provider', 'alias'], { unique: true })
export class AIModelAlias extends MyBaseEntity {

    @Column({ type: 'uuid' })
    modelId!: string;

    @Column({ type: 'enum', enum: AIProviderType })
    provider!: AIProviderType;

    @Column({ type: 'text' })
    alias!: string;
}

import { Column, Entity, Index } from "typeorm";

import { MyBaseEntity } from "./base.js";
import { ScopeInfo } from "./auth.entity.js";

export interface OpenAIConfig {
    endpoints: {
        apiKey: string; // OpenAI APIキー
        baseURL?: string; // オプション：カスタムベースURL（例：https://api.openai.com/v1/）
        apiVersion?: string; // オプション：APIバージョン（例：2023-05-15）
        // modelIds?: { [modelAlias: string]: string }; // 任意のモデルエイリアスとOpenAIモデル名の対応
        httpAgent?: any; // オプション：HTTPエージェント（例：プロキシ設定など）
        maxRetries?: number; // オプション：最大リトライ回数（デフォルトは3）
        // proxy?: {
        //     host: string; // プロキシホスト
        //     port: number; // プロキシポート
        //     auth?: {
        //         username: string; // プロキシ認証ユーザー名
        //         password: string; // プロキシ認証パスワード
        //     };
        // };
    }[];
}
export interface OpenAICompatibleConfig {
    endpoints: {
        apiKey: string; // OpenAI APIキー
        baseURL: string; // オプション：カスタムベースURL（例：https://api.openai.com/v1/）
        maxRetries?: number; // オプション：最大リトライ回数（デフォルトは3）
    }[];
}

export interface AzureOpenAIConfig {
    resources: {
        // resource_name: string; // Azure上のリソース名
        // default_deployment?: string; // オプション：省略時のデフォルト
        baseURL: string; // オプション：カスタムベースURL（例：https://<resource_name>.openai.azure.com/）
        apiKey: string; // オプション：APIキー（あれば）
        apiVersion?: string; // APIバージョン（例：2023-05-15）
    }[];
}

export interface VertexAIConfig {
    project: string;               // GCP プロジェクトID
    locationList: string[];                 // リージョン（例：us-central1）
    // model_ids?: {
    //     [modelAlias: string]: string; // 任意のモデルエイリアスとVertexモデル名の対応
    // };
    apiEndpoint: string; // APIエンドポイント（例：us-central1-aiplatform.googleapis.com）
    httpAgent?: any; // オプション：HTTPエージェント（例：プロキシ設定など）
}

export interface AnthropicVertexAIConfig {
    projectId: string;               // GCP プロジェクトID
    regionList: string[];                   // リージョン（例：us-central1）
    // model_ids?: {
    //     [modelAlias: string]: string; // 任意のモデルエイリアスとVertexモデル名の対応
    // };
    baseURL?: string; // オプション：カスタムベースURL（例：https://us-central1-aiplatform.googleapis.com/）
    httpAgent?: any;
}

export interface CohereConfig {
    endpoints: {
        token: string;
        environment?: string;
    }[];
}

export type CredentialMetadata =
    | AzureOpenAIConfig
    | VertexAIConfig
    | AnthropicVertexAIConfig
    | CohereConfig
    | Record<string, any>; // その他（未定義プロバイダやローカルLLM）

export function isAzureMetadata(meta: CredentialMetadata): meta is AzureOpenAIConfig {
    return (meta as AzureOpenAIConfig).resources !== undefined;
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
    USD_1M_TOKENS = 'USD/1M tokens', // 1Mトークンあたりの価格
    USD_1M_CHARS = 'USD/1M CHARS', // 1M文字あたりの価格
    USD_1M_TOKENS_PER_SECOND = 'USD/1M tokens/sec', // 1Mトークンあたりの価格
    USD_1M_CHARS_PER_SECOND = 'USD/1M CHARS/sec', // 1M文字あたりの価格
}
@Entity()
@Index(['orgKey', 'modelId'])
@Index(['orgKey', 'scopeInfo.scopeType', 'scopeInfo.scopeId'])
@Index(['orgKey', 'scopeInfo.scopeType', 'scopeInfo.scopeId', 'name', 'validFrom'], { unique: true })
export class AIModelPricingEntity extends MyBaseEntity {
    @Column({ type: 'uuid' })
    modelId!: string; // ModelのIDを参照する

    @Column(type => ScopeInfo)
    scopeInfo!: ScopeInfo;

    @Column()
    name!: string; // 価格設定の識別名（例: "GPT-4 Pricing 2024-01-01"）

    @Column('decimal', { precision: 10, scale: 6 })
    inputPricePerUnit!: number;

    @Column('decimal', { precision: 10, scale: 6 })
    outputPricePerUnit!: number;

    @Column({type:'jsonb', nullable: true})
    metadata?: Record<string, any>; // 任意のメタデータ（例: "currency": "USD", "model": "gpt-4"）

    @Column({ type: 'varchar', default: 'USD/1Mtokens' })
    unit!: string;

    @Column({ type: 'timestamptz' })
    validFrom!: Date;

    @Column({ default: true })
    isActive!: boolean; // 有効/無効フラグ
}

@Entity()
@Index(['orgKey', 'scopeInfo.scopeType', 'scopeInfo.scopeId'])
@Index(['orgKey', 'scopeInfo.scopeType', 'scopeInfo.scopeId', 'name'], { unique: true })
@Index(['orgKey', 'provider']) // プロバイダ検索に備える
export class AIProviderTemplateEntity extends MyBaseEntity {
    @Column({ type: 'enum', enum: AIProviderType })
    provider!: AIProviderType;

    @Column()
    name!: string;

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
    [AIProviderType.OPENAI_COMPATIBLE]: OpenAICompatibleConfig; // OpenAI互換のローカルLLM
    [AIProviderType.VERTEXAI]: VertexAIConfig;
    [AIProviderType.ANTHROPIC_VERTEXAI]: AnthropicVertexAIConfig; // Vertex AI上のAnthropicモデル
    [AIProviderType.OPENAPI_VERTEXAI]: VertexAIConfig; // Vertex AI上のOpenAI互換モデル
    [AIProviderType.CEREBRAS]: OpenAIConfig; // Cerebrasの設定
    [AIProviderType.COHERE]: CohereConfig; // Cohereの設定
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

    @Column({ type: 'text', nullable: true })
    description?: string;

    @Column({ type: 'jsonb' })
    config!: AIProviderConfig;

    @Column({ default: true })
    isActive!: boolean;
}
// 型ガードを単独関数に分離
export function getAIProviderConfig<T extends AIProviderType>(
    provider: AIProviderEntity,
    type: T
): AIProviderConfigMap[T] {
    return provider.config as AIProviderConfigMap[T];
}


@Entity()
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
@Index(['orgKey', 'name'] )
@Index(['orgKey', 'scopeInfo.scopeType', 'scopeInfo.scopeId', 'providerModelId'], { unique: true })
@Index(['orgKey', 'scopeInfo.scopeType', 'scopeInfo.scopeId', 'name'], { unique: true })
export class AIModelEntity extends MyBaseEntity {

    @Column('text', { array: true, nullable: false, default: '{}' })
    providerNameList!: string[];

    @Column()
    providerModelId!: string;

    @Column()
    name!: string;

    @Column(type => ScopeInfo)
    scopeInfo!: ScopeInfo;

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

    @Column({ nullable: true })
    developer?: string;

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
@Index(['orgKey', 'scopeInfo.scopeType', 'scopeInfo.scopeId'])
@Index(['orgKey', 'scopeInfo.scopeType', 'scopeInfo.scopeId', 'alias'], { unique: true })
export class AIModelAlias extends MyBaseEntity {

    @Column({ type: 'uuid' })
    modelId!: string;

    @Column(type => ScopeInfo)
    scopeInfo!: ScopeInfo;

    @Column({ type: 'text' })
    alias!: string;
}

@Entity()
@Index(['orgKey', 'scopeInfo.scopeType', 'scopeInfo.scopeId'])
@Index(['orgKey', 'scopeInfo.scopeType', 'scopeInfo.scopeId', 'name'], { unique: true })
export class TagEntity extends MyBaseEntity {
    @Column()
    name!: string;

    @Column(type => ScopeInfo)
    scopeInfo!: ScopeInfo;

    @Column({ nullable: true })
    category?: string; // タグのカテゴリ（例: '企業別', '技術別'など）

    @Column({ nullable: true })
    label?: string; // 表示用ラベル

    @Column({ type: 'text', nullable: true })
    description?: string;

    @Column({ nullable: true, length: 7 })
    color?: string; // HEXカラー (#FF5733)

    @Column({ default: 0 })
    usageCount!: number; // 使用回数（統計用）

    @Column({ default: 10000 })
    uiOrder!: number; // UI上の表示順序

    @Column({ default: false })
    overrideOthers!: boolean; // 他のタグを上書きするかどうか

    @Column({ default: true })
    isActive!: boolean;
}



//   CREATE TABLE api_provider_entity_bk AS SELECT * FROM api_provider_entity;
//   DROP TABLE api_provider_entity;
  
//   INSERT INTO api_provider_entity(id,org_key,created_by,updated_by,created_at,updated_at,created_ip,updated_ip,type,name,label,uri_base,o_auth2_config,description,is_deleted,sort_seq,auth_type,path_user_info,uri_base_auth)
//   SELECT id,org_key,created_by,updated_by,created_at,updated_at,created_ip,updated_ip,type,name,label,uri_base,o_auth2_config,description,is_deleted,sort_seq,auth_type,path_user_info,uri_base_auth FROM api_provider_entity_bk; 
  
//   DROP TABLE api_provider_entity_bk;
  
//   UPDATE ai_model_entity SET provider_name=provider::text WHERE provider_name IS NULL;
//   UPDATE ai_model_entity SET provider_type=provider::text::ai_model_entity_provider_type_enum WHERE provider_type IS NULL;
//   UPDATE ai_model_alias  SET provider_name=provider::text WHERE provider_name IS NULL;
//   UPDATE ai_model_alias  SET provider_type=provider::text::ai_model_alias_provider_type_enum WHERE provider_type IS NULL;



// -- =======================
// -- ① バックアップ作成
// -- =======================
// CREATE TABLE ai_model_entity_backup AS TABLE ai_model_entity;
// CREATE TABLE ai_model_alias_backup AS TABLE ai_model_alias;

// -- =======================
// -- ② 旧テーブル削除
// -- =======================
// DROP TABLE ai_model_alias;
// DROP TABLE ai_model_entity;

// -- =======================
// -- ③ TypeORM で再作成
// -- =======================
// -- ※ アプリ起動 or `npx typeorm migration:run` で自動再作成

// -- =======================
// -- ④ データ復元
// -- =======================

// -- AIModelEntity
// INSERT INTO ai_model_entity (
//     id, org_key, created_by, updated_by, created_at, updated_at, created_ip, updated_ip,
//     provider, provider_type, provider_name, provider_model_id, name, short_name, throttle_key,
//     status, description, details, modalities, max_context_tokens, max_output_tokens,
//     is_stream, input_formats, output_formats, default_parameters, capabilities,
//     metadata, endpoint_template, documentation_url, license_type, knowledge_cutoff,
//     release_date, deprecation_date, tags, ui_order, is_active
// )
// SELECT
//     id, org_key, created_by, updated_by, created_at, updated_at, created_ip, updated_ip,
//     provider, provider_type, provider_name, provider_model_id, name, short_name, throttle_key,
//     status, description, details, modalities, max_context_tokens, max_output_tokens,
//     is_stream, input_formats, output_formats, default_parameters, capabilities,
//     metadata, endpoint_template, documentation_url, license_type, knowledge_cutoff,
//     release_date, deprecation_date, tags, ui_order, is_active
// FROM ai_model_entity_backup;

// -- AIModelAlias
// INSERT INTO ai_model_alias (
//     id, org_key, created_by, updated_by, created_at, updated_at, created_ip, updated_ip,
//     model_id, provider, provider_type, provider_name, alias
// )
// SELECT
//     id, org_key, created_by, updated_by, created_at, updated_at, created_ip, updated_ip,
//     model_id, provider, provider_type, provider_name, alias
// FROM ai_model_alias_backup;

// -- =======================
// -- ⑤ バックアップ削除（任意）
// -- =======================
// -- DROP TABLE ai_model_entity_backup;
// -- DROP TABLE ai_model_alias_backup;

//   UPDATE ai_model_entity SET provider_name_list=ARRAY[provider_name] WHERE provider_name_list = '{}';

  
//   WITH tag_extraction AS (
//     -- ai_model_entityのtagsカラムから全てのタグを抽出
//     SELECT DISTINCT
//         org_key,
//         TRIM(tag_name) as tag_name,
//         COUNT(*) as usage_count,
//         -- 最初にそのタグを使用したレコードの情報を取得
//         MIN(created_by) as first_created_by,
//         MIN(created_at) as first_created_at,
//         MIN(created_ip) as first_created_ip
//     FROM (
//         SELECT 
//             org_key,
//             created_by,
//             created_at,
//             created_ip,
//             unnest(tags) as tag_name
//         FROM ai_model_entity 
//         WHERE tags IS NOT NULL 
//         AND array_length(tags, 1) > 0
//     ) expanded_tags
//     WHERE tag_name IS NOT NULL 
//     AND TRIM(tag_name) != ''
//     AND LENGTH(TRIM(tag_name)) > 0
//     GROUP BY org_key, TRIM(tag_name)
// ),
// tag_stats AS (
//     -- 各タグの詳細な統計情報を計算
//     SELECT 
//         te.org_key,
//         te.tag_name,
//         te.usage_count,
//         te.first_created_by,
//         te.first_created_at,
//         te.first_created_ip,
//         -- 最後に更新されたレコードの情報
//         MAX(ame.updated_by) as last_updated_by,
//         MAX(ame.updated_at) as last_updated_at,
//         MAX(ame.updated_ip) as last_updated_ip
//     FROM tag_extraction te
//     JOIN ai_model_entity ame ON (
//         te.org_key = ame.org_key 
//         AND te.tag_name = ANY(ame.tags)
//     )
//     GROUP BY 
//         te.org_key, 
//         te.tag_name, 
//         te.usage_count, 
//         te.first_created_by, 
//         te.first_created_at, 
//         te.first_created_ip
// )
// INSERT INTO tag_entity (
//     id,
//     org_key,
//     name,
//     label,
//     description,
//     color,
//     usage_count,
//     is_active,
//     scope_info_scope_type,
//     scope_info_scope_id,
//     created_by,
//     updated_by,
//     created_at,
//     updated_at,
//     created_ip,
//     updated_ip
// )
// SELECT 
//     gen_random_uuid() as id,  -- UUIDを生成
//     org_key,
//     tag_name as name,
//     NULL as label,
//     NULL as description,
//     NULL as color,
//     usage_count,
//     true as is_active,
//     'ORGANIZATION'::tag_entity_scope_info_scope_type_enum as scope_info_scope_type,  -- 適切なスコープタイプを設定
//     '{f31006cf-1d10-4a48-ab5e-af6003deac32}' as scope_info_scope_id,  -- 組織レベルの場合はNULL
//     COALESCE(first_created_by, 'system') as created_by,
//     COALESCE(last_updated_by, 'system') as updated_by,
//     COALESCE(first_created_at, now()) as created_at,
//     COALESCE(last_updated_at, now()) as updated_at,
//     first_created_ip as created_ip,
//     last_updated_ip as updated_ip
// FROM tag_stats
// ON CONFLICT (org_key, scope_info_scope_type, scope_info_scope_id, name) DO UPDATE SET
//     usage_count = EXCLUDED.usage_count,
//     updated_by = EXCLUDED.updated_by,
//     updated_at = EXCLUDED.updated_at,
//     updated_ip = EXCLUDED.updated_ip;

 
  
  
//   UPDATE ai_model_pricing_entity SET unit='USD/1M tokens' WHERE unit='USD/1Mtokens';
  

//   CREATE TABLE ai_model_entity_bk AS SELECT * FROM ai_model_entity;
//   --DROP TABLE ai_model_entity;
//   INSERT INTO ai_model_entity (id,org_key,created_by,updated_by,created_at,updated_at,created_ip,updated_ip,provider_name_list,provider_model_id,name,short_name,throttle_key,status,description,details,modalities,max_context_tokens,max_output_tokens,is_stream,input_formats,output_formats,default_parameters,capabilities,metadata,endpoint_template,documentation_url,license_type,knowledge_cutoff,release_date,deprecation_date,tags,ui_order,is_active,scope_info_scope_type,scope_info_scope_id)
//   SELECT                       id,org_key,created_by,updated_by,created_at,updated_at,created_ip,updated_ip,provider_name_list,provider_model_id,name,short_name,throttle_key,status,description,details,modalities,max_context_tokens,max_output_tokens,is_stream,input_formats,output_formats,default_parameters,capabilities,metadata,endpoint_template,documentation_url,license_type,knowledge_cutoff,release_date,deprecation_date,tags,ui_order,is_active,'DIVISION','{1a7dcedc-5a7d-4aa6-828d-9c5aadec4f3f}' FROM ai_model_entity_bk;

//   CREATE TABLE ai_provider_template_entity_bk AS SELECT * FROM ai_provider_template_entity; 
//   CREATE TABLE ai_model_entity_bk AS SELECT * FROM ai_model_entity;
//   CREATE TABLE ai_model_pricing_entity_bk AS SELECT * FROM ai_model_pricing_entity; 
//   CREATE TABLE ai_model_alias_bk AS SELECT * FROM ai_model_alias;
   
//   DROP TABLE ai_provider_template_entity;
//   DROP TABLE ai_model_entity;
//   DROP TABLE ai_model_pricing_entity;
//   DROP TABLE ai_model_alias;
  
//   -- 指定したテーブル群の全INSERT文を一括生成
// WITH target_tables AS (
//   SELECT unnest(ARRAY[
//     'ai_provider_template_entity',
//     'ai_model_entity', 
//     'ai_model_pricing_entity',
//     'ai_model_alias',
//     'tag_entity'
//   ]) AS table_name
// ),
// column_lists AS (
//   SELECT 
//     t.table_name,
//     string_agg(c.column_name, ', ' ORDER BY c.ordinal_position) AS columns
//   FROM target_tables t
//   JOIN information_schema.columns c 
//     ON c.table_name = t.table_name 
//     AND c.table_schema = 'ribbon'
//   GROUP BY t.table_name
// )
// SELECT 
//   'INSERT INTO ' || table_name || ' (' || columns || ') ' ||
//   'SELECT ' || columns || ' FROM ' || table_name || '_bk;' AS insert_statement
// FROM column_lists
// ORDER BY table_name;
  
  
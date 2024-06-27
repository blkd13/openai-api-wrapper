# openai-api-wrapper

## 概要

OpenAI の API をラップして使いやすくしたものです。

## 機能

1. **API 生データのロギング**: API の入出力の生データを`history`に保存します。
2. **課金履歴**: 課金履歴を`history.log`に書き込みます。
3. **エージェントとステップ**: 複数ステップからなるエージェントを作成するためのクラスを利用できます。
4. **バッチ/オンライン**: バッチ機能と、REST-API のサーバー機能があります。

## ディレクトリ構造

```markdown
├── README.md
├── history (通信ログが溜まるところ。エラー調査とかに使う。)
│   ├── ...
│   └── ...
├── history.log (課金履歴)
├── package.json
├── prompts_and_responses (投げつけたプロンプトと結果が溜まるところ)
│   ├── (agent name)/ (エージェント毎にディレクトリが分かれている)
│ │   ├── ...
│ │   └── ...
│   └── ...
│    ├── ...
│    └── ...
├── results
├── src （ソースコード）
│   └── app
│   ├── agent
│   │   ├── company-report-from-logos (エージェント定義)
│   │   │   ├── README.md
│   │   │   └── runner.ts
│   │   └── sample (エージェント定義)
│   │   └── runner.ts
│   ├── cli.ts
│   ├── common (共通機能)
│   │   ├── base-step.ts
│   │   ├── fss.ts
│   │   ├── openai-api-wrapper.ts
│   │   └── utils.ts
│   └── main (メイン実行系)
│    ├── main-batch.ts
│   ├── main-generate.ts
│   ├── main-server.ts
│   └── main-vision-plain.ts
└── tsconfig.json
```

## 使用方法

### 事前準備

```bash
# プロキシの設定（必要に応じて）
export https_proxy="http://${username}:${password}@${proxyHost}:${proxyPort}"

# OpenAIのAPI鍵設定
export OPENAI_API_KEY="${YOUR_OPENAI_API_KEY}"

# 必要ライブラリをインストール
npm install
```

### CLI

CLI の使い方は help を参照してください。

```bash
# ヘルプ
npm run cli --help
```

コマンドをインストールする場合。

```bash
# oaw ユーザーのみにインストール
npm link oaw

# oaw グローバルにインストール
npm link
```

### バッチ利用

```bash
# <sample>の部分はエージェント名を入れる。
# src/app/agent配下にあるディレクトリ名がエージェント名なので、そこから選んで使う。
npm run batch sample
```

結果は`prompts_and_responses`に溜まるので、中身見ておくと途中経過が見れてよい。.tmp が作成中ファイル。

`history/`には通信の生データが溜まる。エラー解析とかで使う。
`history.log`は課金履歴が載る。

### オートリビルド

以下のコマンドでプロセスを起動しておくと、ソースコードが変更されるたびに自動でビルドされます。

```bash
npm run start:dev
```

## エージェントの作り方

```bash
# agentNameで名前を指定する
npm run cli generate <agentName>
```

`src/app/agent/${agentName}`配下に`runner.ts`という名前でひな型が作成されるので、それを元に作る。
※細かいことはひな型のコメントに書いてあります。

## VertexAI(GoogleCloud) を使う場合

以下の 3 手順を行う。

- VertexAI 用の環境変数を設定する
- gcloud コマンドで認証を通す
- useAzure フラグを立てる

### gloud コマンドで認証を通す

事前に会社メールアドレスで GCP にアカウントを作って GCP プロジェクト管理者に権限をもらっておく必要がある。
権限がある状態でこのコマンドで認証を通す。（認証を通すとしばらくはトークンが有効になるので、切れたらまた認証を通す）

```bash
gcloud auth application-default print-access-token
```

### VertexAI 用の環境変数を設定する

```bash
# GCP のプロジェクトID（デフォルトはgcp-cloud-shosys-ai-002）。※プロジェクト名ではなくプロジェクトIDであることに注意
export GCP_PROCJET_ID="${YOUR_GCP_PROCJET_ID}"

# GCP のリージョン（デフォルトはasia-northeast1）
export GCP_REGION="${YOUR_GCP_REGION}"
```

### aiApi.wrapperOptions.provider で vertexai を設定する

runner 等のプログラムの頭で aiApi の aiApi.wrapperOptions.provider を vertexai にする。
※デフォルトが vertexai なのでやらなくてもよい。

```typescript
// vertexai に向ける
aiApi.wrapperOptions.provider = "vertexai";
```

## Azure を使う場合

以下の 4 手順を行う。

- Azure 用の環境変数を設定する
- Azure のライブラリを改造
- デプロイ名を設定する
- useAzure フラグを立てる

### Azure 用の環境変数を設定する

```bash
# Azure OpenAI のエンドポイント
export AZURE_OPENAI_ENDPOINT="${YOUR_AZURE_OPENAI_ENDPOINT}"

# Azure OpenAI のAPI鍵
export AZURE_OPENAI_API_KEY="${YOUR_AZURE_OPENAI_API_KEY}"
```

### Azure のライブラリを改造

```bash
# Microsoft のazureライブラリを上書きする。※httpヘッダーが取れない問題に対応するため。
cd node_modules_overwrite
./overwrite.sh
```

### デプロイ名を設定する

モデルごとのデプロイ名は openai-api-wrapper.ts の azureDeployNameMap で設定する。

```typescript ./src/app/common/openai-api-wrapper.ts
export const azureDeployNameMap: Record<string, string> = {
  "gpt-3.5-turbo": "gpt35",
  "gpt-4-vision-preview": "gpt4",
};
```

### aiApi.wrapperOptions.provider で azure を設定する

runner 等のプログラムの頭で aiApi の aiApi.wrapperOptions.provider を azure にする。
場合によっては base-step にハードコーディングしてもよい。

```typescript
// Azure に向ける
aiApi.wrapperOptions.provider = "azure";
```

## Groq を使う場合

### Groq 用の環境変数を設定する

```bash
# Groq のAPI鍵
export GROQ_API_KEY="${YOUR_GROQ_API_KEY}"
```

### aiApi.wrapperOptions.provider で groq を設定する

runner 等のプログラムの頭で aiApi の aiApi.wrapperOptions.provider を groq にする。
場合によっては base-step にハードコーディングしてもよい。

```typescript
// Groq に向ける
aiApi.wrapperOptions.provider = "groq";
```

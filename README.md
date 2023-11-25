# openai-api-wrapper

## 概要

OpenAIのAPIをラップして使いやすくしたものです。

## 機能

1. **API生データのロギング**: APIの入出力の生データを`history`に保存します。
2. **課金履歴**: 課金履歴を`history.log`に書き込みます。
3. **エージェントとステップ**: 複数ステップからなるエージェントを作成するためのクラスを利用できます。
4. **バッチ/オンライン**: バッチ機能と、REST-APIのサーバー機能があります。

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
│   │   ├── ...
│   │   └── ...
│   └── ...
│       ├── ...
│       └── ...
├── results
├── src （ソースコード）
│   └── app
│       ├── agent
│       │   ├── company-report-from-logos (エージェント定義)
│       │   │   ├── README.md
│       │   │   └── runner.ts
│       │   └── sample (エージェント定義)
│       │       └── runner.ts
│       ├── cli.ts
│       ├── common (共通機能)
│       │   ├── base-step.ts
│       │   ├── fss.ts
│       │   ├── openai-api-wrapper.ts
│       │   └── utils.ts
│       └── main (メイン実行系)
│           ├── main-batch.ts
│           ├── main-generate.ts
│           ├── main-server.ts
│           └── main-vision-plain.ts
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

CLIの使い方はhelpを参照してください。

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

結果は`prompts_and_responses`に溜まるので、中身見ておくと途中経過が見れてよい。.tmpが作成中ファイル。

`history/`には通信の生データが溜まる。エラー解析とかで使う。
`history.log`は課金履歴が載る。

## エージェントの作り方

```bash
# agentNameで名前を指定する
npm run generate <agentName>
```

`src/app/agent/${agentName}`配下に`runner.ts`という名前でひな型が作成されるので、それを元に作る。
※細かいことはひな型のコメントに書いてあります。

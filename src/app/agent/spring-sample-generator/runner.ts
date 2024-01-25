import { fileURLToPath } from 'url';

import { BaseStep, MultiStep, StepOutputFormat } from "../../common/base-step.js";
import { GPTModels } from '../../common/openai-api-wrapper.js';
import { Utils } from '../../common/utils.js';
import { parseJavaCode, javaServiceTemplateMap, javaServiceImplementsMap, parseJavaMethodSignatureWithGenerics } from "./helper.js";
import fss from '../../common/fss.js';
import * as fs from 'fs';

import ResourceNotFoundException from './spring-template/ResourceNotFoundException.java.js';
import CustomException from './spring-template/CustomException.java.js';
import BaseEntity from './spring-template/BaseEntity.java.js';
import DemoApplication from './spring-template/DemoApplication.java.js';
import Pom from './spring-template/pom.xml.js';

const __dirname = Utils.basename(fileURLToPath(import.meta.url));
const PROJECT_NAME = 'deposit-management-system-01';
const PACKAGE_NAME = 'com.example.demo';
const PACKAGE_DIRE = `spring/src/main/java/com/example/demo`;
const INPUT_PROMPT = Utils.trimLines(`
お題は「貸金業の貸付管理システム」です。
`);

/**
 * このエージェント用の共通設定。
 * エージェントごとに設定したいデフォルト値が異なるのでrunnerの最初に書くことにした。
 */
abstract class BaseStepDomainModelGenerator extends BaseStep {
    agentName: string = Utils.basename(Utils.dirname(import.meta.url));
    model: GPTModels = 'gpt-4-1106-preview';
    // labelPrefix: string = `${this.agentName}_${this.model}`;
    labelPrefix: string = `${PROJECT_NAME}/`;  // ラベルのプレフィックス。サブディレクトリに分けるように/を入れておくと便利。
    systemMessageJa = '経験豊富で優秀なソフトウェアエンジニア。専門はドメイン駆動設計。';
    systemMessageEn = 'Experienced and talented software engineer. Specialized in domain-driven design.';
    systemMessage = this.systemMessageJa;
    temperature: number = 0.0; // ランダム度合い。0に近いほど毎回同じ結果になる。プログラムのようなものは 0 に、文章系は 1 にするのが良い。
    format = StepOutputFormat.MARKDOWN;
}
/**
 * このエージェント用の共通設定。
 * エージェントごとに設定したいデフォルト値が異なるのでrunnerの最初に書くことにした。
 */
abstract class BaseMultiStepDomainModelGenerator extends MultiStep {
    agentName: string = Utils.basename(Utils.dirname(import.meta.url));
}

class Step0000_RequirementsToFeatureListSummary extends BaseStepDomainModelGenerator {
    // model: GPTModels = 'gpt-3.5-turbo';
    constructor() {
        super();
        this.chapters = [{
            title: `Instructions`,
            content: Utils.trimLines(`
                システム開発のための要件定義を手伝ってください。
                与えられたお題目に対して、まずは機能の頭出しをしたいです。
                markdownの番号リスト形式で機能一覧を列挙してください。
                出力はシステム名と機能一覧のみとし、余計なことは書かないでください。
            `),
        }, {
            content: INPUT_PROMPT,
        }];
    }
}

class Step0010_FeatureListSummaryToFeatureListDetail extends BaseStepDomainModelGenerator {
    // model: GPTModels = 'gpt-3.5-turbo';
    constructor() {
        super();
        this.chapters = [{
            title: `Instructions`,
            content: Utils.trimLines(`
                与えられた機能一覧をよく理解して、具体化、詳細化を行ってください。
                そのうえで機能一覧（詳細）を作成してください。
            `),
        }, {
            title: 'Input Document',
            content: Utils.setMarkdownBlock(new Step0000_RequirementsToFeatureListSummary().formed, 'markdown'),
        }];
    }
}

class Step0015_EntityList extends BaseStepDomainModelGenerator {
    constructor() {
        super();
        this.chapters = [{
            title: `Instructions`,
            content: Utils.trimLines(`
                これから提示する設計書をよく読んで、ドメイン駆動設計の要領でEntityを抽出してください。
                Enumは対象外です。
                出力形式は「Entity抽出のサンプル」を参考にしてください。
                Entityの名前はPasCalCaseで記述してください。(OJTのように、大文字が連続する名前は禁止です。Ojtと書いてください。)
            `),
            children: [{
                title: `評価ポイント`,
                content: Utils.trimLines(`
                    評価ポイントは以下の三点です。
                    - エンティティの明確さと適切性の評価：エンティティの明確さと適切性を評価します。DDDでは、エンティティはビジネスドメインの核となる概念であり、その特性や関連を明確に表現する必要があります。
                    - 結合度と凝集度の評価：エンティティ間の結合度と凝集度を評価します。理想的には、エンティティ間の結合は低く、凝集度は高いほうが望ましいです。過度な結合は、エンティティの再利用性を低下させ、凝集度の低いエンティティは、ビジネスドメインの概念を適切に表現できない可能性があります。
                    - 柔軟性と拡張性の評価：エンティティが将来の変更や拡張にどの程度対応できるかを評価します。
                `),
            }, {
                title: `Entitiy抽出のサンプル`,
                content: Utils.setMarkdownBlock(Utils.trimLines(`
                    ### 注文管理関連のエンティティ:
                    1. **Order** - 顧客の注文情報を含むエンティティ。注文ID、注文日、顧客の詳細、注文された商品のリスト、合計金額、支払い状態などの属性を持つ。
                    2. **Product** - 注文で購入される商品を表すエンティティ。商品ID、商品名、価格、在庫状況などの属性を持つ。
                    3. **Customer** - 注文を行う顧客を表すエンティティ。顧客ID、名前、連絡先情報、配送先住所、注文履歴などの属性を持つ。
                    4. **Payment** - 注文の支払い情報を表すエンティティ。支払いID、注文ID、支払い方法、支払い状況、支払い日時などの属性を持つ。
                    5. **Shipping** - 注文の配送情報を表すエンティティ。配送ID、注文ID、配送先住所、配送状況、予定配送日などの属性を持つ。

                    ### 従業員管理関連のエンティティ:
                    1. **Employee** - 従業員の個人情報と職務情報を含むエンティティ。従業員ID、名前、住所、電話番号、メールアドレス、部署、役職、入社日などの属性を持つ。
                    2. **Department** - 従業員が所属する部署を表すエンティティ。部署ID、部署名、部署の責任者、部署の機能・目的などの属性を持つ。
                    3. **Project** - 従業員が関与するプロジェクトを表すエンティティ。プロジェクトID、プロジェクト名、開始日、終了日、プロジェクトの目的、参加している従業員のリストなどの属性を持つ。
                    4. **Attendance** - 従業員の出勤状況を記録するエンティティ。出勤記録ID、従業員ID、出勤日、出勤時間、退勤時間、勤務時間などの属性を持つ。
                    5. **PerformanceReview** - 従業員の業績評価を表すエンティティ。評価ID、従業員ID、評価期間、評価者、評価結果、フィードバックコメントなどの属性を持つ。
                `), 'markdown'),
            },],
        }, {
            title: '設計書', content: Utils.setMarkdownBlock(new Step0010_FeatureListSummaryToFeatureListDetail().formed, 'markdown'),
        },];
    }
}

class Step0020_FeatureListDetailToJsonFormat extends BaseStepDomainModelGenerator {
    // model: GPTModels = 'gpt-3.5-turbo';
    format: StepOutputFormat = StepOutputFormat.JSON;
    constructor() {
        super();
        this.chapters = [{
            title: `Instructions`,
            content: Utils.trimLines(`
                与えられた機能一覧（詳細）をよく理解して、指定されたJson形式を作成してください。
            `),
        }, {
            title: 'Input Document',
            content: new Step0010_FeatureListSummaryToFeatureListDetail().formed,
        }, {
            title: 'Output Format',
            content: Utils.trimLines(`
                出力フォーマットは以下の通りです。
                \`\`\`json
                {"featureList":["feature1","feature2","feature3"]}
                \`\`\`
            `),
        }];
    }
}

class Step0030_DesignSummary extends BaseMultiStepDomainModelGenerator {
    featureList!: string[];
    constructor() {
        super();
        class Step0030_DesignSummaryChil extends BaseStepDomainModelGenerator {
            // model: GPTModels = 'gpt-3.5-turbo';
            constructor(public feature: string) {
                super();

                // 複数並列処理するので、被らないようにラベルを設定する。（これがログファイル名になる）
                this.label = `${this.constructor.name}_${Utils.safeFileName(feature)}`; // Utils.safeFileNameはファイル名として使える文字だけにするメソッド。
                // 個別の指示を作成。
                this.chapters = [
                    {
                        title: `Instructions`,
                        content: Utils.trimLines(`
                            与えられた機能一覧（詳細）をよく理解して、担当機能の詳細化を行ってください。
                            あなたの担当は「${feature}」です。
                        `),
                    },
                    {
                        title: 'Input Document',
                        content: Utils.setMarkdownBlock(new Step0010_FeatureListSummaryToFeatureListDetail().formed, 'markdown'),
                    },
                    {
                        title: 'Output Format',
                        content: Utils.trimLines(`
                            概要、UI/UX要件、バックエンド要件、ビジネスルールについて、具体的かつ詳細に記述してください。
                            機能名をタイトルとするMarkdown形式で記述してください。
                        `),
                    },
                    // {
                    //     title: 'Sample Output',
                    //     content: Utils.trimLines(`
                    //         書き方については以下のサンプル出力を参考にしてください。
                    //         \`\`\`markdown
                    //         # 待ちリスト管理機能

                    //         ## 正常系の要件

                    //         ### 待ちリストへの登録
                    //         1. 患者が予約したい日時が満席の場合、待ちリストに登録するオプションを提供する。
                    //         2. 待ちリストに登録する際、患者は連絡先情報（電話番号とメールアドレス）を提供する必要がある。
                    //         3. 登録が完了すると、患者に待ちリスト登録確認の通知を送信する。

                    //         ### 空き情報の通知
                    //         1. キャンセルが発生した場合、システムは待ちリストの先頭にいる患者に自動で通知する。
                    //         2. 通知はメールとSMSの両方で送信し、予約可能な日時と予約方法を案内する。
                    //         3. 通知を受けた患者は指定された時間内（例：2時間以内）に予約を行う必要がある。

                    //         ### 予約の確定
                    //         1. 待ちリストからの予約が成立した場合、その患者は待ちリストから削除される。
                    //         2. 予約確定後、患者に予約確定通知を送信する。
                    //         3. 待ちリストに残っている患者は、順番が繰り上がる。

                    //         ## 異常系の要件

                    //         ### 通知の失敗
                    //         1. 通知送信時にエラーが発生した場合（例：メールアドレスが無効、SMS送信エラー）、システムは再試行を行う。
                    //         2. 一定回数（例：3回）再試行しても失敗する場合、その患者は待ちリストから除外し、次の患者に通知を試みる。

                    //         ### 予約未確定
                    //         1. 通知を受けた患者が指定された時間内に予約を行わなかった場合、その患者は待ちリストから除外される。
                    //         2. 次の患者に自動で通知が行われる。

                    //         ### 待ちリストのキャンセル
                    //         1. 患者は待ちリストから自分を削除することができる。
                    //         2. 削除操作を行うと、患者に待ちリスト削除確認の通知を送信する。

                    //         ### 待ちリストの上限
                    //         1. 待ちリストには上限を設ける（例：20人まで）。
                    //         2. 上限に達した場合、新たな患者は待ちリストに登録できないことを通知する。

                    //         ### データ整合性
                    //         1. システムは待ちリストのデータ整合性を維持するため、定期的に検証を行う。
                    //         2. 不整合が発見された場合は、手動での確認と修正を行う。

                    //         ### プライバシー保護
                    //         1. 待ちリストに登録された患者の個人情報は、プライバシー保護のために適切に管理する。
                    //         2. 通知以外の目的で患者の連絡先情報を使用しない。

                    //         ## その他の考慮事項

                    //         ### 時間帯の考慮
                    //         1. 通知は患者が受け取りやすい時間帯に送信するようにスケジュールする（例：夜間の通知を避ける）。

                    //         ### 待ちリストの優先順位
                    //         1. 特定の条件（例：緊急性が高い患者）に基づいて、待ちリスト内での優先順位を設定することができる。

                    //         ### 通知のカスタマイズ
                    //         1. 患者は通知の受け取り方法（メールのみ、SMSのみ、両方）を選択できるようにする。
                    //         \`\`\`
                    //     `),
                    // },
                ];
            }
        }

        // 前のステップの結果を読み込む（ステップを new して .formed でそのステップの結果にアクセスできる）
        const _tmp = JSON.parse(new Step0020_FeatureListDetailToJsonFormat().formed);
        this.featureList = _tmp.featureList;
        // childStepListを組み立て。
        this.childStepList = this.featureList.map(targetName => new Step0030_DesignSummaryChil(targetName));
    }

    postProcess(result: string[]): string[] {
        // 全部まとめてファイルに出力する。
        // const reportList = result.map((targetName: string, index: number) => `# ${this.featureList[index]}\n\n${targetName}`);
        const reportList = result.map((targetName: string, index: number) => `${targetName}`);
        const outputFileName = `results/${this.agentName}/${PROJECT_NAME}/summary/${this.constructor.name}_${Utils.formatDate(new Date(), 'yyyyMMddHHmmssSSS')}-report_all.md`;
        fss.writeFileSync(outputFileName, reportList.join('\n---\n'));
        return result;
    }
}

class Step0031_DesignSummaryReview extends BaseStepDomainModelGenerator {
    // model: GPTModels = 'gpt-3.5-turbo';
    format: StepOutputFormat = StepOutputFormat.JSON;
    constructor() {
        super();

        this.chapters = [{
            title: `Instructions`,
            content: Utils.trimLines(`
                以下の設計書について、設計書間での整合性が取れているかを確認してください。

                - 機能の重複が無いか。
                - 足りていない機能が無いか。

                上記のポイントについて確認した結果、修正すべき設計書と修正内容をリストアップしてください。
                全体の整合性が取れている場合はinstructionsとして空の配列を返してください。
            `),
        }, {
            title: '設計書',
            content: Utils.setMarkdownBlock(new Step0030_DesignSummary().childStepList.map((step: BaseStep) => step.formed).join('\n\n---\n\n'), 'markdown'),
        }, {
            title: 'Output Format',
            content: Utils.trimLines(`
                出力フォーマットは以下の通りです。

                \`\`\`json
                {"instructions":[{"title":"設計書名","content":["修正内容",]},{"title":"設計書名","content":["修正内容",]}]}
                \`\`\`
            `),
        }];
    }
}

class Step0033_DesignSummaryRefine extends BaseMultiStepDomainModelGenerator {
    instructions!: { title: string, content: string[] }[];
    constructor() {
        super();
        class Step0033_DesignSummaryRefineChil extends BaseStepDomainModelGenerator {
            // model: GPTModels = 'gpt-3.5-turbo';
            constructor(public instruction: { title: string, content: string[], beforeContent: string }) {
                super();

                // 複数並列処理するので、被らないようにラベルを設定する。（これがログファイル名になる）
                this.label = `${this.constructor.name}_${Utils.safeFileName(instruction.title)}`; // Utils.safeFileNameはファイル名として使える文字だけにするメソッド。
                // 個別の指示を作成。
                this.chapters = [
                    {
                        title: `Instructions`,
                        content: Utils.trimLines(`
                            以下のレビュー指摘に基づいて与えられた設計書を修正してください。

                            ${instruction.content.map(target => ('- ' + target)).join('\n')}
                        `),
                    }, {
                        title: 'Input Document',
                        content: Utils.setMarkdownBlock(instruction.beforeContent, 'markdown'),
                    },
                ];
            }
        }

        // 前のステップの結果を読み込む（ステップを new して .formed でそのステップの結果にアクセスできる）
        const _tmp = JSON.parse(new Step0031_DesignSummaryReview().formed);
        this.instructions = _tmp.instructions;
        // childStepListを組み立て。
        this.childStepList = new Step0030_DesignSummary().childStepList.map((step: BaseStep) => {
            const name = (step as any).feature;
            const target = this.instructions.find(target => target.title === name || `${target.title}機能` === name || target.title === `${name}機能` || `${target.title}機能の詳細化` === name || target.title === `${name}機能の詳細化`);
            return { ...target, beforeContent: step.formed };
        }).filter(target => target.title && target.content).map(target => new Step0033_DesignSummaryRefineChil(target as any));
    }

    postProcess(result: string[]): string[] {
        // 全部まとめてファイルに出力する。
        // const reportList = result.map((targetName: string, index: number) => `# ${this.featureList[index]}\n\n${targetName}`);
        const reportList = result.map((targetName: string, index: number) => `${targetName}`);
        const outputFileName = `results/${this.agentName}/${PROJECT_NAME}/summary/${this.constructor.name}_${Utils.formatDate(new Date(), 'yyyyMMddHHmmssSSS')}-report_all.md`;
        fss.writeFileSync(outputFileName, reportList.join('\n---\n'));
        return result;
    }
}

class Step0034_DesignSummaryRefineReview extends BaseStepDomainModelGenerator {
    // model: GPTModels = 'gpt-3.5-turbo';
    format: StepOutputFormat = StepOutputFormat.JSON;
    constructor() {
        super();

        this.chapters = [{
            title: `Instructions`,
            content: Utils.trimLines(`
                以下の設計書について、設計書間での整合性が取れているかを確認してください。

                - 機能の重複が無いか。⇒機能の重複がある場合は、どちらかを削除するべきか決めてください。
                - 足りていない機能が無いか。⇒一方の設計書で必要とされている機能が他方の設計書に無い場合は、どちらかに追加するべきか決めてください。

                上記のポイントについて確認した結果、修正すべき設計書と修正内容をリストアップしてください。
                全体の整合性が取れている場合はinstructionsとして空の配列を返してください。
            `),
        }, {
            title: '設計書',
            content: Utils.setMarkdownBlock(new Step0033_DesignSummaryRefine().childStepList.map((step: BaseStep) => step.formed).join('\n\n---\n\n'), 'markdown'),
        }, {
            title: 'Output Format',
            content: Utils.trimLines(`
                出力フォーマットは以下の通りです。

                \`\`\`json
                {"instructions":[{"title":"設計書名","content":["修正内容",]},{"title":"設計書名","content":["修正内容",]}]}
                \`\`\`
            `),
        }];
    }
}


class Step0040_EntityList extends BaseStepDomainModelGenerator {
    constructor() {
        super();
        this.chapters = [{
            title: `Instructions`,
            content: Utils.trimLines(`
                これから提示する設計書をよく読んで、ドメイン駆動設計の要領でEntityを抽出してください。
                Enumは対象外です。
                出力形式は「Entity抽出のサンプル」を参考にしてください。
                Entityの名前はPasCalCaseで記述してください。(OJTのように、大文字が連続する名前は禁止です。Ojtと書いてください。)
            `),
            children: [{
                title: `評価ポイント`,
                content: Utils.trimLines(`
                    評価ポイントは以下の三点です。
                    - エンティティの明確さと適切性の評価：エンティティの明確さと適切性を評価します。DDDでは、エンティティはビジネスドメインの核となる概念であり、その特性や関連を明確に表現する必要があります。
                    - 結合度と凝集度の評価：エンティティ間の結合度と凝集度を評価します。理想的には、エンティティ間の結合は低く、凝集度は高いほうが望ましいです。過度な結合は、エンティティの再利用性を低下させ、凝集度の低いエンティティは、ビジネスドメインの概念を適切に表現できない可能性があります。
                    - 柔軟性と拡張性の評価：エンティティが将来の変更や拡張にどの程度対応できるかを評価します。
                `),
            }, {
                title: `Entitiy抽出のサンプル`,
                content: Utils.setMarkdownBlock(Utils.trimLines(`
                    ### 注文管理関連のエンティティ:
                    1. **Order** - 顧客の注文情報を含むエンティティ。注文ID、注文日、顧客の詳細、注文された商品のリスト、合計金額、支払い状態などの属性を持つ。
                    2. **Product** - 注文で購入される商品を表すエンティティ。商品ID、商品名、価格、在庫状況などの属性を持つ。
                    3. **Customer** - 注文を行う顧客を表すエンティティ。顧客ID、名前、連絡先情報、配送先住所、注文履歴などの属性を持つ。
                    4. **Payment** - 注文の支払い情報を表すエンティティ。支払いID、注文ID、支払い方法、支払い状況、支払い日時などの属性を持つ。
                    5. **Shipping** - 注文の配送情報を表すエンティティ。配送ID、注文ID、配送先住所、配送状況、予定配送日などの属性を持つ。

                    ### 従業員管理関連のエンティティ:
                    1. **Employee** - 従業員の個人情報と職務情報を含むエンティティ。従業員ID、名前、住所、電話番号、メールアドレス、部署、役職、入社日などの属性を持つ。
                    2. **Department** - 従業員が所属する部署を表すエンティティ。部署ID、部署名、部署の責任者、部署の機能・目的などの属性を持つ。
                    3. **Project** - 従業員が関与するプロジェクトを表すエンティティ。プロジェクトID、プロジェクト名、開始日、終了日、プロジェクトの目的、参加している従業員のリストなどの属性を持つ。
                    4. **Attendance** - 従業員の出勤状況を記録するエンティティ。出勤記録ID、従業員ID、出勤日、出勤時間、退勤時間、勤務時間などの属性を持つ。
                    5. **PerformanceReview** - 従業員の業績評価を表すエンティティ。評価ID、従業員ID、評価期間、評価者、評価結果、フィードバックコメントなどの属性を持つ。
                `), 'markdown'),
            },],
        }, {
            title: '設計書',
            content: Utils.setMarkdownBlock(new Step0030_DesignSummary().childStepList.map((step: BaseStep) => step.formed).join('\n\n---\n\n'), 'markdown'),
        },];
    }
}

class Step0050_EntityAttributes extends BaseStepDomainModelGenerator {
    constructor() {
        super();
        this.chapters = [{
            title: `Instructions`,
            // AttributesはOpenAPIのschemaとして記載してください。
            content: Utils.trimLines(`
                これから提示する設計書をよく読んで、Entity一覧の各EntityのAttributesを抽出してください。
                javaのコードを書くようなイメージで、Attributesを抽出してください。
                追加の補助クラス、enumについても省略せずに記載してください。
                Attributesの名前はCamelCaseで記述してください。(OJTのように、大文字が連続する名前は禁止です。ojtと書いてください。)
            `),
            children: [
            ],
        }, {
            title: '設計書',
            children: [{
                title: `機能一覧`,
                content: Utils.setMarkdownBlock(new Step0030_DesignSummary().childStepList.map((step: BaseStep) => step.formed).join('\n\n---\n\n'), 'markdown'),
            }, {
                title: `Entity一覧`,
                content: Utils.setMarkdownBlock(new Step0040_EntityList().formed, 'markdown'),
            }],
        },];
    }
}
class Step0053_EntityAttributesJpaJson extends BaseStepDomainModelGenerator {
    format: StepOutputFormat = StepOutputFormat.JSON;
    constructor() {
        super();
        this.chapters = [{
            title: `Instructions`,
            content: Utils.trimLines(`
                これから提示する設計書をよく読んで、Entityに対してJPAで使えるようにアノテーションを考えてください。
            `),
            children: [
            ],
        }, {
            title: '設計書',
            children: [{
                title: `機能一覧`,
                content: Utils.setMarkdownBlock(new Step0030_DesignSummary().childStepList.map((step: BaseStep) => step.formed).join('\n\n---\n\n'), 'markdown'),
            }, {
                title: `Entity`,
                content: Utils.setMarkdownBlock(new Step0050_EntityAttributes().formed, 'markdown'),
            }],
        }, {
            title: 'Output Format',
            content: Utils.trimLines(`
                以下のJSONフォーマットで整理してください。
                アノテーションは必要に応じて追加してもよいです。
                \`\`\`json
                {
                    "classAnnotations": {
                        "@Entity": ["EntityClassName", "EntityClassName2",],
                        "@Table": ["TableClassName", "TableClassName2",],
                        "@Embeddable": ["EmbeddableClassName", "EmbeddableClassName2",],
                        "@MappedSuperclass": ["MappedSuperclassName", "MappedSuperclassName2",],
                    },
                    "fieldAnnotations": {
                        "@Id": { "ClassName": ["IdFieldName"], "ClassName2": ["IdFieldName"], },
                        "@GeneratedValue(strategy = GenerationType.IDENTITY)": { "ClassName": ["IdFieldName"], "ClassName2": ["IdFieldName"], },
                        "@EmbeddedId": { "ClassName": ["IdFieldName", "IdFieldName2"], "ClassName2": ["IdFieldName", "IdFieldName2"], },
                        "@Embedded": { "ClassName": ["FieldName", "FieldName2",], "ClassName2": ["FieldName", "FieldName2",], },
                        "@Column(nullable = false)": { "ClassName": ["FieldName", "FieldName2",], "ClassName2": ["FieldName", "FieldName2",], },
                        "@Enumerated(EnumType.STRING)": { "ClassName": ["FieldName", "FieldName2",], "ClassName2": ["FieldName", "FieldName2",], },
                        "@ManyToOne": { "ClassName": ["FieldName", "FieldName2",], "ClassName2": ["FieldName", "FieldName2",], },
                        "@OneToMany": { "ClassName": ["FieldName", "FieldName2",], "ClassName2": ["FieldName", "FieldName2",], },
                        "@OneToOne(ownside)": { "ClassName": ["FieldName", "FieldName2",], "ClassName2": ["FieldName", "FieldName2",], },
                        "@OneToOne(non-ownside)": { "ClassName": ["FieldName", "FieldName2",], "ClassName2": ["FieldName", "FieldName2",], },
                        "@JoinColumn": { "ClassName": ["FieldName", "FieldName2",], "ClassName2": ["FieldName", "FieldName2",], },
                    },
                }
                \`\`\`
            `),
        }];
    }
    postProcess(result: string): string {
        // アノテーションを整理する。
        const annos = Utils.jsonParse(result) as { classAnnotations: { [key: string]: string[] }, fieldAnnotations: { [key: string]: { [key: string]: string[] } } };
        // クラスアノテーションをクラスキーで整理する。
        const classAnnotations = Object.entries(annos.classAnnotations).reduce((acc, [anno, classNames]) => {
            classNames.forEach(className => {
                acc[className] = acc[className] || [];
                acc[className].push(anno);
            });
            return acc;
        }, {} as { [key: string]: string[] });
        // フィールドアノテーションをクラスキーとフィールドキーで整理する。
        const fieldAnnotations = Object.entries(annos.fieldAnnotations).reduce((acc, [anno, classFieldNames]) => {
            Object.entries(classFieldNames).forEach(([className, fieldNames]) => {
                fieldNames.forEach(fieldName => {
                    acc[className] = acc[className] || {};
                    acc[className][fieldName] = acc[className][fieldName] || [];

                    // 項目名の微調整
                    if (anno === '@JoinColumn') {
                        // @JoinColumnは_idがついてしまっているので、_idを削除したフィールド名と同期させておく
                        acc[className][Utils.toCamelCase(fieldName.replace(/_[Ii][Dd]$/, ''))] = acc[className][fieldName];
                    } else if (anno === '@OneToMany') {
                        // @OneToMayは項目名が複数形になってしまうので単数形に変換したオブジェクトと同期させておく
                        acc[className][Utils.singularize(fieldName)] = acc[className][fieldName];
                    } else { }

                    // JOIN系のアノテーションは結合条件を記述する必要があるので、ここで結合条件を記述する。
                    if (anno === '@ManyToOne') {
                        // @ManyToOne
                        // @JoinColumn(name = "customer_id", referencedColumnName = "id")
                        // private Customer customer;
                        acc[className][fieldName].push(anno);
                    } else if (anno === '@OneToMany') {
                        // @OneToMany(mappedBy = "customer", cascade = CascadeType.ALL)
                        // private List<TransactionHistory> transactionHistories;
                        acc[className][fieldName].push(`${anno}(mappedBy = "${Utils.toCamelCase(className)}", cascade = CascadeType.ALL)`);
                    } else if (anno === '@OneToOne(ownside)') {
                        // @OneToOne(mappedBy = "customer", cascade = CascadeType.ALL)
                        // private CreditReport creditReport;
                        acc[className][fieldName].push(`${anno}(mappedBy = "${Utils.toCamelCase(className)}", cascade = CascadeType.ALL)`);
                    } else if (anno === '@OneToOne(non-ownside)') {
                        // @OneToOne
                        // @JoinColumn(name = "customer_id", referencedColumnName = "id")
                        // private Customer customer;
                        acc[className][fieldName].push(`@OneToOne`);
                    } else if (anno === '@JoinColumn') {
                        acc[className][fieldName].push(`@JoinColumn(name = "${Utils.toSnakeCase(fieldName)}", referencedColumnName = "id")`);
                    } else {
                        acc[className][fieldName].push(anno);
                    }
                });
            });
            return acc;
        }, {} as { [key: string]: { [key: string]: string[] } });

        const models = parseJavaCode(Utils.mdTrim(new Step0050_EntityAttributes().formed), PACKAGE_NAME);
        Object.entries(models.classes).forEach(([className, obj]) => {
            const fields = obj.props.map(field => {
                const _fieldAnnoMap = fieldAnnotations[className] || fieldAnnotations[`${className}Entity`] || [];
                const _fieldAnnoList = _fieldAnnoMap[field.name] || _fieldAnnoMap[field.name.replace(/I[Dd]$/, '')] || _fieldAnnoMap[field.name.replace(/_[Ii][Dd]$/, '')] || [];
                const annotations = _fieldAnnoList.map(anno => `\t${anno}\n`).join('');
                return `${annotations}\tprivate ${field.type} ${field.name};\n`;
            }).join('\n');

            // Entityの場合は@Tableアノテーションを付与する。
            if ((classAnnotations[className] || []).find(anno => anno === '@Entity')) {
                // 複数形のスネークケースにする
                const pluralized = Utils.toSnakeCase(className).split('_').map((word, index, ary) => index === ary.length - 1 ? Utils.pluralize(word) : word).join('_');
                classAnnotations[className].push(`@Table(name = "${pluralized}")`);
            } else { }

            obj.source = Utils.trimLines(`
                package ${PACKAGE_NAME}.domain.entity;

                import lombok.Data;
                import jakarta.persistence.*;
                import java.math.BigDecimal;
                import java.math.BigInteger;
                import java.time.LocalDate;
                import java.time.LocalDateTime;
                import java.time.LocalTime;
                import java.time.Period;
                import java.util.List;
                import java.util.Map;
                import ${PACKAGE_NAME}.domain.enums.*;

                ${classAnnotations[className] ? classAnnotations[className].join('\n') : ''}
                @Data
                public class ${className} {
                
                ${fields}
                }
            `);
            fss.writeFileSync(`results/${this.agentName}/${PROJECT_NAME}/${PACKAGE_DIRE}/domain/entity/${className}.java`, obj.source);
        });
        Object.entries(models.enums).forEach(([className, obj]) => {
            obj.source = Utils.trimLines(`
                package ${PACKAGE_NAME}.domain.enums;

                public enum ${className} {
                    ${obj.values.join(', ')}
                }
            `);
            fss.writeFileSync(`results/${this.agentName}/${PROJECT_NAME}/${PACKAGE_DIRE}/domain/enums/${className}.java`, obj.source);
        });

        // // クラスごとに分割して出力する。

        const entitySource = Object.entries(models.classes).map(([className, obj]) => Utils.setMarkdownBlock(obj.source, `java ${PACKAGE_NAME}.domain.entity.${className}`)).join('\n\n');
        const enumsSource = Object.entries(models.enums).map(([className, obj]) => Utils.setMarkdownBlock(obj.source, `java ${PACKAGE_NAME}.domain.enums.${className}`)).join('\n\n');
        fss.writeFileSync(`results/${this.agentName}/${PROJECT_NAME}/entities.md`, entitySource + '\n\n---\n\n' + enumsSource);
        return result;
    }
}
class Step0055_EntityAttributesToOpenAPI extends BaseStepDomainModelGenerator {
    constructor() {
        super();
        this.chapters = [{
            title: `Instructions`,
            content: Utils.trimLines(`
                以下のjavaコードをOpenAPIのschema形式で書いて下さい。
                出力形式は変換サンプルを参考にしてください。
                requiredは省略してください。
            `),
            children: [
            ],
        }, {
            title: '変換対象のjavaコード',
            content: Utils.setMarkdownBlock(Utils.mdTrim(new Step0050_EntityAttributes().formed), 'java'),
        }, {
            title: '変換サンプル',
            children: [{
                title: `変換前javaコード`,
                content: Utils.setMarkdownBlock(Utils.trimLines(`
                    // 予約関連のエンティティ
                    class Appointment {
                        Long appointmentId;
                        Patient patient;
                        LocalDateTime appointmentDateTime;
                        Department department;
                        Doctor doctor;
                        AppointmentStatus status;
                    }
                    enum AppointmentStatus {
                        CONFIRMED, WAITING_LIST, CANCELLED
                    }
                `), 'java'),
            }, {
                title: `変換後OpenAPIスキーマ`,
                content: Utils.setMarkdownBlock(Utils.trimLines(`
                    components:
                        schemas:
                            Appointment:
                                type: object
                                properties:
                                appointmentId:
                                    type: integer
                                    format: int64
                                patient:
                                    $ref: '#/components/schemas/Patient'
                                appointmentDateTime:
                                    type: string
                                    format: date-time
                                department:
                                    $ref: '#/components/schemas/Department'
                                doctor:
                                    $ref: '#/components/schemas/Doctor'
                                status:
                                    $ref: '#/components/schemas/AppointmentStatus'
                        
                            AppointmentStatus:
                                type: string
                                enum:
                                    - CONFIRMED
                                    - WAITING_LIST
                                    - CANCELLED
                `), 'yaml'),
            }],
        },];
    }
}

class Step0060_ViewList extends BaseStepDomainModelGenerator {
    // model: GPTModels = 'gpt-3.5-turbo';
    format: StepOutputFormat = StepOutputFormat.JSON;
    constructor() {
        super();
        this.chapters = [{
            title: `Instructions`,
            content: Utils.trimLines(`
                これから提示する設計書をよく読んで、要件を満たすように画面一覧を作成してください。
            `),
            children: [],
        }, {
            title: '設計書',
            children: [{
                title: `機能一覧`,
                content: Utils.setMarkdownBlock(new Step0030_DesignSummary().childStepList.map((step: BaseStep) => step.formed).join('\n\n---\n\n'), 'markdown'),
            }, {
                title: `Entity一覧`,
                content: Utils.setMarkdownBlock(Utils.mdTrim(new Step0050_EntityAttributes().formed), 'java'),
            }],
        }, {
            title: 'Output Format',
            content: Utils.trimLines(`
                出力フォーマットは以下の通りです。
                \`\`\`json
                {"viewList":[{"name": "View name(as varName)","destinationList":["destination view name","destination view name"],"relatedFeatureList":["機能一覧の設計書のタイトル","機能一覧の設計書のタイトル"]}]}
                \`\`\`
            `),
            //　"partsList":["parts(as varName)","parts(as varName)"],
        },];
    }
}

class Step0070_ViewDocuments extends BaseMultiStepDomainModelGenerator {
    viewList!: { name: string, destinationList: string[], relatedFeatureList: string[] }[];
    constructor() {
        super();
        class Step0070_ViewDocumentsChil extends BaseStepDomainModelGenerator {
            // model: GPTModels = 'gpt-3.5-turbo';
            constructor(public feature: { name: string, destinationList: string[], relatedFeatureList: string[] }) {
                super();
                // {"viewList":[{"name": "View name","destinationList":["parts","parts"],"relatedFeatureList":["featureName","featureName"]}]}

                // 複数並列処理するので、被らないようにラベルを設定する。（これがログファイル名になる）
                this.label = `${this.constructor.name}_${Utils.safeFileName(feature.name)}`; // Utils.safeFileNameはファイル名として使える文字だけにするメソッド。
                // 個別の指示を作成。
                this.chapters = [
                    {
                        title: `Instructions`,
                        content: Utils.trimLines(`
                            これから提示する設計書をよく読んで、画面の詳細設計書を作成してください。
                            あなたの担当は「${feature.name}」です。担当外のものはやらなくてよいです。
                        `),
                    }, {
                        title: '設計書',
                        children: [{
                            title: `機能設計書`,
                            content: Utils.setMarkdownBlock(feature.relatedFeatureList.join('\n\n---\n\n'), 'markdown'),
                            children: [{
                                title: `画面遷移先`,
                                content: feature.destinationList.map((destination: string) => `* ${destination}`).join('\n'),
                            },],
                        }, {
                            title: `Entity`,
                            content: Utils.setMarkdownBlock(Utils.mdTrim(new Step0050_EntityAttributes().formed), 'java'),
                        }],
                    }, {
                        title: 'Output Sample',
                        content: `以下のサンプル設計書の書き方に倣ってください。\n\n` +
                            Utils.setMarkdownBlock(Utils.trimLines(`
                            # 画面詳細設計書: PasswordResetView

                            ## 1. 画面概要

                            - 画面名: パスワードリセット
                            - 画面ID: PasswordResetView
                            - 画面タイプ: フォーム
                            - 説明: ユーザーがパスワードを忘れた場合に新しいパスワードを設定するための画面。

                            ## 2. UIコンポーネント

                            - メールアドレス入力フィールド
                            - 属性: 必須
                            - バリデーション: 有効なメールアドレス形式
                            - パスワードリセットリンクを送信ボタン
                            - アクション: メールアドレス入力フィールドのバリデーションを実行し、問題がなければパスワードリセットリンクをメールで送信する。

                            ## 3. バリデーションルール

                            - メールアドレス
                            - 必須入力
                            - メールアドレス形式（例: user@example.com）

                            ## 4. 画面遷移

                            - パスワードリセットリンクを送信ボタンをクリック後、以下のいずれかのアクションが発生する。
                            - 成功: ユーザーに「パスワードリセットリンクをメールアドレスに送信しました。」というメッセージを表示し、LoginViewに遷移する。
                            - 失敗（メールアドレスが登録されていない場合）: ユーザーに「登録されていないメールアドレスです。」というエラーメッセージを表示する。

                            ## 5. エラーメッセージ

                            - メールアドレスが未入力の場合: 「メールアドレスを入力してください。」
                            - メールアドレスが無効な形式の場合: 「有効なメールアドレスを入力してください。」
                            - メールアドレスが登録されていない場合: 「登録されていないメールアドレスです。」

                            ## 6. ビジネスロジック

                            - パスワードリセットリンクを送信する前に、入力されたメールアドレスがシステムに登録されているかを確認する。
                            - メールアドレスが登録されている場合、PasswordResetTokenエンティティを生成し、有効期限を設定する。
                            - 生成されたトークンを含むパスワードリセットリンクをメールアドレスに送信する。

                            ## 7. API

                            - パスワードリセットリンクを送信するAPI

                            ## 8. 備考

                            - パスワードリセットリンクをクリックした後のパスワード変更画面の設計は、この設計書の範囲外である。
                        `)),
                    }
                ];
            }
        }
        this.viewList = JSON.parse(new Step0060_ViewList().formed).viewList;
        const mas = new Step0030_DesignSummary().childStepList.reduce((acc: { [key: string]: string }, step: BaseStep) => {
            const feature = (step as any).feature;
            acc[feature] = step.formed;
            // "機能"の有無で取りこぼしを防ぐ。
            acc[feature.replace(/機能$/g, '')] = step.formed;
            acc[feature + '機能'] = step.formed;
            acc[feature.replace(/機能の詳細化$/g, '')] = step.formed;
            acc[feature + '機能の詳細化'] = step.formed;
            acc[feature.replace(/の詳細化$/g, '')] = step.formed;
            acc[feature + 'の詳細化'] = step.formed;
            return acc;
        }, {} as { [key: string]: string });
        // console.log(Object.keys(mas));
        this.viewList.forEach((feature: { name: string, destinationList: string[], relatedFeatureList: string[] }) => {
            for (let index = 0; index < feature.relatedFeatureList.length; index++) {
                // console.log(feature.relatedFeatureList[index]);
                feature.relatedFeatureList[index] = mas[feature.relatedFeatureList[index] || feature.name];
            }
        });
        this.childStepList = this.viewList.map(targetName => new Step0070_ViewDocumentsChil(targetName));
    }

    postProcess(result: string[]): string[] {
        // 全部まとめてファイルに出力する。
        // const reportList = result.map((targetName: string, index: number) => `# ${this.featureList[index]}\n\n${targetName}`);
        const reportList = result.map((targetName: string, index: number) => `${targetName}`);
        const outputFileName = `results/${this.agentName}/${PROJECT_NAME}/summary/${this.constructor.name}_${Utils.formatDate(new Date(), 'yyyyMMddHHmmssSSS')}-report_all.md`;
        fss.writeFileSync(outputFileName, reportList.join('\n---\n'));
        return result;
    }
}

class Step0080_ServiceList extends BaseStepDomainModelGenerator {
    // format: StepOutputFormat = StepOutputFormat.JSON;
    constructor() {
        super();
        const apiList = new Step0070_ViewDocuments().childStepList.map(step => {
            const match = step.formed.match(/## 7\. API([\s\S]*?)(?=## \d)/);
            if (match) {
                // console.log(step.formed);
                const shifted = match[1].trim().split('\n').map(line => `  ${line}`).join('\n');
                return `- ${(step as any).feature.name}\n${shifted}`;
            } else {
                return '';
            }
        }).join('\n');
        this.chapters = [
            {
                title: `Instructions`,
                content: Utils.trimLines(`
                    これから提示する設計書をよく理解して、サービス一覧を作成してください。
                    まず全量を把握して、サービスごとにグルーピングして考えてください。
                    サービスは、バックエンド側のビジネスルールを実装するものです。
                `),
            }, {
                title: '設計書',
                children: [{
                    title: `画面⇒API呼び出し一覧`,
                    content: Utils.setMarkdownBlock(apiList, 'markdown'),
                }, {
                    title: `Entity`,
                    content: Utils.setMarkdownBlock(Utils.mdTrim(new Step0050_EntityAttributes().formed), 'java'),
                }, {
                    title: `機能設計書`,
                    content: Utils.setMarkdownBlock(new Step0030_DesignSummary().childStepList.map((step: BaseStep) => step.formed).join('\n\n---\n\n'), 'markdown'),
                }],
            }, {
                title: 'Output Format',
                content: `表形式でサービス名（英語名）、名前、利用元画面IDリストを出力してください。`,
            }
        ];
    }
}

class Step0090_ServiceMethodList extends BaseStepDomainModelGenerator {
    // format: StepOutputFormat = StepOutputFormat.JSON;
    constructor() {
        super();
        const apiList = new Step0070_ViewDocuments().childStepList.map(step => {
            const match = step.formed.match(/## 7\. API([\s\S]*?)(?=## \d)/);
            if (match) {
                // console.log(step.formed);
                const shifted = match[1].trim().split('\n').map(line => `  ${line}`).join('\n');
                return `- ${(step as any).feature.name}\n${shifted}`;
            } else {
                return '';
            }
        }).join('\n');
        this.chapters = [
            {
                title: `Instructions`,
                content: Utils.trimLines(`
                    これから提示する設計書をよく理解して、サービスメソッド一覧を作成してください。
                `),
            }, {
                title: '設計書',
                children: [{
                    title: `画面⇒API呼び出し一覧`,
                    content: Utils.setMarkdownBlock(apiList, 'markdown'),
                }, {
                    title: `サービス一覧`,
                    content: Utils.setMarkdownBlock(Utils.mdTrim(new Step0080_ServiceList().formed), 'markdown'),
                }, {
                    title: `Entity`,
                    content: Utils.setMarkdownBlock(Utils.mdTrim(new Step0050_EntityAttributes().formed), 'java'),
                }, {
                    title: `機能設計書`,
                    content: Utils.setMarkdownBlock(new Step0030_DesignSummary().childStepList.map((step: BaseStep) => step.formed).join('\n\n---\n\n'), 'markdown'),
                }],
            }, {
                title: 'Output Format',
                // content: `表形式でサービス名(英語名)、ID（英語名）、名前、メソッド、エンドポイント、requestの形式、responseの形式、利用元画面IDリストを出力してください。`,
                content: `表形式でサービス名(英語名)、メソッド名（英語名）、利用元画面ID(複数可)、依存先Entity（複数可）、依存先サービス名（複数可）、関係する機能設計書名(複数可)を出力してください。`,
            }
        ];
    }
}

class Step0092_ServiceMethodListReqRes extends BaseStepDomainModelGenerator {
    // format: StepOutputFormat = StepOutputFormat.JSON;
    constructor() {
        super();
        const beforeStep = new Step0090_ServiceMethodList();
        this.presetMessage.push({ role: 'user', content: beforeStep.prompt });
        this.presetMessage.push({ role: 'assistant', content: beforeStep.result });

        this.chapters = [
            {
                title: `Instructions`,
                content: Utils.trimLines(`
                    先程のサービスメソッド一覧について、エンドポイントとrequestとresponseの形式を考えてください。
                    型はjavaの記法で書いてください。
                `),
            }, {
                title: 'Output Format',
                // content: `表形式でサービス名(英語名)、ID（英語名）、名前、メソッド、エンドポイント利用元画面IDリストを出力してください。`,
                content: `表形式でサービス名(英語名)、メソッド名（英語名）、日本語名、メソッド、エンドポイント、requestの形式、responseの形式を出力してください。`,
            }
        ];
    }

    /**
     * サービス一覧は大きいのに対応できるように列を分けて二段階で作っているので、ここでマージ処理を行う。
     * @param result 
     * @returns 
     */
    postProcess(result: string): string {
        const mergedAPIList = [];

        // 前回ステップで作成したものをmarkdownテーブルから読み込む。
        const serviceData = Utils.loadTableDataFromMarkdown(new Step0090_ServiceMethodList().formed).data.reduce((before: { [key: string]: { [key: string]: { usageScreenIdList: string[], entityList: string[], serviceList: string[], documentList: string[] } } }, current: string[]) => {
            const [serviceName, apiName, usageScreenIdListString, entityListString, serviceListString, documentListString] = current;
            if (!before[serviceName]) {
                before[serviceName] = {};
            } else { }
            const usageScreenIdList = usageScreenIdListString.split(',').filter(entity => entity !== '');
            const entityList = entityListString.split(',').filter(entity => entity !== '');
            const serviceList = serviceListString.split(',').filter(entity => entity !== '');
            const documentList = documentListString.split(',').filter(entity => entity !== '');
            before[serviceName][apiName] = { usageScreenIdList, entityList, serviceList, documentList };
            return before;
        }, {}) as { [key: string]: { [key: string]: { name: string, method: string, endpoint: string, request: string, response: string, usageScreenIdList: string[], entityList: string[], serviceList: string[], documentList: string[] } } };

        // 今回のステップで作成したものをmarkdownテーブルから読み込む。
        Utils.loadTableDataFromMarkdown(result).data.forEach(element => {
            const [serviceName, apiName, name, method, endpoint, request, response] = element;
            serviceData[serviceName][apiName] = { ...serviceData[serviceName][apiName], name, method, endpoint, request, response };
        });

        // テーブル形式のデータを作成する。
        const heads = ['serviceName', 'apiName', 'name', 'method', 'endpoint', 'request', 'response', 'usageScreenIdList', 'Dependent Repositories', 'Dependent Services', 'Related Functional Specifications'];
        mergedAPIList.push(heads);
        mergedAPIList.push(heads.map(() => '---'));
        Object.keys(serviceData).forEach(serviceName => {
            Object.keys(serviceData[serviceName]).forEach(apiName => {
                mergedAPIList.push([serviceName, apiName,
                    serviceData[serviceName][apiName].name,
                    serviceData[serviceName][apiName].method,
                    serviceData[serviceName][apiName].endpoint,
                    serviceData[serviceName][apiName].request,
                    serviceData[serviceName][apiName].response,
                    serviceData[serviceName][apiName].usageScreenIdList.join(','),
                    serviceData[serviceName][apiName].entityList.map(entity => `${entity}Repository<${entity}, Long>`).join(','),
                    serviceData[serviceName][apiName].serviceList.join(','),
                    serviceData[serviceName][apiName].documentList.join(',')
                ]);
            });
        });
        const apiDataTable = mergedAPIList.map(row => `| ${row.join(' | ')} |`).join('\n');
        // service用にヘッダーを設定する。
        mergedAPIList[0][1] = 'methodName';
        mergedAPIList[0][5] = 'args';
        mergedAPIList[0][6] = 'return';
        // service用にmethodとendpointを削る。
        const serviceDataTable = mergedAPIList.map(row => `| ${row.slice(0, 3).concat(row.slice(5, 10)).join(' | ')} |`).join('\n');

        // markdownとjsonで出力する。
        fss.writeFileSync(`results/${this.agentName}/${PROJECT_NAME}/ApiList.md`, apiDataTable);
        fss.writeFileSync(`results/${this.agentName}/${PROJECT_NAME}/ServiceList.md`, serviceDataTable);
        fss.writeFileSync(`results/${this.agentName}/${PROJECT_NAME}/ServiceList.json`, JSON.stringify(serviceData, null, 2));
        return result;
    }
}

class Step0095_ApiListJson extends BaseStepDomainModelGenerator {
    format: StepOutputFormat = StepOutputFormat.JSON;
    constructor() {
        super();
        this.chapters = [
            {
                title: `Instructions`,
                content: Utils.trimLines(`
                    与えられた表をJSON形式に変換してください。
                `),
            }, {
                content: Utils.setMarkdownBlock(Utils.mdTrim(new Step0090_ServiceMethodList().formed), 'markdown'),
            }, {
                title: 'Output Format',
                // {"serviceName":{"apiName":{"name":"API名","method":"GET","endpoint":"/api/endpoint","request":"{ request }","response":"{ response }","usageScreenIdList":"画面IDリスト"}}}
                content: Utils.trimLines(`
                    以下のJSON形式で出力してください。
                    {"serviceName":{"apiName":{"name":"API名","method":"GET","endpoint":"/api/endpoint","usageScreenIdList":["画面ID",],"entityList":["Entity名",],"documentList":["機能設計書",]}}}
                `),
            }
        ];
    }
}

/**
 * APIドキュメントを作成する。
 * ※要らないかもしれない。
 */
class Step0100_ApiDocuments extends BaseMultiStepDomainModelGenerator {
    viewList!: { name: string, destinationList: string[], relatedFeatureList: string[] }[];
    constructor() {
        super();
        // const ENTITY_LIST = Utils.setMarkdownBlock(Utils.mdTrim(new Step0053_EntityAttributesJpa().formed), 'java');
        const ENTITY_LIST = fs.readFileSync(`results/${this.agentName}/${PROJECT_NAME}/entities.md`, 'utf-8');
        const entityData = parseJavaCode(Utils.mdTrim(new Step0050_EntityAttributes().formed), PACKAGE_NAME);
        const REPOSITORY_LIST = entityData.entityList.map(entityName => `- ${entityName}Repository<${entityName}, Long>`).join('\n');
        const API_LIST = fs.readFileSync(`results/${this.agentName}/${PROJECT_NAME}/ApiList.md`, 'utf-8');

        // 画面一覧から画面と紐づく機能一覧を取得する。
        this.viewList = JSON.parse(new Step0060_ViewList().formed).viewList;
        const featureMas = new Step0030_DesignSummary().childStepList.reduce((acc: { [key: string]: string }, step: BaseStep) => {
            const feature = (step as any).feature;
            acc[feature] = step.formed;
            // "機能"の有無で取りこぼしを防ぐ。
            acc[feature.replace(/機能$/g, '')] = step.formed;
            acc[feature + '機能'] = step.formed;
            acc[feature.replace(/機能の詳細化$/g, '')] = step.formed;
            acc[feature + '機能の詳細化'] = step.formed;
            acc[feature.replace(/の詳細化$/g, '')] = step.formed;
            acc[feature + 'の詳細化'] = step.formed;
            return acc;
        }, {} as { [key: string]: string });

        class Step0100_ApiDocumentsChil extends BaseStepDomainModelGenerator {
            // model: GPTModels = 'gpt-3.5-turbo';
            constructor(
                public serviceName: string,
                public apiName: string,
                public api: { name: string, method: string, endpoint: string, request: string, response: string, usageScreenIdList: string[] },
                public viewDocList: string[],
                public featureList: string[],
            ) {
                super();
                const apiId = Utils.safeFileName(serviceName + "." + apiName);
                // 複数並列処理するので、被らないようにラベルを設定する。（これがログファイル名になる）
                this.label = `${this.constructor.name}_${Utils.safeFileName(apiId)}`; // Utils.safeFileNameはファイル名として使える文字だけにするメソッド。
                // 個別の指示を作成。
                this.chapters = [
                    {
                        title: `Instructions`,
                        content: Utils.trimLines(`
                            これから提示する設計書をよく読んで、APIの詳細設計書を作成してください。
                            あなたの担当は「${apiId}」です。担当外のものはやらなくてよいです。
                            特に、「バックエンド処理詳細」については以下のルールに則って考えてください。
                            - 可能な限り詳細、かつ正確に記載すること
                            - フローチャートが描けるのに十分な詳細を記載すること
                            - エンティティ、サービスを使う場合は英字名を使うこと
                            - ビジネスロジックの流れを記載すること
                        `),
                    }, {
                        title: '全体設計書',
                        content: `全体設計書はシステム全体について語っています。あなたの担当分が相対的にどのような役割かを理解するのに役立ててください。`,
                        children: [{
                            title: `API一覧`,
                            content: API_LIST,
                        }, {
                            title: `Entity`,
                            content: ENTITY_LIST,
                        }, {
                            title: `Repository`,
                            content: REPOSITORY_LIST,
                        }],
                    }, {
                        title: '個別設計書',
                        content: `個別設計書はあなたの担当に関係する部分です。`,
                        children: [{
                            title: `機能設計書`,
                            content: Utils.setMarkdownBlock(Utils.mdTrim(featureList.join('\n\n---\n\n')), 'markdown'),
                        }, {
                            title: `画面設計書`,
                            content: Utils.setMarkdownBlock(Utils.mdTrim(viewDocList.join('\n\n---\n\n')), 'markdown'),
                        }],
                    }, {
                        title: 'Output Sample',
                        content: `以下のサンプル設計書の書き方に倣ってください。ただし「バックエンド処理詳細」についてはサンプルの書き方よりももっと詳細かつ長大な記載になってもよいです。\n\n` +
                            Utils.trimLines(`
                                ---
                                # 詳細設計書: AppointmentService.getAvailableAppointmentSlots

                                ## 機能概要
                                - 機能名: 予約可能時間帯取得
                                - 機能ID: getAvailableAppointmentSlots
                                - 機能説明: 特定の日付に対して、歯科医院で利用可能な予約時間帯を取得する。

                                ## API仕様

                                ### Endpoint
                                - Method: GET
                                - Path: /api/appointments/slots
                                - Query Parameters:
                                  - date: LocalDate (必須) - 利用者が予約可能時間帯を確認したい日付。

                                ### Request
                                \`\`\`json
                                {
                                  "date": "2023-04-15"
                                }
                                \`\`\`

                                ### Response
                                - Content-Type: application/json
                                - Body:
                                \`\`\`json
                                {
                                  "slots": [
                                    {
                                      "slotId": 12345,
                                      "date": "2023-04-15",
                                      "startTime": "09:00",
                                      "endTime": "09:30",
                                      "doctorId": 67890,
                                      "slotStatus": "AVAILABLE"
                                    },
                                    {
                                      "slotId": 12346,
                                      "date": "2023-04-15",
                                      "startTime": "09:30",
                                      "endTime": "10:00",
                                      "doctorId": 67891,
                                      "slotStatus": "BOOKED"
                                    }
                                    // ... その他の予約可能時間帯
                                  ]
                                }
                                \`\`\`

                                ### Response Fields
                                - slots: List<AppointmentSlot> - 利用可能な予約時間帯のリスト。
                                  - slotId: Long - 時間帯の一意識別子。
                                  - date: LocalDate - 予約可能時間帯の日付。
                                  - startTime: LocalTime - 予約可能時間帯の開始時間。
                                  - endTime: LocalTime - 予約可能時間帯の終了時間。
                                  - doctorId: Long - 予約可能時間帯を提供する医師のID。
                                  - slotStatus: SlotStatus - 時間帯の状態（AVAILABLE: 利用可能, BOOKED: 予約済み）。

                                ### エラーレスポンス
                                - 400 Bad Request: 日付が指定されていない、または不正な形式の場合。
                                - 404 Not Found: 指定された日付に予約可能時間帯が存在しない場合。
                                - 500 Internal Server Error: サーバー側の問題で予約可能時間帯を取得できない場合。

                                ### エラーメッセージ例
                                \`\`\`json
                                {
                                  "message": "Invalid date format. Please use 'YYYY-MM-DD'."
                                }
                                \`\`\`

                                ## バックエンド処理詳細
                                1. リクエストから日付を取得し、バリデーションを行う。
                                2. 指定された日付に対して、予約可能時間帯をデータベースから取得する。
                                3. 各時間帯のステータス（予約済みか利用可能か）を確認し、リストに追加する。
                                4. 予約可能時間帯のリストをレスポンスとして返す。

                                ## ビジネスロジック
                                - 予約可能時間帯は、医院の診療時間内でのみ表示される。
                                - 休診日や医師の休暇など、予約を受け付けない日は、予約可能時間帯として表示されない。
                                - 予約済みの時間帯は、他の患者が予約できないように非活性化する。
                                - 医師ごとの予約可能時間帯は、その医師のスケジュールに基づいて動的に生成される。
                                - 予約可能時間帯の表示は、システムに登録されている全医師に対してデフォルトで行われるが、患者は特定の医師を選択して表示を絞り込むことができる。
                                - 予約可能時間帯のデータは、常に最新の情報を反映するようにシステムが更新を行う。
                            `),
                    }
                ];
            }
        }
        // console.log(serviceData);

        const viewDocMap = new Step0070_ViewDocuments().childStepList.reduce((before: { [key: string]: any }, current: BaseStep) => {
            const featureName = (current as any).feature.name;
            if (!before[featureName]) {
                before[featureName] = [];
            } else { }
            before[featureName] = current.formed;
            return before;
        }, {});

        type MetaServiceData = { [key: string]: { [key: string]: { name: string, method: string, endpoint: string, request: string, response: string, usageScreenIdList: string[], entityList: string[], serviceList: string[], documentList: string[] } } };
        const serviceData = JSON.parse(fs.readFileSync(`results/${this.agentName}/${PROJECT_NAME}/ServiceList.json`, 'utf-8')) as MetaServiceData;

        // console.log(entityData);
        this.childStepList = Object.entries(serviceData).map(([serviceName, apiData]) =>
            Object.entries(apiData).map(([apiName, api]) => {
                // 利用元画面を取得
                const views = this.viewList.filter(view => api.usageScreenIdList.some(usageScreenId => view.name === usageScreenId));
                // 利用元画面から機能設計書を取得。重複削除もする。
                const features = Array.from(new Set(views.map(view => view.relatedFeatureList).flat())).map(featureName => featureMas[featureName]);
                const viewDocs = views.map(view => viewDocMap[view.name]);
                return new Step0100_ApiDocumentsChil(serviceName, apiName, api, viewDocs, features);
            })
        ).flat();
    }

    postProcess(result: string[]): string[] {
        // 使いやすいようにJSON形式でまとめておく
        const allObj = result.reduce((prev, objString: string, index: number) => {
            // ChildStepの型がないので、anyでキャストする。
            const childStep = this.childStepList[index] as any as { serviceName: string, apiName: string };
            // マップに追加する。
            prev[Utils.safeFileName(`${childStep.serviceName}.${childStep.apiName}`)] = objString;
            return prev;
        }, {} as Record<string, any>);

        const outputFileName = `results/${this.agentName}/${PROJECT_NAME}/ServiceDocs.json`;
        fss.writeFileSync(outputFileName, JSON.stringify(allObj, null, 2));
        return result;
    }
}

class Step0110_ApiSourceReqRes extends BaseMultiStepDomainModelGenerator {
    constructor() {
        super();
        // const ENTITY_LIST = Utils.setMarkdownBlock(Utils.mdTrim(new Step0053_EntityAttributesJpa().formed), 'java');
        const ENTITY_LIST = fs.readFileSync(`results/${this.agentName}/${PROJECT_NAME}/entities.md`, 'utf-8');

        type MetaServiceData = { [key: string]: { [key: string]: { name: string, method: string, endpoint: string, request: string, response: string, usageScreenIdList: string[], entityList: string[], serviceList: string[], documentList: string[] } } };
        const serviceData = JSON.parse(fs.readFileSync(`results/${this.agentName}/${PROJECT_NAME}/ServiceList.json`, 'utf-8')) as MetaServiceData;
        class Step0110_ApiSourceReqResChil extends BaseStepDomainModelGenerator {
            // model: GPTModels = 'gpt-3.5-turbo';
            format: StepOutputFormat = StepOutputFormat.JSON;
            constructor(
                public serviceName: string,
                public apiName: string,
                public detailDocument: string,
                public request: string,
                public response: string,
            ) {
                super();
                // {"viewList":[{"name": "View name","destinationList":["parts","parts"],"relatedFeatureList":["featureName","featureName"]}]}
                const apiId = Utils.safeFileName(serviceName + "." + apiName);

                // 複数並列処理するので、被らないようにラベルを設定する。（これがログファイル名になる）
                this.label = `${this.constructor.name}_${Utils.safeFileName(apiId)}`; // Utils.safeFileNameはファイル名として使える文字だけにするメソッド。
                // 個別の指示を作成。
                this.chapters = [
                    {
                        title: `Instructions`,
                        content: Utils.trimLines(`
                            これから提示する設計書をよく読んで、APIのRequestDto/ResponseDtoを作成してください。
                            あなたの担当は「${apiId}」です。担当外のものはやらなくてよいです。
                            RequestDto/ResponseDtoのクラス名は、以下のルールに則ってください。
                            - RequestDto -> ${Utils.toPascalCase(serviceName)}${Utils.toPascalCase(apiName)}RequestDto
                            - ResponseDto -> ${Utils.toPascalCase(serviceName)}${Utils.toPascalCase(apiName)}ResponseDto
                            RequestDtoにはバリデーターを付けてください。
                        `),
                    }, {
                        title: '設計書',
                        children: [{
                            title: `${Utils.toPascalCase(serviceName)}${Utils.toPascalCase(apiName)}RequestDto`,
                            content: Utils.setMarkdownBlock(request),
                        }, {
                            title: `${Utils.toPascalCase(serviceName)}${Utils.toPascalCase(apiName)}ResponseDto`,
                            content: Utils.setMarkdownBlock(response),
                        }, {
                            content: Utils.addMarkdownDepth(detailDocument, 1),
                        }, {
                            title: `共通Entity`,
                            content: ENTITY_LIST,
                        }],
                    }, {
                        title: 'Output Format',
                        content: Utils.trimLines(`
                            以下のJSON形式で出力してください。補助クラスは必要に応じて適宜追加してください。
                            出力するのはJSONのみで、Javaのソースコードは出力しなくてよいです。
                            {
                                "SomeRequestDto":[{"type":"className","name":"varName","validations":["@NotNull(message = \"some message.\")"]},],
                                "SomeResponseDto":[{"type":"className","name":"varName"},],
                                "SubSomeDto":[{"type":"className","name":"varName"},],
                            }
                        `),
                    }
                ];
            }
        }
        // console.log(entityData);
        const serviceMethodDocMas = new Step0100_ApiDocuments().childStepList.reduce((before: { [key: string]: any }, current: BaseStep) => {
            const serviceMethodName = Utils.safeFileName((current as any).serviceName + '.' + (current as any).apiName);
            if (!before[serviceMethodName]) {
                before[serviceMethodName] = [];
            } else { }
            before[serviceMethodName] = current.formed;
            return before;
        }, {});
        this.childStepList = Object.entries(serviceData).map(([serviceName, apiData]) =>
            Object.entries(apiData).map(([apiName, api]) => {
                return new Step0110_ApiSourceReqResChil(serviceName, apiName, serviceMethodDocMas[Utils.safeFileName(serviceName + "." + apiName)], api.request, api.response);
            })
        ).flat();
    }

    postProcess(result: string[]): string[] {
        // 全部まとめてファイルに出力する。
        const keys = this.childStepList.map((step: BaseStep) => Utils.safeFileName(`${(step as any).serviceName}.${(step as any).apiName}`));

        const allObj = result.reduce((prev, objString: string, index: number) => {
            const obj = Utils.jsonParse<Record<string, any>>(objString);
            prev[keys[index]] = obj;
            return prev;
        }, {} as Record<string, any>);

        const outputFileName = `results/${this.agentName}/${PROJECT_NAME}/request-response.json`;
        fss.writeFileSync(outputFileName, JSON.stringify(allObj, null, 2));
        return result;
    }
}


class Step0120_ApiSourceJson extends BaseMultiStepDomainModelGenerator {
    constructor() {
        super();
        const ENTITY_LIST = fs.readFileSync(`results/${this.agentName}/${PROJECT_NAME}/entities.md`, 'utf-8');
        const SERVICE_LIST = fs.readFileSync(`results/${this.agentName}/${PROJECT_NAME}/ServiceList.md`, 'utf-8');
        const entityData = parseJavaCode(Utils.mdTrim(new Step0050_EntityAttributes().formed), PACKAGE_NAME);
        const REPOSITORY_LIST = entityData.entityList.map(entityName => `- ${entityName}Repository<${entityName}, Long>`).join('\n');

        // 画面一覧から画面と紐づく機能一覧を取得する。
        const viewList = JSON.parse(new Step0060_ViewList().formed).viewList as { name: string, destinationList: string[], relatedFeatureList: string[] }[];
        const featureMas = new Step0030_DesignSummary().childStepList.reduce((acc: { [key: string]: string }, step: BaseStep) => {
            const feature = (step as any).feature;
            acc[feature] = step.formed;
            // "機能"の有無で取りこぼしを防ぐ。
            acc[feature.replace(/機能$/g, '')] = step.formed;
            acc[feature + '機能'] = step.formed;
            acc[feature.replace(/機能の詳細化$/g, '')] = step.formed;
            acc[feature + '機能の詳細化'] = step.formed;
            acc[feature.replace(/の詳細化$/g, '')] = step.formed;
            acc[feature + 'の詳細化'] = step.formed;
            return acc;
        }, {} as { [key: string]: string });


        type MetaServiceData = Record<string, Record<string, { name: string, method: string, endpoint: string, request: string, response: string, usageScreenIdList: string[], entityList: string[], serviceList: string[], documentList: string[] }>>;
        const serviceData = JSON.parse(fs.readFileSync(`results/${this.agentName}/${PROJECT_NAME}/ServiceList.json`, 'utf-8')) as MetaServiceData;
        const reqResData = JSON.parse(fs.readFileSync(`results/${this.agentName}/${PROJECT_NAME}/request-response.json`, 'utf-8')) as Record<string, Record<string, { type: string, name: string, validations?: string[] }[]>>;
        const serviceDocsData = JSON.parse(fs.readFileSync(`results/${this.agentName}/${PROJECT_NAME}/ServiceDocs.json`, 'utf-8')) as Record<string, string>;
        const serviceTemplateMap = javaServiceTemplateMap(serviceData, reqResData, serviceDocsData, entityData, PACKAGE_NAME);

        const exceptionSource =
            Utils.setMarkdownBlock(fs.readFileSync(`results/${this.agentName}/${PROJECT_NAME}/${PACKAGE_DIRE}/exception/ResourceNotFoundException.java`, 'utf-8'), 'java com.example.demo.exception.ResourceNotFoundException') + '\n\n' +
            Utils.setMarkdownBlock(fs.readFileSync(`results/${this.agentName}/${PROJECT_NAME}/${PACKAGE_DIRE}/exception/CustomException.java`, 'utf-8'), 'java com.example.demo.exception.CustomException')

        // console.log(serviceTemplateMap);
        class Step0120_ApiSourceJsonChil extends BaseStepDomainModelGenerator {
            // model: GPTModels = 'gpt-3.5-turbo';
            format: StepOutputFormat = StepOutputFormat.JSON;
            constructor(
                public serviceName: string,
                public apiName: string,
                public api: { name: string, method: string, endpoint: string, request: string, response: string, usageScreenIdList: string[], serviceList: string[] },
                public viewDocList: string[],
                public featureList: string[]
            ) {
                super();
                // {"viewList":[{"name": "View name","destinationList":["parts","parts"],"relatedFeatureList":["featureName","featureName"]}]}
                const apiId = Utils.safeFileName(serviceName + "." + apiName);
                // 複数並列処理するので、被らないようにラベルを設定する。（これがログファイル名になる）
                this.label = `${this.constructor.name}_${Utils.safeFileName(apiId)}`; // Utils.safeFileNameはファイル名として使える文字だけにするメソッド。
                // console.log(this.label);
                // console.log(api.serviceList.map(serviceName => Utils.setMarkdownBlock(serviceTemplateMap[Utils.safeFileName(serviceName)], 'java')).join('\n'));
                // 個別の指示を作成。
                this.chapters = [
                    {
                        title: `Instructions`,
                        content: Utils.trimLines(`
                            これから提示する設計書をよく読んで、サービス実装のひな型のTODOを実装してください。
                            あなたの担当は「${apiId}」です。担当外のものはやらなくてよいです。
                            また、バリデーションは別のクラスで実装してあるので実装しなくてよいです。
                            Entityの操作は、対応するAPI、もしくはRepositoryインターフェース経由で行ってください。（entityManager.createQueryは禁止です）。
                            追加のインジェクションが必要な場合は「サービス一覧」、「Repository一覧」の中からのみ選択可能です。
                        `),
                    }, {
                        title: '個別設計書',
                        content: `個別設計書はあなたが実装すべき設計書です`,
                        children: [{
                            title: `サービス実装のひな型`,
                            content: Utils.setMarkdownBlock(serviceTemplateMap[apiId], 'java'),
                        }, {
                            content: Utils.addMarkdownDepth(serviceDocsData[apiId], 1),
                        }],
                        // }, {
                        //     title: '関連設計書',
                        //     content: `関連設計書はあなたの担当に関係する部分です。`,
                        //     children: [{
                        //         title: `機能設計書`,
                        //         content: Utils.setMarkdownBlock(Utils.mdTrim(featureList.join('\n\n---\n\n')), 'markdown'),
                        //     }, {
                        //         title: `画面設計書`,
                        //         content: Utils.setMarkdownBlock(Utils.mdTrim(viewDocList.join('\n\n---\n\n')), 'markdown'),
                        //     }],
                    }, {
                        title: '全体設計書',
                        content: `全体設計書はシステム全体について語っています。あなたの担当分が相対的にどのような役割かを理解するのに役立ててください。`,
                        children: [{
                            title: `フレームワーク`,
                            content: `SpringBoot + JPA`,
                        }, {
                            title: `ディレクトリ構成`,
                            content: Utils.trimLines(`
                                - ${PACKAGE_NAME}
                                  - domain: domain層のパッケージ
                                    - controller: controllerのパッケージ
                                    - service: serviceのインターフェースクラス
                                      - impl: serviceの実装クラス
                                    - repository: repositoryのインターフェースクラス
                                    - entity: entityのパッケージ
                                    - enums: enumのパッケージ
                                  - exception: Exceptionクラスのパッケージ
                            `),
                        }, {
                            title: `サービス一覧`,
                            content: SERVICE_LIST,
                        }, {
                            title: `利用サービス`,
                            content: api.serviceList.map(serviceName => Utils.setMarkdownBlock(serviceTemplateMap[Utils.safeFileName(serviceName)], 'java')).join('\n') || 'なし',
                        }, {
                            title: `Repository一覧`,
                            content: REPOSITORY_LIST,
                        }, {
                            title: `Entity`,
                            content: ENTITY_LIST,
                        }, {
                            title: `Common classes`,
                            content: exceptionSource
                        }],
                    }, {
                        title: 'Output Format',
                        content: Utils.trimLines(`
                            以下のJSON形式で出力してください。
                            {
                                "additionalImports": ["\${必要な追加のインポートのJava code}"],
                                "additionalInjections": ["\${必要な追加のインジェクションのJava code}"],
                                "methodAnnotations": ["\${メソッドに適用されるアノテーションのJava code}"],
                                "methodBodyInnerCodes": ["\${メソッドの内部実装のJava code with Japanese comment}"],
                                "todos": ["\${メソッドの内部実装で、難しくて実装できないもの}"]
                            }
                        `),
                    }
                ];
            }
        }

        const viewDocMap = new Step0070_ViewDocuments().childStepList.reduce((before: { [key: string]: any }, current: BaseStep) => {
            const featureName = (current as any).feature.name;
            if (!before[featureName]) {
                before[featureName] = [];
            } else { }
            before[featureName] = current.formed;
            return before;
        }, {});

        // console.log(entityData);
        this.childStepList = Object.entries(serviceData).map(([serviceName, apiData]) =>
            Object.entries(apiData).map(([apiName, api]) => {
                // 利用元画面を取得
                const views = viewList.filter(view => api.usageScreenIdList.some(usageScreenId => view.name === usageScreenId));
                // 利用元画面から機能設計書を取得。重複削除もする。
                const features = Array.from(new Set(views.map(view => view.relatedFeatureList).flat())).map(featureName => featureMas[featureName]);
                const viewDocs = views.map(view => viewDocMap[view.name]);

                return new Step0120_ApiSourceJsonChil(serviceName, apiName, api, viewDocs, features);
            })
        ).flat();
    }
    postProcess(result: string[]): string[] {
        // 全部まとめてファイルに出力する。
        const keys = this.childStepList.map((step: BaseStep) => Utils.safeFileName(`${(step as any).serviceName}.${(step as any).apiName}`));

        const allObj = result.reduce((prev, objString: string, index: number) => {
            const obj = Utils.jsonParse<Record<string, any>>(objString);
            prev[keys[index]] = obj;
            return prev;
        }, {} as Record<string, any>);

        // TODOをリストアップする
        // // console.log(allObj);
        // Object.entries(allObj).forEach(([key, value]) => {
        //     console.log(key, value.todos);
        // });

        type MetaServiceData = Record<string, Record<string, { name: string, method: string, endpoint: string, request: string, response: string, usageScreenIdList: string[], entityList: string[], serviceList: string[], documentList: string[] }>>;
        const serviceData = JSON.parse(fs.readFileSync(`results/${this.agentName}/${PROJECT_NAME}/ServiceList.json`, 'utf-8')) as MetaServiceData;
        const reqResData = JSON.parse(fs.readFileSync(`results/${this.agentName}/${PROJECT_NAME}/request-response.json`, 'utf-8')) as Record<string, Record<string, { type: string, name: string, validations?: string[] }[]>>;
        const serviceDocsData = JSON.parse(fs.readFileSync(`results/${this.agentName}/${PROJECT_NAME}/ServiceDocs.json`, 'utf-8')) as Record<string, string>;

        const entityData = parseJavaCode(Utils.mdTrim(new Step0050_EntityAttributes().formed), PACKAGE_NAME);
        const javaServiceImplementsMapObj = javaServiceImplementsMap(serviceData, reqResData, serviceDocsData, allObj, entityData, PACKAGE_NAME);

        const outputFileName = `results/${this.agentName}/${PROJECT_NAME}/service-data.json`;
        fss.writeFileSync(outputFileName, JSON.stringify(allObj, null, 2));
        Object.entries(javaServiceImplementsMapObj).forEach(([key, value]) => {
            fss.writeFileSync(`results/${this.agentName}/${PROJECT_NAME}/${PACKAGE_DIRE}/domain/service/impl/${key}Impl.java`, value.implement);
            fss.writeFileSync(`results/${this.agentName}/${PROJECT_NAME}/${PACKAGE_DIRE}/domain/service/${key}.java`, value.interface);
            fss.writeFileSync(`results/${this.agentName}/${PROJECT_NAME}/${PACKAGE_DIRE}/domain/controller/${key}Controller.java`, value.controller);
        });

        return result;
    }
}


class Step0130_RepositoryMethod extends BaseMultiStepDomainModelGenerator {
    constructor() {
        super();
        // const ENTITY_LIST = Utils.setMarkdownBlock(Utils.mdTrim(new Step0053_EntityAttributesJpa().formed), 'java');
        const ENTITY_LIST = fs.readFileSync(`results/${this.agentName}/${PROJECT_NAME}/entities.md`, 'utf-8');
        const API_LIST = fs.readFileSync(`results/${this.agentName}/${PROJECT_NAME}/ServiceList.md`, 'utf-8');

        type MetaServiceData = Record<string, Record<string, { name: string, method: string, endpoint: string, request: string, response: string, usageScreenIdList: string[], entityList: string[], serviceList: string[], documentList: string[] }>>;
        const serviceData = JSON.parse(fs.readFileSync(`results/${this.agentName}/${PROJECT_NAME}/ServiceList.json`, 'utf-8')) as MetaServiceData;

        // console.log(serviceTemplateMap);
        class Step0130_RepositoryMethodChil extends BaseStepDomainModelGenerator {
            // model: GPTModels = 'gpt-3.5-turbo';
            format: StepOutputFormat = StepOutputFormat.JSON;
            constructor(
                public serviceName: string,
            ) {
                super();
                // {"viewList":[{"name": "View name","destinationList":["parts","parts"],"relatedFeatureList":["featureName","featureName"]}]}
                const apiId = Utils.safeFileName(serviceName);
                // 複数並列処理するので、被らないようにラベルを設定する。（これがログファイル名になる）
                this.label = `${this.constructor.name}_${Utils.safeFileName(apiId)}`; // Utils.safeFileNameはファイル名として使える文字だけにするメソッド。

                // 個別の指示を作成。
                this.chapters = [
                    {
                        title: `Instructions`,
                        content: Utils.trimLines(`
                            これから提示するソースコードをよく理解して、Repositoryインターフェースで実装されるべきメソッドを抽出してください。
                        `),
                    }, {
                        title: 'Target Source Code',
                        content: Utils.setMarkdownBlock(fs.readFileSync(`results/${this.agentName}/${PROJECT_NAME}/${PACKAGE_DIRE}/domain/service/impl/${apiId}Impl.java`, 'utf-8'), 'java'),
                    }, {
                        title: '参考資料',
                        children: [{
                            title: `フレームワーク`,
                            content: `SpringBoot + JPA`,
                        }, {
                            title: `Entity`,
                            content: '以下のentityには、対応するRepositoryインターフェースが存在します。\n\n' + ENTITY_LIST,
                        }],
                    }, {
                        title: 'Output Format',
                        content: Utils.trimLines(`
                            以下のJSON形式で出力してください。
                            {
                                "jpaMethods": {
                                    "EntityName": ["\${JPAメソッドのJava code}"]
                                },
                            }
                        `),
                    }
                ];
            }
        }

        // console.log(entityData);
        this.childStepList = Object.entries(serviceData).map(([serviceName, apiData]) => new Step0130_RepositoryMethodChil(serviceName));
    }

    postProcess(result: string[]): string[] {
        // // 全部まとめてファイルに出力する。
        const keys = this.childStepList.map((step: BaseStep) => Utils.safeFileName(`${(step as any).serviceName}`));

        const allObj = result.reduce((prev, objString: string, index: number) => {
            const obj = Utils.jsonParse<Record<string, any>>(objString);
            prev[keys[index]] = obj;
            return prev;
        }, {} as Record<string, Record<string, Record<string, string[]>>>);
        const outputFileName = `results/${this.agentName}/${PROJECT_NAME}/repository-methods.json`;
        fss.writeFileSync(outputFileName, JSON.stringify(allObj, null, 2));
        // console.dir(allObj, { depth: 5 });

        const entityData = parseJavaCode(Utils.mdTrim(new Step0050_EntityAttributes().formed), PACKAGE_NAME).classes;
        // console.dir(entityData, { depth: 5 });

        // RespositoryのJSONベースでメソッドをまとめる。
        const repositoryMethods0: Record<string, Set<string>> = {};
        Object.entries(allObj).forEach(([key, value]) => {
            Object.entries(value.jpaMethods).forEach(([entityName, methods]) => {
                if (!repositoryMethods0[entityName]) { repositoryMethods0[entityName] = new Set(); }
                methods.forEach(method => repositoryMethods0[entityName].add(method));
            });
        });
        // console.dir(repositoryMethods0, { depth: 5 });

        // EntityベースでRepositoryのメソッドをまとめる。
        const repositoryMethods: Record<string, Set<string>> = {};
        Object.keys(entityData).forEach(entityName => {
            [repositoryMethods0[entityName], repositoryMethods0[`${entityName}Repository`]].filter(bit => bit).forEach(methods => {
                if (!repositoryMethods[entityName]) { repositoryMethods[entityName] = new Set(); }
                methods.forEach(method => repositoryMethods[entityName].add(method));
            });
        });
        // console.log(repositoryMethods);

        Object.entries(repositoryMethods).forEach(([entityName, methods]) => {
            const methodSet = new Set();
            methodSet.add('saveAll'); // saveAllは明示的に定義するとエラーになるので、デフォルトで追加しておく。
            methodSet.add('save'); // saveは明示的に定義するとワーニングになるので、デフォルトで追加しておく。
            const methodList = Array.from(methods).filter(method => {
                const methodSignature = parseJavaMethodSignatureWithGenerics(method);
                // console.log(methodSignature);
                methodSignature.methodName = methodSignature.methodName.replace(/<.*>/g, '');
                const boolean = !methodSet.has(methodSignature.methodName);
                methodSet.add(methodSignature.methodName);
                return boolean;
            });
            const outputFileName = `results/${this.agentName}/${PROJECT_NAME}/${PACKAGE_DIRE}/domain/repository/${entityName}Repository.java`;
            const methodsBody = Utils.trimLines(`
                package ${PACKAGE_NAME}.domain.repository;

                import ${PACKAGE_NAME}.domain.entity.*;
                import ${PACKAGE_NAME}.domain.enums.*;
                import java.time.LocalDate;
                import java.time.LocalDateTime;
                import java.time.LocalTime;
                import java.util.Map;
                import java.util.List;
                import java.util.Optional;
                import org.springframework.data.jpa.repository.JpaRepository;
                import org.springframework.stereotype.Repository;
                
                import ${PACKAGE_NAME}.domain.entity.${entityName};

                @Repository
                public interface ${entityName}Repository extends JpaRepository<${entityName}, Long> {
                ${methodList.map(method => '\tpublic ' + method.replace(/^public /g, '')).join('\n')}
                }
            `);
            fss.writeFileSync(outputFileName, methodsBody);
        });

        return result;
    }
}

class Step0080_ApiList0 extends BaseMultiStepDomainModelGenerator {
    viewList!: { name: string, destinationList: string[], relatedFeatureList: string[] }[];
    constructor() {
        super();
        class Step0080_ApiListChil extends BaseStepDomainModelGenerator {
            // model: GPTModels = 'gpt-3.5-turbo';
            format: StepOutputFormat = StepOutputFormat.JSON;
            constructor(public view: { name: string, document: string }) {
                super();
                this.label = `${this.constructor.name}_${Utils.safeFileName(view.name)}`; // Utils.safeFileNameはファイル名として使える文字だけにするメソッド。
                view.document = Utils.mdTrim(view.document);
                this.chapters = [
                    {
                        title: `Instructions`,
                        content: Utils.trimLines(`
                            これから提示する設計書をJSON形式に変換してください。
                    `),
                    }, {
                        title: '設計書',
                        children: [{
                            title: `画面設計書`,
                            content: Utils.setMarkdownBlock(view.document, 'markdown'),
                        }, {
                            title: `Entity`,
                            content: Utils.setMarkdownBlock(Utils.mdTrim(new Step0050_EntityAttributes().formed), 'java'),
                        }],
                    }, {
                        title: 'Output Format',
                        content: `OpenAPI 3.0.0形式(JSON)で出力してください。`,
                    }
                ];
            }
        }
        this.childStepList = new Step0070_ViewDocuments().childStepList.map((step: BaseStep) => new Step0080_ApiListChil(({ document: step.formed, name: (step as any).feature.name })));
    }

    postProcess(result: string[]): string[] {
        // 全部まとめてファイルに出力する。
        // const reportList = result.map((targetName: string, index: number) => `# ${ this.featureList[index] }\n\n${ targetName }`);
        const reportList = result.map((targetName: string, index: number) => `${targetName}`);
        const outputFileName = `results/${this.agentName}/${this.constructor.name}_${Utils.formatDate(new Date(), 'yyyyMMddHHmmssSSS')}-report_all.md`;
        fss.writeFileSync(outputFileName, reportList.join('\n---\n'));
        return result;
    }
}
class Step0060_ServiceList extends BaseStepDomainModelGenerator {
    constructor() {
        super();
        this.chapters = [{
            title: `Instructions`,
            content: Utils.trimLines(`
                これから提示する設計書をよく読んで、ドメイン駆動設計の要領でDomain Serviceを抽出してください。
                    `),
            children: [
                // {
                //     title: `評価ポイント`,
                //     content: Utils.trimLines(`
                //     評価ポイントは以下の三点です。
                //     - エンティティの明確さと適切性の評価：エンティティの明確さと適切性を評価します。DDDでは、エンティティはビジネスドメインの核となる概念であり、その特性や関連を明確に表現する必要があります。
                //     - 結合度と凝集度の評価：エンティティ間の結合度と凝集度を評価します。理想的には、エンティティ間の結合は低く、凝集度は高いほうが望ましいです。過度な結合は、エンティティの再利用性を低下させ、凝集度の低いエンティティは、ビジネスドメインの概念を適切に表現できない可能性があります。
                //     - 柔軟性と拡張性の評価：エンティティが将来の変更や拡張にどの程度対応できるかを評価します。
                // `),
                // }, {
                //     title: `Entitiy抽出のサンプル`,
                //     content: Utils.setMarkdownBlock(Utils.trimLines(`
                //     - Domain Services => Methods
                //     ### 注文管理関連のエンティティ:
                //     1. **Order** - 顧客の注文情報を含むエンティティ。注文ID、注文日、顧客の詳細、注文された商品のリスト、合計金額、支払い状態などの属性を持つ。
                //     2. **Product** - 注文で購入される商品を表すエンティティ。商品ID、商品名、価格、在庫状況などの属性を持つ。
                //     3. **Customer** - 注文を行う顧客を表すエンティティ。顧客ID、名前、連絡先情報、配送先住所、注文履歴などの属性を持つ。
                //     4. **Payment** - 注文の支払い情報を表すエンティティ。支払いID、注文ID、支払い方法、支払い状況、支払い日時などの属性を持つ。
                //     5. **Shipping** - 注文の配送情報を表すエンティティ。配送ID、注文ID、配送先住所、配送状況、予定配送日などの属性を持つ。

                //     ### 従業員管理関連のエンティティ:
                //     1. **Employee** - 従業員の個人情報と職務情報を含むエンティティ。従業員ID、名前、住所、電話番号、メールアドレス、部署、役職、入社日などの属性を持つ。
                //     2. **Department** - 従業員が所属する部署を表すエンティティ。部署ID、部署名、部署の責任者、部署の機能・目的などの属性を持つ。
                //     3. **Project** - 従業員が関与するプロジェクトを表すエンティティ。プロジェクトID、プロジェクト名、開始日、終了日、プロジェクトの目的、参加している従業員のリストなどの属性を持つ。
                //     4. **Attendance** - 従業員の出勤状況を記録するエンティティ。出勤記録ID、従業員ID、出勤日、出勤時間、退勤時間、勤務時間などの属性を持つ。
                //     5. **PerformanceReview** - 従業員の業績評価を表すエンティティ。評価ID、従業員ID、評価期間、評価者、評価結果、フィードバックコメントなどの属性を持つ。
                // `), 'markdown'),
                // },
            ],
        }, {
            title: '設計書',
            children: [{
                title: `機能一覧`,
                content: Utils.setMarkdownBlock(new Step0030_DesignSummary().childStepList.map((step: BaseStep) => step.formed).join('\n\n---\n\n'), 'markdown'),
            }, {
                title: `Entity一覧`,
                content: Utils.setMarkdownBlock(new Step0040_EntityList().formed, 'markdown'),
            }],
        },];
    }
}

class Step0050_EntityListToJson extends BaseStepDomainModelGenerator {
    format: StepOutputFormat = StepOutputFormat.JSON;
    constructor() {
        super();
        this.chapters = [{
            title: `Instructions`,
            content: Utils.trimLines(`
                これから提示する設計書をよく読んで、ER図を作成してください。
                抽出にあたってアクター／リソースの両方について、抜け漏れの無いように気を付けてください。
                まずはEntityの名前と役割を一覧化してください。EnumはEntityとは分けて記載してください。
            `),
        }, {
            title: 'Input Document',
            content: new Step0010_FeatureListSummaryToFeatureListDetail().formed,
        }, {
            title: 'Output Format',
            content: Utils.trimLines(`
                {"featureList":["feature1","feature2","feature3"]}
            `),
        }];
    }
}
class Step0050_ extends BaseStepDomainModelGenerator {
    model: GPTModels = 'gpt-3.5-turbo';
    format: StepOutputFormat = StepOutputFormat.JSON;
    constructor() {
        super();
        this.chapters = [{
            title: `Instructions`,
            content: Utils.trimLines(`
                与えられた機能一覧（詳細）をよく理解して、指定されたJson形式を作成してください。
            `),
        }, {
            title: 'Input Document',
            content: new Step0010_FeatureListSummaryToFeatureListDetail().formed,
        }, {
            title: 'Output Format',
            content: Utils.trimLines(`
                {"featureList":["feature1","feature2","feature3"]}
            `),
        }];
    }
}

/**
 * 必ず main() という関数を定義する。
 * promiseチェーンで順次実行させる。
 * 
 * 1. newでオブジェクトを作る。
 * 2. initPromptでプロンプトをファイルに出力。
 * 3. run()で実行
 * 
 * 途中まで行ってたらコメントアウトして再ランする。
 * 例えば、promptを手修正したかったらinitPromptだけコメントアウトすれば手修正したファイルがそのまま飛ぶ。
 */
export async function main() {
    ResourceNotFoundException
    BaseEntity
    DemoApplication
    Utils.replaceTemplateStringDeep
    fss.writeFileSync(`results/${__dirname}/${PROJECT_NAME}/${PACKAGE_DIRE}/exception/ResourceNotFoundException.java`, ResourceNotFoundException.replace(/\{\{packageName\}\}/g, PACKAGE_NAME));
    fss.writeFileSync(`results/${__dirname}/${PROJECT_NAME}/${PACKAGE_DIRE}/exception/CustomException.java`, CustomException.replace(/\{\{packageName\}\}/g, PACKAGE_NAME));
    fss.writeFileSync(`results/${__dirname}/${PROJECT_NAME}/${PACKAGE_DIRE}/domain/entity/BaseEntity.java`, BaseEntity.replace(/\{\{packageName\}\}/g, PACKAGE_NAME));
    fss.writeFileSync(`results/${__dirname}/${PROJECT_NAME}/${PACKAGE_DIRE}/DemoApplication.java`, DemoApplication.replace(/\{\{packageName\}\}/g, PACKAGE_NAME));
    const split0 = PACKAGE_NAME.split('\.');
    const name = split0.pop() || '';
    fss.writeFileSync(`results/${__dirname}/${PROJECT_NAME}/${PROJECT_NAME}/pom.xml`, Pom.replace(/\{\{groupId\}\}/g, split0.join('.')).replace(/\{\{artifactId\}\}/g, name).replace(/\{\{name\}\}/g, name));
    let obj;
    return Promise.resolve().then(() => {
        obj = new Step0000_RequirementsToFeatureListSummary();
        obj.initPrompt();
        return obj.run();
    }).then(() => {
        obj = new Step0010_FeatureListSummaryToFeatureListDetail();
        obj.initPrompt();
        return obj.run();
    }).then(() => {
        obj = new Step0015_EntityList();
        obj.initPrompt();
        return obj.run();
    }).then(() => {
        obj = new Step0020_FeatureListDetailToJsonFormat();
        obj.initPrompt();
        return obj.run();
    }).then(() => {
        obj = new Step0030_DesignSummary(); // 機能の詳細化
        obj.initPrompt();
        return obj.run();
        //-- // ※使ってない
        // }).then(() => {
        //     obj = new Step0031_DesignSummaryReview();
        //     obj.initPrompt();
        //     return obj.run();
        // }).then(() => {
        //     obj = new Step0033_DesignSummaryRefine();
        //     obj.initPrompt();
        //     return obj.run();
        // }).then(() => {
        //     obj = new Step0034_DesignSummaryRefineReview();
        //     obj.initPrompt();
        //     return obj.run();
        // -- // ※使ってない
    }).then(() => {
        obj = new Step0040_EntityList(); // Entity一覧を作る
        obj.initPrompt();
        return obj.run();
    }).then(() => {
        obj = new Step0050_EntityAttributes(); // Entityに属性を補充する
        obj.initPrompt();
        return obj.run();
    }).then(() => {
        obj = new Step0053_EntityAttributesJpa(); // ここは並列化可能 Entityに属性を補充する
        obj.initPrompt();
        return obj.run();
        // obj.postProcess(obj.result);
    }).then(() => {
        //     obj = new Step0055_EntityAttributesToOpenAPI(); // ※使ってない：ここは並列化可能
        //     obj.initPrompt();
        //     return obj.run();
    }).then(() => {
        obj = new Step0060_ViewList(); // 画面一覧を作る
        obj.initPrompt();
        return obj.run();
    }).then(() => {
        obj = new Step0070_ViewDocuments(); // 画面詳細設計書を作る
        obj.initPrompt();
        return obj.run();
    }).then(() => {
        obj = new Step0080_ServiceList(); // サービス一覧を作る
        obj.initPrompt();
        return obj.run();
    }).then(() => {
        obj = new Step0090_ServiceMethodList(); // サービス⇒API一覧を作る
        obj.initPrompt();
        return obj.run();
    }).then(() => {
        obj = new Step0092_ServiceMethodListReqRes(); // サービス⇒API一覧に列追加
        obj.initPrompt();
        return obj.run();
        // obj.postProcess(obj.result); // 後処理デバッグ用
    }).then(() => {
        obj = new Step0100_ApiDocuments();
        obj.initPrompt();
        return obj.run();
        // obj.postProcess(obj.childStepList.map((step) => step.result)); // 後処理デバッグ用
    }).then(() => {
        obj = new Step0110_ApiSourceReqRes();
        obj.initPrompt();
        return obj.run();
    }).then(() => {
        obj = new Step0120_ApiSourceJson();
        obj.initPrompt();
        return obj.run();
        // obj.postProcess(obj.childStepList.map((step) => step.result)); // 後処理デバッグ用
    }).then(() => {
        obj = new Step0130_RepositoryMethod();
        obj.initPrompt();
        return obj.run();
        // obj.postProcess(obj.childStepList.map((step) => step.result)); // 後処理デバッグ用
    }).then(() => {
    });
}


/**
 * このファイルが直接実行された場合のコード。
 */
if (fileURLToPath(import.meta.url) === process.argv[1]) {
    main();
} else {
    // main実行じゃなかったら何もしない
}
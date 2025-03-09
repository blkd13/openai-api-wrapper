import { fileURLToPath } from "url";

import {
  BaseStep,
  MultiStep,
  PromptLang,
  StepOutputFormat,
  getStepInstance,
} from "../../common/base-step.js";
import { GPTModels } from '../../common/model-definition.js';
import { Utils } from "../../common/utils.js";
import {
  parseJavaModelCode,
  javaServiceTemplateMap,
  javaServiceImplementsMap,
  DtoClass,
  TIME_TYPE_REMAP,
  TIME_TYPE_COLUMN_DEFINITION,
  ServiceMethod,
  angularServiceMap,
  javaInterfaceMap,
  EntityValueObjectType,
  EnumType,
  EntityDetailFilledType,
} from "./helper.js";
import fss from "../../common/fss.js";
import * as fs from "fs";

import spring_ResourceNotFoundException from "./spring-template/ResourceNotFoundException.java.js";
import spring_CustomException from "./spring-template/CustomException.java.js";
import spring_BaseEntity from "./spring-template/BaseEntity.java.js";
import spring_DemoApplication from "./spring-template/DemoApplication.java.js";
import spring_application from "./spring-template/application.yml.js";
import spring_Pom from "./spring-template/pom.xml.js";
import angular_apiInterceptor from "./angular-template/api.interceptor.ts.js";
import angular_appConfig from "./angular-template/app.config.ts.js";
import angular_environmentDevelopment from "./angular-template/environment.development.ts.js";
import angular_environment from "./angular-template/environment.ts.js";
import angular_package from "./angular-template/package.json.js";
import angular_tailwindConfig from "./angular-template/tailwind.config.js.js";
import angular_proxyConf from "./angular-template/proxy.conf.js.js";

import { JAVA_FQCN_MAP, javaTypeToTypescript } from "./constant.js";

const __dirname = Utils.basename(Utils.dirname(import.meta.url));
const PROJECT_NAME = "deposit-management-system-02";
const PACKAGE_NAME = "com.example.dms02";
const SPRING_DIRE = `spring/src/main/java/${PACKAGE_NAME.replace(/\./g, "/")}`;
const INPUT_PROMPT_JA = Utils.trimLines(`
お題は「貸金業をするために必要なシステム全般」です。
`);
const IMPUT_PROMPT_EN = Utils.trimLines(`
The theme is "System requirements for a lending business".
`);

/**
 * このエージェント用の共通設定。
 * エージェントごとに設定したいデフォルト値が異なるのでrunnerの最初に書くことにした。
 */
export abstract class BaseStepDomainModelGenerator extends BaseStep {
  agentName: string = Utils.basename(Utils.dirname(import.meta.url));
  model: GPTModels = "gpt-4-turbo-preview";
  labelPrefix: string = `${PROJECT_NAME}/`; // ラベルのプレフィックス。サブディレクトリに分けるように/を入れておくと便利。
  systemMessageJa =
    "経験豊富で優秀なソフトウェアエンジニア。専門はドメイン駆動設計。";
  systemMessageEn =
    "Experienced and talented software engineer. Specialized in domain-driven design.";
  systemMessage = this.systemMessageJa;
  temperature: number = 0.0; // ランダム度合い。0に近いほど毎回同じ結果になる。プログラムのようなものは 0 に、文章系は 1 にするのが良い。
  format = StepOutputFormat.MARKDOWN;
  lang: PromptLang = "ja";
}
/**
 * このエージェント用の共通設定。
 * エージェントごとに設定したいデフォルト値が異なるのでrunnerの最初に書くことにした。
 */
export abstract class MultiStepDomainModelGenerator extends MultiStep {
  agentName: string = Utils.basename(Utils.dirname(import.meta.url));
  labelPrefix: string = `${PROJECT_NAME}/`; // ラベルのプレフィックス。サブディレクトリに分けるように/を入れておくと便利。
}

class Step0000_RequirementsToFeatureListSummary extends BaseStepDomainModelGenerator {
  // model: GPTModels = 'gpt-3.5-turbo';
  constructor() {
    super();
    this.chapters = [
      {
        title: `Instructions`,
        contentJa: Utils.trimLines(`
                システム開発のための要件定義を手伝ってください。
                与えられたお題目に対して、まずは機能の頭出しをしたいです。
                markdownの番号リスト形式で機能一覧を列挙してください。
                出力はシステム名と機能一覧のみとし、余計なことは書かないでください。
                ステップバイステップで考えて結果のみを出力してください。
            `),
        contentEn: Utils.trimLines(`
                Please help with system development requirements.
                First, I would like to brainstorm the functions for the given theme.
                Please list the functions in a numbered list in markdown format.
                The output should only include the system name and the list of functions, and nothing else.
                Please think step by step and output only the results.
            `),
      },
      {
        content: this.lang === "ja" ? INPUT_PROMPT_JA : IMPUT_PROMPT_EN,
      },
    ];
  }
}

class Step0010_FeatureListSummaryToFeatureListDetail extends BaseStepDomainModelGenerator {
  // model: GPTModels = 'gpt-3.5-turbo';
  constructor() {
    super();
    const featureListSummaryStep = getStepInstance(
      Step0000_RequirementsToFeatureListSummary
    );
    this.presetMessages.push({
      role: "user",
      content: featureListSummaryStep.prompt,
    });
    this.presetMessages.push({
      role: "assistant",
      content: featureListSummaryStep.result,
    });

    this.chapters = [
      {
        contentJa: Utils.trimLines(`
                ありがとうございます。
                開発工程に進むために、より細かく具体的な一覧にしてください。
                また、足りていない機能があるかもチェックして、必要な機能を追加してください。
            `),
        contentEn: Utils.trimLines(`
                Thank you.
                To proceed with the development process, please make a more detailed and specific list.
                Also, check for any missing features and add any necessary features.
            `),
      },
    ];
  }
}

class Step0013_AdvancedExpertiseListJson extends BaseStepDomainModelGenerator {
  // model: GPTModels = 'gpt-3.5-turbo';
  format: StepOutputFormat = StepOutputFormat.JSON;
  constructor() {
    super();
    const featureListDetailStep = getStepInstance(
      Step0010_FeatureListSummaryToFeatureListDetail
    );
    this.presetMessages.push({
      role: "user",
      content: featureListDetailStep.prompt,
    });
    this.presetMessages.push({
      role: "assistant",
      content: featureListDetailStep.result,
    });

    this.chapters = [
      {
        contentJa: Utils.trimLines(`
                ありがとうございます。
                この設計書を基に開発を進めるに当たって、特に高度な専門性を要求する業務機能を、全て漏れなく提示してください。
            `),
        contentEn: Utils.trimLines(`
                Thank you.
                Based on this design document, please provide all the business functions that require advanced expertise, without exception, for the development process.
            `),
      },
      {
        title: `Output Format`,
        contentJa: Utils.trimLines(`
                出力フォーマットは以下の通りです。
                \`\`\`json
                {"advancedExpertiseList":[{"title":"機能タイトル","content":"内容","featureName":"機能名"},{"title":"機能タイトル","content":"内容","featureName":"機能名"}]}
                \`\`\`
            `),
        contentEn: Utils.trimLines(`
                The output format is as follows.
                \`\`\`json
                {"advancedExpertiseList":[{"title":"Function Title","content":"Content","featureName":"Feature Name"},{"title":"Function Title","content":"Content","featureName":"Feature Name"}]}
                \`\`\`
            `),
      },
    ];
  }
}

class Step0015_AdvancedExpertiseDetail extends MultiStepDomainModelGenerator {
  advancedExpertiseList: {
    title: string;
    content: string;
    featureName: string;
  }[];
  constructor() {
    super();
    const featureListDetailStep = getStepInstance(
      Step0010_FeatureListSummaryToFeatureListDetail
    );
    const advancedExpertiseListJsonStep = getStepInstance(
      Step0013_AdvancedExpertiseListJson
    );
    this.advancedExpertiseList = JSON.parse(
      advancedExpertiseListJsonStep.formed
    ).advancedExpertiseList;
    // console.log(this.advancedExpertiseList);
    // console.log(advancedExpertiseListJsonStep.chapters[0]);
    const advancedExpertiseListMarkdown = this.advancedExpertiseList
      .map((target) => `- ** ${target.title} **: ${target.content}`)
      .join("\n");
    class Step0015_AdvancedExpertiseDetailChil extends BaseStepDomainModelGenerator {
      // model: GPTModels = 'gpt-3.5-turbo';
      constructor(
        public advancedExpertise: {
          title: string;
          content: string;
          featureName: string;
        }
      ) {
        super();
        this.label = `${this.constructor.name}_${Utils.safeFileName(
          advancedExpertise.title
        )}`; // Utils.safeFileNameはファイル名として使える文字だけにするメソッド。

        this.presetMessages.push({
          role: "user",
          content: featureListDetailStep.prompt,
        });
        this.presetMessages.push({
          role: "assistant",
          content: featureListDetailStep.result,
        });
        // advancedExpertiseListはJson形式なので、Markdown形式に変換する。
        this.presetMessages.push({
          role: "user",
          content: this.chooseContent(
            advancedExpertiseListJsonStep.chapters[0]
          ),
        });
        this.presetMessages.push({
          role: "assistant",
          content: advancedExpertiseListMarkdown,
        });

        this.chapters = [
          {
            contentJa: Utils.trimLines(`
                        「${advancedExpertise.title}」の詳細設計書を提示してください。
                        章立ては 入力データ、処理フロー、処理詳細補足（具体的なビジネスロジックや計算式など）、出力データ 、運用ルール、備考としてください。
                        曖昧な言い回しは避けて、断定調で仕様を記載してください。
                    `),
            contentEn: Utils.trimLines(`
                        Please provide a detailed design document for "${advancedExpertise.title}".
                        The structure should include input data, processing flow, detailed processing details (specific business logic, formulas, etc.), output data, operational rules, and notes.
                        Avoid ambiguous expressions and describe the specifications in a definitive tone.
                    `),
          },
        ];
      }
    }
    this.childStepList = this.advancedExpertiseList.map(
      (target) => new Step0015_AdvancedExpertiseDetailChil(target)
    );
  }
}

class Step0020_FeatureListDetailToJsonFormat extends BaseStepDomainModelGenerator {
  // model: GPTModels = 'gpt-3.5-turbo';
  format: StepOutputFormat = StepOutputFormat.JSON;
  constructor() {
    super();
    this.chapters = [
      {
        title: `Instructions`,
        contentJa: Utils.trimLines(`
                与えられた機能一覧（詳細）をよく理解して、指定されたJson形式を作成してください。
            `),
        contentEn: Utils.trimLines(`
                Please thoroughly understand the given list of functions (details) and create the specified Json format.
            `),
      },
      {
        title: "Input Document",
        content: getStepInstance(Step0010_FeatureListSummaryToFeatureListDetail)
          .formed,
      },
      {
        title: "Output Format",
        contentJa: Utils.trimLines(`
                出力フォーマットは以下の通りです。
                \`\`\`json
                {"featureList":["feature1","feature2","feature3"]}
                \`\`\`
            `),
        contentEn: Utils.trimLines(`
                The output format is as follows.
                \`\`\`json
                {"featureList":["feature1","feature2","feature3"]}
                \`\`\`
            `),
      },
    ];
  }
}

// # Instructions

// これから提示する設計書をよく読んで、Entity一覧の「債権管理関連のエンティティ」の属性を考えてください。
// ValueObject、Enumを含む場合はそれらについても記載してください。
// Entity一覧に載っていないEntityを追加した場合はそれも明示してください。
// 貸付管理システムの全体的な機能とビジネスルールを考慮して設計してください。

class Step0030_DesignSummary extends MultiStepDomainModelGenerator {
  featureList: string[];
  constructor() {
    super();
    const featureListDetailMarkdown = getStepInstance(
      Step0010_FeatureListSummaryToFeatureListDetail
    ).formed;
    // const advancedExpertiseJson = JSON.parse(getStepInstance(Step0013_AdvancedExpertiseListJson).formed).advancedExpertiseList;
    const step0015_AdvancedExpertiseDetail = getStepInstance(
      Step0015_AdvancedExpertiseDetail
    );
    const advancedExpertiseMap =
      step0015_AdvancedExpertiseDetail.childStepList.reduce(
        (acc, target, index) => {
          if (
            !acc[
            step0015_AdvancedExpertiseDetail.advancedExpertiseList[index]
              .featureName
            ]
          ) {
            acc[
              step0015_AdvancedExpertiseDetail.advancedExpertiseList[
                index
              ].featureName
            ] = "";
          } else {
          }
          acc[
            step0015_AdvancedExpertiseDetail.advancedExpertiseList[
              index
            ].featureName
          ] =
            acc[
            step0015_AdvancedExpertiseDetail.advancedExpertiseList[index]
              .featureName
            ] +
            "\n\n---\n\n" +
            target.result;
          return acc;
        },
        {} as { [key: string]: string }
      );
    // console.log(advancedExpertiseMap);

    class Step0030_DesignSummaryChil extends BaseStepDomainModelGenerator {
      // model: GPTModels = 'gpt-3.5-turbo';
      constructor(public feature: string) {
        super();

        // 複数並列処理するので、被らないようにラベルを設定する。（これがログファイル名になる）
        this.label = `${this.constructor.name}_${feature}`; // Utils.safeFileNameはファイル名として使える文字だけにするメソッド。
        // 個別の指示を作成。
        this.chapters = [
          {
            title: `Instructions`,
            contentJa: Utils.trimLines(`
                            与えられた機能一覧（詳細）をよく理解して、担当機能の詳細化を行ってください。
                            あなたの担当は「${feature}」です。
                        `),
            contentEn: Utils.trimLines(`
                            Please thoroughly understand the given list of functions (details) and create the specified Json format.
                            Your responsibility is "${feature}".
                        `),
          },
          {
            title: "Input Document",
            content: Utils.addMarkdownDepth(
              featureListDetailMarkdown + advancedExpertiseMap[feature] || "",
              2
            ),
          },
          {
            title: "Output Format",
            contentJa: Utils.trimLines(`
                            概要、UI/UX要件、バックエンド要件、ビジネスルール、処理詳細補足（具体的なビジネスロジックや計算式など）、運用ルール、備考について、具体的かつ詳細に記述してください。
                            機能名をタイトルとするMarkdown形式で記述してください。
                        `),
            contentEn: Utils.trimLines(`
                            Please describe the overview, UI/UX requirements, backend requirements, business rules, detailed processing details (specific business logic, formulas, etc.), operational rules, and notes in a specific and detailed manner.
                            Describe in Markdown format with the function name as the title.
                        `),
          },
        ];
      }
    }

    // 前のステップの結果を読み込む（ステップを new して .formed でそのステップの結果にアクセスできる）
    const _tmp = JSON.parse(
      getStepInstance(Step0020_FeatureListDetailToJsonFormat).formed
    );
    this.featureList = _tmp.featureList;
    // childStepListを組み立て。
    this.childStepList = this.featureList.map(
      (targetName) =>
        new Step0030_DesignSummaryChil(Utils.safeFileName(targetName))
    );
  }

  postProcess(result: string[]): string[] {
    // 全部まとめてファイルに出力する。
    const mas = this.childStepList.reduce(
      (acc: { [key: string]: string }, step: BaseStep, index: number) => {
        const feature = (step as any).feature;
        acc[feature] = step.formed;
        // "機能"の有無で取りこぼしを防ぐ。
        acc[feature.replace(/機能$/g, "")] = step.formed;
        acc[feature + "機能"] = step.formed;
        acc[feature.replace(/機能の詳細化$/g, "")] = step.formed;
        acc[feature + "機能の詳細化"] = step.formed;
        acc[feature.replace(/の詳細化$/g, "")] = step.formed;
        acc[feature + "の詳細化"] = step.formed;
        return acc;
      },
      {} as { [key: string]: string }
    );

    const outputFileName = `results/${this.agentName}/${PROJECT_NAME}/FeatureDocs.json`;
    fss.writeFileSync(outputFileName, JSON.stringify(mas, null, 2));
    return result;
  }
}

class Step0031_DesignSummaryReview extends BaseStepDomainModelGenerator {
  // model: GPTModels = 'gpt-3.5-turbo';
  format: StepOutputFormat = StepOutputFormat.JSON;
  constructor() {
    super();

    this.chapters = [
      {
        title: `Instructions`,
        contentJa: Utils.trimLines(`
                以下の設計書について、設計書間での整合性が取れているかを確認してください。

                - 機能の重複が無いか。
                - 足りていない機能が無いか。

                上記のポイントについて確認した結果、修正すべき設計書と修正内容をリストアップしてください。
                全体の整合性が取れている場合はinstructionsとして空の配列を返してください。
            `),
        contentEn: Utils.trimLines(`
                Please check whether the design documents are consistent with each other.

                - Is there any duplication of functions?
                - Are there any missing functions?

                After checking the above points, list the design documents that need to be modified and the modifications.
                If the overall consistency is maintained, return an empty array as instructions.
            `),
      },
      {
        title: "設計書",
        content: Utils.setMarkdownBlock(
          getStepInstance(Step0030_DesignSummary)
            .childStepList.map((step: BaseStep) => step.formed)
            .join("\n\n---\n\n"),
          "markdown"
        ),
      },
      {
        title: "Output Format",
        contentJa: Utils.trimLines(`
                出力フォーマットは以下の通りです。

                \`\`\`json
                {"instructions":[{"title":"設計書名","content":["修正内容",]},{"title":"設計書名","content":["修正内容",]}]}
                \`\`\`
            `),
        contentEn: Utils.trimLines(`
                The output format is as follows.
                \`\`\`json
                {"instructions":[{"title":"Document Name","content":["Modification",]},{"title":"Document Name","content":["Modification",]}]}
                \`\`\`
            `),
      },
    ];
  }
}

class Step0033_DesignSummaryRefine extends MultiStepDomainModelGenerator {
  instructions!: { title: string; content: string[] }[];
  constructor() {
    super();
    class Step0033_DesignSummaryRefineChil extends BaseStepDomainModelGenerator {
      // model: GPTModels = 'gpt-3.5-turbo';
      constructor(
        public instruction: {
          title: string;
          content: string[];
          beforeContent: string;
        }
      ) {
        super();

        // 複数並列処理するので、被らないようにラベルを設定する。（これがログファイル名になる）
        this.label = `${this.constructor.name}_${Utils.safeFileName(
          instruction.title
        )}`; // Utils.safeFileNameはファイル名として使える文字だけにするメソッド。
        // 個別の指示を作成。
        this.chapters = [
          {
            title: `Instructions`,
            contentJa: Utils.trimLines(`
                            以下のレビュー指摘に基づいて与えられた設計書を修正してください。

                            ${instruction.content.map((target) => "- " + target).join("\n")}
                            `),
            contentEn: Utils.trimLines(`
                            Please modify the given design document based on the following review comments.

                            ${instruction.content.map((target) => "- " + target).join("\n")}`),
          },
          {
            title: "Input Document",
            content: Utils.setMarkdownBlock(
              instruction.beforeContent,
              "markdown"
            ),
          },
        ];
      }
    }

    // 前のステップの結果を読み込む（ステップを new して .formed でそのステップの結果にアクセスできる）
    const _tmp = JSON.parse(
      getStepInstance(Step0031_DesignSummaryReview).formed
    );
    this.instructions = _tmp.instructions;
    // childStepListを組み立て。
    this.childStepList = getStepInstance(Step0030_DesignSummary)
      .childStepList.map((step: BaseStep) => {
        const name = (step as any).feature;
        const target = this.instructions.find(
          (target) =>
            target.title === name ||
            `${target.title}機能` === name ||
            target.title === `${name}機能` ||
            `${target.title}機能の詳細化` === name ||
            target.title === `${name}機能の詳細化`
        );
        return { ...target, beforeContent: step.formed };
      })
      .filter((target) => target.title && target.content)
      .map((target) => new Step0033_DesignSummaryRefineChil(target as any));
  }

  postProcess(result: string[]): string[] {
    // 全部まとめてファイルに出力する。
    // const reportList = result.map((targetName: string, index: number) => `# ${this.featureList[index]}\n\n${targetName}`);
    const reportList = result.map(
      (targetName: string, index: number) => `${targetName}`
    );
    const outputFileName = `results/${this.agentName}/${PROJECT_NAME}/summary/${this.constructor.name
      }_${Utils.formatDate(new Date(), "yyyyMMddHHmmssSSS")}-report_all.md`;
    fss.writeFileSync(outputFileName, reportList.join("\n---\n"));
    return result;
  }
}

class Step0034_DesignSummaryRefineReview extends BaseStepDomainModelGenerator {
  // model: GPTModels = 'gpt-3.5-turbo';
  format: StepOutputFormat = StepOutputFormat.JSON;
  constructor() {
    super();

    this.chapters = [
      {
        title: `Instructions`,
        contentJa: Utils.trimLines(`
                以下の設計書について、設計書間での整合性が取れているかを確認してください。

                - 機能の重複が無いか。⇒機能の重複がある場合は、どちらかを削除するべきか決めてください。
                - 足りていない機能が無いか。⇒一方の設計書で必要とされている機能が他方の設計書に無い場合は、どちらかに追加するべきか決めてください。

                上記のポイントについて確認した結果、修正すべき設計書と修正内容をリストアップしてください。
                全体の整合性が取れている場合はinstructionsとして空の配列を返してください。
            `),
        contentEn: Utils.trimLines(`
                Please check whether the design documents are consistent with each other.

                - Is there any duplication of functions? ⇒ If there is a duplication of functions, decide which one to delete.
                - Are there any missing functions? ⇒ If a function required in one document is missing in another document, decide which one to add.

                After checking the above points, list the design documents that need to be modified and the modifications.
                If the overall consistency is maintained, return an empty array as instructions.
            `),
      },
      {
        titleJa: "設計書",
        titleEn: "Design Document",
        content: Utils.setMarkdownBlock(
          getStepInstance(Step0033_DesignSummaryRefine)
            .childStepList.map((step: BaseStep) => step.formed)
            .join("\n\n---\n\n"),
          "markdown"
        ),
      },
      {
        title: "Output Format",
        contentJa: Utils.trimLines(`
                出力フォーマットは以下の通りです。

                \`\`\`json
                {"instructions":[{"title":"設計書名","content":["修正内容",]},{"title":"設計書名","content":["修正内容",]}]}
                \`\`\`
            `),
        contentEn: Utils.trimLines(`
                The output format is as follows.
                \`\`\`json
                {"instructions":[{"title":"Document Name","content":["Modification",]},{"title":"Document Name","content":["Modification",]}]}
                \`\`\`
            `),
      },
    ];
  }
}

class Step0040_EntityList extends BaseStepDomainModelGenerator {
  constructor() {
    super();
    this.chapters = [
      {
        title: `Instructions`,
        contentJa: Utils.trimLines(`
                これから提示する設計書をよく読んで、ドメイン駆動設計の要領でEntityを抽出してください。
                出力形式は「サンプル出力」を参考にしてください。
                Enumは不要です。
            `),
        contentEn: Utils.trimLines(`
                Please read the following design document carefully and extract the Entity in the manner of domain-driven design.
                Please refer to the "Sample Output" for the output format.
                Enum is not required.
            `),
        // Entityの名前はPasCalCaseで記述してください。(OJTのように、大文字が連続する名前は禁止です。Ojtと書いてください。)
        children: [
          {
            titleJa: `評価ポイント`,
            titleEn: `Evaluation Points`,
            contentJa: Utils.trimLines(`
                    Entity設計の評価ポイントは以下の二点です。
                    - **エンティティの明確さと適切性の評価** : エンティティの明確さと適切性を評価します。DDDでは、エンティティはビジネスドメインの核となる概念であり、その特性や関連を明確に表現する必要があります。
                    - **結合度と凝集度の評価** : エンティティ間の結合度と凝集度を評価します。理想的には、エンティティ間の結合は低く、凝集度は高いほうが望ましいです。過度な結合は、エンティティの再利用性を低下させ、凝集度の低いエンティティは、ビジネスドメインの概念を適切に表現できない可能性があります。
                `),
            contentEn: Utils.trimLines(`
                    The evaluation points for entity design are as follows.
                    - **Evaluation of clarity and appropriateness of entities**: Evaluate the clarity and appropriateness of entities. In DDD, entities are the core concepts of the business domain and need to clearly express their characteristics and relationships.
                    - **Evaluation of coupling and cohesion**: Evaluate the coupling and cohesion between entities. Ideally, low coupling and high cohesion between entities are desirable. Excessive coupling reduces the reusability of entities, and entities with low cohesion may not adequately represent the concepts of the business domain.
                `),
          },
          {
            titleJa: `サンプル出力`,
            titleEn: `Sample Output`,
            contentJa: Utils.setMarkdownBlock(
              Utils.trimLines(`
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
                `),
              "markdown"
            ),
            contentEn: Utils.setMarkdownBlock(
              Utils.trimLines(`
                    ### Order Management Related Entities:
                    1. **Order** - An entity that contains customer order information. It has attributes such as order ID, order date, customer details, list of ordered items, total amount, payment status, etc.
                    2. **Product** - An entity representing the product purchased in an order. It has attributes such as product ID, product name, price, inventory status, etc.
                    3. **Customer** - An entity representing a customer who places an order. It has attributes such as customer ID, name, contact information, shipping address, order history, etc.
                    4. **Payment** - An entity representing payment information for an order. It has attributes such as payment ID, order ID, payment method, payment status, payment date and time, etc.
                    5. **Shipping** - An entity representing shipping information for an order. It has attributes such as shipping ID, order ID, shipping address, shipping status, scheduled delivery date, etc.

                    ### Employee Management Related Entities:
                    1. **Employee** - An entity that contains personal and job information of employees. It has attributes such as employee ID, name, address, phone number, email address, department, position, date of joining, etc.
                    2. **Department** - An entity representing the department to which employees belong. It has attributes such as department ID, department name, department head, department function/purpose, etc.
                    3. **Project** - An entity representing the projects in which employees are involved. It has attributes such as project ID, project name, start date, end date, project purpose, list of employees involved in the project, etc.
                    4. **Attendance** - An entity that records the attendance status of employees. It has attributes such as attendance record ID, employee ID, date of attendance, time of arrival, time of departure, working hours, etc.
                    5. **PerformanceReview** - An entity representing the performance evaluation of employees. It has attributes such as evaluation ID, employee ID, evaluation period, evaluator, evaluation result, feedback comments, etc.
                `),
              "markdown"
            ),
          },
        ],
      },
      {
        titleJa: "設計書",
        titleEn: "Design Document",
        children: [
          {
            titleJa: `機能設計書`,
            titleEn: `Feature Design Document`,
            content: Utils.addMarkdownDepth(
              getStepInstance(Step0030_DesignSummary)
                .childStepList.map((step: BaseStep) => step.formed)
                .join("\n\n"),
              2
            ),
            // }, { // 何回かやったけど高度な機能からEntityが抽出されるケースは多くはなかったので、なくてもいいのかもしれない。。
            //     title: `高度な機能の詳細設計書`,
            //     contentJa: Utils.addMarkdownDepth(getStepInstance(Step0015_AdvancedExpertiseDetail).childStepList.map((step: BaseStep) => step.formed).join('\n\n'), 2),
          },
        ],
      },
    ];

    this.refineMessages = [
      {
        role: "user",
        content:
          this.lang == "ja"
            ? Utils.trimLines(`
                    ありがとうございます。
                    Entity一覧に不足が無いか確認し、不足があれば追加してください。
                    出力形式は先程と同様としてください。
                `)
            : Utils.trimLines(`
                    Thank you.
                    Please check if there are any missing entities in the entity list and add them if necessary.
                    Please use the same output format as before.
                `),
        // contentEn: Utils.trimLines(`
        //     Thank you.
        //     Please check if there are any missing entities in the entity list and add them if necessary.
        //     Please use the same output format as before.
        // `),

        // }, {
        //     role: 'user',
        //     content: Utils.trimLines(`
        //         ありがとうございます。
        //         同様にValueObject、Enumを抽出してください。
        //     `),
        // }, {
        //     role: 'user',
        //     content: Utils.trimLines(`
        //         設計書に照らして、ValueObjectsの属性、およびEnumsの抽出が十分かもう一度チェックしてください。
        //         先程とは別の視点から設計書を読み直すことも重要です。
        //         不十分であれば、追加分のalueObjects、およびEnumsのみを提示してください。
        //         形式は先ほどと同じでお願いします。
        //     `),
        // }, {
        //     role: 'user',
        //     content: Utils.trimLines(`
        //         Entityごとに、関係する設計書名リストを整理してください。
        //         関係は1対1ということはないはずであり、関係が薄めのものでもなるべく拾うようにしてください。
        //         同時に、ValueObject、EnumとEntityの関係も整理してください。

        //         出力フォーマットは以下の通りです。
        //         \`\`\`json
        //         {
        //             "entityFeatureMapping":{"entity1":["機能1","機能2"],"entity2":["機能3","機能4"]},
        //             "valueObjectEntityMapping":{"valueObject1":["entity1","entity2"],"valueObject2":["entity3","entity4"]},
        //             "enumEntityMapping":{"enum1":["entity1","entity2"],"enum2":["entity3","entity4"]}
        //         }
        //         \`\`\`
        //     `)
      },
    ];
  }

  postProcess(result: string): string {
    const entityObject: Record<string, Record<string, string>> = {};
    let groupName = "";
    // refineしたものを結合する。
    Array.from(Utils.range(this.refineMessages.length + 1)).forEach((index) => {
      this.getRefineData(index)
        .split("\n")
        .forEach((target) => {
          if (
            target.startsWith("### ") &&
            (target.endsWith("のエンティティ:") ||
              target.endsWith(" Related Entities:")) &&
            target.length > 5
          ) {
            groupName =
              target
                .replace("### ", "")
                .replace("のエンティティ:", "")
                .replace(" Related Entities:", "")
                .replace(/関連$/g, "")
                .replace(/機能$/g, "") + "機能";
            if (entityObject[groupName]) {
            } else {
              entityObject[groupName] = {};
            }
          } else {
            const [_, _entityName, entityDescription] =
              target.match(/^(?:[0-9]+\.|-) \*\*(.*)\*\* - (.*)/) || [];
            if (_entityName && entityDescription) {
              // 読み込み時にEntity名を標準化しておく。記号を削除する。PasCalCaseにする。末尾にEntityが付いている場合は削除する。
              const entityName = Utils.safeFileName(
                Utils.toPascalCase(_entityName)
              ).replace(/Entity$/g, "");
              entityObject[groupName][entityName] = entityDescription;
            } else {
              // skip
            }
          }
        });
      // console.log(entityObject);
    });
    // console.log(entityObject);
    fss.writeFileSync(
      `results/${this.agentName}/${PROJECT_NAME}/EntityList.json`,
      JSON.stringify(entityObject, null, 2)
    );
    return result;
  }
}

class Step0042_EntityFeatureMapping extends BaseStepDomainModelGenerator {
  format: StepOutputFormat = StepOutputFormat.JSON;

  constructor() {
    super();
    this.loadPresetMessagesFromStep(getStepInstance(Step0040_EntityList));
    //
    this.chapters = [
      {
        contentJa: Utils.trimLines(`
                Entityごとに、関係する設計書名リストを整理してください。
                関係は1対1ということはないはずであり、関係が薄めのものでもなるべく拾うようにしてください。

                出力フォーマットは以下の通りです。
                \`\`\`json
                {
                    "entityFeatureMapping":{"entity1":["機能1","機能2"],"entity2":["機能3","機能4"]}
                }
                \`\`\`
            `),
        contentEn: Utils.trimLines(`
                Please organize a list of related design document names for each entity.
                There should not be a one-to-one relationship, and you should try to pick up as many relationships as possible, even if they are weak.

                The output format is as follows.
                \`\`\`json
                {
                    "entityFeatureMapping":{"entity1":["Feature1","Feature2"],"entity2":["Feature3","Feature4"]}
                }
                \`\`\`
            `),
      },
    ];
  }
}

// class Step0043_ValueObjectEnumList extends BaseStepDomainModelGenerator {
//     constructor() {
//         super();
//         // Step0040_EntityListのステップをプリセットプロントとして読み込む。
//         this.loadPresetMessagesFromStep(getStepInstance(Step0040_EntityList));

//         this.chapters = [{
//             contentJa: Utils.trimLines(`
//                 ありがとうございます。
//                 同様に複数のEntityで共通で利用されるValueObject、Enumを抽出してください。
//             `),
//             contentEn: Utils.trimLines(`
//                 Thank you.
//                 Similarly, extract ValueObjects and Enums that are commonly used in multiple entities.
//             `),
//         },];
//         // とりあえず一回セルフリファインを掛けておく。
//         this.refineMessages = [{
//             role: 'user',
//             content: this.lang === 'ja' ? Utils.trimLines(`
//                 設計書に照らして、共通のValueObjects、Enumsの抽出が十分かもう一度チェックしてください。
//                 先程とは別の視点から設計書を読み直すことも重要です。
//                 不十分であれば、追加分のalueObjects、およびEnumsのみを提示してください。
//                 形式は先ほどと同じでお願いします。
//             `) : Utils.trimLines(`
//                 Please check again if the extraction of common ValueObjects and Enums is sufficient based on the design document.
//                 It is also important to reread the design document from a different perspective than before.
//                 If it is insufficient, please present only the additional ValueObjects and Enums.
//                 Please use the same format as before.
//             `),
//         },];
//     }

//     postProcess(result: string): string {
//         const entityObject: Record<string, Record<string, string>> = {};
//         let groupName = '';
//         // refineしたものを結合する。
//         Array.from(Utils.range(this.refineMessages.length + 1)).forEach(index => {
//             this.getRefineData(index).split('\n').forEach(target => {
//                 // ### 追加のValueObject:
//                 if (target.startsWith('### ')) {
//                     groupName = target.endsWith('ValueObject:') ? 'ValueObject' : target.endsWith('Enum:') ? 'Enum' : '';
//                     if (entityObject[groupName]) {
//                     } else {
//                         entityObject[groupName] = {};
//                     }
//                 } else {
//                     const [_, entityName, entityDescription] = target.match(/^(?:[0-9]+\.|-) \*\*(.*)\*\* - (.*)/) || [];
//                     if (entityName && entityDescription) {
//                         // 読み込み時にEntity名を標準化しておく。
//                         const key = Utils.safeFileName(Utils.toPascalCase(entityName));
//                         if (entityObject[groupName][key]) {
//                             if (entityObject[groupName][key].length < entityDescription.length) {
//                                 // 追加済み、かつ前回読み込み分の説明文よりも長かったら更新する。
//                                 entityObject[groupName][key] = entityDescription;
//                             } else {
//                                 // 追加済み、かつ前回読み込み分の説明文の方が長かったら多分「更新無し」的なことが書いてあるだけなのでスキップする。
//                             }
//                         } else {
//                             // 追加済みでなければ追加
//                             entityObject[groupName][key] = entityDescription;
//                         }
//                     } else {
//                         // skip
//                     }
//                 }
//             });
//             // console.log(entityObject);
//         });
//         // console.log(entityObject);
//         fss.writeFileSync(`results/${this.agentName}/${PROJECT_NAME}/ValueObjectEnumList.json`, JSON.stringify(entityObject, null, 2));
//         return result;
//     }
// }

// class Step0045_EntityFeatureValueObjectMapping extends BaseStepDomainModelGenerator {
//     format: StepOutputFormat = StepOutputFormat.JSON;

//     constructor() {
//         super();
//         this.loadPresetMessagesFromStep(getStepInstance(Step0043_ValueObjectEnumList));
//         //
//         this.chapters = [{
//             contentJa: Utils.trimLines(`
//                 Entityごとに、関係する設計書名リストを整理してください。
//                 関係は1対1ということはないはずであり、関係が薄めのものでもなるべく拾うようにしてください。
//                 同時に、ValueObject、EnumとEntityの関係も整理してください。

//                 出力フォーマットは以下の通りです。
//                 \`\`\`json
//                 {
//                     "entityFeatureMapping":{"entity1":["機能1","機能2"],"entity2":["機能3","機能4"]},
//                     "valueObjectEntityMapping":{"valueObject1":["entity1","entity2"],"valueObject2":["entity3","entity4"]},
//                     "enumEntityMapping":{"enum1":["entity1","entity2"],"enum2":["entity3","entity4"]}
//                 }
//                 \`\`\`
//             `),
//             contentEn: Utils.trimLines(`
//                 Please organize a list of related design document names for each entity.
//                 There should not be a one-to-one relationship, and you should try to pick up as many relationships as possible, even if they are weak.
//                 At the same time, organize the relationship between ValueObjects, Enums, and Entities.

//                 The output format is as follows.
//                 \`\`\`json
//                 {
//                     "entityFeatureMapping":{"entity1":["機能1","機能2"],"entity2":["機能3","機能4"]},
//                     "valueObjectEntityMapping":{"valueObject1":["entity1","entity2"],"valueObject2":["entity3","entity4"]},
//                     "enumEntityMapping":{"enum1":["entity1","entity2"],"enum2":["entity3","entity4"]}
//                 }
//                 \`\`\`
//             `),
//         }];
//     }
// }

// class Step0048_ValuObjectEnumDetail extends MultiStepDomainModelGenerator {
//     valueObjectEnumMap: string[] = JSON.parse(fs.readFileSync(`results/${this.agentName}/${PROJECT_NAME}/ValueObjectEnumList.json`, 'utf-8'));
//     constructor() {
//         super();
//         const mas: Record<'entityFeatureMapping' | 'valueObjectEntityMapping' | 'enumEntityMapping', Record<string, string[]>> = JSON.parse(getStepInstance(Step0045_EntityFeatureValueObjectMapping).formed);
//         const entityFeatureMapping = mas.entityFeatureMapping;
//         const valueObjectEntityMapping = mas.valueObjectEntityMapping;
//         const enumEntityMapping = mas.enumEntityMapping;
//         // const designSummaryMap: Record<string, string> = JSON.parse(getStepInstance(Step0030_DesignSummary).formed);
//         const designSummaryMap: Record<string, string> = JSON.parse(fs.readFileSync(`results/${this.agentName}/${PROJECT_NAME}/FeatureDocs.json`, 'utf-8')) as { [key: string]: string };
//         class Step0048_ValuObjectEnumDetailChil extends BaseStepDomainModelGenerator {
//             systemMessageJa: string = `経験豊富で優秀なビジネスアナリスト。`;
//             systemMessageEn: string = `An experienced and excellent business analyst.`;
//             constructor(public groupName: string, public entityName: string, public entityDescription: string) {
//                 super();
//                 this.label = `${this.constructor.name}_${Utils.safeFileName(groupName)}_${Utils.safeFileName(entityName)}`; // Utils.safeFileNameはファイル名として使える文字だけにするメソッド。
//                 // entityNameから関連する機能名を取得する。
//                 const featureNameList = Array.from(new Set([...(valueObjectEntityMapping[entityName] || []), ...(enumEntityMapping[entityName] || [])])).map(entityName => entityFeatureMapping[entityName]).flat();
//                 const childItem = groupName.toLocaleLowerCase().startsWith('enum') ? 'VALUES' : 'attributes';
//                 this.chapters = [{
//                     title: `Instructions`,
//                     contentJa: Utils.trimLines(`
//                         これから提示する設計書をよく読んでシステム全体像を把握してください。
//                         そのうえで、Common ValueObject/Enum一覧の${groupName}である「${entityName}」の ${childItem} に不足が無いかをチェックしてください。
//                         チェックした結果、適切に改善された${childItem}を提示してください。
//                         担当外のものについては対象外としてください。
//                     `),
//                     contentEn: Utils.trimLines(`
//                         Please read the following design document carefully and understand the overall system.
//                         Then, check if there are any missing ${childItem} in the Common ValueObject/Enum list for ${groupName}, " ${entityName}".
//                         After checking, please present the improved ${childItem}.
//                         Please exclude items that are not relevant.
//                     `),
//                 }, {
//                     titleJa: '設計書', titleEn: 'Design Document',
//                     children: [{
//                         titleJa: `機能設計書（関連するもののみ抜粋）`, titleEn: `Feature Design Document (Extract only related items)`,
//                         // content: Utils.addMarkdownDepth(getStepInstance(Step0030_DesignSummary).childStepList.map((step: BaseStep) => step.formed).join('\n\n'), 2),
//                         // 抽出版
//                         content: Utils.addMarkdownDepth(featureNameList.map(functionName => designSummaryMap[functionName]).join('\n\n'), 2),
//                     }, {
//                         titleJa: `Entity一覧`, titleEn: `Entity List`,
//                         content: Utils.addMarkdownDepth(getStepInstance(Step0040_EntityList).formed, 1),
//                     }, {
//                         titleJa: `Common ValueObject/Enum一覧`, titleEn: `Common ValueObject/Enum List`,
//                         content: Utils.addMarkdownDepth(getStepInstance(Step0043_ValueObjectEnumList).getRefineData(0), 1),
//                     }, {
//                         titleJa: `Common ValueObject/Enum一覧（追加）`, titleEn: `Common ValueObject/Enum List (Additional)`,
//                         content: Utils.addMarkdownDepth(getStepInstance(Step0043_ValueObjectEnumList).getRefineData(1), 1),
//                     }],
//                 }, {
//                     titleJa: 'ネーミングルール', titleEn: 'Naming Rules',
//                     contentJa: Utils.trimLines(`
//                         - Attributesの名前はCamelCase
//                         - ValueObjects、Enumsの名前はPasCalCase
//                         - Enumsの値は全て大文字のSNAKE_CASE
//                     `),
//                     contentEn: Utils.trimLines(`
//                         - The name of the attribute is CamelCase
//                         - The name of ValueObjects and Enums is PasCalCase
//                         - The value of Enums is all uppercase SNAKE_CASE
//                     `),
//                 }, {
//                     title: 'Output Sample',
//                     contentJa: Utils.trimLines(`
//                         出力形式は以下のサンプルを参考にしてください。

//                         ### RiskLevel EnumのVALUES

//                         \`\`\`plaintext
//                         1. LOW - 低リスク: 顧客の信用スコアが高く、財務状況が安定しており、申請情報に問題がない場合に割り当てられます。
//                         2. MEDIUM - 中リスク: 顧客の信用スコアが平均的で、財務状況に若干の問題があるか、または申請情報に小さな問題がある場合に割り当てられます。
//                         3. HIGH - 高リスク: 顧客の信用スコアが低く、財務状況が不安定であるか、申請情報に大きな問題がある場合に割り当てられます。
//                         \`\`\`

//                         この定義は、設計書の「リスク管理機能」のセクションにおける「UI/UX要件」でのリスク評価結果の表示要件（リスクレベル（低、中、高）とその根拠を明確に表示）に基づいています。
//                         また、リスク評価アルゴリズムの処理詳細補足にも対応しており、信用スコア、財務状況、申請情報を基にリスクレベルを評価するビジネスルールを反映しています。
//                     `),
//                     contentEn: Utils.trimLines(`
//                         Please refer to the following sample for the output format.

//                         ### RiskLevel Enum VALUES

//                         \`\`\`plaintext
//                         1. LOW - Low risk: Assigned when the customer's credit score is high, the financial situation is stable, and there are no issues with the application information.
//                         2. MEDIUM - Medium risk: Assigned when the customer's credit score is average, there are some issues with the financial situation, or there are minor issues with the application information.
//                         3. HIGH - High risk: Assigned when the customer's credit score is low, the financial situation is unstable, or there are significant issues with the application information.
//                         \`\`\`

//                         This definition is based on the display requirements for risk assessment results (display of risk level (low, medium, high) and its basis) in the "UI/UX requirements" section of the "Risk Management" feature in the design document.
//                         It also reflects the business rules for evaluating risk levels based on credit scores, financial conditions, and application information, which are also detailed in the risk assessment algorithm processing details.
//                     `),
//                 }];

//                 // // とりあえず一回セルフリファインを掛けておく。
//                 // this.refineMessages.push({
//                 //     role: 'user', contentJa: Utils.trimLines(`
//                 //         設計書に照らして、${entityName}や、ValueObjectsの属性、およびEnumsの値が十分かチェックしてください。
//                 //         十分であれば特に何もせず、不十分であれば追加設計を提示してください。
//                 //     `)
//                 // });
//             }
//         }
//         // childStepListを組み立て。
//         this.childStepList = Object.entries(this.valueObjectEnumMap).map(([groupName, entityList]) =>
//             Object.entries(entityList).map(([entityName, entityDescription]) => new Step0048_ValuObjectEnumDetailChil(groupName, entityName, entityDescription))
//         ).flat();
//     }
// }

class Step0050_AllAtOneceEntityAttributes extends BaseStepDomainModelGenerator {
  entityListGroupMap: string[] = JSON.parse(
    fs.readFileSync(
      `results/${this.agentName}/${PROJECT_NAME}/EntityList.json`,
      "utf-8"
    )
  );
  systemMessageJa: string = `経験豊富で優秀なビジネスアナリスト。`;
  systemMessageEn: string = `An experienced and excellent business analyst.`;
  constructor() {
    super();
    const entityFeatureMapping: Record<string, string[]> = JSON.parse(
      getStepInstance(Step0042_EntityFeatureMapping).formed
    ).entityFeatureMapping;
    Object.keys(entityFeatureMapping).forEach((key) => {
      entityFeatureMapping[Utils.toPascalCase(key)] = entityFeatureMapping[key];
    });
    // const designSummaryMap: Record<string, string> = JSON.parse(getStepInstance(Step0030_DesignSummary).formed);
    // const designSummaryMap: Record<string, string> = JSON.parse(fs.readFileSync(`results/${this.agentName}/${PROJECT_NAME}/FeatureDocs.json`, 'utf-8')) as { [key: string]: string };
    this.chapters = [
      {
        title: `Instructions`,
        contentJa: Utils.trimLines(`
                        これから提示する設計書をよく読んで、Entity一覧の設計を詳細化してください。
                        注意点は以下の通りです。
                        - 出力はjavaのクラス形式でお願いします。
                        - EntityのIdはLong型としてください。関連するEntityのIdもLong型です。
                        - 日付型はLocalDate、LocalDateTimeとしてください。
                        - ValueObjects、Enumsを含む場合はそれらについても記載してください。
                        - Attributesの名前はCamelCaseで記述してください。
                        - ValueObjects、Enumsの名前はPasCalCaseで記述してください。
                        - Enumsの値は全て大文字のSNAKE_CASEで記述してください。
                        - Getter/Setter、コンストラクタ は不要です。
                    `),
        contentEn: Utils.trimLines(`
                        Please read the following design document carefully and detail the design of the Entity list.
                        The points to note are as follows.
                        - The output should be in the form of a Java class.
                        - The Entity's ID should be of type Long. The IDs of related Entities should also be of type Long.
                        - Date types should be LocalDate and LocalDateTime.
                        - If there are ValueObjects and Enums, please describe them as well.
                        - The name of the attribute is written in CamelCase.
                        - The name of ValueObjects and Enums is written in PasCalCase.
                        - The value of Enums should be written in all uppercase SNAKE_CASE.
                        - Access modifiers such as getter/setter, and constructors are not necessary.
                    `),
      },
      {
        titleJa: "設計書",
        titleEn: "Design Document",
        children: [
          {
            titleJa: `機能設計書（関連するもののみ抜粋）`,
            titleEn: `Feature Design Document (Extract only related items)`,
            contentJa: Utils.addMarkdownDepth(
              getStepInstance(Step0030_DesignSummary)
                .childStepList.map((step: BaseStep) => step.formed)
                .join("\n\n"),
              2
            ),
            // 抽出版
            // content: Utils.addMarkdownDepth(entityFeatureMapping[entityName].map(functionName => designSummaryMap[functionName]).join('\n\n'), 2),
          },
          {
            titleJa: `Entity一覧`,
            titleEn: `Entity List`,
            content: Utils.addMarkdownDepth(
              getStepInstance(Step0040_EntityList).formed,
              1
            ),
            // }, {
            //     title: `Common`,
            //     contentJa: Utils.addMarkdownDepth(getStepInstance(Step0043_ValueObjectEnumList).formed, 1),
          },
        ],
      },
    ];

    // とりあえず一回セルフリファインを掛けておく。
    this.refineMessages.push({
      role: "user",
      content:
        this.lang === "ja"
          ? Utils.trimLines(`
                        設計書に照らして、Entityの属性、ValueObjectsの属性、およびEnumsの値が十分かチェックしてください。
                        十分であれば特に何もせず、不十分であれば追加設計を提示してください。
                    `)
          : Utils.trimLines(`
                        Please check if the attributes of the Entity, ValueObjects, and Enums are sufficient based on the design document.
                        If sufficient, do nothing in particular. If insufficient, please present additional design.
                    `),
    });
  }
}

class Step0050_EntityAttributes extends MultiStepDomainModelGenerator {
  entityListGroupMap: string[] = JSON.parse(
    fs.readFileSync(
      `results/${this.agentName}/${PROJECT_NAME}/EntityList.json`,
      "utf-8"
    )
  );
  constructor() {
    super();
    const entityFeatureMapping: Record<string, string[]> = JSON.parse(
      getStepInstance(Step0042_EntityFeatureMapping).formed
    ).entityFeatureMapping;
    Object.keys(entityFeatureMapping).forEach((key) => {
      entityFeatureMapping[Utils.toPascalCase(key)] = entityFeatureMapping[key];
    });
    // const designSummaryMap: Record<string, string> = JSON.parse(getStepInstance(Step0030_DesignSummary).formed);
    const designSummaryMap: Record<string, string> = JSON.parse(
      fs.readFileSync(
        `results/${this.agentName}/${PROJECT_NAME}/FeatureDocs.json`,
        "utf-8"
      )
    ) as { [key: string]: string };
    class Step0050_EntityAttributesChil extends BaseStepDomainModelGenerator {
      systemMessageJa: string = `経験豊富で優秀なビジネスアナリスト。`;
      systemMessageEn: string = `An experienced and excellent business analyst.`;
      constructor(public entityName: string) {
        super();
        this.label = `${this.constructor.name}_${Utils.safeFileName(
          entityName
        )}`; // Utils.safeFileNameはファイル名として使える文字だけにするメソッド。
        this.chapters = [
          {
            title: `Instructions`,
            contentJa: Utils.trimLines(`
                        これから提示する設計書をよく読んで、Entity一覧の「${entityName}」のAttributesを考えてください。
                        注意点は以下の通りです。
                        - EntityのIdはLong型としてください。関連するEntityのIdもLong型です。
                        - 日付型はLocalDate、LocalDateTimeとしてください。
                        - ValueObjects、Enumsを含む場合はそれらについても記載してください。
                        - Attributesの名前はCamelCaseで記述してください。
                        - ValueObjects、Enumsの名前はPasCalCaseで記述してください。
                        - Enumsの値は全て大文字のSNAKE_CASEで記述してください。
                        - Getter/Setter、コンストラクタ は不要です。
                        - 「${entityName}」のみを出力対象としてください。
                    `),
            contentEn: Utils.trimLines(`
                        Please read the following design document carefully and consider the Attributes of "${entityName}" in the Entity list.
                        The points to note are as follows.
                        - The Entity's ID should be of type Long. The IDs of related Entities should also be of type Long.
                        - Date types should be LocalDate and LocalDateTime.
                        - If there are ValueObjects and Enums, please describe them as well.
                        - The name of the attribute is written in CamelCase.
                        - The name of ValueObjects and Enums is written in PasCalCase.
                        - The value of Enums should be written in all uppercase SNAKE_CASE.
                        - Access modifiers such as getter/setter, and constructors are not necessary.
                        - Please output only "${entityName}".
                    `),
          },
          {
            titleJa: "設計書",
            titleEn: "Design Document",
            children: [
              {
                titleJa: `機能設計書（関連するもののみ抜粋）`,
                titleEn: `Feature Design Document (Extract only related items)`,
                // contentJa: Utils.addMarkdownDepth(getStepInstance(Step0030_DesignSummary).childStepList.map((step: BaseStep) => step.formed).join('\n\n'), 2),
                // 抽出版
                content: Utils.addMarkdownDepth(
                  entityFeatureMapping[entityName]
                    .map((functionName) => designSummaryMap[functionName])
                    .join("\n\n"),
                  2
                ),
              },
              {
                titleJa: `Entity一覧`,
                titleEn: `Entity List`,
                content: Utils.addMarkdownDepth(
                  getStepInstance(Step0040_EntityList).formed,
                  1
                ),
                // }, {
                //     title: `Common`,
                //     contentJa: Utils.addMarkdownDepth(getStepInstance(Step0043_ValueObjectEnumList).formed, 1),
              },
            ],
          },
        ];

        // とりあえず一回セルフリファインを掛けておく。
        this.refineMessages.push({
          role: "user",
          content:
            this.lang === "ja"
              ? Utils.trimLines(`
                        設計書に照らして、${entityName}や、ValueObjectsの属性、およびEnumsの値が十分かチェックしてください。
                        十分であれば特に何もせず、不十分であれば追加設計を提示してください。
                    `)
              : Utils.trimLines(`
                        Please check if the attributes of ${entityName}, ValueObjects, and Enums are sufficient based on the design document.
                        If they are sufficient, there is no need to do anything special. If they are insufficient, please present additional designs.
                    `),
        });
      }
    }
    // childStepListを組み立て。
    this.childStepList = Object.entries(this.entityListGroupMap)
      .map(([groupName, entityList]) =>
        Object.entries(entityList).map(
          ([entityName, entityDescription]) =>
            new Step0050_EntityAttributesChil(entityName)
        )
      )
      .flat();
  }
}

class Step0052_EntityAttributesMerge extends MultiStepDomainModelGenerator {
  constructor() {
    super();
    const step0050_EntityAttributes = getStepInstance(
      Step0050_EntityAttributes
    );
    class Step0052_EntityAttributesMergeChil extends BaseStepDomainModelGenerator {
      // model: GPTModels = 'gpt-3.5-turbo';
      constructor(public index: number) {
        super();
        const beforeStep = step0050_EntityAttributes.childStepList[index];
        const entityName = (beforeStep as any).entityName;
        this.label = `${this.constructor.name}_${Utils.safeFileName(
          entityName
        )}`; // Utils.safeFileNameはファイル名として使える文字だけにするメソッド。
        this.chapters = [
          {
            title: `Instructions`,
            // 表形式でお願いします。余計な説明は不要です。
            // 列は、 Attribute Name 、Java Class、Optional、Type（ValueObjects/Enum）、Collection（List/Map）、Descriptionでお願いします。
            contentJa: Utils.trimLines(`
                        以下の設計書を理解して、Credit について、当初設計に追加設計を適用して、統合版のEntity、ValueObjects、Enums定義を作成してください。
                        javaのコードとして出力してください。コード以外は不要です。
                        EntityのIdはLong型としてください。関連するEntityのIdもLong型です。
                        日付型はLocalDate、LocalDateTimeとしてください。
                        public/privateなどのアクセス修飾子、getter/setter、コンストラクタ、コメント  は不要です。
                        ValueObjects、Enumsの名前はPasCalCaseで記述してください。
                        Enumsの値は全て大文字のSNAKE_CASEで記述してください。
                    `),
            contentEn: Utils.trimLines(`
                        Please understand the following design document and apply additional designs to Credit to create an integrated version of the Entity, ValueObjects, and Enums definitions.
                        Please output it as Java code. Anything other than code is not necessary.
                        The Entity's ID should be of type Long. The IDs of related Entities should also be of type Long.
                        Date types should be LocalDate and LocalDateTime.
                        Access modifiers such as public/private, getter/setter, constructors, and comments are not necessary.
                        Please write the names of ValueObjects and Enums in PasCalCase.
                        The values of Enums should be written in all uppercase SNAKE_CASE.
                    `),
          },
          {
            titleJa: "当初設計",
            titleEn: "Initial Design",
            content: Utils.addMarkdownDepth(beforeStep.getRefineData(0), 2),
          },
          {
            titleJa: "追加設計",
            titleEn: "Additional Design",
            content: Utils.addMarkdownDepth(beforeStep.getRefineData(1), 2),
          },
          {},
        ];
      }
    }

    // childStepListを組み立て。
    this.childStepList = Array.from(
      Utils.range(step0050_EntityAttributes.childStepList.length)
    ).map((index) => new Step0052_EntityAttributesMergeChil(index));
  }

  postProcess(result: string[]): string[] {
    const modelSources: string[] = [];
    const enumSources: string[] = [];
    const allModels: Record<string, any> = {};

    const entityNameList: string[] = getStepInstance(
      Step0050_EntityAttributes
    ).childStepList.map((step: BaseStep) => (step as any).entityName);
    const valueObjectNameList: string[] = [];
    const enumNameList: string[] = [];

    const mergedModel: {
      classes: Record<string, EntityValueObjectType>;
      enums: Record<string, EnumType>;
    } = { classes: {}, enums: {} };

    result.forEach((target, index) => {
      // Angular用のモデルを生成する。
      const models = parseJavaModelCode(target, PACKAGE_NAME);
      allModels[entityNameList[index]] = models;

      // とりあえず同じ名前のものがあればマージする方式。
      // また、EntityかValueObjectかを判定してValueObjectのリストを作成する。
      Object.entries(mergedModel).forEach(([key, stockObj]) => {
        Object.entries(models[key as "classes" | "enums"]).forEach(
          ([className, baseObj]) => {
            //  クラス名を標準化しておく。
            className = Utils.safeFileName(
              Utils.toPascalCase(className)
            ).replace(/(Entity|ValueObject|Enum)$/g, "");
            // console.log(className);
            if (className in stockObj) {
              // 既存のものにマージ
              if (key === "classes") {
                const names = (
                  stockObj[className] as { props: any[] }
                ).props.map((prop: any) => prop.name);
                baseObj.props.forEach((prop: any) => {
                  if (!names.includes(prop.name)) {
                    (stockObj[className] as { props: any[] }).props.push(prop);
                  } else {
                  }
                });
              } else {
                const values = (stockObj[className] as { values: string[] })
                  .values;
                baseObj.values.forEach((value: any) => {
                  if (!values.includes(value)) {
                    // console.log(className, value);
                    (stockObj[className] as { values: any[] }).values.push(
                      value
                    );
                  } else {
                  }
                });
              }
            } else {
              // 新規追加
              stockObj[className] = baseObj;

              if (key === "classes") {
                // valueObjectListに追加
                if (!entityNameList.includes(className)) {
                  // EntityでないものはValueObjectとして扱う。
                  valueObjectNameList.push(className);
                  stockObj[className].type = "valueObject";
                } else {
                  stockObj[className].type = "entity";
                }
              } else {
                enumNameList.push(className);
                stockObj[className].type = "enum";
              }
            }
          }
        );
      });
    });
    // console.log(valueObjectNameList);
    Object.keys(mergedModel.classes).forEach((className) => {
      const obj = mergedModel.classes[className];
      obj.annotations = obj.annotations || [];
      // Set型はJSON.stringifyで無視されてしまうので、型としては配列で持ちたいが、重複は削除したいので、
      // 収集するときはSetで、出力するときはArrayに変換する。
      const imports = new Set<string>();
      // クラスアノテーションを追加する。
      if (entityNameList.includes(className)) {
        // Entityの場合
        // 引数無しのアノテーションを追加する。
        ["Data", "NoArgsConstructor", "AllArgsConstructor", "Entity"].forEach(
          (s) => {
            obj.annotations.push(`@${s}`);
            imports.add(s);
          }
        );
        // 末尾の単語を複数形にしたスネークケースにする
        const pluralized = Utils.toSnakeCase(className)
          .split("_")
          .map((word, index, ary) =>
            index === ary.length - 1 ? Utils.pluralize(word) : word
          )
          .join("_");
        obj.annotations.push(`@Table(name = "${pluralized}")`);
        imports.add("Table");
        obj.annotations.push(`@EqualsAndHashCode(callSuper = false)`);
        imports.add("EqualsAndHashCode");

        // BaseEntityを継承する。
        imports.add("BaseEntity");
      } else if (valueObjectNameList.includes(className)) {
        // ValueObjectの場合
        // 引数無しのアノテーションを追加する。
        [
          "Data",
          "NoArgsConstructor",
          "AllArgsConstructor",
          "Embeddable",
        ].forEach((s) => {
          obj.annotations.push(`@${s}`);
          imports.add(s);
        });
      } else {
        // その他の場合
        // skip
      }

      // プロパティアノテーションを追加する。
      obj.props.forEach((prop) => {
        prop.annotations = prop.annotations || [];
        // List<String>などの場合、Stringの部分だけを抽出する。
        // TODO 二次元配列は対応していない。
        prop.strippedType = prop.type
          .replace(/.*</, "")
          .replace(/>$/, "")
          .replace(/[, ]/, "");

        // 時刻系の場合、LocalDateかLocalDateTimeに統一する。
        if (TIME_TYPE_REMAP[prop.strippedType]) {
          // TIME_TYPE_REMAPにマッチする型名をTIME_TYPE_COLUMN_DEFINITIONに変換する。
          prop.type = prop.type.replace(
            prop.strippedType,
            TIME_TYPE_REMAP[prop.strippedType]
          );
          prop.strippedType = TIME_TYPE_REMAP[prop.strippedType];
        } else {
          // 時刻系以外は何もしない。
        }

        // 素の型名をimport文に追加する。
        imports.add(prop.strippedType);
        if (prop.type.includes("<")) {
          // ジェネリクスを含む場合、import文に追加する。（だいたいList。まれにMap。Mapだと後で壊れる。）
          imports.add(prop.type.replace(/<.*$/, ""));
        }

        // 型名によってアノテーションを追加する。
        if (valueObjectNameList.includes(prop.strippedType)) {
          prop.annotations.push("@Embedded");
          imports.add("Embedded");
        } else if (enumNameList.includes(prop.strippedType)) {
          prop.annotations.push("@Enumerated(EnumType.STRING)");
          imports.add("Enumerated");
          imports.add("EnumType");
        } else if (prop.strippedType === "LocalDate") {
          prop.annotations.push("@Temporal(TemporalType.DATE)");
          imports.add("Temporal");
          imports.add("TemporalType");
        } else if (prop.strippedType === "LocalDateTime") {
          prop.annotations.push("@Temporal(TemporalType.TIMESTAMP)");
          imports.add("Temporal");
          imports.add("TemporalType");
        } else {
        }
      });

      // importsを設定する。
      obj.imports = Array.from(imports);
    });

    // 関連するクラスを探して纏めておく。設計書の連鎖を辿っていく。
    function findRelatedClassesAndEnums(
      classAndEnumChain: string[],
      className: string,
      depth: number = 0
    ) {
      // 既に探索済みの場合はスキップする。
      if (classAndEnumChain.includes(className)) {
        return;
      } else {
        // skip
      }

      // 探索済みでなければ、探索済みに追加する。
      const obj = mergedModel.classes[className];
      if (obj) {
        classAndEnumChain.push(className);
        // さらに探索する。
        obj.props.forEach((prop) => {
          findRelatedClassesAndEnums(
            classAndEnumChain,
            prop.strippedType,
            depth + 1
          );
        });
      } else if (mergedModel.enums[className]) {
        // enumの場合は、探索済みに追加するだけ。
        classAndEnumChain.push(className);
      } else {
        // skip
      }
    }
    Object.entries(mergedModel.classes).forEach(([className, obj]) => {
      obj.relatedClasses = obj.relatedClasses || [];
      findRelatedClassesAndEnums(obj.relatedClasses, className);
    });

    // console.log(valueObjectNameList);
    const javaSources = [
      // ${obj.annotations.join('\n') || Utils.TRIM_LINES_DELETE_LINE}
      // \t${prop.annotations.join('\n') || Utils.TRIM_LINES_DELETE_LINE}
      ...Object.entries(mergedModel.classes).map(([className, obj]) =>
        Utils.trimLines(`
                class ${className} {
                ${(obj as { props: any[] }).props
            .map((prop) =>
              Utils.trimLines(`
                    \t${prop.type} ${prop.name};
                `)
            )
            .join("\n")}
                }
            `)
      ),
      ...Object.entries(mergedModel.enums).map(([className, obj]) =>
        Utils.trimLines(`
                enum ${className} {
                \t${(obj as { values: string[] }).values.join(", ")}
                }
            `)
      ),
    ];

    const tsSources = [
      ...Object.entries(mergedModel.classes).map(([className, obj]) =>
        Utils.trimLines(`
                export interface ${className} {
                ${(obj as { props: any[] }).props
            .map(
              (prop) =>
                `\t${prop.name}: ${javaTypeToTypescript(prop.type)};`
            )
            .join("\n")}
                }
            `)
      ),
      ...Object.entries(mergedModel.enums).map(([className, obj]) =>
        Utils.trimLines(`
                export enum ${className} {
                \t${(obj as { values: string[] }).values.join(", ")}
                }
            `)
      ),
    ];

    if (false) {
      // 全量をちゃんとチェックする方式。やっぱ面倒になったのでやめた。
      const stock: Record<string, Record<string, string[]>> = {
        classes: {},
        enums: {},
      };
      Object.entries(allModels).map(([entityName, entityDetail]) => {
        Object.entries(stock).forEach(([key, stockObj]) => {
          Object.entries((entityDetail as any)[key]).forEach(
            ([className, obj]) => {
              stockObj[className] = stockObj[className] || [];
              stockObj[className].push(entityName);
            }
          );
        });
      });
      // console.log(stock);
      const mult = Object.keys(stock).reduce((acc, key) => {
        acc[key] = acc[key] || {};
        Object.entries(stock[key]).forEach(([className, entityNames]) => {
          const set = new Set();
          entityNames.map((entityName) => {
            const bit = (allModels as any)[entityName][key][className];
            if (key === "classes") {
              set.add(
                JSON.stringify((bit.props as any[]).map((prop) => prop.name))
              );
            } else {
              set.add(JSON.stringify(bit.values));
            }
          });

          if (set.size === 1) {
            // 1つしかないものはスキップ
          } else {
            acc[key][className] = entityNames;
          }
        });
        return acc;
      }, {} as Record<string, Record<string, string[]>>);
      // console.log(mult);

      Object.entries(allModels).forEach(([entityName, models]) => {
        modelSources.push(
          ...Object.entries(models.classes).map(([className, obj]) =>
            Utils.trimLines(`
                export interface ${className} {
                ${(obj as { props: any[] }).props
                .map(
                  (prop) =>
                    `\t${prop.name}: ${javaTypeToTypescript(prop.type)};`
                )
                .join("\n")}
                }
            `)
          )
        );
        enumSources.push(
          ...Object.entries(models.enums).map(([className, obj]) =>
            Utils.trimLines(`
                export enum ${className} {
                \t${(obj as any).values.join(", ")}
                }
            `)
          )
        );
      });
    }

    fss.writeFileSync(
      `results/${this.agentName}/${PROJECT_NAME}/EntityPlain.java`,
      javaSources.join("\n\n")
    );
    fss.writeFileSync(
      `results/${this.agentName}/${PROJECT_NAME}/angular/src/app/models/models.ts`,
      tsSources.join("\n\n")
    );

    fss.writeFileSync(
      `results/${this.agentName}/${PROJECT_NAME}/EntityDetailRaw.json`,
      JSON.stringify(allModels, null, 2)
    );

    // Entityの詳細を整理する。
    // const entityDetailFrame = { ...mergedModel.classes, ...mergedModel.enums, entityNameList, valueObjectNameList, enumNameList };
    const entityDetailFrame = {
      ...mergedModel,
      entityNameList,
      valueObjectNameList,
      enumNameList,
    };
    fss.writeFileSync(
      `results/${this.agentName}/${PROJECT_NAME}/EntityDetailFrame.json`,
      JSON.stringify(entityDetailFrame, null, 2)
    );

    return result;
  }
}

/**
 * 第一段階で必須判定を行う。
 * 第二段階で関連するEntityを判定する。
 */
class Step0056_EntityAttributesJpaJson extends BaseStepDomainModelGenerator {
  format: StepOutputFormat = StepOutputFormat.JSON;
  constructor() {
    super();

    const entityPlain = fs.readFileSync(
      `results/${this.agentName}/${PROJECT_NAME}/EntityPlain.java`,
      "utf-8"
    );

    // 出力量を調整するために二段階に分ける。
    // 第一段階はEntity単体のアノテーションを考える。
    // 第二段階はEntity間の関係を考える。
    this.chapters = [
      {
        title: `Instructions`,
        contentJa: Utils.trimLines(`
                これから提示する設計書をよく読んで、Entity、ValueObjectに対してJPAで使えるようにアノテーションを考えてください。
                まずはEntity、ValueObject単体に対して、指定されたアノテーションのみを考えてください。
            `),
        contentEn: Utils.trimLines(`
                Please read the following design document carefully and consider the annotations for Entity and ValueObject so that they can be used with JPA.
                First, consider only the specified annotations for Entity and ValueObject individually.
            `),
        children: [],
      },
      {
        titleJa: "設計書",
        titleEn: "Design Document",
        children: [
          {
            titleJa: `機能一覧`,
            titleEn: `Feature List`,
            content: Utils.setMarkdownBlock(
              getStepInstance(Step0030_DesignSummary).result,
              "markdown"
            ),
          },
          {
            title: `Entity`,
            content: Utils.setMarkdownBlock(entityPlain, "java"),
          },
        ],
      },
      {
        // さぼり防止用にJSON形式で出力させる。Entity全量を一気にjavaに書き換えろというとChatGPT4がさぼるのでJSON形式で出力させる。こうするとさぼらない。
        title: "Output Format",
        contentJa: Utils.trimLines(
          `以下のJSONフォーマットで整理してください。`
        ),
        contentEn: Utils.trimLines(
          `Please organize the following in JSON format.`
        ),
        children: [
          {
            content: Utils.setMarkdownBlock(
              Utils.trimLines(`
                {
                    "fieldAnnotations": {
                        "@Id": { "ClassName": ["IdFieldName"], "ClassName2": ["IdFieldName"], },
                        "@EmbeddedId": { "ClassName": ["IdFieldName", "IdFieldName2"], "ClassName2": ["IdFieldName", "IdFieldName2"], },
                        "@Column(nullable = false)": { "ClassName": ["FieldName", "FieldName2",], "ClassName2": ["FieldName", "FieldName2",], },
                    },
                }
            `),
              "json"
            ),
          },
        ],
      },
    ];

    // 二段階目をセルフリファインで実施する。
    this.refineMessages.push({
      role: "user",
      content:
        (this.lang == "ja"
          ? Utils.trimLines(`
                ありがとうございます。
                次はEntity全体を俯瞰して、Entity間の関係について考えてください。
                そのうえで、以下のフォーマットでアノテーションを出力してください。
            `)
          : Utils.trimLines(`
                Thank you.
                Next, consider the relationship between the entire Entity and then output the annotations in the following format.
            `)) +
        Utils.setMarkdownBlock(
          Utils.trimLines(`
                {
                    "fieldAnnotations": {
                        "@ManyToOne": { "ClassName": ["FieldName", "FieldName2",], "ClassName2": ["FieldName", "FieldName2",], },
                        "@OneToMany": { "ClassName": ["FieldName", "FieldName2",], "ClassName2": ["FieldName", "FieldName2",], },
                        "@OneToOne(ownside)": { "ClassName": ["FieldName", "FieldName2",], "ClassName2": ["FieldName", "FieldName2",], },
                        "@OneToOne(non-ownside)": { "ClassName": ["FieldName", "FieldName2",], "ClassName2": ["FieldName", "FieldName2",], },
                        "@JoinColumn": { "ClassName": ["FieldName", "FieldName2",], "ClassName2": ["FieldName", "FieldName2",], },
                    },
                }
            `),
          "json"
        ),
    });
  }
  postProcess(result: string): string {
    // アノテーションを整理する。
    const annos0 = Utils.jsonParse(this.getRefineData(0)) as {
      fieldAnnotations: { [key: string]: { [key: string]: string[] } };
    };
    const annos1 = Utils.jsonParse(result) as {
      fieldAnnotations: { [key: string]: { [key: string]: string[] } };
    };
    const annos = {
      fieldAnnotations: {
        ...annos0.fieldAnnotations,
        ...annos1.fieldAnnotations,
      },
    };
    // フィールドアノテーションをクラスキーとフィールドキーで整理する。
    const fieldAnnotations = Object.entries(annos.fieldAnnotations).reduce(
      (acc, [anno, classFieldNames]) => {
        Object.entries(classFieldNames).forEach(([className, fieldNames]) => {
          fieldNames.forEach((fieldName) => {
            acc[className] = acc[className] || {};
            acc[className][fieldName] = acc[className][fieldName] || [];

            // 項目名の微調整
            if (anno === "@JoinColumn") {
              // @JoinColumnは_idがついてしまっているので、_idを削除したフィールド名と同期させておく
              acc[className][
                Utils.toCamelCase(fieldName.replace(/_[Ii][Dd]$/, ""))
              ] = acc[className][fieldName];
            } else if (anno === "@OneToMany") {
              // @OneToManyは項目名が複数形になってしまうので単数形に変換したオブジェクトと同期させておく
              acc[className][Utils.singularize(fieldName)] =
                acc[className][fieldName];
            } else {
            }

            // TODO エンティティの関連を整理するタスクは上手くいっていない。
            // Idの関連を消してしまってもうまくいかないし、関連アリにするとIdだとJPAで関連できないので、一旦関連系のアノテーションは削除しているが、本来は何かしらの対処をすべき。
            if (fieldName.endsWith("Id")) {
              // xxIdは外部結合のためのフィールドだけどIdだとJPAの自動生成が効かないのでアノテーションを無視する。
              if (
                [
                  "@ManyToOne",
                  "@OneToMany",
                  "@OneToOne(ownside)",
                  "@OneToOne(non-ownside)",
                  "@JoinColumn",
                ].find((exclude) => {
                  // console.log(`exclude: ${className}.${fieldName} ${anno}`);
                  return anno.startsWith(exclude);
                })
              ) {
                // console.log(`exclude: ${className}.${fieldName} ${anno}`);
              } else {
                acc[className][fieldName].push(anno);
              }
            } else {
              let isJoinColumn = true;

              // JOIN系のアノテーションは結合条件を記述する必要があるので、ここで結合条件を記述する。
              if (anno === "@ManyToOne") {
                // @ManyToOne
                // @JoinColumn(name = "customer_id", referencedColumnName = "id")
                // private Customer customer;
                acc[className][fieldName].push(anno);
              } else if (anno === "@OneToMany") {
                // @OneToMany(mappedBy = "customer", cascade = CascadeType.ALL)
                // private List<TransactionHistory> transactionHistories;
                acc[className][fieldName].push(
                  `${anno}(mappedBy = "${Utils.toCamelCase(
                    className
                  )}", cascade = CascadeType.ALL)`
                );
              } else if (anno === "@OneToOne(ownside)") {
                // @OneToOne(mappedBy = "customer", cascade = CascadeType.ALL)
                // private CreditReport creditReport;
                acc[className][fieldName].push(
                  `${anno.split("(")[0]}(mappedBy = "${Utils.toCamelCase(
                    className
                  )}", cascade = CascadeType.ALL)`
                );
              } else if (anno === "@OneToOne(non-ownside)") {
                // @OneToOne
                // @JoinColumn(name = "customer_id", referencedColumnName = "id")
                // private Customer customer;
                acc[className][fieldName].push(`@OneToOne`);
              } else if (anno === "@JoinColumn") {
                acc[className][fieldName].push(
                  `@JoinColumn(name = "${Utils.toSnakeCase(
                    fieldName
                  )}", referencedColumnName = "id")`
                );
              } else {
                acc[className][fieldName].push(anno);
                isJoinColumn = false;
              }
              // @JOIN系のアノテーション全体に対する処理
              if (isJoinColumn) {
                // @ColumnとJOIN系のアノテーションは併用できないので、@Column(nullable = false)があれば削除する。
                if (
                  acc[className][fieldName].find(
                    (s) => s === "@Column(nullable = false)"
                  )
                ) {
                  acc[className][fieldName].splice(
                    acc[className][fieldName].findIndex(
                      (s) => s === "@Column(nullable = false)"
                    ),
                    1
                  );
                } else {
                }
                // if (fieldName.endsWith('Id')) {
                //     acc[className][fieldName]
                //     acc[className][fieldName].splice(acc[className][fieldName].findIndex(s => s === '@Column'), 1);
                // }
              }
            }
          });
        });
        return acc;
      },
      {} as { [key: string]: { [key: string]: string[] } }
    );

    const entityDetailFrame = JSON.parse(
      fs.readFileSync(
        `results/${this.agentName}/${PROJECT_NAME}/EntityDetailFrame.json`,
        "utf-8"
      )
    ) as EntityDetailFilledType;
    // import文を作成するために、FQCNの逆引きマスタを作っておく。
    [
      ...entityDetailFrame.entityNameList,
      ...entityDetailFrame.valueObjectNameList,
    ]
      .flat()
      .forEach((className) => {
        JAVA_FQCN_MAP[className] = `${PACKAGE_NAME}.domain.entity.${className}`;
      });
    entityDetailFrame.enumNameList.flat().forEach((className) => {
      JAVA_FQCN_MAP[className] = `${PACKAGE_NAME}.domain.enums.${className}`;
    });

    // @Idが無いEntityがあれば、@Idを追加する。
    Object.entries(entityDetailFrame.classes).forEach(
      ([className, classObject]) => {
        if (classObject.type === "entity") {
          const idProp = classObject.props.find((prop) => {
            fieldAnnotations[className] = fieldAnnotations[className] || {};
            return (
              (fieldAnnotations[className][prop.name] || []).includes("@Id") ||
              (prop.annotations || []).includes("@Id")
            );
          });
          if (!idProp) {
            // console.log(className);
            fieldAnnotations[className] = fieldAnnotations[className] || {};
            fieldAnnotations[className]["id"] =
              fieldAnnotations[className]["id"] || [];
            fieldAnnotations[className]["id"].push("@Id");
          } else {
          }
        } else {
        }
      }
    );

    Object.entries(entityDetailFrame.classes).forEach(
      ([className, classObject]) => {
        const imports = new Set<string>(classObject.imports);
        // テーブル内で同じValueObjectが複数回使われる場合がある。その場合は項目名が重複するので、それを避けるための処理をするためのSet。
        const usedValueObjectNameSet: Set<string> = new Set<string>();
        // Fieldのアノテーションを付与する。
        const fields = classObject.props
          .map((field) => {
            const _fieldAnnoMap =
              fieldAnnotations[className] ||
              fieldAnnotations[`${className}Entity`] ||
              [];
            field.annotations = [
              ...(_fieldAnnoMap[field.name] ||
                _fieldAnnoMap[field.name.replace(/I[Dd]$/, "")] ||
                _fieldAnnoMap[field.name.replace(/_[Ii][Dd]$/, "")] ||
                []),
              ...field.annotations,
            ];

            if (
              usedValueObjectNameSet.has(field.type) &&
              entityDetailFrame.classes[field.type]
            ) {
              // テーブル内で同じValueObjectが複数回使われる場合がある。その場合は項目名が重複するので、それを避けるための処理をする。
              // @AttributeOverrides({
              //     @AttributeOverride(name = "amount", column = @Column(name = "monthly_repayment_amount_amount")),
              //     @AttributeOverride(name = "currency", column = @Column(name = "monthly_repayment_amount_currency"))
              // })
              const fieldRenamed = entityDetailFrame.classes[
                field.type
              ].props.map(
                (prop) =>
                  `\t\t\t@AttributeOverride(name = "${prop.name
                  }", column = @Column(name = "${Utils.toSnakeCase(
                    field.name
                  )}_${prop.name}"))`
              );
              field.annotations.push(
                `@AttributeOverrides({\n${fieldRenamed.join(",\n")}\n\t})`
              );
              imports.add("AttributeOverrides");
              imports.add("AttributeOverride");
            } else {
            }
            usedValueObjectNameSet.add(field.type);

            field.isOptional = true; // 初期値としてフラグを立てておく。
            field.annotations.forEach((anno) => {
              // import文を作成するために、型名を集める。
              imports.add(anno.trim().replace("@", "").replace(/\(.*/g, ""));
              // nullable = falseの場合は、Optionalではないので、フラグを折る。
              if (
                anno.includes("nullable = false") ||
                anno === "@Id" ||
                anno === "@EmbeddedId"
              ) {
                field.isOptional = false;
              } else {
              }
            });
            // @Idの場合は、@GeneratedValueを追加する。
            if (field.annotations.find((anno) => anno === "@Id")) {
              field.annotations.push(
                "@GeneratedValue(strategy = GenerationType.IDENTITY)"
              );
              imports.add("GeneratedValue");
              imports.add("GenerationType");
            } else {
            }
            field.type.split(/[<>,.?]/).forEach((s) => imports.add(s)); // import文を作成するために、型名を集める。

            // TIME_TYPE_REMAPにマッチする型名をTIME_TYPE_COLUMN_DEFINITIONに変換する。
            Object.entries(TIME_TYPE_REMAP).forEach(([from, to]) => {
              // console.log(`TIME_TYPE_REMAP: ${field.type} => ${to}`);
              // if (field.type.match(new RegExp(`(^${from}$|^${from}\W|\W${from}\W|\W${from}$)`))) {
              if (field.type === from) {
                field.type = field.type.replace(from, to);
                // console.log(`TIME_TYPE_REMAP: ${from} => ${to}`);
                for (let i = 0; i < field.annotations.length; i++) {
                  const anno = field.annotations[i];
                  if (field.annotations[i].startsWith("@Column")) {
                    // @Columnが既にあるので、columnDefinitionを追加する。
                    field.annotations[i] =
                      anno.substring(0, anno.length - 1) +
                      `, columnDefinition = "${TIME_TYPE_COLUMN_DEFINITION[field.type]
                      }")`;
                    break;
                  } else if (i == field.annotations.length - 1) {
                    // 最後の要素なので、@Columnを追加する。
                    field.annotations.push(
                      `@Column(columnDefinition = "${TIME_TYPE_COLUMN_DEFINITION[field.type]
                      }")`
                    );
                    imports.add("Column"); // Columnをimportにも追加する。
                    break;
                  } else {
                  }
                }
              } else {
              }
            });

            const annotations = field.annotations
              .map((anno) => `\t${anno}\n`)
              .join("");
            return `${annotations}\tprivate ${field.type} ${field.name};\n`;
          })
          .join("\n");

        // 拾いにくいクラスをハードコーディングでimportする。
        [
          "EnumType.STRING",
          "GenerationType.IDENTITY",
          "CascadeType.ALL",
        ].forEach((s) => {
          if (fields.includes(s)) {
            imports.add(s.split(".")[0]);
          } else {
          }
        }); // import文を作成するために、型名を集める。

        // import文を作成する。
        const importList = Array.from(imports)
          .map((importName) => JAVA_FQCN_MAP[importName])
          .filter((importName) => importName)
          .filter(
            (importName) =>
              !importName.startsWith(`${PACKAGE_NAME}.domain.entity.`)
          ) // 同じパッケージのクラスはimportしない。
          .map((importName) => `import ${importName};\n`)
          .sort()
          .join("");

        // Javaソースコードを作成する。
        classObject.source = Utils.trimLines(
          `
                package ${PACKAGE_NAME}.domain.entity;

                ${importList || Utils.TRIM_LINES_DELETE_LINE}
                ${classObject.annotations.join("\n") ||
          Utils.TRIM_LINES_DELETE_LINE
          }
                public class ${className}${classObject.type === "entity" ? " extends BaseEntity" : ""
          } {
                
                ${fields}
                }
            `
        ).replace(/\t/g, "    "); // タブをスペース4つに変換する。
        fss.writeFileSync(
          `results/${this.agentName}/${PROJECT_NAME}/${SPRING_DIRE}/domain/entity/${className}.java`,
          classObject.source
        );

        // マークダウンテーブルを作成する。
        classObject.mdTable = Utils.trimLines(`
                ### ${className}

                | Attribute Name | Java Class | Optional |
                |-|-|-|
                ${(classObject.props as any[])
            .map(
              (prop) =>
                `| ${prop.name} | ${prop.type} | ${prop.isOptional ? "Yes" : "No"
                } |`
            )
            .join("\n")}
            `);

        classObject.imports = Array.from(imports);
      }
    );
    Object.entries(entityDetailFrame.enums).forEach(
      ([className, enumObject]) => {
        // Javaソースコードを作成する。
        enumObject.source = Utils.trimLines(
          `
                package ${PACKAGE_NAME}.domain.enums;

                public enum ${className} {
                    ${enumObject.values.join(", ")}
                }
            `
        ).replace(/\t/g, "    "); // タブをスペース4つに変換する。
        fss.writeFileSync(
          `results/${this.agentName}/${PROJECT_NAME}/${SPRING_DIRE}/domain/enums/${className}.java`,
          enumObject.source
        );

        // マークダウンテーブルを作成する。
        enumObject.mdTable = Utils.trimLines(
          `- ${className}: ${enumObject.values.join(", ")}`
        );
        // descriptionを追加したらこっちのリッチなテーブルに変更する。
        // enumObject.mdTable = Utils.trimLines(`
        //     ### ${className}

        //     ${enumObject.values.join(', ')}
        // `);
      }
    );

    // Entityは良く使うので1ファイルにまとめておく。
    const entitySource = Utils.setMarkdownBlock(
      Object.entries(entityDetailFrame.classes)
        .map(([className, obj]) => obj.source)
        .join("\n")
        .replace(/^(?:package |import |@Table).*(\r?\n)/gm, ""),
      `java ${PACKAGE_NAME}.domain.entity`
    );
    const enumsSource = Utils.setMarkdownBlock(
      Object.entries(entityDetailFrame.enums)
        .map(([className, obj]) => obj.source)
        .join("\n")
        .replace(/^(?:package ).*(\r?\n)/gm, ""),
      `java ${PACKAGE_NAME}.domain.enum`
    );
    const entityMdTable = `## Entities\n\n${entityDetailFrame.entityNameList
      .map((className) => entityDetailFrame.classes[className].mdTable)
      .join("\n\n")}`;
    const valueObjectMdTable = `## ValueObjects\n\n${entityDetailFrame.valueObjectNameList
      .map((className) => entityDetailFrame.classes[className].mdTable)
      .join("\n\n")}`;
    const enumMdTable = `## Enums\n\n${entityDetailFrame.enumNameList
      .map((className) => entityDetailFrame.enums[className].mdTable)
      .join("\n")}`;
    fss.writeFileSync(
      `results/${this.agentName}/${PROJECT_NAME}/entities.md`,
      entityMdTable + "\n\n" + valueObjectMdTable + "\n\n" + enumMdTable
    );
    fss.writeFileSync(
      `results/${this.agentName}/${PROJECT_NAME}/entities.java.md`,
      (entitySource + "\n\n---\n\n" + enumsSource).replace(/\n\n\n/g, "\n\n")
    );

    const mdTableMas: Record<string, string> = {};
    Object.entries(entityDetailFrame.classes).forEach(
      ([className, obj]) => (mdTableMas[className] = obj.mdTable)
    );
    Object.entries(entityDetailFrame.enums).forEach(
      ([className, obj]) => (mdTableMas[className] = obj.mdTable)
    );
    fss.writeFileSync(
      `results/${this.agentName}/${PROJECT_NAME}/EntityDetailDoc.json`,
      JSON.stringify(mdTableMas, null, 2)
    );
    fss.writeFileSync(
      `results/${this.agentName}/${PROJECT_NAME}/EntityDetailFilled.json`,
      JSON.stringify(entityDetailFrame, null, 2)
    );

    return result;
  }
}
class Step0055_EntityAttributesToOpenAPI extends BaseStepDomainModelGenerator {
  constructor() {
    super();
    this.chapters = [
      {
        title: `Instructions`,
        contentJa: Utils.trimLines(`
                以下のjavaコードをOpenAPIのschema形式で書いて下さい。
                出力形式は変換サンプルを参考にしてください。
                requiredは省略してください。
            `),
        contentEn: Utils.trimLines(`
                Please write the following java code in OpenAPI schema format.
                Please refer to the conversion sample for the output format.
                Please omit the required.
            `),
      },
      {
        titleJa: "変換対象のjavaコード",
        titleEn: "Java code to be converted",
        content: fs.readFileSync(
          `results/${this.agentName}/${PROJECT_NAME}/entities.md`,
          "utf-8"
        ),
      },
      {
        titleJa: "変換サンプル",
        titleEn: "Conversion sample",
        children: [
          {
            titleJa: `変換前javaコード`,
            titleEn: `Java code before conversion`,
            content: Utils.setMarkdownBlock(
              Utils.trimLines(`
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
                `),
              "java"
            ),
          },
          {
            titleJa: `変換後OpenAPIスキーマ`,
            titleEn: `OpenAPI schema after conversion`,
            content: Utils.setMarkdownBlock(
              Utils.trimLines(`
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
                `),
              "yaml"
            ),
          },
        ],
      },
    ];
  }
}

class Step0060_ViewList extends BaseStepDomainModelGenerator {
  // model: GPTModels = 'gpt-3.5-turbo';
  format: StepOutputFormat = StepOutputFormat.JSON;
  constructor() {
    super();
    this.chapters = [
      {
        title: `Instructions`,
        contentJa: Utils.trimLines(
          `これから提示する設計書をよく読んで、要件を満たすように画面一覧を作成してください。`
        ),
        contentEn: Utils.trimLines(
          `Please read the following design document carefully and create a list of screens that meets the requirements.`
        ),
      },
      {
        titleJa: "設計書",
        titleEn: "Design Document",
        children: [
          {
            titleJa: `機能設計`,
            titleEn: `Feature Design`,
            content: Utils.addMarkdownDepth(
              getStepInstance(Step0030_DesignSummary)
                .childStepList.map((step: BaseStep) => step.formed)
                .join("\n\n"),
              2
            ),
          },
          {
            title: `Domain Models`,
            content: Utils.addMarkdownDepth(
              fs.readFileSync(
                `results/${this.agentName}/${PROJECT_NAME}/entities.md`,
                "utf-8"
              ),
              1
            ),
          },
          {
            titleJa: `フレームワーク`,
            titleEn: `Framework`,
            content: `Angular + Spring Boot + JPA + PostgreSQL`,
          },
        ],
      },
      {
        title: "Output Format",
        contentJa: Utils.trimLines(`
                出力フォーマットは以下の通りです。
                \`\`\`json
                {"viewList":[{"name": "View name(as varName)","type":"page/dialog/parts","destinationList":["destination view name","destination view name"],"relatedFeatureList":["機能一覧の設計書のタイトル","機能一覧の設計書のタイトル"]}]}
                \`\`\`
            `),
        contentEn: Utils.trimLines(`
                The output format is as follows.
                \`\`\`json
                {"viewList":[{"name": "View name(as varName)","type":"page/dialog/parts","destinationList":["destination view name","destination view name"],"relatedFeatureList":["title of the design document of the feature list","title of the design document of the feature list"]}]}
                \`\`\`
            `),
        //　"partsList":["parts(as varName)","parts(as varName)"],
      },
    ];
  }

  postProcess(result: string): string {
    // 全量纏めて使いやすい形に整形する。
    const viewList = JSON.parse(result).viewList;
    const featureDocs = JSON.parse(
      fs.readFileSync(
        `results/${this.agentName}/${PROJECT_NAME}/FeatureDocs.json`,
        "utf-8"
      )
    ) as { [key: string]: string };
    const entityList = JSON.parse(
      fs.readFileSync(
        `results/${this.agentName}/${PROJECT_NAME}/EntityList.json`,
        "utf-8"
      )
    ) as { [key: string]: { [key: string]: string } };
    const entityDetailFilled = JSON.parse(
      fs.readFileSync(
        `results/${this.agentName}/${PROJECT_NAME}/EntityDetailFilled.json`,
        "utf-8"
      )
    ) as EntityDetailFilledType;
    const entityDetailDoc = JSON.parse(
      fs.readFileSync(
        `results/${this.agentName}/${PROJECT_NAME}/EntityDetailDoc.json`,
        "utf-8"
      )
    ) as { [key: string]: string };
    // console.log(Object.keys(mas));
    // viewListのオブジェクトに関連機能の設計書を埋め込む。
    const nameListMap: Record<string, string[]> = {
      entity: entityDetailFilled.entityNameList,
      valueObject: entityDetailFilled.valueObjectNameList,
      enum: entityDetailFilled.enumNameList,
    };
    viewList.forEach(
      (view: {
        name: string;
        destinationList: string[];
        relatedFeatureList: string[];
        relatedFeatureDocumentList: string[];
        relatedEntityList: string[];
        relatedEntityDoc: string;
      }) => {
        view.relatedFeatureList = view.relatedFeatureList || [];
        view.relatedFeatureDocumentList = view.relatedFeatureDocumentList || [];
        view.relatedEntityList = view.relatedEntityList || [];
        for (let index = 0; index < view.relatedFeatureList.length; index++) {
          view.relatedFeatureDocumentList.push(
            featureDocs[view.relatedFeatureList[index]] || view.name
          );

          if (entityList[view.relatedFeatureList[index]]) {
            Object.keys(entityList[view.relatedFeatureList[index]]).forEach(
              (entityName) => {
                entityDetailFilled.classes[entityName].relatedClasses.forEach(
                  (relatedClassName) => {
                    view.relatedEntityList.push(relatedClassName);
                  }
                );
              }
            );
          } else {
          }
        }
        view.relatedEntityDoc = "";
        ["entity", "valueObject", "enum"].forEach((type) => {
          const docs = view.relatedEntityList
            .filter((entityName) => nameListMap[type].includes(entityName))
            .map((entityName) => entityDetailDoc[entityName] || "");
          if (docs.length > 0) {
            if (type === "enum") {
              view.relatedEntityDoc += `## ${Utils.toPascalCase(
                Utils.pluralize(type)
              )}\n\n${docs.join("\n")}\n\n`;
            } else {
              view.relatedEntityDoc += `## ${Utils.toPascalCase(
                Utils.pluralize(type)
              )}\n\n${docs.join("\n\n")}\n\n`;
            }
          } else {
          }
        });
      }
    );

    fss.writeFileSync(
      `results/${this.agentName}/${PROJECT_NAME}/ViewList.json`,
      JSON.stringify({ viewList }, null, 2)
    );
    return result;
  }
}

class Step0070_ViewDocuments extends MultiStepDomainModelGenerator {
  viewList!: {
    name: string;
    destinationList: string[];
    relatedFeatureList: string[];
    relatedFeatureDocumentList: string[];
    relatedEntityList: string[];
    relatedEntityDoc: string;
  }[];
  constructor() {
    super();

    class Step0070_ViewDocumentsChil extends BaseStepDomainModelGenerator {
      // model: GPTModels = 'gpt-3.5-turbo';
      constructor(
        public view: {
          name: string;
          destinationList: string[];
          relatedFeatureList: string[];
          relatedFeatureDocumentList: string[];
          relatedEntityList: string[];
          relatedEntityDoc: string;
        }
      ) {
        super();
        // const view: any = null;
        // {"viewList":[{"name": "View name","destinationList":["parts","parts"],"relatedFeatureList":["featureName","featureName"]}]}

        // 複数並列処理するので、被らないようにラベルを設定する。（これがログファイル名になる）
        this.label = `${this.constructor.name}_${Utils.safeFileName(
          view.name
        )}`; // Utils.safeFileNameはファイル名として使える文字だけにするメソッド。
        // 個別の指示を作成。
        this.chapters = [
          {
            title: `Instructions`,
            contentJa: Utils.trimLines(`
                            これから提示する設計書をよく読んで、画面の詳細設計書を作成してください。
                            あなたの担当は「${view.name}」です。担当外のものはやらなくてよいです。
                        `),
            contentEn: Utils.trimLines(`
                            Please read the following design document carefully and create a detailed design document for the screen.
                            Your responsibility is "${view.name}". You don't have to do anything outside of your responsibility.
                        `),
          },
          {
            titleJa: "設計書",
            titleEn: "Design Document",
            children: [
              {
                //     title: `機能設計`,
                //     content: Utils.addMarkdownDepth(getStepInstance(Step0030_DesignSummary).childStepList.map((step: BaseStep) => step.formed).join('\n\n'), 2),
                // }, {
                //     title: `Domain Models`,
                //     content: Utils.addMarkdownDepth(fs.readFileSync(`results/${this.agentName}/${PROJECT_NAME}/entities.md`, 'utf-8'), 1),
                titleJa: `機能設計書`,
                titleEn: `Feature Design Document`,
                content: Utils.addMarkdownDepth(
                  view.relatedFeatureDocumentList.join("\n\n"),
                  2
                ),
                children: [
                  {
                    titleJa: `画面遷移先`,
                    titleEn: `Destination View`,
                    content: view.destinationList
                      .map((destination: string) => `* ${destination}`)
                      .join("\n"),
                  },
                ],
              },
              {
                title: `Domain Models`,
                content: Utils.addMarkdownDepth(view.relatedEntityDoc, 1),
              },
            ],
          },
          {
            title: "Output Sample",
            contentJa:
              `以下のサンプル設計書の書き方に倣ってください。\n\n` +
              Utils.setMarkdownBlock(
                Utils.trimLines(`
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

                            - **パスワードリセットリンクを送信するAPI**
                              - 説明: ユーザーがパスワードを忘れた場合に新しいパスワードを設定するためのリンクをメールで送信する。
                              - 入力: メールアドレス
                              - 出力: 送信結果
                                
                            ## 8. 備考

                            - パスワードリセットリンクをクリックした後のパスワード変更画面の設計は、この設計書の範囲外である。
                        `)
              ),
            contentEn:
              `Please follow the sample design document below.\n\n` +
              Utils.setMarkdownBlock(
                Utils.trimLines(`
                            # View Detail Design Document: PasswordResetView

                            ## 1. Overview

                            - View Name: Password Reset
                            - View ID: PasswordResetView
                            - View Type: Form
                            - Description: A screen for users to set a new password if they forget their password.

                            ## 2. UI Components

                            - Email Address Input Field
                            - Attribute: Required
                            - Validation: Valid email address format
                            - Send Password Reset Link Button
                            - Action: Perform validation of the email address input field and if there are no problems, send a password reset link by email.

                            ## 3. Validation Rules

                            - Email Address
                            - Required input
                            - Email address format (e.g. user@example.com)

                            ## 4. View Transition

                            - After clicking the Send Password Reset Link button, one of the following actions occurs.
                            - Success: Display the message "Password reset link sent to email address." to the user and transition to the LoginView.
                            - Failure (if the email address is not registered): Display the error message "Email address not registered."

                            ## 5. Error Messages

                            - If the email address is not entered: "Please enter your email address."
                            - If the email address is in an invalid format: "Please enter a valid email address."
                            - If the email address is not registered: "Email address not registered."

                            ## 6. Business Logic

                            - Before sending the password reset link, check if the entered email address is registered in the system.
                            - If the email address is registered, generate a PasswordResetToken entity and set the expiration date.
                            - Send an email with the generated token included in the password reset link.

                            ## 7. API

                            - **API to Send Password Reset Link**
                              - Description: Send a link by email for users to set a new password if they forget their password.
                              - Input: Email address
                              - Output: Send result

                            ## 8. Notes

                            - The design of the password change screen after clicking the password reset link is out of scope of this design document.
                        `)
              ),
          },
        ];
      }
    }
    this.viewList = JSON.parse(
      fs.readFileSync(
        `results/${this.agentName}/${PROJECT_NAME}/ViewList.json`,
        "utf-8"
      )
    ).viewList as {
      name: string;
      destinationList: string[];
      relatedFeatureList: string[];
      relatedFeatureDocumentList: string[];
      relatedEntityList: string[];
      relatedEntityDoc: string;
    }[];
    this.childStepList = this.viewList.map(
      (target) => new Step0070_ViewDocumentsChil(target)
    );
  }

  postProcess(result: string[]): string[] {
    const allObj = this.viewList.reduce(
      (
        all: { [key: string]: string },
        view: {
          name: string;
          destinationList: string[];
          relatedFeatureList: string[];
          relatedFeatureDocumentList: string[];
        },
        index: number
      ) => {
        all[view.name] = result[index];
        return all;
      },
      {}
    );
    const outputFileName = `results/${this.agentName}/${PROJECT_NAME}/ViewDocs.json`;
    fss.writeFileSync(outputFileName, JSON.stringify(allObj, null, 2));
    return result;
  }
}

class Step0072_ViewComponents extends BaseStepDomainModelGenerator {
  constructor() {
    super();
    this.chapters = [
      {
        title: `Instructions`,
        contentJa: Utils.trimLines(`
                これから提示する設計書をよく読んで、画面のコンポーネント一覧を作成してください。
                画面のコンポーネント一覧は、画面の詳細設計書に記載されているUIコンポーネントを抜き出してください。
            `),
        contentEn: Utils.trimLines(`
                Please read the following design document carefully and create a list of screen components.
                The list of screen components should extract the UI components described in the detailed design document of the screen.
            `),
      },
      {
        titleJa: "設計書",
        titleEn: "Design Document",
        children: [
          {
            titleJa: `画面詳細設計書`,
            titleEn: `View Detail Design Document`,
            content: Utils.addMarkdownDepth(
              fs.readFileSync(
                `results/${this.agentName}/${PROJECT_NAME}/ViewDocs.json`,
                "utf-8"
              ),
              2
            ),
          },
        ],
      },
      {
        title: "Output Format",
        contentJa: `表形式でコンポーネント名、説明、属性を出力してください。`,
        contentEn: `Please output the component name, description, and attributes in tabular format.`,
      },
    ];
  }
}

class Step0080_ServiceList extends BaseStepDomainModelGenerator {
  // format: StepOutputFormat = StepOutputFormat.JSON;
  constructor() {
    super();
    const apiList = getStepInstance(Step0070_ViewDocuments)
      .childStepList.map((step) => {
        const match = step.formed.match(/## 7\. API([\s\S]*?)(?=## \d)/);
        if (match) {
          // console.log(step.formed);
          const shifted = match[1]
            .trim()
            .split("\n")
            .filter((s) => s.trim())
            .map((line) => `  ${line}`)
            .join("\n");
          return `- ${(step as any).view.name}\n${shifted}`;
        } else {
          console.log(`APIが見つかりませんでした。${(step as any).view.name}`);
          return "";
        }
      })
      .filter((s) => s.trim())
      .join("\n");
    // console.log(apiList);
    this.chapters = [
      {
        title: `Instructions`,
        contentJa: Utils.trimLines(`
                    これから提示する設計書をよく理解して、サービス一覧を作成してください。
                    まず全量を把握して、関連の強いAPIをサービスとしてグループ化してして考えてください。
                    サービスは、バックエンド側のビジネスルールを実装するものです。
                `),
        contentEn: Utils.trimLines(`
                    Please read the following design document carefully and create a list of services.
                    First, understand the entire document and group the APIs that are closely related into services.
                    Services are for implementing backend business rules.
                `),
      },
      {
        titleJa: "設計書",
        titleEn: "Design Document",
        children: [
          {
            titleJa: `画面⇒API呼び出し一覧`,
            titleEn: `View ⇒ API Call List`,
            content: apiList,
          },
          {
            titleJa: `機能設計`,
            titleEn: `Function Design`,
            content: Utils.addMarkdownDepth(
              [
                ...getStepInstance(Step0030_DesignSummary).childStepList,
                ...getStepInstance(Step0015_AdvancedExpertiseDetail)
                  .childStepList, // 高度な専門知識
              ]
                .map((step: BaseStep) => step.formed)
                .join("\n\n"),
              2
            ),
          },
          {
            title: `Domain Models`,
            content: Utils.addMarkdownDepth(
              fs.readFileSync(
                `results/${this.agentName}/${PROJECT_NAME}/entities.md`,
                "utf-8"
              ),
              1
            ),
          },
        ],
      },
      {
        title: "Output Format",
        contentJa: `表形式でサービス名（英語名）、名前、利用元画面IDリストを出力してください。`,
        contentEn: `Please output the service name (English name), name, and list of source screen IDs in tabular format.`,
      },
    ];

    this.refineMessages.push(
      {
        role: "user",
        content:
          this.lang == "ja"
            ? Utils.trimLines(`
                ありがとうございます。それでは次にそのサービス一覧を更に詳細化していきましょう。
                サービスごとにどんなメソッドが必要かを再度設計書全体を見直して考えてみてください。

                表形式でサービス名(英語名)、メソッド名（英語名）、利用元画面ID(複数可)、依存先Entity（複数可）、依存先サービス名（複数可）、関係する機能設計書名(複数可)を出力してください。
            `)
            : Utils.trimLines(`
                Thank you. Next, let's further refine the list of services.
                Please reconsider the entire design document to think about what methods are needed for each service.

                Please output the service name (English name), method name (English name), source screen ID (multiple), dependent entity (multiple), dependent service name (multiple), and related function design document name (multiple) in tabular format.
            `),
      },
      {
        role: "user",
        // content: `表形式でサービス名(英語名)、ID（英語名）、名前、メソッド、エンドポイント利用元画面IDリストを出力してください。`,
        content:
          this.lang === "ja"
            ? Utils.trimLines(`
                ありがとうございます。次はこれらのサービスをREST APIとして公開するための設計を行います。
                再度、提示された設計書の要求を確認したうえで、詳細化したサービス一覧にエンドポイントとrequestの型とresponseの型を追記してください。
                requestの型とresponseの型はDomain Modelsに提示されたものを参考にjavaの記法で書いてください。
                
                表形式でサービス名(英語名)、メソッド名（英語名）、日本語名、Httpメソッド、エンドポイント、requestの形式、responseの形式を出力してください。
            `)
            : Utils.trimLines(`
                Thank you. Next, we will design these services to expose them as REST APIs.
                Please add the endpoint, request type, and response type to the detailed list of services after confirming the requirements of the presented design document.
                Please write the request type and response type in Java notation based on the Domain Models.

                Please output the service name (English name), method name (English name), Japanese name, HTTP method, endpoint, request format, and response format in tabular format.
            `),
      }
    );
  }

  /**
   * サービス一覧は大規模リストに対応できるように列を分けて二段階で作っているので、ここでマージ処理を行う。
   * @param result
   * @returns
   */
  postProcess(result: string): string {
    const mergedAPIList = [];

    // 前回ステップで作成したものをmarkdownテーブルから読み込む。
    const serviceList = Utils.loadTableDataFromMarkdown(
      this.getRefineData(1)
    ).data.reduce(
      (
        before: {
          [key: string]: {
            [key: string]: {
              usageScreenIdList: string[];
              entityList: string[];
              serviceList: string[];
              documentList: string[];
            };
          };
        },
        current: string[]
      ) => {
        const [
          serviceName,
          apiName,
          usageScreenIdListString,
          entityListString,
          serviceListString,
          documentListString,
        ] = current;
        if (!before[serviceName]) {
          before[serviceName] = {};
        } else {
        }
        const usageScreenIdList = usageScreenIdListString
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s);
        const entityList = entityListString
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s);
        const serviceList = serviceListString
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s);
        const documentList = documentListString
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s);
        before[serviceName][apiName] = {
          usageScreenIdList,
          entityList,
          serviceList,
          documentList,
        };
        return before;
      },
      {}
    ) as { [key: string]: { [key: string]: ServiceMethod } };

    // 今回のステップで作成したものをmarkdownテーブルから読み込む。
    Utils.loadTableDataFromMarkdown(result).data.forEach((element) => {
      const [serviceName, apiName, name, method, _endpoint, request, response] =
        element;

      // endpointとpathVariableを整備する。
      const pathVariableListByEndpoint = Array.from(
        _endpoint.matchAll(/\{([^}]+)\}/g)
      ).map((match) => match[1]);
      // console.log(_endpoint, pathVariableListByEndpoint);
      let pathVariableList = request
        .split(",")
        .filter((_, index) => index < pathVariableListByEndpoint.length)
        .map((s) => s.trim().split(" ")[1]);
      let endpoint = _endpoint;
      if (["POST", "PUT", "PATCH"].includes(method.toUpperCase())) {
        // POST, PUT, PATCHの場合は、pathVariableを削除する。
        endpoint = endpoint
          .replace(/\{([^}]+)\}/g, "")
          .replace(/\/\/+/, "/")
          .replace(/\/$/, "");
        pathVariableList = [];
      } else {
        // GET, DELETEの場合は、pathVariableを使えるように整備する。
        pathVariableListByEndpoint.forEach((pathVariable, index) => {
          // console.log(pathVariable, pathVariableList[index]);
          if (pathVariableList[index]) {
            // pathVariableList(requestに掛かれている項目名)がある場合は、endpointのpathVariableを置換する。
            endpoint = endpoint.replace(
              `{${pathVariable}}`,
              `{${pathVariableList[index]}}`
            );
          } else {
            // requestからpathVariableが取れない場合は逆にpathVariableをpathVariableListに追加する。
            pathVariableList[index] = pathVariable;
          }
        });
      }
      serviceList[serviceName][apiName] = {
        ...serviceList[serviceName][apiName],
        name,
        method,
        endpoint,
        pathVariableList,
        request,
        response,
      };
    });

    const entityModel = JSON.parse(
      fs.readFileSync(
        `results/${this.agentName}/${PROJECT_NAME}/EntityDetailFilled.json`,
        "utf-8"
      )
    ) as EntityDetailFilledType;
    // テーブル形式のデータを作成する。
    const heads = [
      "serviceName",
      "apiName",
      "name",
      "method",
      "endpoint",
      "pathVariableList",
      "request",
      "response",
      "usageScreenIdList",
      "Dependent Repositories",
      "Dependent Services",
      "Related Functional Specifications",
    ];
    mergedAPIList.push(heads);
    mergedAPIList.push(heads.map(() => "-")); // ヘッダーの下線を作成する。
    Object.keys(serviceList).forEach((serviceName) => {
      Object.keys(serviceList[serviceName]).forEach((apiName) => {
        // const pathVariableList = (serviceList[serviceName][apiName].endpoint.match(/\{([^}]+)\}/g) || []).map(pathVariable => pathVariable.replace(/^\{/, '').replace(/\}$/, ''));
        mergedAPIList.push([
          Utils.toPascalCase(Utils.safeFileName(serviceName)).replace(
            /Service$/g,
            ""
          ) + "Service", // サービス名を標準化 ⇒ PascalCaseService にする。
          Utils.toCamelCase(Utils.safeFileName(apiName)), // メソッド名を標準化 ⇒ camelCase にする。
          serviceList[serviceName][apiName].name,
          serviceList[serviceName][apiName].method.toUpperCase(), // httpメソッドは大文字にする。
          serviceList[serviceName][apiName].endpoint,
          serviceList[serviceName][apiName].pathVariableList.join(","),
          serviceList[serviceName][apiName].request,
          serviceList[serviceName][apiName].response,
          serviceList[serviceName][apiName].usageScreenIdList.join(","),
          // Entity以外のもの（embeddableなど）は除外する。
          serviceList[serviceName][apiName].entityList
            .filter((entity) => entityModel.entityNameList.includes(entity))
            .map((entity) => `${entity}Repository<${entity}, Long>`)
            .join(","),
          serviceList[serviceName][apiName].serviceList.join(","),
          serviceList[serviceName][apiName].documentList.join(","),
        ]);
      });
    });
    const apiDataTable = mergedAPIList
      .map((row) => `| ${row.join(" | ")} |`)
      .join("\n");
    // service用にヘッダーを設定する。
    mergedAPIList[0][1] = "methodName";
    mergedAPIList[0][6] = "args";
    mergedAPIList[0][7] = "return";
    // service用にmethodとendpointとpathVariableListを削除する。
    const serviceDataTable = mergedAPIList
      .map(
        (row) => `| ${row.slice(0, 3).concat(row.slice(6, 10)).join(" | ")} |`
      )
      .join("\n");

    // markdownとjsonで出力する。
    fss.writeFileSync(
      `results/${this.agentName}/${PROJECT_NAME}/ApiList.md`,
      apiDataTable
    );
    fss.writeFileSync(
      `results/${this.agentName}/${PROJECT_NAME}/ServiceList.md`,
      serviceDataTable
    );
    fss.writeFileSync(
      `results/${this.agentName}/${PROJECT_NAME}/ServiceList.json`,
      JSON.stringify(serviceList, null, 2)
    );
    return result;
  }
}

// class Step0090_ServiceMethodList extends BaseStepDomainModelGenerator {
//     // format: StepOutputFormat = StepOutputFormat.JSON;
//     constructor() {
//         super();
//         const apiList = getStepInstance(Step0070_ViewDocuments).childStepList.map(step => {
//             const match = step.formed.match(/## 7\. API([\s\S]*?)(?=## \d)/);
//             if (match) {
//                 // console.log(step.formed);
//                 const shifted = match[1].trim().split('\n').map(line => `  ${line}`).join('\n');
//                 return `- ${(step as any).feature.name}\n${shifted}`;
//             } else {
//                 return '';
//             }
//         }).join('\n');
//         this.chapters = [
//             {
//                 title: `Instructions`,
//                 contentJa: Utils.trimLines(`これから提示する設計書をよく理解して、サービスメソッド一覧を作成してください。`),
//                 contentEn: Utils.trimLines(`Please read the following design document carefully and create a list of service methods.`),
//             }, {
//                 titleJa: '設計書', titleEn: 'Design Document',
//                 children: [{
//                     titleJa: `画面⇒API呼び出し一覧`, titleEn: `View ⇒ API Call List`,
//                     content: apiList,
//                 }, {
//                     titleJa: `サービス一覧`, titleEn: `Service List`,
//                     content: Utils.mdTrim(getStepInstance(Step0080_ServiceList).formed),
//                 }, {
//                     titleJa: `機能設計`, titleEn: `Function Design`,
//                     content: Utils.addMarkdownDepth([
//                         ...getStepInstance(Step0030_DesignSummary).childStepList,
//                         ...getStepInstance(Step0015_AdvancedExpertiseDetail).childStepList, // 高度な専門知識
//                     ].map((step: BaseStep) => step.formed).join('\n\n'), 2),
//                 }, {
//                     title: `Domain Models`,
//                     content: Utils.addMarkdownDepth(fs.readFileSync(`results/${this.agentName}/${PROJECT_NAME}/entities.md`, 'utf-8'), 1),
//                 }],
//             }, {
//                 title: 'Output Format',
//                 // content: `表形式でサービス名(英語名)、ID（英語名）、名前、メソッド、エンドポイント、requestの形式、responseの形式、利用元画面IDリストを出力してください。`,
//                 contentJa: `表形式でサービス名(英語名)、メソッド名（英語名）、利用元画面ID(複数可)、依存先Entity（複数可）、依存先サービス名（複数可）、関係する機能設計書名(複数可)を出力してください。`,
//                 contentEn: `Please output the service name (English name), method name (English name), source screen ID (multiple), dependent entity (multiple), dependent service name (multiple), and related function design document name (multiple) in tabular format.`,
//             }
//         ];
//     }
// }

// class Step0092_ServiceMethodListReqRes extends BaseStepDomainModelGenerator {
//     // format: StepOutputFormat = StepOutputFormat.JSON;
//     constructor() {
//         super();
//         const beforeStep = getStepInstance(Step0090_ServiceMethodList);
//         this.presetMessages.push({ role: 'user', content: beforeStep.prompt });
//         this.presetMessages.push({ role: 'assistant', content: beforeStep.result });

//         this.chapters = [
//             {
//                 title: `Instructions`,
//                 contentJa: Utils.trimLines(`
//                     先程のサービスメソッド一覧について、エンドポイントとrequestとresponseの形式を考えてください。
//                     型はjavaの記法で書いてください。
//                 `),
//                 contentEn: Utils.trimLines(`
//                     Please consider the endpoint, request type, and response type for the service method list you just created.
//                     Please write the type in Java notation.
//                 `),
//             }, {
//                 title: 'Output Format',
//                 // content: `表形式でサービス名(英語名)、ID（英語名）、名前、メソッド、エンドポイント利用元画面IDリストを出力してください。`,
//                 contentJa: `表形式でサービス名(英語名)、メソッド名（英語名）、日本語名、メソッド、エンドポイント、requestの形式、responseの形式を出力してください。`,
//                 contentEn: `Please output the service name (English name), method name (English name), Japanese name, method, endpoint, request format, and response format in tabular format.`,
//             }
//         ];
//     }

//     /**
//      * サービス一覧は大規模リストに対応できるように列を分けて二段階で作っているので、ここでマージ処理を行う。
//      * @param result
//      * @returns
//      */
//     postProcess(result: string): string {
//         const mergedAPIList = [];

//         // 前回ステップで作成したものをmarkdownテーブルから読み込む。
//         const serviceList = Utils.loadTableDataFromMarkdown(getStepInstance(Step0090_ServiceMethodList).formed).data.reduce((before: { [key: string]: { [key: string]: { usageScreenIdList: string[], entityList: string[], serviceList: string[], documentList: string[] } } }, current: string[]) => {
//             const [serviceName, apiName, usageScreenIdListString, entityListString, serviceListString, documentListString] = current;
//             if (!before[serviceName]) {
//                 before[serviceName] = {};
//             } else { }
//             const usageScreenIdList = usageScreenIdListString.split(',').map(s => s.trim()).filter(s => s);
//             const entityList = entityListString.split(',').map(s => s.trim()).filter(s => s);
//             const serviceList = serviceListString.split(',').map(s => s.trim()).filter(s => s);
//             const documentList = documentListString.split(',').map(s => s.trim()).filter(s => s);
//             before[serviceName][apiName] = { usageScreenIdList, entityList, serviceList, documentList };
//             return before;
//         }, {}) as { [key: string]: { [key: string]: ServiceMethod } };

//         // 今回のステップで作成したものをmarkdownテーブルから読み込む。
//         Utils.loadTableDataFromMarkdown(result).data.forEach(element => {
//             const [serviceName, apiName, name, method, _endpoint, request, response] = element;

//             // endpointとpathVariableを整備する。
//             const pathVariableListByEndpoint = Array.from(_endpoint.matchAll(/\{([^}]+)\}/g)).map(match => match[1]);
//             let pathVariableList = request.split(',').filter((_, index) => index < pathVariableListByEndpoint.length).map(s => s.trim().split(' ')[1]);
//             let endpoint = _endpoint;
//             if (['POST', 'PUT', 'PATCH'].includes(method.toUpperCase())) {
//                 // POST, PUT, PATCHの場合は、pathVariableを削除する。
//                 endpoint = endpoint.replace(/\{([^}]+)\}/g, '').replace(/\/\/+/, '/').replace(/\/$/, '');
//                 pathVariableList = [];
//             } else {
//                 // GET, DELETEの場合は、pathVariableを使えるように整備する。
//                 pathVariableListByEndpoint.forEach((pathVariable, index) => {
//                     endpoint = endpoint.replace(`{${pathVariable}}`, `{${pathVariableList[index]}}`);
//                 });
//             }
//             serviceList[serviceName][apiName] = { ...serviceList[serviceName][apiName], name, method, endpoint, pathVariableList, request, response };
//         });

//         const entityModel = JSON.parse(fs.readFileSync(`results/${this.agentName}/${PROJECT_NAME}/EntityDetailFilled.json`, 'utf-8')) as EntityModelClass;
//         // テーブル形式のデータを作成する。
//         const heads = ['serviceName', 'apiName', 'name', 'method', 'endpoint', 'pathVariableList', 'request', 'response', 'usageScreenIdList', 'Dependent Repositories', 'Dependent Services', 'Related Functional Specifications'];
//         mergedAPIList.push(heads);
//         mergedAPIList.push(heads.map(() => '---'));
//         Object.keys(serviceList).forEach(serviceName => {
//             Object.keys(serviceList[serviceName]).forEach(apiName => {
//                 // const pathVariableList = (serviceList[serviceName][apiName].endpoint.match(/\{([^}]+)\}/g) || []).map(pathVariable => pathVariable.replace(/^\{/, '').replace(/\}$/, ''));
//                 mergedAPIList.push([
//                     Utils.toPascalCase(Utils.safeFileName(serviceName)).replace(/Service$/g, '') + 'Service', // サービス名を標準化 ⇒ PascalCaseService にする。
//                     Utils.toCamelCase(Utils.safeFileName(apiName)), // メソッド名を標準化 ⇒ camelCase にする。
//                     serviceList[serviceName][apiName].name,
//                     serviceList[serviceName][apiName].method.toUpperCase(), // httpメソッドは大文字にする。
//                     serviceList[serviceName][apiName].endpoint,
//                     serviceList[serviceName][apiName].pathVariableList.join(','),
//                     serviceList[serviceName][apiName].request,
//                     serviceList[serviceName][apiName].response,
//                     serviceList[serviceName][apiName].usageScreenIdList.join(','),
//                     // Entity以外のもの（embeddableなど）は除外する。
//                     serviceList[serviceName][apiName].entityList.filter(entity => entityModel.entityNameList.includes(entity)).map(entity => `${entity}Repository<${entity}, Long>`).join(','),
//                     serviceList[serviceName][apiName].serviceList.join(','),
//                     serviceList[serviceName][apiName].documentList.join(',')
//                 ]);
//             });
//         });
//         const apiDataTable = mergedAPIList.map(row => `| ${row.join(' | ')} |`).join('\n');
//         // service用にヘッダーを設定する。
//         mergedAPIList[0][1] = 'methodName';
//         mergedAPIList[0][6] = 'args';
//         mergedAPIList[0][7] = 'return';
//         // service用にmethodとendpointとpathVariableListを削除する。
//         const serviceDataTable = mergedAPIList.map(row => `| ${row.slice(0, 3).concat(row.slice(6, 10)).join(' | ')} |`).join('\n');

//         // markdownとjsonで出力する。
//         fss.writeFileSync(`results/${this.agentName}/${PROJECT_NAME}/ApiList.md`, apiDataTable);
//         fss.writeFileSync(`results/${this.agentName}/${PROJECT_NAME}/ServiceList.md`, serviceDataTable);
//         fss.writeFileSync(`results/${this.agentName}/${PROJECT_NAME}/ServiceList.json`, JSON.stringify(serviceList, null, 2));
//         return result;
//     }
// }

// class Step0095_ApiListJson extends BaseStepDomainModelGenerator {
//     format: StepOutputFormat = StepOutputFormat.JSON;
//     constructor() {
//         super();
//         this.chapters = [
//             {
//                 title: `Instructions`,
//                 contentJa: Utils.trimLines(`与えられた表をJSON形式に変換してください。`),
//                 contentEn: Utils.trimLines(`Convert the given table to JSON format.`),
//             }, {
//                 content: Utils.setMarkdownBlock(Utils.mdTrim(getStepInstance(Step0090_ServiceMethodList).formed), 'markdown'),
//             }, {
//                 title: 'Output Format',
//                 // {"serviceName":{"apiName":{"name":"API名","method":"GET","endpoint":"/api/endpoint","request":"{ request }","response":"{ response }","usageScreenIdList":"画面IDリスト"}}}
//                 contentJa: Utils.trimLines(`
//                     以下のJSON形式で出力してください。
//                     {"serviceName":{"apiName":{"name":"API名","method":"GET","endpoint":"/api/endpoint","usageScreenIdList":["画面ID",],"entityList":["Entity名",],"documentList":["機能設計書",]}}}
//                 `),
//                 contentEn: Utils.trimLines(`
//                     Please output in the following JSON format.
//                     {"serviceName":{"apiName":{"name":"API name","method":"GET","endpoint":"/api/endpoint","usageScreenIdList":["screenID",],"entityList":["Entity name",],"documentList":["function design document",]}}}
//                 `),
//             }
//         ];
//     }
// }

type EntityDetailFilled = {
  classes: Record<
    string,
    {
      relatedClasses: string[];
      type: "entity" | "valueObject";
      imports: string[];
      annotations: string[];
      source: string;
      mdTable: string;
      props: {
        type: string;
        strippedType: string;
        name: string;
        annotations: string[];
        isOptional: boolean;
        description: string;
      }[];
    }
  >;
  enums: Record<
    string,
    { type: "enum"; source: string; mdTable: string; values: string[] }
  >;
  entityNameList: string[];
  valueObjectNameList: string[];
  enumNameList: string[];
};

/**
 * APIドキュメントを作成する。
 * ※要らないかもしれない。
 */
class Step0100_ApiDocuments extends MultiStepDomainModelGenerator {
  viewList = JSON.parse(
    fs.readFileSync(
      `results/${this.agentName}/${PROJECT_NAME}/ViewList.json`,
      "utf-8"
    )
  ).viewList as {
    name: string;
    destinationList: string[];
    relatedFeatureList: string[];
    relatedFeatureDocumentList: string[];
    relatedEntityList: string[];
    relatedEntityDoc: string;
  }[];
  serviceList = JSON.parse(
    fs.readFileSync(
      `results/${this.agentName}/${PROJECT_NAME}/ServiceList.json`,
      "utf-8"
    )
  ) as { [key: string]: { [key: string]: ServiceMethod } };
  entityDetailFilled = JSON.parse(
    fs.readFileSync(
      `results/${this.agentName}/${PROJECT_NAME}/EntityDetailFilled.json`,
      "utf-8"
    )
  ) as EntityDetailFilled;

  ENTITY_LIST = fs.readFileSync(
    `results/${this.agentName}/${PROJECT_NAME}/entities.md`,
    "utf-8"
  );
  API_LIST = fs.readFileSync(
    `results/${this.agentName}/${PROJECT_NAME}/ApiList.md`,
    "utf-8"
  );
  SERVICE_LIST = fs.readFileSync(
    `results/${this.agentName}/${PROJECT_NAME}/ServiceList.md`,
    "utf-8"
  );

  repositoryDocs = this.entityDetailFilled.entityNameList
    .map((entityName) => `- ${entityName}Repository<${entityName}, Long>`)
    .join("\n");

  constructor() {
    super();

    // 画面一覧から画面と紐づく機能一覧を取得する。
    const featureMas = getStepInstance(
      Step0030_DesignSummary
    ).childStepList.reduce((acc: { [key: string]: string }, step: BaseStep) => {
      const feature = (step as any).feature;
      acc[feature] = step.formed;
      // "機能"の有無で取りこぼしを防ぐ。
      acc[feature.replace(/機能$/g, "")] = step.formed;
      acc[feature + "機能"] = step.formed;
      acc[feature.replace(/機能の詳細化$/g, "")] = step.formed;
      acc[feature + "機能の詳細化"] = step.formed;
      acc[feature.replace(/の詳細化$/g, "")] = step.formed;
      acc[feature + "の詳細化"] = step.formed;
      return acc;
    }, {} as { [key: string]: string });

    const parentInstance = this;

    class Step0100_ApiDocumentsChil extends BaseStepDomainModelGenerator {
      // model: GPTModels = 'gpt-3.5-turbo';
      constructor(
        public serviceName: string,
        public apiName: string,
        public api: {
          name: string;
          method: string;
          endpoint: string;
          request: string;
          response: string;
          usageScreenIdList: string[];
        },
        public viewDocList: string[],
        public featureList: string[]
      ) {
        super();
        const apiId = Utils.safeFileName(serviceName + "." + apiName);
        // 複数並列処理するので、被らないようにラベルを設定する。（これがログファイル名になる）
        this.label = `${this.constructor.name}_${Utils.safeFileName(apiId)}`; // Utils.safeFileNameはファイル名として使える文字だけにするメソッド。
        // 個別の指示を作成。
        this.chapters = [
          {
            title: `Instructions`,
            contentJa: Utils.trimLines(`
                            これから提示する設計書をよく読んで、APIの詳細設計書を作成してください。
                            あなたの担当は「${apiId}」です。担当外のものはやらなくてよいです。
                            特に、「バックエンド処理詳細」については以下のルールに則って考えてください。
                            - 可能な限り詳細、かつ正確に記載すること
                            - フローチャートが描けるのに十分な詳細を記載すること
                            - エンティティ、サービスを使う場合は英字名を使うこと
                            - ビジネスロジックの流れを記載すること
                        `),
            contentEn: Utils.trimLines(`
                            Please read the following design document carefully and create a detailed design document for the API.
                            Your assignment is "${apiId}". You don't have to do anything outside of your assignment.
                            In particular, consider the following rules for "Backend Processing Details".
                            - Describe in as much detail and accuracy as possible
                            - Describe in sufficient detail to draw a flowchart
                            - Use English names when using entities and services
                            - Describe the flow of business logic
                        `),
          },
          {
            titleJa: "全体設計書",
            titleEn: "Overall Design Document",
            contentJa: `全体設計書はシステム全体について語っています。あなたの担当分が相対的にどのような役割かを理解するのに役立ててください。`,
            contentEn: `The overall design document talks about the entire system. Use it to understand the relative role of your assignment.`,
            children: [
              {
                // サービス一覧だけの方がいいかもしれないのでAPI一覧を外す。
                //     title: `API一覧`,
                //     content: parentInstance.API_LIST,
              },
              {
                titleJa: `サービス一覧`,
                titleEn: `Service List`,
                content: parentInstance.SERVICE_LIST,
              },
              {
                title: `Domain Models`,
                content: Utils.addMarkdownDepth(parentInstance.ENTITY_LIST, 1),
              },
              {
                title: `Repository`,
                content: parentInstance.repositoryDocs,
              },
            ],
          },
          {
            titleJa: "個別設計書",
            titleEn: "Individual Design Document",
            contentJa: `個別設計書はあなたの担当に関係する部分です。`,
            contentEn: `The individual design document is related to your assignment.`,
            children: [
              {
                titleJa: `機能設計書`,
                titleEn: `Function Design Document`,
                content: Utils.setMarkdownBlock(
                  Utils.mdTrim(featureList.join("\n\n---\n\n")),
                  "markdown"
                ),
              },
              {
                titleJa: `画面設計書`,
                titleEn: `View Design Document`,
                content: Utils.setMarkdownBlock(
                  Utils.mdTrim(viewDocList.join("\n\n---\n\n")),
                  "markdown"
                ),
              },
            ],
          },
          {
            title: "Output Sample",
            contentJa:
              `以下のサンプル設計書の書き方に倣ってください。ただし「バックエンド処理詳細」についてはサンプルの書き方よりももっと詳細かつ長大な記載になってもよいです。\n\n` +
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
            contentEn:
              `Please follow the sample design document. However, for "Backend Processing Details", it may be more detailed and longer than the sample.` +
              "\n\n" +
              Utils.trimLines(`
                                ---
                                # Detailed Design Document: AppointmentService.getAvailableAppointmentSlots

                                ## Function Summary
                                - Function Name: Get Available Appointment Slots
                                - Function ID: getAvailableAppointmentSlots
                                - Function Description: Get the available appointment slots at the dental clinic for a specific date.

                                ## API Specification

                                ### Endpoint
                                - Method: GET
                                - Path: /api/appointments/slots
                                - Query Parameters:
                                  - date: LocalDate (required) - The date for which the user wants to check the available appointment slots.

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
                                    // ... Other available appointment slots
                                  ]
                                }
                                \`\`\`

                                ### Response Fields
                                - slots: List<AppointmentSlot> - List of available appointment slots.
                                  - slotId: Long - Unique identifier for the slot.
                                  - date: LocalDate - Date of the available appointment slot.
                                  - startTime: LocalTime - Start time of the available appointment slot.
                                  - endTime: LocalTime - End time of the available appointment slot.
                                  - doctorId: Long - ID of the doctor providing the available appointment slot.
                                  - slotStatus: SlotStatus - Status of the slot (AVAILABLE: Available, BOOKED: Booked).

                                ### Error Responses
                                - 400 Bad Request: If the date is not specified or in an invalid format.
                                - 404 Not Found: If no available appointment slots exist for the specified date.
                                - 500 Internal Server Error: If the server is unable to retrieve the available appointment slots due to a server-side issue.
                                
                                ### Error Message Example
                                \`\`\`json
                                {
                                  "message": "Invalid date format. Please use 'YYYY-MM-DD'."
                                }
                                \`\`\`

                                ## Backend Processing Details
                                1. Retrieve the date from the request and perform validation.
                                2. Retrieve the available appointment slots from the database for the specified date.
                                3. Check the status of each slot (booked or available) and add to the list.
                                4. Return the list of available appointment slots as the response.

                                ## Business Logic
                                - Available appointment slots are only displayed within the clinic's office hours.
                                - Days when the clinic is closed or when a doctor is on vacation are not displayed as available appointment slots.
                                - Booked time slots are deactivated to prevent other patients from booking.
                                - Available appointment slots for each doctor are dynamically generated based on the doctor's schedule.
                                - The display of available appointment slots is by default for all registered doctors in the system, but patients can narrow down the display by selecting a specific doctor.
                                - The available appointment slot data is always updated to reflect the latest information.
                            `),
          },
        ];
      }
    }
    // console.log(serviceData);

    const viewDocMap = getStepInstance(
      Step0070_ViewDocuments
    ).childStepList.reduce(
      (before: { [key: string]: any }, current: BaseStep) => {
        const featureName = (current as any).view.name;
        if (!before[featureName]) {
          before[featureName] = [];
        } else {
        }
        before[featureName] = current.formed;
        return before;
      },
      {}
    );

    // console.log(entityData);
    this.childStepList = Object.entries(this.serviceList)
      .map(([serviceName, apiData]) =>
        Object.entries(apiData).map(([apiName, api]) => {
          // 利用元画面を取得
          const views = this.viewList.filter((view) =>
            api.usageScreenIdList.some(
              (usageScreenId) => view.name === usageScreenId
            )
          );
          // 利用元画面から機能設計書を取得。重複削除もする。
          const features = Array.from(
            new Set(views.map((view) => view.relatedFeatureList).flat())
          ).map((featureName) => featureMas[featureName]);
          const viewDocs = views.map((view) => viewDocMap[view.name]);
          return new Step0100_ApiDocumentsChil(
            serviceName,
            apiName,
            api,
            viewDocs,
            features
          );
        })
      )
      .flat();
  }

  postProcess(result: string[]): string[] {
    // 使いやすいようにJSON形式でまとめておく
    const allObj = result.reduce((prev, objString: string, index: number) => {
      // ChildStepの型がないので、anyでキャストする。
      const childStep = this.childStepList[index] as any as {
        serviceName: string;
        apiName: string;
      };
      // マップに追加する。
      prev[
        Utils.safeFileName(`${childStep.serviceName}.${childStep.apiName}`)
      ] = objString;
      return prev;
    }, {} as Record<string, any>);

    const outputFileName = `results/${this.agentName}/${PROJECT_NAME}/ServiceDocs.json`;
    fss.writeFileSync(outputFileName, JSON.stringify(allObj, null, 2));
    return result;
  }
}

class Step0110_ApiSourceReqRes extends MultiStepDomainModelGenerator {
  entityList = fs.readFileSync(
    `results/${this.agentName}/${PROJECT_NAME}/entities.java.md`,
    "utf-8"
  );
  serviceList = JSON.parse(
    fs.readFileSync(
      `results/${this.agentName}/${PROJECT_NAME}/ServiceList.json`,
      "utf-8"
    )
  ) as { [key: string]: { [key: string]: ServiceMethod } };
  constructor() {
    super();
    const parentInstance = this;

    class Step0110_ApiSourceReqResChil extends BaseStepDomainModelGenerator {
      // model: GPTModels = 'gpt-3.5-turbo';
      // format: StepOutputFormat = StepOutputFormat.JSON;
      constructor(
        public serviceName: string,
        public apiName: string,
        public detailDocument: string,
        public request: string,
        public response: string
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
            contentJa: Utils.trimLines(`
                            これから提示する設計書をよく読んで、APIのRequestDto/ResponseDtoを作成してください。
                            あなたの担当は「${apiId}」です。担当外のものはやらなくてよいです。
                            RequestDto/ResponseDtoのクラス名は、以下のルールに則ってください。
                            - RequestDto -> ${Utils.toPascalCase(
              serviceName
            )}${Utils.toPascalCase(apiName)}RequestDto
                            - ResponseDto -> ${Utils.toPascalCase(
              serviceName
            )}${Utils.toPascalCase(apiName)}ResponseDto
                            RequestDtoには Jakarta Bean Validation API のバリデーターを付けてください。
                            Lombokの@Dataを使ってください。
                            階層化されたRequestDtoの内部項目に対してバリデーションを行う場合は、内部クラスとして定義してください。
                            ${PACKAGE_NAME}.domain.entity, ${PACKAGE_NAME}.domain.enumsを有効利用してください。バリデーションを掛けるためにそれらをextendsしてもよいです。
                            クラスメンバはフィールドのみとすること（コンストラクタとメソッドは不要）。
                        `),
            contentEn: Utils.trimLines(`
                            Please read the following design document carefully and create the RequestDto/ResponseDto for the API.
                            Your assignment is "${apiId}". You don't have to do anything outside of your assignment.
                            The class names of RequestDto/ResponseDto should follow the following rules.
                            - RequestDto -> ${Utils.toPascalCase(
              serviceName
            )}${Utils.toPascalCase(apiName)}RequestDto
                            - ResponseDto -> ${Utils.toPascalCase(
              serviceName
            )}${Utils.toPascalCase(apiName)}ResponseDto
                            Please attach Jakarta Bean Validation API validators to RequestDto.
                            Use Lombok's @Data.
                            If you want to validate the internal items of the hierarchical RequestDto, define it as an inner class.
                            Please make effective use of ${PACKAGE_NAME}.domain.entity, ${PACKAGE_NAME}.domain.enums. You may extend them to apply validation.
                            Class members should be fields only (constructors and methods are not required).
                        `),
          },
          {
            titleJa: "設計書",
            titleEn: "Design Document",
            children: [
              {
                title: `${Utils.toPascalCase(serviceName)}${Utils.toPascalCase(
                  apiName
                )}RequestDto`,
                content: request,
              },
              {
                title: `${Utils.toPascalCase(serviceName)}${Utils.toPascalCase(
                  apiName
                )}ResponseDto`,
                content: response,
              },
              {
                contentJa: Utils.addMarkdownDepth(detailDocument, 1),
              },
              {
                titleJa: `共通Entity`,
                titleEn: `Common Entity`,
                content: parentInstance.entityList,
              },
            ],
          },
          {
            title: "Output Format",
            contentJa: Utils.trimLines(`
                            javaのソースコードのみを出力してください。
                            説明は不要です。
                        `),
            contentEn: Utils.trimLines(`
                            Please output only the java source code.
                            No explanation is required.
                        `),
          },
        ];
      }
    }
    // console.log(entityData);
    const serviceMethodDocMas = getStepInstance(
      Step0100_ApiDocuments
    ).childStepList.reduce(
      (before: { [key: string]: any }, current: BaseStep) => {
        const serviceMethodName = Utils.safeFileName(
          (current as any).serviceName + "." + (current as any).apiName
        );
        if (!before[serviceMethodName]) {
          before[serviceMethodName] = [];
        } else {
        }
        before[serviceMethodName] = current.formed;
        return before;
      },
      {}
    );
    this.childStepList = Object.entries(this.serviceList)
      .map(
        ([serviceName, apiData]) =>
          Object.entries(apiData).map(([apiName, api]) => {
            return new Step0110_ApiSourceReqResChil(
              serviceName,
              apiName,
              serviceMethodDocMas[`${serviceName}.${apiName}`],
              api.request,
              api.response
            );
          }) // .filter(step => step.serviceName === 'CustomerInformationService' && step.apiName === 'saveCustomerInformation')
      )
      .flat();
  }

  postProcess(result: string[]): string[] {
    // javaのソースコードを解析してモデル化してファイルに出力する。
    const mas: Record<string, DtoClass> = {};
    result.forEach((dtoString: string, index: number) => {
      // service->apiの単位でループするので、サービスでまとめる。
      const { serviceName, apiName } = this.childStepList[index] as any;
      if (!mas[serviceName]) {
        mas[serviceName] = new DtoClass(serviceName);
      } else {
      }
      let dto: DtoClass = mas[serviceName];
      const root = dto;
      const reqDto = `${Utils.toPascalCase(serviceName)}${Utils.toPascalCase(
        apiName
      )}RequestDto`;
      const resDto = `${Utils.toPascalCase(serviceName)}${Utils.toPascalCase(
        apiName
      )}ResponseDto`;
      dto.methods.push({
        name: apiName,
        type: resDto,
        annotations: [],
        description: "",
        args: [reqDto],
        body: "",
      });
      const dtoChain: DtoClass[] = [dto];
      let annotationStock: string[] = [];
      Utils.mdTrim(dtoString)
        .split("\n")
        .forEach((line, lineIndex) => {
          const trimed = line.trim();
          if (
            !trimed ||
            trimed.startsWith("package ") ||
            trimed.startsWith("//") ||
            trimed.startsWith("*") ||
            trimed.startsWith("/*") ||
            trimed.startsWith("@Override") ||
            trimed.startsWith("@SuppressWarnings") ||
            trimed.startsWith("@Data")
          ) {
            // skip
          } else if (line.startsWith("import ")) {
            // import文を追加する。（重複は除く）
            const importLine = line
              .replace("import ", "")
              .replace(/;.*$/g, "")
              .trim();
            if (!dto.imports.includes(importLine)) dto.imports.push(importLine);
          } else if (trimed.startsWith("@")) {
            if (trimed.startsWith("@Length")) {
              // @Sizeと@Lengthをミスっていることがあるので@Sizeに統一する。
              annotationStock.push("@Size");
            } else {
              annotationStock.push(trimed);
            }
          } else {
            // console.log(`line-bef: ${serviceName} ${line}`);
            line = line.replace(/^\s*(?:public |private )/g, "");
            line = line.replace(/^\s*(?:static )/g, "");
            // console.log(`line-aft: ${serviceName} ${line}`);
            if (line.startsWith("class ")) {
              const className = line.split(" ")[1];
              dtoChain.push(dto);
              dto.innerClasses.push((dto = new DtoClass(className)));
              dto.name = className;
            } else if (trimed.split("//")[0].trim().endsWith(";")) {
              const splitted = line
                .trim()
                .split("//")[0]
                .trim()
                .replace(/;.*$/g, "")
                .trim()
                .split(" ");
              const type = splitted.slice(0, -1).join(" ");
              const name = splitted[splitted.length - 1];
              dto.fields.push({
                name,
                type,
                annotations: annotationStock,
                description: trimed.split("//")[1] || "",
              });
              annotationStock = [];
            } else if (trimed.startsWith("}")) {
              dto = dtoChain.pop() as DtoClass;
            } else {
              console.log(
                `unknown line ${serviceName}.${apiName} ${lineIndex}: ${line}`
              );
            }
          }
        });

      // 後処理
      // request/responseの型がもしなかったら追加する。(requestは項目なしだとない時があるので。）
      [reqDto, resDto].forEach((dtoType) => {
        if (root.innerClasses.find((inner) => inner.name === dtoType)) {
        } else {
          root.innerClasses.push(new DtoClass(dtoType));
        }
      });
      // なんとなくimport文をソートしておく。
      root.imports.sort();
    });

    // 全部まとめてファイルに出力する。
    fss.writeFileSync(
      `results/${this.agentName}/${PROJECT_NAME}/ServiceModel.json`,
      JSON.stringify(mas, null, 2)
    );

    // ここまでで、Serviceのインターフェースが確定したので、service/controllerのソースを作成する。
    const javaInterfaceSourceMap = javaInterfaceMap(
      JSON.parse(
        fs.readFileSync(
          `results/${this.agentName}/${PROJECT_NAME}/ServiceList.json`,
          "utf-8"
        )
      ) as { [key: string]: { [key: string]: ServiceMethod } },
      mas, // 今作ったばかりのServiceModel
      JSON.parse(
        fs.readFileSync(
          `results/${this.agentName}/${PROJECT_NAME}/ServiceDocs.json`,
          "utf-8"
        )
      ) as Record<string, string>,
      JSON.parse(
        fs.readFileSync(
          `results/${this.agentName}/${PROJECT_NAME}/EntityDetailFilled.json`,
          "utf-8"
        )
      ) as EntityDetailFilledType,
      PACKAGE_NAME
    );
    Object.entries(javaInterfaceSourceMap).forEach(([key, value]) => {
      fss.writeFileSync(
        `results/${this.agentName}/${PROJECT_NAME}/${SPRING_DIRE}/domain/service/${key}.java`,
        value.interface
      );
      fss.writeFileSync(
        `results/${this.agentName}/${PROJECT_NAME}/${SPRING_DIRE}/domain/controller/${key}Controller.java`,
        value.controller
      );
    });

    // Serviceのインターフェースが確定したので、Angularのサービスを作成する。
    const angularServiceSourceMap = angularServiceMap(
      JSON.parse(
        fs.readFileSync(
          `results/${this.agentName}/${PROJECT_NAME}/ServiceList.json`,
          "utf-8"
        )
      ) as { [key: string]: { [key: string]: ServiceMethod } },
      mas, // 今作ったばかりのServiceModel
      JSON.parse(
        fs.readFileSync(
          `results/${this.agentName}/${PROJECT_NAME}/ServiceDocs.json`,
          "utf-8"
        )
      ) as Record<string, string>,
      JSON.parse(
        fs.readFileSync(
          `results/${this.agentName}/${PROJECT_NAME}/EntityDetailFilled.json`,
          "utf-8"
        )
      ) as EntityDetailFilledType
    );
    Object.entries(angularServiceSourceMap).forEach(([key, value]) => {
      fss.writeFileSync(
        `results/${this.agentName
        }/${PROJECT_NAME}/angular/src/app/service/${Utils.toKebabCase(
          key
        )}.service.ts`,
        value
      );
    });
    return result;
  }
}

class Step0120_ApiSourceJson extends MultiStepDomainModelGenerator {
  entityModel: EntityDetailFilledType = JSON.parse(
    fs.readFileSync(
      `results/${this.agentName}/${PROJECT_NAME}/EntityDetailFilled.json`,
      "utf-8"
    )
  ) as EntityDetailFilledType;
  serviceList: { [key: string]: { [key: string]: ServiceMethod } } = JSON.parse(
    fs.readFileSync(
      `results/${this.agentName}/${PROJECT_NAME}/ServiceList.json`,
      "utf-8"
    )
  ) as { [key: string]: { [key: string]: ServiceMethod } };
  serviceModel: Record<string, DtoClass> = JSON.parse(
    fs.readFileSync(
      `results/${this.agentName}/${PROJECT_NAME}/ServiceModel.json`,
      "utf-8"
    )
  ) as Record<string, DtoClass>;
  serviceDocs: Record<string, string> = JSON.parse(
    fs.readFileSync(
      `results/${this.agentName}/${PROJECT_NAME}/ServiceDocs.json`,
      "utf-8"
    )
  ) as Record<string, string>;

  ENTITY_LIST = fs.readFileSync(
    `results/${this.agentName}/${PROJECT_NAME}/entities.md`,
    "utf-8"
  );
  SERVICE_LIST = fs.readFileSync(
    `results/${this.agentName}/${PROJECT_NAME}/ServiceList.md`,
    "utf-8"
  );
  REPOSITORY_LIST = this.entityModel.entityNameList
    .map((entityName) => `- ${entityName}Repository<${entityName}, Long>`)
    .join("\n");

  constructor() {
    super();

    const serviceTemplateMap = javaServiceTemplateMap(
      this.serviceList,
      this.serviceModel,
      this.serviceDocs,
      this.entityModel,
      PACKAGE_NAME
    );
    const serviceInterfaceMap: Record<string, string> = Object.entries(
      this.serviceList
    ).reduce((prev: Record<string, string>, [serviceName, apiData]) => {
      prev[serviceName] = fs.readFileSync(
        `results/${this.agentName}/${PROJECT_NAME}/${SPRING_DIRE}/domain/service/${serviceName}.java`,
        "utf-8"
      );
      return prev;
    }, {});

    const exceptionSource =
      Utils.setMarkdownBlock(
        fs.readFileSync(
          `results/${this.agentName}/${PROJECT_NAME}/${SPRING_DIRE}/exception/ResourceNotFoundException.java`,
          "utf-8"
        ),
        "java com.example.demo.exception.ResourceNotFoundException"
      ) +
      "\n\n" +
      Utils.setMarkdownBlock(
        fs.readFileSync(
          `results/${this.agentName}/${PROJECT_NAME}/${SPRING_DIRE}/exception/CustomException.java`,
          "utf-8"
        ),
        "java com.example.demo.exception.CustomException"
      );

    // console.log(serviceTemplateMap);
    const parentInstance = this;
    class Step0120_ApiSourceJsonChil extends BaseStepDomainModelGenerator {
      // model: GPTModels = 'gpt-3.5-turbo';
      format: StepOutputFormat = StepOutputFormat.JSON;
      constructor(
        public serviceName: string,
        public apiName: string,
        public api: {
          name: string;
          method: string;
          endpoint: string;
          request: string;
          response: string;
          usageScreenIdList: string[];
          serviceList: string[];
        }
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
            contentJa: Utils.trimLines(`
                            これから提示する設計書をよく読んで、サービス実装のひな型のTODOを実装してください。
                            あなたの担当は「${apiId}」です。担当外のものはやらなくてよいです。
                            RequestDtoはEntityと似ていても異なるものです。マッピング処理を忘れないように注意してください。
                            項目の型には注意しましょう。Entityの型とは異なることがあります。
                            また、バリデーションは別のクラスで実装してあるので実装しなくてよいです。
                            Entityの操作は、対応するAPI、もしくはRepositoryインターフェース経由で行ってください。（entityManager.createQueryは禁止です）。
                            追加のインジェクションが必要な場合は「サービス一覧」、「Repository一覧」の中からのみ選択可能です。
                        `),
            contentEn: Utils.trimLines(`
                            Please read the following design document carefully and implement the TODO of the service implementation.
                            Your assignment is "${apiId}". You don't have to do anything outside of your assignment.
                            RequestDto is similar to Entity but different. Be careful not to forget the mapping process.
                            Pay attention to the type of the item. It may be different from the type of the Entity.
                            Also, the validation is implemented in another class, so you don't have to implement it.
                            Entity operations should be performed through the corresponding API or Repository interface. (entityManager.createQuery is prohibited).
                            If additional injection is required, it can only be selected from the "Service List" and "Repository List".
                        `),
          },
          {
            titleJa: "個別設計書",
            titleEn: "Individual Design Document",
            contentJa: `個別設計書はあなたが実装すべき設計書です`,
            contentEn: `The individual design document is the design document you should implement`,
            children: [
              {
                titleJa: `サービス実装のひな型`,
                titleEn: `Service Implementation Template`,
                content: Utils.setMarkdownBlock(
                  serviceTemplateMap[apiId],
                  "java"
                ),
              },
              {
                content: Utils.addMarkdownDepth(
                  parentInstance.serviceDocs[apiId],
                  1
                ),
              },
            ],
          },
          {
            titleJa: "全体設計書",
            titleEn: "Overall Design Document",
            contentJa: `全体設計書はシステム全体について語っています。あなたの担当分が相対的にどのような役割かを理解するのに役立ててください。`,
            contentEn: `The overall design document speaks about the entire system. Use it to understand the relative role of your assignment.`,
            children: [
              {
                titleJa: `フレームワーク`,
                titleEn: `Framework`,
                content: `SpringBoot + JPA`,
              },
              {
                titleJa: `ディレクトリ構成`,
                titleEn: `Directory Structure`,
                contentJa: Utils.trimLines(`
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
                contentEn: Utils.trimLines(`
                                - ${PACKAGE_NAME}
                                  - domain: Package for the domain layer
                                    - controller: Package for the controller
                                    - service: Package for the service interface class
                                      - impl: Package for the service implementation class
                                    - repository: Package for the repository interface class
                                    - entity: Package for the entity
                                    - enums: Package for the enum
                                  - exception: Package for the Exception class
                            `),
              },
              {
                titleJa: `サービス一覧`,
                titleEn: `Service List`,
                content: parentInstance.SERVICE_LIST,
              },
              {
                titleJa: `利用サービス`,
                titleEn: `Used Services`,
                content:
                  api.serviceList
                    .map((serviceName) =>
                      Utils.setMarkdownBlock(
                        serviceInterfaceMap[serviceName],
                        "java"
                      )
                    )
                    .join("\n") || "なし",
              },
              {
                titleJa: `Repository一覧`,
                titleEn: `Repository List`,
                content: parentInstance.REPOSITORY_LIST,
              },
              {
                title: `Domain Models`,
                content: Utils.addMarkdownDepth(parentInstance.ENTITY_LIST, 1),
              },
              {
                title: `Common classes`,
                content: exceptionSource,
              },
            ],
          },
          {
            title: "Output Format",
            contentJa: Utils.trimLines(`
                            以下のJSON形式で出力してください。
                            {
                                "additionalImports": ["\${必要な追加のインポートのJava code}"],
                                "additionalInjections": ["\${必要な追加のインジェクションのJava code}"],
                                "methodAnnotations": ["\${メソッドに適用されるアノテーションのJava code}"],
                                "methodBodyInnerCodes": ["\${メソッドの内部実装のJava code with Japanese comment}"],
                                "todos": ["\${メソッドの内部実装で、難しくて実装できないもの}"]
                            }
                        `),
            contentEn: Utils.trimLines(`
                            Please output in the following JSON format.
                            {
                                "additionalImports": ["\${Additional import Java code}"],
                                "additionalInjections": ["\${Additional injection Java code}"],
                                "methodAnnotations": ["\${Method annotation Java code}"],
                                "methodBodyInnerCodes": ["\${Method body inner Java code with Japanese comment}"],
                                "todos": ["\${Things that are difficult to implement in the method body}"]
                            }
                        `),
            // javaソースコードのみを出力してください。
            // 提供されたDto定義は省略してよいです。
            // インポート文は省略しないでください。
            // コメントは日本語でお願いします。
            // メソッドの内容は省略不可です。
            // TODOがあればTODOとわかるようにコメントしてください。
            // 複雑な仕様は推論して実装してください。ただし、存在しないクラスを使ってはいけません。
          },
        ];
      }
    }
    this.childStepList = Object.entries(this.serviceList)
      .map(([serviceName, apiData]) =>
        Object.entries(apiData).map(([apiName, api]) => {
          return new Step0120_ApiSourceJsonChil(serviceName, apiName, api);
        })
      )
      .flat();
  }
  postProcess(result: string[]): string[] {
    // 全部まとめてファイルに出力する。
    const keys = this.childStepList.map((step: BaseStep) =>
      Utils.safeFileName(
        `${(step as any).serviceName}.${(step as any).apiName}`
      )
    );

    const allObj = result.reduce((prev, objString: string, index: number) => {
      const obj = Utils.jsonParse<Record<string, any>>(objString);
      prev[keys[index]] = obj;
      return prev;
    }, {} as Record<string, any>);

    // TODOをリストアップする
    // console.log(allObj);
    // Object.entries(allObj).forEach(([key, value]) => {
    //     console.log(key, value.todos);
    // });

    // javaの実装ソースコードを作成する。
    const javaServiceImplementsMapObj = javaServiceImplementsMap(
      this.serviceList,
      this.serviceModel,
      this.serviceDocs,
      allObj,
      this.entityModel,
      PACKAGE_NAME
    );

    fss.writeFileSync(
      `results/${this.agentName}/${PROJECT_NAME}/service-data.json`,
      JSON.stringify(allObj, null, 2)
    );
    Object.entries(javaServiceImplementsMapObj).forEach(([key, value]) => {
      fss.writeFileSync(
        `results/${this.agentName}/${PROJECT_NAME}/${SPRING_DIRE}/domain/service/impl/${key}Impl.java`,
        value.implement
      );
    });

    return result;
  }
}

class Step0130_RepositoryMethod extends MultiStepDomainModelGenerator {
  constructor() {
    super();
    const ENTITY_LIST = fs.readFileSync(
      `results/${this.agentName}/${PROJECT_NAME}/entities.md`,
      "utf-8"
    );

    type MetaServiceData = Record<
      string,
      Record<
        string,
        {
          name: string;
          method: string;
          endpoint: string;
          request: string;
          response: string;
          usageScreenIdList: string[];
          entityList: string[];
          serviceList: string[];
          documentList: string[];
        }
      >
    >;
    const serviceList = JSON.parse(
      fs.readFileSync(
        `results/${this.agentName}/${PROJECT_NAME}/ServiceList.json`,
        "utf-8"
      )
    ) as MetaServiceData;

    class Step0130_RepositoryMethodChil extends BaseStepDomainModelGenerator {
      // model: GPTModels = 'gpt-3.5-turbo';
      format: StepOutputFormat = StepOutputFormat.JSON;
      constructor(public serviceName: string) {
        super();
        // {"viewList":[{"name": "View name","destinationList":["parts","parts"],"relatedFeatureList":["featureName","featureName"]}]}
        const apiId = Utils.safeFileName(serviceName);
        // 複数並列処理するので、被らないようにラベルを設定する。（これがログファイル名になる）
        this.label = `${this.constructor.name}_${Utils.safeFileName(apiId)}`; // Utils.safeFileNameはファイル名として使える文字だけにするメソッド。

        // 個別の指示を作成。
        this.chapters = [
          {
            title: `Instructions`,
            contentJa: Utils.trimLines(`
                            これから提示するソースコードをよく理解して、Repositoryインターフェースで実装されるべきメソッドを抽出してください。
                        `),
            contentEn: Utils.trimLines(`
                            Please understand the following source code well and extract the methods that should be implemented in the Repository interface.
                        `),
          },
          {
            title: "Target Source Code",
            contentJa: Utils.setMarkdownBlock(
              fs.readFileSync(
                `results/${this.agentName}/${PROJECT_NAME}/${SPRING_DIRE}/domain/service/impl/${apiId}Impl.java`,
                "utf-8"
              ),
              "java"
            ),
          },
          {
            titleJa: "参考資料",
            titleEn: "Reference Documents",
            children: [
              {
                titleJa: `フレームワーク`,
                titleEn: `Framework`,
                content: `SpringBoot + JPA`,
              },
              {
                title: `Entity`,
                contentJa:
                  "以下のentityには、対応するRepositoryインターフェースが存在します。\n\n" +
                  ENTITY_LIST,
                contentEn:
                  "The following entity has a corresponding Repository interface.\n\n" +
                  ENTITY_LIST,
              },
            ],
          },
          {
            title: "Output Format",
            contentJa: Utils.trimLines(`
                            以下のJSON形式で出力してください。
                            {
                                "jpaMethods": {
                                    "EntityName": ["\${JPAメソッドのJava code}"]
                                },
                            }
                        `),
            contentEn: Utils.trimLines(`
                            Please output in the following JSON format.
                            {
                                "jpaMethods": {
                                    "EntityName": ["\${JPA method Java code}"]
                                },
                            }
                        `),
          },
        ];
      }
    }

    // console.log(entityData);
    this.childStepList = Object.entries(serviceList).map(
      ([serviceName, apiData]) => new Step0130_RepositoryMethodChil(serviceName)
    );
  }

  postProcess(result: string[]): string[] {
    // // 全部まとめてファイルに出力する。
    const keys = this.childStepList.map((step: BaseStep) =>
      Utils.safeFileName(`${(step as any).serviceName}`)
    );

    const allObj = result.reduce((prev, objString: string, index: number) => {
      const obj = Utils.jsonParse<Record<string, any>>(objString);
      prev[keys[index]] = obj;
      return prev;
    }, {} as Record<string, Record<string, Record<string, string[]>>>);
    const outputFileName = `results/${this.agentName}/${PROJECT_NAME}/repository-methods.json`;
    fss.writeFileSync(outputFileName, JSON.stringify(allObj, null, 2));
    // console.dir(allObj, { depth: 5 });

    // RespositoryのJSONベースでメソッドをまとめる。
    const repositoryMethods0: Record<string, Set<string>> = {};
    Object.entries(allObj).forEach(([key, value]) => {
      Object.entries(value.jpaMethods).forEach(([entityName, methods]) => {
        if (!repositoryMethods0[entityName]) {
          repositoryMethods0[entityName] = new Set();
        }
        methods.forEach((method) => repositoryMethods0[entityName].add(method));
      });
    });
    // console.dir(repositoryMethods0, { depth: 5 });

    const entityModel = JSON.parse(
      fs.readFileSync(
        `results/${this.agentName}/${PROJECT_NAME}/EntityDetailFilled.json`,
        "utf-8"
      )
    ) as EntityDetailFilledType;
    // console.dir(entityModel, { depth: 5 });

    // EntityベースでRepositoryのメソッドをまとめる。
    const repositoryMethods: Record<string, Set<string>> = {};
    entityModel.entityNameList.forEach((entityName) => {
      [
        repositoryMethods0[entityName],
        repositoryMethods0[`${entityName}Repository`],
      ]
        .filter((bit) => bit)
        .forEach((methods) => {
          if (!repositoryMethods[entityName]) {
            repositoryMethods[entityName] = new Set();
          }
          methods.forEach((method) =>
            repositoryMethods[entityName].add(method)
          );
        });
    });
    // console.log(repositoryMethods);

    Object.entries(repositoryMethods).forEach(([entityName, methods]) => {
      const methodSet = new Set();
      methodSet.add("saveAll"); // saveAllは明示的に定義するとエラーになるので無視させる。
      methodSet.add("save"); // saveは明示的に定義するとワーニングになるので無視させる。
      methodSet.add("findById"); // findByIdはOptional無しの定義が入るとエラーになるので無視させる。
      methodSet.add("findAll"); // findByIdはOptional無しの定義が入るとエラーになるので無視させる。
      const methodList = Array.from(methods).filter((method) => {
        const pattern = /.*\s+(\w+)\s*\((.*?)\)/;
        const match = method.match(pattern);
        if (match) {
          const methodName = match[1];
          const boolean = !methodSet.has(methodName);
          methodSet.add(methodName);
          // console.log(methodName, boolean);
          return boolean;
        } else {
          // メソッドの定義がおかしいので無視する。
          return false;
        }
      });
      const outputFileName = `results/${this.agentName}/${PROJECT_NAME}/${SPRING_DIRE}/domain/repository/${entityName}Repository.java`;
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
                ${methodList
          .map(
            (method) =>
              "\tpublic " +
              method.replace(/^public /g, "").replace(/;$/g, "") +
              ";\n"
          )
          .join("")}
                }
            `);
      fss.writeFileSync(outputFileName, methodsBody);
    });

    return result;
  }
}

class Step0050_EntityListToJson extends BaseStepDomainModelGenerator {
  format: StepOutputFormat = StepOutputFormat.JSON;
  constructor() {
    super();
    this.chapters = [
      {
        title: `Instructions`,
        contentJa: Utils.trimLines(`
                これから提示する設計書をよく読んで、ER図を作成してください。
                抽出にあたってアクター／リソースの両方について、抜け漏れの無いように気を付けてください。
                まずはEntityの名前と役割を一覧化してください。EnumはEntityとは分けて記載してください。
            `),
        contentEn: Utils.trimLines(`
                Please read the following design document carefully and create an ER diagram.
                Be careful not to miss any actors or resources when extracting.
                First, list the names and roles of the entities. Enum should be listed separately from the entity.
            `),
      },
      {
        title: "Input Document",
        content: getStepInstance(Step0010_FeatureListSummaryToFeatureListDetail)
          .formed,
      },
      {
        title: "Output Format",
        content: Utils.trimLines(`
                {"featureList":["feature1","feature2","feature3"]}
            `),
      },
    ];
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
  // POM用の名前
  const split0 = PACKAGE_NAME.split(".");
  const name = split0.pop() || "";

  const vars = {
    packageName: PACKAGE_NAME,
    projectName: PROJECT_NAME,
    "project-name": Utils.toKebabCase(PROJECT_NAME),
    project_name: Utils.toSnakeCase(PROJECT_NAME),
    name,
    artifactId: name,
    groupId: split0.join("."),
  };

  // springのテンプレートを作成する。
  fss.writeFileSync(
    `results/${__dirname}/${PROJECT_NAME}/${SPRING_DIRE}/exception/ResourceNotFoundException.java`,
    Utils.replaceTemplateString(spring_ResourceNotFoundException, vars)
  );
  fss.writeFileSync(
    `results/${__dirname}/${PROJECT_NAME}/${SPRING_DIRE}/exception/CustomException.java`,
    Utils.replaceTemplateString(spring_CustomException, vars)
  );
  fss.writeFileSync(
    `results/${__dirname}/${PROJECT_NAME}/${SPRING_DIRE}/domain/entity/BaseEntity.java`,
    Utils.replaceTemplateString(spring_BaseEntity, vars)
  );
  fss.writeFileSync(
    `results/${__dirname}/${PROJECT_NAME}/${SPRING_DIRE}/DemoApplication.java`,
    Utils.replaceTemplateString(spring_DemoApplication, vars)
  );
  fss.writeFileSync(
    `results/${__dirname}/${PROJECT_NAME}/spring/pom.xml`,
    Utils.replaceTemplateString(spring_Pom, vars)
  );
  fss.writeFileSync(
    `results/${__dirname}/${PROJECT_NAME}/spring/src/main/resources/application.yml`,
    Utils.replaceTemplateString(spring_application, vars)
  );

  // Angularのテンプレートを作成する。
  fss.writeFileSync(
    `results/${__dirname}/${PROJECT_NAME}/angular/src/app/api.interceptor.ts`,
    Utils.replaceTemplateString(angular_apiInterceptor, vars)
  );
  fss.writeFileSync(
    `results/${__dirname}/${PROJECT_NAME}/angular/src/app/app.config.ts`,
    Utils.replaceTemplateString(angular_appConfig, vars)
  );
  fss.writeFileSync(
    `results/${__dirname}/${PROJECT_NAME}/angular/src/environments/environment.development.ts`,
    Utils.replaceTemplateString(angular_environmentDevelopment, vars)
  );
  fss.writeFileSync(
    `results/${__dirname}/${PROJECT_NAME}/angular/src/environments/environment.ts`,
    Utils.replaceTemplateString(angular_environment, vars)
  );
  fss.writeFileSync(
    `results/${__dirname}/${PROJECT_NAME}/angular/package.json`,
    Utils.replaceTemplateString(angular_package, vars)
  );
  fss.writeFileSync(
    `results/${__dirname}/${PROJECT_NAME}/angular/tailwind.config.js`,
    Utils.replaceTemplateString(angular_tailwindConfig, vars)
  );
  fss.writeFileSync(
    `results/${__dirname}/${PROJECT_NAME}/angular/proxy.conf.js`,
    Utils.replaceTemplateString(angular_proxyConf, vars)
  );

  let obj;
  return Promise.resolve()
    .then(() => {
      obj = getStepInstance(Step0000_RequirementsToFeatureListSummary);
      obj.initPrompt();
      return obj.run();
    })
    .then(() => {
      obj = getStepInstance(Step0010_FeatureListSummaryToFeatureListDetail);
      obj.initPrompt();
      return obj.run();
    })
    .then(() => {
      obj = getStepInstance(Step0013_AdvancedExpertiseListJson);
      obj.initPrompt();
      return obj.run();
    })
    .then(() => {
      obj = getStepInstance(Step0015_AdvancedExpertiseDetail);
      obj.initPrompt();
      return obj.run();
    })
    .then(() => {
      obj = getStepInstance(Step0020_FeatureListDetailToJsonFormat);
      obj.initPrompt();
      return obj.run();
    })
    .then(() => {
      obj = getStepInstance(Step0030_DesignSummary);
      obj.initPrompt();
      return obj.run();
    })
    .then(() => {
      //     // obj.postProcess(obj.childStepList.map((step) => step.result)); // 後処理デバッグ用
      //     //-- // ※使ってない
      //     // }).then(() => {
      //     //     obj = new Step0031_DesignSummaryReview();
      //     //     obj.initPrompt();
      //     //     return obj.run();
      //     // }).then(() => {
      //     //     obj = new Step0033_DesignSummaryRefine();
      //     //     obj.initPrompt();
      //     //     return obj.run();
      //     // }).then(() => {
      //     //     obj = new Step0034_DesignSummaryRefineReview();
      //     //     obj.initPrompt();
      //     //     return obj.run();
      //     // -- // ※使ってない
    })
    .then(() => {
      obj = getStepInstance(Step0040_EntityList); // Entity一覧を作る
      obj.initPrompt();
      return obj.run();
    })
    .then(() => {
      obj = getStepInstance(Step0042_EntityFeatureMapping); // Entity⇒機能マッピングを作る
      obj.initPrompt();
      return obj.run();
    })
    .then(() => {
      // // // Entity一覧を詳細化して、最後に帳尻合わせた方が良さそうな気がしたので一旦廃止
      // //     obj = getStepInstance(Step0043_ValueObjectEnumList); // ValueObject⇒Enum一覧を作る
      // //     obj.initPrompt();
      // //     // return obj.run();
      // //     obj.postProcess(obj.result);
      // // }).then(() => {
      // //     obj = getStepInstance(Step0045_EntityFeatureMapping); // Entity⇒機能マッピングを作る
      // //     obj.initPrompt();
      // //     // return obj.run();
      // // }).then(() => {
      // //     obj = getStepInstance(Step0048_ValuObjectEnumDetail); // ValueObject、Enum詳細を作る
      // //     obj.initPrompt();
      // //     // return obj.run();
    })
    .then(() => {
      obj = getStepInstance(Step0050_EntityAttributes); // Entity一覧（属性あり版）を作る
      obj.initPrompt();
      return obj.run();
      // obj.postProcess(obj.childStepList.map((step) => step.result));
    })
    .then(() => {
      obj = getStepInstance(Step0052_EntityAttributesMerge); // Entity一覧属性あり版のセルフリファインのマージ版
      obj.initPrompt();
      return obj.run();
      // obj.postProcess(obj.childStepList.map((step) => step.result));
    })
    .then(() => {
      obj = getStepInstance(Step0056_EntityAttributesJpaJson); // EntityにJPAアノテーションを補充する。ここは並列化可能
      obj.initPrompt();
      return obj.run();
      // obj.postProcess(obj.result);
    })
    .then(() => {
      //     //     obj = new Step0055_EntityAttributesToOpenAPI(); // ※使ってない：ここは並列化可能
      //     //     obj.initPrompt();
      //     //     return obj.run();
    })
    .then(() => {
      obj = getStepInstance(Step0060_ViewList); // 画面一覧を作る
      obj.initPrompt();
      return obj.run();
      // obj.postProcess(obj.result);
    })
    .then(() => {
      obj = getStepInstance(Step0070_ViewDocuments); // 画面詳細設計書を作る
      obj.initPrompt();
      return obj.run();
      // obj.postProcess(obj.childStepList.map((step) => step.result)); // 後処理デバッグ用
    })
    .then(() => {
      obj = getStepInstance(Step0080_ServiceList); // サービス一覧を作る
      obj.initPrompt();
      return obj.run();
      // obj.postProcess(obj.result);
    })
    .then(() => {
      // // Step0080_ServiceListのセルフリファインに統合したので廃止
      //     obj = getStepInstance(Step0090_ServiceMethodList); // サービス⇒API一覧を作る
      //     obj.initPrompt();
      //     // return obj.run();
      // }).then(() => {
      //     obj = getStepInstance(Step0092_ServiceMethodListReqRes); // サービス⇒API一覧に列追加
      //     obj.initPrompt();
      //     // return obj.run();
      //     // obj.postProcess(obj.result); // 後処理デバッグ用
    })
    .then(() => {
      obj = getStepInstance(Step0100_ApiDocuments);
      obj.initPrompt();
      return obj.run();
      // obj.postProcess(obj.childStepList.map((step) => step.result)); // 後処理デバッグ用
    })
    .then(() => {
      obj = getStepInstance(Step0110_ApiSourceReqRes);
      obj.initPrompt();
      return obj.run();
      // obj.postProcess(obj.childStepList.map((step) => step.result)); // 後処理デバッグ用
    })
    .then(() => {
      obj = getStepInstance(Step0120_ApiSourceJson);
      obj.initPrompt();
      return obj.run();
      // obj.postProcess(obj.childStepList.map((step) => step.result)); // 後処理デバッグ用
    })
    .then(() => {
      obj = getStepInstance(Step0130_RepositoryMethod);
      obj.initPrompt();
      return obj.run();
      // obj.postProcess(obj.childStepList.map((step) => step.result)); // 後処理デバッグ用
    })
    .then(() => { });
}

process.on("uncaughtException", (error) => {
  console.error("未捕捉の例外:", error);
  // 必要なクリーンアップ処理やプロセスの再起動などを行う
  // ただし、この状態から安全に回復することは難しいので、プロセスを終了させることが一般的
  // process.exit(1);
});
process.on("unhandledRejection", (reason, promise) => {
  console.error("未処理のPromiseの拒否:", promise, "理由:", reason);
  // 必要なエラーロギングやクリーンアップ処理
  // Node.jsは将来的に未処理のPromiseの拒否に対してプロセスを終了させる可能性があるため、対処が必要
});

/**
 * このファイルが直接実行された場合のコード。
 */
if (fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    main();
    console.log("正常終了しました。");
  } catch (e) {
    console.log("最外殻でエラーが発生しました。");
    console.error(e);
  }
} else {
  // main実行じゃなかったら何もしない
}

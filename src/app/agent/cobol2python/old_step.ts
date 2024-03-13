import path from "path";
import {
  BaseStepCobol2Python,
  MultiStepCobol2Python,
  Step0020_ConvertToDoc,
} from "./runner.js";
import { Utils } from "../../common/utils.js";
import { getStepInstance } from "../..//common/base-step.js";

/**
 * ソースから文書（詳細設計書）化
 */
export class Step0030_ClassifyDoc extends MultiStepCobol2Python {
  // クラスとして普通に自由に変数を作ってもよい。
  filePathList!: string[];

  constructor() {
    super();
    class Step0030_ClassifyDocChil extends BaseStepCobol2Python {
      systemMessageJa =
        "経験豊富で優秀なソフトウェアエンジニア。専門はドメイン駆動設計とクリーンアーキテクチャ。";
      systemMessageEn =
        "An experienced and excellent software engineer. Specializes in domain-driven design and clean architecture.";
      // 共通定義を上書きする場合はここで定義する。
      constructor(
        public targetFilePath: string,
        public innerIndex: number,
        public sectionName: string,
        public document: string
      ) {
        super();
        const baseName = path.basename(targetFilePath);
        // 複数並列処理するので、被らないようにラベルを設定する。（これがログファイル名になる）
        this.label = Utils.safeFileName(
          `${
            this.constructor.name
          }_${baseName}-${innerIndex}-${sectionName.replaceAll("-", "_")}`
        ); // Utils.safeFileNameはファイル名として使える文字だけにするメソッド。
        // 個別の指示を作成。
        this.chapters = [
          {
            title: `Instructions`,
            contentJa: Utils.trimLines(`
                            以下の詳細設計書はクリーンアーキテクチャでいうところのエンティティ、ユースケース、アプリケーション、インターフェースアダプター、フレームワークとドライバのうち、どれに当たるか判定してください。
                        `),
            contentEn: Utils.trimLines(`
                            Which of the following does the following detailed design document correspond to in terms of the entity, use case, application, interface adapter, framework, driver in the clean architecture?
                        `),
            children: [
              {
                titleJa: `対象の詳細設計書`,
                titleEn: `Target detailed design document`,
                content: Utils.setMarkdownBlock(document, "markdown"),
              },
              {
                titleJa: `出力形式`,
                titleEn: `Output format`,
                content: Utils.trimLines(`
                                    判定結果は以下のJSON形式で出力してください。
                                    {"entity": true, "use_case": false, "application": false, "interface_adapter": false, "framework": false, "driver": false, "other": false, "descriptions": "エンティティに該当します。"}
                                `),
              },
            ],
          },
        ];
      }
    }

    // childStepListを組み立て。
    this.childStepList = getStepInstance(
      Step0020_ConvertToDoc
    ).childStepList.map((step0) => {
      const step = step0 as any as {
        targetFilePath: string;
        innerIndex: number;
        sectionName: string;
        sectionCode: string;
        result: string;
      };
      return new Step0030_ClassifyDocChil(
        step.targetFilePath,
        step.innerIndex,
        step.sectionName,
        step.result
      );
    });
  }

  postProcess(resultList: string[]): string[] {
    const summary: Record<ArchitectureType, string[]> = {
      entity: [],
      use_case: [],
      application: [],
      interface_adapter: [],
      framework: [],
      driver: [],
      other: [],
    };
    resultList.forEach((result, index) => {
      const flags: Record<ArchitectureType, boolean> = Utils.jsonParse(result);
      // console.log(`${Object.keys(flags).filter(key => flags[key as ArchitectureType]).length} ${this.childStepList[index].label}`);
      Object.entries(flags).forEach(([key, value]) => {
        if (value === true)
          summary[key as ArchitectureType].push(
            this.childStepList[index].label
          );
      });
    });
    // console.log(summary);
    return resultList;
  }
}

type ArchitectureType =
  | "entity"
  | "use_case"
  | "application"
  | "interface_adapter"
  | "framework"
  | "driver"
  | "other";
const architectureTypeList: ArchitectureType[] = [
  "use_case",
  "interface_adapter",
  "driver",
];

/**
 * ソースから文書（詳細設計書）化
 */
class Step0040_RebuildDocument extends MultiStepCobol2Python {
  // クラスとして普通に自由に変数を作ってもよい。
  filePathList!: string[];

  constructor() {
    super();
    class Step0040_RebuildDocumentChil extends BaseStepCobol2Python {
      systemMessageJa =
        "経験豊富で優秀なソフトウェアエンジニア。専門はドメイン駆動設計とクリーンアーキテクチャ。";
      systemMessageEn =
        "An experienced and excellent software engineer. Specializes in domain-driven design and clean architecture.";
      // 共通定義を上書きする場合はここで定義する。
      constructor(
        public targetFilePath: string,
        public innerIndex: number,
        public sectionName: string,
        public document: string,
        public classifies: string[]
      ) {
        super();
        const baseName = path.basename(targetFilePath);
        // 複数並列処理するので、被らないようにラベルを設定する。（これがログファイル名になる）
        this.label = Utils.safeFileName(
          `${
            this.constructor.name
          }_${baseName}-${innerIndex}-${sectionName.replaceAll("-", "_")}`
        ); // Utils.safeFileNameはファイル名として使える文字だけにするメソッド。
        const classifyString = classifies.join(", ");
        // 個別の指示を作成。
        this.chapters = [
          {
            title: `Instructions`,
            contentJa: Utils.trimLines(`
                        以下の詳細設計書を ${classifyString} に分解して、それぞれの設計書として再構成してください。
                        重要なビジネスロジックが漏れないように注意してください。
                    `),
            contentEn: Utils.trimLines(`
                        Please divide the following detailed design document into ${classifyString} and reconstruct each design document accordingly.
                        Be careful not to miss important business logic.
                    `),
            children: [
              {
                titleJa: `対象の詳細設計書`,
                titleEn: `Target detailed design document`,
                content: Utils.setMarkdownBlock(document, "markdown"),
              },
            ],
          },
        ];
      }
    }

    // childStepListを組み立て。
    const docList = getStepInstance(Step0020_ConvertToDoc);
    const classifyList = getStepInstance(Step0030_ClassifyDoc);
    this.childStepList = docList.childStepList
      .map((step0, index) => {
        const step = step0 as any as {
          targetFilePath: string;
          innerIndex: number;
          sectionName: string;
          sectionCode: string;
          result: string;
          label: string;
        };
        const classify = Utils.jsonParse(
          classifyList.childStepList[index].result
        ) as Record<ArchitectureType, boolean>;
        const classifies = Object.entries(classify)
          .filter(
            ([key, value]) => architectureTypeList.includes(key as any) && value
          )
          .map(([key, value]) => key);
        return new Step0040_RebuildDocumentChil(
          step.targetFilePath,
          step.innerIndex,
          step.sectionName,
          step.result,
          classifies
        );
      })
      .filter((step) => step.classifies.length > 1);
  }

  postProcess(resultList: string[]): string[] {
    function row(label: string, rec: Record<ArchitectureType, boolean>) {
      // console.log(`| ${label} |${ArchitectureTypeList.map(key => rec[key] ? ' o ' : ' ').join('|')} |`);
    }
    // console.log(`| label |${ArchitectureTypeList.join(' | ')} |`);
    // console.log(`| - |${ArchitectureTypeList.map(type => ':-:').join('|')}|`);
    getStepInstance(Step0030_ClassifyDoc).childStepList.forEach(
      (step, index) => {
        const res = Utils.jsonParse(step.result) as Record<
          ArchitectureType,
          boolean
        >;
        if (Object.entries(res).filter(([key, value]) => value).length > 1) {
          // console.log(`${step.label}\t${JSON.stringify(res)}`);
          row(step.label, res);
        } else {
          if (res.framework || res.driver) {
            // console.log(`${step.label}\t${JSON.stringify(res)}`);
            // console.log(step.prompt);
          } else {
            // console.log(`${step.label}\t${JSON.stringify(res)}`);
            row(step.label, res);
          }
        }
      }
    );
    return resultList;
  }
}

/**
 * ソースから文書（詳細設計書）化
 */
class Step0050_ extends MultiStepCobol2Python {
  // クラスとして普通に自由に変数を作ってもよい。
  filePathList!: string[];

  constructor() {
    super();
    class Step0050_RebuildDocumentChil extends BaseStepCobol2Python {
      systemMessageJa =
        "経験豊富で優秀なソフトウェアエンジニア。専門はドメイン駆動設計とクリーンアーキテクチャ。";
      systemMessageEn =
        "An experienced and excellent software engineer. Specializes in domain-driven design and clean architecture.";
      // 共通定義を上書きする場合はここで定義する。
      constructor(
        public targetFilePath: string,
        public innerIndex: number,
        public sectionName: string,
        public document: string,
        public classify: Record<string, boolean>
      ) {
        super();
        const baseName = path.basename(targetFilePath);
        // 複数並列処理するので、被らないようにラベルを設定する。（これがログファイル名になる）
        this.label = Utils.safeFileName(
          `${
            this.constructor.name
          }_${baseName}-${innerIndex}-${sectionName.replaceAll("-", "_")}`
        ); // Utils.safeFileNameはファイル名として使える文字だけにするメソッド。
        const classifyString = Object.entries(classify)
          .filter(
            ([key, value]) => !["other", "descriptions"].includes(key) && value
          )
          .map(([key, value]) => key)
          .join(", ");
        // 個別の指示を作成。
        this.chapters = [
          {
            title: `Instructions`,
            contentJa: Utils.trimLines(`
                            以下の詳細設計書を ${classifyString} に分解して、それぞれの設計書として再構成してください。
                            重要なビジネスロジックが漏れないように注意してください。
                        `),
            contentEn: Utils.trimLines(``),
            children: [
              {
                titleJa: `対象の詳細設計書`,
                titleEn: `Target detailed design document`,
                content: Utils.setMarkdownBlock(document, "markdown"),
              },
            ],
          },
        ];
      }
    }

    // childStepListを組み立て。
    const docList = getStepInstance(Step0020_ConvertToDoc);
    const classifyList = getStepInstance(Step0030_ClassifyDoc);
    this.childStepList = docList.childStepList
      .map((step0, index) => {
        const step = step0 as any as {
          targetFilePath: string;
          innerIndex: number;
          sectionName: string;
          sectionCode: string;
          result: string;
        };
        const classify = Utils.jsonParse(
          classifyList.childStepList[index].result
        ) as Record<string, boolean>;
        return new Step0050_RebuildDocumentChil(
          step.targetFilePath,
          step.innerIndex,
          step.sectionName,
          step.result,
          classify
        );
      })
      .filter(
        (step) =>
          Object.entries(step.classify).filter(([key, value]) => value).length >
          1
      );
  }

  postProcess(resultList: string[]): string[] {
    // console.log(resultList);
    return resultList;
  }
}

class Step0030_ClassifyDoc2 extends BaseStepCobol2Python {
  systemMessageJa =
    "経験豊富で優秀なソフトウェアエンジニア。専門はCOBOLシステムのモダナイズ。";
  systemMessageEn =
    "An experienced and excellent software engineer. Specializes in modernizing COBOL systems.";
  // 共通定義を上書きする場合はここで定義する。
  constructor(
    public targetFilePath: string,
    public innerIndex: number,
    public sectionName: string,
    public sectionCode: string
  ) {
    super();
    const baseName = path.basename(targetFilePath);
    // 複数並列処理するので、被らないようにラベルを設定する。（これがログファイル名になる）
    this.label = Utils.safeFileName(
      `${
        this.constructor.name
      }_${baseName}-${innerIndex}-${sectionName.replaceAll("-", "_")}`
    ); // Utils.safeFileNameはファイル名として使える文字だけにするメソッド。
    // 個別の指示を作成。
    this.chapters = [
      {
        title: `Instructions`,
        contentJa: Utils.trimLines(`
                    以下の詳細設計書を ユースケース、インターフェースアダプター、ドライバに分解して、それぞれの設計書として再構成してください。
                    重要なビジネスロジックが漏れないように注意してください。
                `),
        contentEn: Utils.trimLines(`
                    Which of the following does the following detailed design document correspond to in terms of the entity, use case, application, interface adapter, framework, and
                `),
        children: [
          {
            titleJa: `対象のCOBOLソースコード`,
            titleEn: `Target COBOL source code`,
            content: Utils.setMarkdownBlock(sectionCode, "cobol"),
          },
        ],
      },
    ];
  }
}

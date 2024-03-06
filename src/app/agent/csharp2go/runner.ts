import { fileURLToPath } from "url";
import path, { basename } from "path";
import * as fs from "fs";

import {
  BaseStep,
  MultiStep,
  PromptLang,
  StepOutputFormat,
  aiApi,
} from "../../common/base-step.js";
import { GPTModels } from "../../common/openai-api-wrapper.js";
import { Utils } from "../../common/utils.js";
import fss from "../../common/fss.js";
import { SAMPLE_INSERT_CSHARP, SAMPLE_INSERT_GOLANG } from "./sample_code.js";
import { CsharpSection, parseCsharpCode, getSection } from "./parse-csharp.js";
import { getStepInstance } from "../../common/base-step.js";

// Azureに向ける
aiApi.wrapperOptions.provider = "azure";

// サブディレクトリ名
export const PROJECT_NAME = "Flare";

//変換ファイル
const WORK_DIR =
  "C:/workspace/Flare/V20303-Develop/FlareApplication/TradeWin.Flare.Business.Server/Services/tmp";

/**
 * runner.tsでは以下の3つが必須。
 * - BaseStepXXXクラスの作成：Stepクラスの元になるクラス。エージェント用の共通設定を書いておくクラス。
 * - StepXXXクラスの作成：BaseStepXXXを拡張して実際にどういう動きをするかを定義するクラス。
 * - mainの作成：Stepクラスをどの順番で動かすかを書いておくクラス。main-batch.tsから呼ばれるので、必ずexport async function main()で定義する必要がある。
 */

/**
 * このエージェント用の共通設定。
 * エージェントごとに設定したいデフォルト値が異なるのでrunnerの最初に書くことにした。
 */
abstract class BaseStepCsharp2Go extends BaseStep {
  agentName: string = Utils.basename(Utils.dirname(import.meta.url));
  model: GPTModels = "gpt-4-vision-preview";
  systemMessageJa = "C#からGoへの変換エージェントです"; // AI専門家
  systemMessageEn = "You are C# to Go conversion agent";
  systemMessage = this.systemMessageJa;
  labelPrefix: string = `${PROJECT_NAME}/`;
  temperature: number = 0.0; // ランダム度合い。0に近いほど毎回同じ結果になる。プログラムのようなものは 0 に、文章系は 1 にするのが良い。
  format = StepOutputFormat.MARKDOWN;
  lang: PromptLang = "ja";
}

export abstract class MultiStepCsharp2Go extends MultiStep {
  agentName: string = Utils.basename(Utils.dirname(import.meta.url));
  labelPrefix: string = `${PROJECT_NAME}/`;
}

/**
 * 最初のプロンプト。
 * このエージェント用の共通クラスであるBaseStepSampleを拡張する。
 */
class Step0010_Convert_Base extends BaseStepCsharp2Go {
  // BaseStepSampleで指定したデフォルト値から変更したいものはここで定義すると上書きされる。

  /**
   * コンストラクタの中で chapters というオブジェクトリストを組み立てる。
   * これが後のメソッドでMarkdownに変換されてプロンプトになる。
   */
  constructor(key: string, sectionCode: string) {
    super();

    // プロンプトを構造化しやすくするためのオブジェクト。
    // const baseName = path.basename(targetFilePath);
    this.label = Utils.safeFileName(key);
    this.chapters = [
      {
        // 指示を与えるChapter
        title: `Instructions`,
        content: Utils.trimLines(`
        C#で書かれたソースコードをGoに書き換えてください。

        - 補足は不要
        - 外部関数などのライブラリは既存のものとして扱ってよい。追加で定義する必要はありません。
        - コメントは日本語で記載
        `),
        children: [
          {
            title: `変換サンプル`,
            content: `変換サンプルは以下の通りです。注意深く参考にしてください。`,
            children: [
              {
                title: `変換前`,
                content: Utils.setMarkdownBlock(SAMPLE_INSERT_CSHARP, "csharp"),
              },
              {
                title: `変換後`,
                content: Utils.setMarkdownBlock(SAMPLE_INSERT_GOLANG, "go"),
              },
            ],
          },
          {
            title: `変換対象のC#ソースコード`,
            content: Utils.setMarkdownBlock(sectionCode, "csharp"),
          },
        ],
      },
    ];
  }
}

/**
 * 最初のステップの結果を詳細化するステップ
 * 並列に展開するのでBaseStepではなく MultiStep を拡張する。
 * MultiStepではchapterではなく、childStepListを組み立てる。
 */
class Step0010_Convert_Multi extends MultiStepCsharp2Go {
  // クラスとして普通に自由に変数を作ってもよい。
  filePathList!: string[];

  constructor() {
    super();

    this.filePathList = fss
      .getFilesRecursively(WORK_DIR)
      .filter((filePath) => filePath.endsWith(".cs"));
    // console.log(this.filePathList);
    // this.childStepList
    const CsharpSectionMap = this.filePathList.reduce(
      (prev, targetFilePath) => {
        const code: string = fs.readFileSync(targetFilePath, `utf-8`);
        parseCsharpCode(code, targetFilePath).forEach((section) => {
          // console.log("namespace:" + section.namespace);
          const key = section.namespace.split(" ")[1] + "." + section.className;
          if (key in prev) {
            prev[key].sourceCode += "\n" + section.sourceCode;
          } else {
            prev[key] = section;
          }
        });
        return prev;
      },
      {} as { [key: string]: CsharpSection }
    );
    for (const key in CsharpSectionMap) {
      this.childStepList.push(
        new Step0010_Convert_Base(key, getSection(CsharpSectionMap[key]))
      );
    }
    // console.log(CsharpSectionMap);
  }

  /**
   * 後処理系は postProcess で。
   * 結果を1つのファイルにまとめる。
   * @param result
   * @returns
   */
  postProcess(result: []): string[] {
    result.forEach((code, index) => {
      const fileName = this.childStepList[index].label.replaceAll(".", "/");
      fss.writeFileSync(
        `./results/${this.agentName}/${PROJECT_NAME}/${fileName}.go`,
        Utils.mdFirstCode(code)
      );
    });
    return result;
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
  let obj;
  return Promise.resolve().then(() => {
    obj = getStepInstance(Step0010_Convert_Multi);
    obj.initPrompt();
    return obj.run();
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

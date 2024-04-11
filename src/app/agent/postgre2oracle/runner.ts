import { fileURLToPath } from "url";
import path, { basename } from "path";
import * as fs from "fs";
import iconv from "iconv-lite";

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
import { getStepInstance } from "../../common/base-step.js";
import { SqlSection, parseSqlForDML, parseSqlForSQL } from "./sql_parser.js";
import { string } from "yargs";
import { SAMPLE_AFTER, SAMPLE_BEFORE } from "./sample_code.js";

// Azureに向ける
aiApi.wrapperOptions.provider = "azure";

// サブディレクトリ名
export const PROJECT_NAME = "ALE";

//変換ファイル
const WORK_DIR_BT = "C:/workspace/ALE/bt-develop/";
const WORK_DIR_OL =
  "C:/workspace/ALE/bl-develop/src/main/resources/apl/sql-mapper/";

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
abstract class BaseStepPos2Ora extends BaseStep {
  agentName: string = Utils.basename(Utils.dirname(import.meta.url));
  model: GPTModels = "gpt-4-vision-preview";
  systemMessageJa = "あなたはOracleとPostgresqlのスペシャリストです";
  systemMessageEn = "You are postgresql to oracle conversion agent";
  systemMessage = this.systemMessageJa;
  labelPrefix: string = `${PROJECT_NAME}/`;
  temperature: number = 0.0; // ランダム度合い。0に近いほど毎回同じ結果になる。プログラムのようなものは 0 に、文章系は 1 にするのが良い。
  format = StepOutputFormat.MARKDOWN;
  lang: PromptLang = "ja";
}

export abstract class MultiStepPos2Ora extends MultiStep {
  agentName: string = Utils.basename(Utils.dirname(import.meta.url));
  labelPrefix: string = `${PROJECT_NAME}/`;
}

/**
 * テーブル定義書を作りたいので、DDLから変換する
 */
class Step0010_Convert_Child_BT_DDL extends BaseStepPos2Ora {
  /**
   * コンストラクタの中で chapters というオブジェクトリストを組み立てる。
   * これが後のメソッドでMarkdownにDB変換されてプロンプトになる。
   */
  constructor(filePath: string, code: string) {
    super();

    // プロンプトを構造化しやすくするためのオブジェクト。
    const baseName = path.basename(filePath);
    this.label = Utils.safeFileName(`${this.constructor.name}_${baseName}`);
    this.chapters = [
      {
        // 指示を与えるChapter
        title: `Instructions`,
        content: Utils.trimLines(`
          DBをPostgreSQLからOracleに変更します。必要な変更を加えて、ソースコードを返答してください
  
          - 補足は不要
          - コメントは日本語でそのまま記載する
          - ソースコードの修正は最小限にする
          `),
        children: [
          {
            title: `変換対象のSQL`,
            content: Utils.setMarkdownBlock(Utils.trimLines(code), "sql"),
          },
        ],
      },
    ];
  }
}

class Step0010_Convert_Parent_BT_DDL extends MultiStepPos2Ora {
  filePathList!: string[];
  commentList!: string[];

  constructor() {
    super();

    this.filePathList = fss
      .getFilesRecursively(WORK_DIR_BT + "ALE_DDL/")
      .filter(
        (filePath) =>
          filePath.endsWith(".sql") && !filePath.includes("INIT_DATA") //DDLとindexのみを対象とする
      );
    this.childStepList = this.filePathList.map((filePath) => {
      const code = readFileByUtf8(filePath); //sjisをutf8にしてから読み込む
      // 以下不要そうなので、コメントアウト
      // const sqlSection = parseSql(code);
      // this.commentList.push(sqlSection.comment);
      return new Step0010_Convert_Child_BT_DDL(filePath, code);
    });
  }

  /**
   * 後処理系は postProcess で。
   * 結果を1つのファイルにまとめる。
   * @param result
   * @returns
   */
  postProcess(result: []): string[] {
    result.forEach((code, index) => {
      const keyword = "develop";
      const place = this.filePathList[index].indexOf(keyword);
      const fileName = this.filePathList[index]
        .substring(place + keyword.length + 1)
        .replaceAll("\\", "/");
      // const result = this.commentList[index] + "/n" + code;
      fss.writeFileSync(
        `./results/${this.agentName}/${PROJECT_NAME}/${fileName}`,
        Utils.mdFirstCode(code)
      );
    });
    return result;
  }
}

/**
 * BT -> Sql ファイルの変換
 */
class Step0020_Convert_Child_BT_Sql extends BaseStepPos2Ora {
  /**
   * コンストラクタの中で chapters というオブジェクトリストを組み立てる。
   * これが後のメソッドでMarkdownにDB変換されてプロンプトになる。
   */
  constructor(filePath: string, code: string, ddl: string) {
    super();

    // プロンプトを構造化しやすくするためのオブジェクト。
    const baseName = path.basename(filePath);
    this.label = Utils.safeFileName(`${this.constructor.name}_${baseName}`);
    this.chapters = [
      {
        // 指示を与えるChapter
        title: `Instructions`,
        content: Utils.trimLines(`
          DBをPostgreSQLからOracleに変更します。必要な変更を加えて、ソースコードを返答してください
  
          - 補足は不要
          - コメントは日本語でそのまま記載する
          - ソースコードの修正は最小限にする
          `),
        children: [
          {
            title: `テーブル情報を参考にしてください`,
            content: Utils.setMarkdownBlock(ddl, "sql"),
          },
          {
            title: `変換対象のSQL`,
            content: Utils.setMarkdownBlock(Utils.trimLines(code), "sql"),
          },
        ],
      },
    ];
  }
}

// コメントクラス
class comment {
  constructor(public commentBefore: string, public commentAfter: string) {}
}

class Step0020_Convert_Parent_BT_Sql extends MultiStepPos2Ora {
  filePathList!: string[];
  commentMap: { [key: string]: comment } = {};

  constructor() {
    super();
    const ddlFileList: string[] = fss
      .getFilesRecursively(
        `./results/${this.agentName}/${PROJECT_NAME}/ALE_DDL/TBL/`
      )
      .filter((filePath) => !filePath.includes("INIT_DATA"));
    const tableMap = ddlFileList.reduce((prev, curr) => {
      const ddl = fs.readFileSync(curr, `utf-8`).match(regex);
      if (ddl) {
        prev[ddl[1]] = curr;
      }
      return prev;
    }, {} as { [key: string]: string });

    this.filePathList = fss
      .getFilesRecursively(WORK_DIR_BT + "ALEBT_CSH/")
      .filter((filePath) => filePath.endsWith(".sql"));
    this.childStepList = this.filePathList.map((filePath) => {
      const code = readFileByUtf8(filePath);
      const sqlSection = parseSqlForSQL(code);
      this.commentMap[filePath] = new comment(
        sqlSection.commentBefore,
        sqlSection.commentAfter
      );
      let ddl: string[] = [];
      for (let key in tableMap) {
        if (sqlSection.code[0].toLowerCase().includes(key.toLowerCase())) {
          ddl.push(fs.readFileSync(tableMap[key], `utf-8`));
        }
      }
      return new Step0020_Convert_Child_BT_Sql(
        filePath,
        sqlSection.code[0],
        ddl.join("\n\n")
      );
    });
  }

  /**
   * 後処理系は postProcess で。
   * 結果を1つのファイルにまとめる。
   * @param result
   * @returns
   */
  postProcess(result: []): string[] {
    return result.map((code, index) => {
      const keyword = "develop";
      const resultArray: string[] = [];
      const filePath = this.filePathList[index];
      const place = filePath.indexOf(keyword);
      const fileName = filePath
        .substring(place + keyword.length + 1)
        .replaceAll("\\", "/");
      if (this.commentMap[filePath].commentBefore != "") {
        // console.log(this.commentMap[filePath].commentBefore);
        resultArray.push(this.commentMap[filePath].commentBefore);
      }
      resultArray.push(Utils.mdFirstCode(code));
      if (this.commentMap[filePath].commentAfter != "") {
        resultArray.push(this.commentMap[filePath].commentAfter);
      }
      fss.writeFileSync(
        `./results/${this.agentName}/${PROJECT_NAME}/${fileName}`,
        Utils.mdFirstCode(resultArray.join("\n"))
      );
      return resultArray.join("\n");
    });
  }
}

/**
 * INIT_DATAの変換
 */
class Step0030_Convert_Child_BT_DML extends BaseStepPos2Ora {
  /**
   * コンストラクタの中で chapters というオブジェクトリストを組み立てる。
   * これが後のメソッドでMarkdownにDB変換されてプロンプトになる。
   */
  constructor(public filePath: string, code: string, index: number) {
    super();

    // プロンプトを構造化しやすくするためのオブジェクト。
    const baseName = path.basename(filePath);
    const subLabel = filePath.includes("HONBAN") ? "HONBAN" : "KAIHATSU";
    this.label = Utils.safeFileName(
      `${this.constructor.name}_${baseName}_${subLabel}_${index}`
    );
    this.chapters = [
      {
        // 指示を与えるChapter
        title: `Instructions`,
        content: Utils.trimLines(`
          DBをPostgreSQLからOracleに変更します。必要な変更を加えて、ソースコードを返答してください
  
          - INSERT ALL は利用しない
          - 補足は不要
          - 変更が不要な場合はそのまま返却する
          - コメントは日本語でそのまま記載する
          - ソースコードの修正は最小限にする
          - サンプルを注意深く参考にしてください。
          `),
        children: [
          {
            title: `サンプル（変換前）`,
            content: Utils.setMarkdownBlock(SAMPLE_BEFORE, "sql"),
          },
          {
            title: `サンプル（変換後）`,
            content: Utils.setMarkdownBlock(SAMPLE_AFTER, "sql"),
          },
          {
            title: `変換対象のSQL`,
            content: Utils.setMarkdownBlock(Utils.trimLines(code), "sql"),
          },
        ],
      },
    ];
  }
}

class Step0030_Convert_Parent_BT_DML extends MultiStepPos2Ora {
  filePathList!: string[];
  commentMap: { [key: string]: comment } = {};

  constructor() {
    super();

    this.filePathList = fss
      .getFilesRecursively(WORK_DIR_BT + "ALE_DDL/")
      .filter(
        (filePath) =>
          filePath.endsWith(".sql") && filePath.includes("INIT_DATA") //DMLのみを対象とする
        // filePath.endsWith(".sql") && filePath.includes("INIT_ALETACCS") //test
      );
    this.childStepList = this.filePathList
      .map((filePath) => {
        const code = readFileByUtf8(filePath); //sjisをutf8にしてから読み込む
        const sqlSection = parseSqlForDML(code);
        this.commentMap[filePath] = new comment(
          sqlSection.commentBefore,
          sqlSection.commentAfter
        );
        return sqlSection.code.map((code, index) => {
          return new Step0030_Convert_Child_BT_DML(filePath, code, index);
        });
      })
      .flat();
  }

  /**
   * 後処理系は postProcess で。
   * 結果を1つのファイルにまとめる。
   * @param result
   * @returns
   */
  postProcess(result: []): string[] {
    const codeMap: { [key: string]: string } = {};
    const filePath = this.childStepList as any as {
      filePath: string;
    }[];
    result.forEach((code, index) => {
      if (filePath[index].filePath in codeMap) {
        codeMap[filePath[index].filePath] += "\n" + Utils.mdFirstCode(code);
      } else {
        codeMap[filePath[index].filePath] = Utils.mdFirstCode(code);
      }
    });
    const val = [];
    for (let key in codeMap) {
      const keyword = "develop";
      const place = key.indexOf(keyword);
      const resultArray: string[] = [];
      const fileName = key
        .substring(place + keyword.length + 1)
        .replaceAll("\\", "/");
      if (this.commentMap[key].commentBefore != "") {
        // console.log(this.commentMap[filePath].commentBefore);
        resultArray.push(this.commentMap[key].commentBefore);
      }
      resultArray.push(Utils.mdFirstCode(codeMap[key]));
      if (this.commentMap[key].commentAfter != "") {
        resultArray.push(this.commentMap[key].commentAfter);
      }
      fss.writeFileSync(
        `./results/${this.agentName}/${PROJECT_NAME}/${fileName}`,
        Utils.mdFirstCode(resultArray.join("\n"))
      );
      val.push(resultArray.join("\n"));
    }
    return val;
  }
}

/**
 * BT -> Java ファイルの変換
 */
class Step0040_Convert_Child_BT_Java extends BaseStepPos2Ora {
  /**
   * コンストラクタの中で chapters というオブジェクトリストを組み立てる。
   * これが後のメソッドでMarkdownにDB変換されてプロンプトになる。
   */
  constructor(filePath: string, code: string, ddl: string) {
    super();

    // プロンプトを構造化しやすくするためのオブジェクト。
    const baseName = path.basename(filePath);
    this.label = Utils.safeFileName(`${this.constructor.name}_${baseName}`);
    this.chapters = [
      {
        // 指示を与えるChapter
        title: `Instructions`,
        content: Utils.trimLines(`
        DBをPostgreSQLからOracle(version:19.7)に変更します。必要な変更を加えて、ソースコードを返答してください

        - 補足は不要
        - コメントは日本語でそのまま記載する
        - ソースコードの修正は最小限にする
        `),
        children: [
          {
            title: `テーブル情報を参考にしてください`,
            content: Utils.setMarkdownBlock(ddl, "sql"),
          },
          {
            title: `変換対象のJavaソースコード`,
            content: Utils.setMarkdownBlock(code, "java"),
          },
        ],
      },
    ];
  }
}
const regex = /create table (\w+)\s*\(/i;
class Step0040_Convert_Parent_BT_Java extends MultiStepPos2Ora {
  filePathList!: string[];

  constructor() {
    super();
    const ddlFileList: string[] = fss
      .getFilesRecursively(
        `./results/${this.agentName}/${PROJECT_NAME}/ALE_DDL/TBL/`
      )
      .filter((filePath) => !filePath.includes("INIT_DATA"));
    const tableMap = ddlFileList.reduce((prev, curr) => {
      const ddl = fs.readFileSync(curr, `utf-8`).match(regex);
      if (ddl) {
        prev[ddl[1]] = curr;
      }
      return prev;
    }, {} as { [key: string]: string });
    this.filePathList = fss
      .getFilesRecursively(WORK_DIR_BT)
      .filter((filePath) => filePath.endsWith("Dao.java"));

    this.childStepList = this.filePathList.map((filePath) => {
      const code = fs.readFileSync(filePath, `utf-8`);
      let ddl: string[] = [];
      for (let key in tableMap) {
        if (code.toLowerCase().includes(key.toLowerCase())) {
          ddl.push(fs.readFileSync(tableMap[key], `utf-8`));
        }
      }
      return new Step0040_Convert_Child_BT_Java(
        filePath,
        code,
        ddl.join("\n\n")
      );
    });
  }

  /**
   * 後処理系は postProcess で。
   * 結果を1つのファイルにまとめる。
   * @param result
   * @returns
   */
  postProcess(result: []): string[] {
    result.forEach((code, index) => {
      const keyword = "develop";
      const place = this.filePathList[index].indexOf(keyword);
      const fileName = this.filePathList[index]
        .substring(place + keyword.length + 1)
        .replaceAll("\\", "/");
      fss.writeFileSync(
        `./results/${this.agentName}/${PROJECT_NAME}/${fileName}`,
        Utils.mdFirstCode(code)
      );
    });
    return result;
  }
}

/**
 * OL ファイルの変換
 */
class Step0050_Convert_Child_OL extends BaseStepPos2Ora {
  /**
   * コンストラクタの中で chapters というオブジェクトリストを組み立てる。
   * これが後のメソッドでMarkdownにDB変換されてプロンプトになる。
   */
  constructor(filePath: string, code: string, ddl: string) {
    super();

    // プロンプトを構造化しやすくするためのオブジェクト。
    const baseName = path.basename(filePath);
    this.label = Utils.safeFileName(`${this.constructor.name}_${baseName}`);
    this.chapters = [
      {
        // 指示を与えるChapter
        title: `Instructions`,
        content: Utils.trimLines(`
            DBをPostgreSQLからOracleに変更します。必要な変更を加えて、ソースコードを返答してください
    
            - 補足は不要
            - コメントは日本語でそのまま記載する
            - ソースコードの修正は最小限にする
            `),
        children: [
          {
            title: `テーブル情報を参考にしてください`,
            content: Utils.setMarkdownBlock(ddl, "sql"),
          },
          {
            title: `変換対象のSQL`,
            content: Utils.setMarkdownBlock(code, "xml"),
          },
        ],
      },
    ];
  }
}

class Step0050_Convert_Parent_OL extends MultiStepPos2Ora {
  filePathList!: string[];

  constructor() {
    super();
    const ddlFileList: string[] = fss
      .getFilesRecursively(
        `./results/${this.agentName}/${PROJECT_NAME}/ALE_DDL/TBL/`
      )
      .filter((filePath) => !filePath.includes("INIT_DATA"));
    const tableMap = ddlFileList.reduce((prev, curr) => {
      const ddl = fs.readFileSync(curr, `utf-8`).match(regex);
      if (ddl) {
        prev[ddl[1]] = curr;
      }
      return prev;
    }, {} as { [key: string]: string });

    this.filePathList = fss
      .getFilesRecursively(WORK_DIR_OL)
      .filter((filePath) => filePath.endsWith(".xml"));
    this.childStepList = this.filePathList.map((filePath) => {
      const code = fs.readFileSync(filePath, `utf-8`);
      let ddl: string[] = [];
      for (let key in tableMap) {
        if (code.toLowerCase().includes(key.toLowerCase())) {
          ddl.push(fs.readFileSync(tableMap[key], `utf-8`));
        }
      }
      return new Step0050_Convert_Child_OL(filePath, code, ddl.join("\n\n"));
    });
  }

  /**
   * 後処理系は postProcess で。
   * 結果を1つのファイルにまとめる。
   * @param result
   * @returns
   */
  postProcess(result: []): string[] {
    result.forEach((code, index) => {
      const keyword = "develop";
      const place = this.filePathList[index].indexOf(keyword);
      const fileName = this.filePathList[index]
        .substring(place + keyword.length + 1)
        .replaceAll("\\", "/");
      fss.writeFileSync(
        `./results/${this.agentName}/${PROJECT_NAME}/${fileName}`,
        Utils.mdFirstCode(code)
      );
    });
    return result;
  }
}

export async function main() {
  let obj;
  return Promise.resolve()
    .then(() => {
      obj = getStepInstance(Step0010_Convert_Parent_BT_DDL);
      obj.initPrompt();
      return obj.run();
    })
    .then(() => {
      obj = getStepInstance(Step0020_Convert_Parent_BT_Sql);
      obj.initPrompt();
      return obj.run();
    })
    .then(() => {
      obj = getStepInstance(Step0030_Convert_Parent_BT_DML);
      obj.initPrompt();
      return obj.run();
    })
    .then(() => {
      obj = getStepInstance(Step0040_Convert_Parent_BT_Java);
      obj.initPrompt();
      return obj.run();
    })
    .then(() => {
      obj = getStepInstance(Step0050_Convert_Parent_OL);
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

function readFileByUtf8(filePath: string): string {
  const buffer = fs.readFileSync(filePath);
  return iconv.decode(buffer, "Shift_JIS");
}

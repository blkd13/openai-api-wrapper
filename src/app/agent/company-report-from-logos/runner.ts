import { fileURLToPath } from 'url';
import * as  fs from 'fs';
import { BaseStep, MultiStep, StepOutputFormat } from "../../common/base-step.js";
import { GPTModels } from '../../common/openai-api-wrapper.js';
import { Utils } from '../../common/utils.js';

/**
 * このエージェント用の共通設定。
 * エージェントごとに設定したいデフォルト値が異なるのでrunnerの最初に書くことにした。
 */
abstract class BaseStepCompanyReportFromLogos extends BaseStep {
    agentName: string = Utils.basename(Utils.dirname(import.meta.url));
    model: GPTModels = 'gpt-4-1106-preview';
    systemMessage = 'Experts in AI-related businesses'; // AIビジネスの専門家
    format = StepOutputFormat.MARKDOWN;
}

/**
 * 画像から会社名やサービス名を抽出するステップ。
 */
class Step0000_ImageDetection extends MultiStep {
    constructor() {
        super();
        // 画像認識の子ステップ
        class Step0000_ImageDetectionChil extends BaseStepCompanyReportFromLogos {
            model: GPTModels = 'gpt-4-vision-preview';
            format = StepOutputFormat.JSON;
            constructor(public visionPath: string) {
                super();
                this.label = `${this.constructor.name}_${Utils.basename(visionPath)}`;
                this.chapters = [
                    { content: `List the names of the companies or the services listed in this image. output JSON format.{"nameList":[...]}` },
                ];
            }
        }
        // 画像ファイルのパスを指定する。
        const files = [
            'assets/ai-business-experts.png',
        ];
        this.childStepList = files.map(filePath => new Step0000_ImageDetectionChil(filePath));
    }
}

/**
 * 画像認識で取得した会社名とかサービス名について詳しくレポートするステップ。
 */
class Step0010_Report extends MultiStep {

    targetNameList: string[] = [];
    constructor() {
        super();
        // 前のステップの結果を取得する。
        const nameListAry = new Step0000_ImageDetection().childStepList.map(childStep => JSON.parse(childStep.formed).nameList)
        // JSON.parse()したらnameListを取り出してflat()で配列を直列化する。
        const nameList = nameListAry.flat();
        // 直列化したものをSetに入れて重複を削除し、ソートも掛けておく。
        const sordUniqAry = [...new Set(nameList)].sort();
        // 大文字小文字を区別しないように小文字に変換した配列を作る。
        const sordUniqLowerAry = sordUniqAry.map((name: string) => name.toLowerCase());
        // 重複を削除した配列を作る。
        this.targetNameList = sordUniqAry.filter((name: string, index: number) => sordUniqLowerAry.indexOf(name.toLowerCase()) === index);

        // 画像認識の子ステップ
        class Step0010_ReportChil extends BaseStepCompanyReportFromLogos {
            constructor(public targetName: string) {
                super();
                this.label = `${this.constructor.name}_${Utils.basename(targetName)}`;
                this.chapters = [
                    { content: `AI関連の企業もしくはサービスである「${targetName}」について日本語で詳しくレポートしてください。知らない場合は「不明です。」とだけ回答してください。最新情報じゃなくてもよいです。`, },
                ];
            }
        }

        this.childStepList = this.targetNameList.filter((obj, index) => index < 2).map(targetName => new Step0010_ReportChil(targetName));
    }
    /**
     * 結果を1つのファイルにまとめる。
     * @param result 
     * @returns 
     */
    postProcess(result: string[]): string[] {
        // タイトルを付けてレポート形式にする。
        const reportList = result.map((targetName: string, index: number) => `# ${this.targetNameList[index]}\n\n${targetName}`);
        // 全部まとめてファイルに出力する。
        const outputFileName = Utils.safeFileName(`results/${this.constructor.name}_${Utils.formatDate(new Date(), 'yyyyMMddHHmmssSSS')}-report_all.md`);
        fs.writeFileSync(outputFileName, reportList.join('\n\n---\n\n'));
        return result;
    }
}


export async function main() {
    let obj;
    return Promise.resolve().then(() => {
        obj = new Step0000_ImageDetection();
        obj.initPrompt();
        return obj.run();
    }).then(() => {
        obj = new Step0010_Report();
        obj.initPrompt();
        return obj.run();
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

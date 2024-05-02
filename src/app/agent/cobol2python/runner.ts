import { fileURLToPath } from 'url';
import * as fs from 'fs';
import { BaseStep, MultiStep, PromptLang, StepOutputFormat, aiApi, getStepInstance } from "../../common/base-step.js";
import { GPTModels } from '../../common/openai-api-wrapper.js';
import { Utils } from '../../common/utils.js';
import fss from '../../common/fss.js';
import path, { parse } from 'path';
import { FROM_DOC, SAMPLE_INSERT_COBOL, SAMPLE_INSERT_PYTHON, TO_DOC } from './sample_code.js';
import { GroupClause, getSubroutineList, getWorkingStorageSection, grepCaller, lineToObjet, parseWorkingStorageSection } from './parse-cobol.js';

// Azureに向ける
aiApi.wrapperOptions.provider = 'azure';

// サブディレクトリ名
// export const PROJECT_NAME = 'wja-poc';
// export const COBOL_DIR = 'E:/workspace/STAR/wja-poc/COBOL'

export const PROJECT_NAME = 'wpf';
export const COBOL_DIR = 'E:/workspace/APF/wrapflow/wpf/BL/'

// シングルステップ用共通設定
export abstract class BaseStepCobol2Python extends BaseStep {
    agentName: string = Utils.basename(Utils.dirname(import.meta.url));
    model: GPTModels = 'gpt-4-vision-preview';
    // model: GPTModels = 'mixtral-8x7b-32768';
    // model: GPTModels = 'gpt-3.5-turbo';
    labelPrefix: string = `${PROJECT_NAME}/`;  // ラベルのプレフィックス。サブディレクトリに分けるように/を入れておくと便利。
    systemMessageJa = 'COBOLからPythonへの変換エージェントです。';
    systemMessageEn = 'COBOL to Python conversion agent.';
    systemMessage = this.systemMessageJa;
    temperature: number = 0.0; // ランダム度合い。0に近いほど毎回同じ結果になる。プログラムのようなものは 0 に、文章系は 1 にするのが良い。
    format = StepOutputFormat.MARKDOWN;
    lang: PromptLang = 'ja';
}

// マルチステップ用共通設定
export abstract class MultiStepCobol2Python extends MultiStep {
    agentName: string = Utils.basename(Utils.dirname(import.meta.url));
    labelPrefix: string = `${PROJECT_NAME}/`;  // ラベルのプレフィックス。サブディレクトリに分けるように/を入れておくと便利。
}

/**
 * 単純にサンプルを見ながらCOBOL->python書換をする。
 */
export class Step0010_SimpleConvert extends MultiStepCobol2Python {

    // クラスとして普通に自由に変数を作ってもよい。
    filePathList!: string[];

    constructor() {
        super();

        /**
         * 実際のステップ定義はここで書く。
         */
        class Step0010_SimpleConvertChil extends BaseStepCobol2Python {
            // 共通定義を上書きする場合はここで定義する。
            constructor(public targetFilePath: string, public innerIndex: number, public sectionName: string, public sectionCode: string) {
                super();
                const baseName = path.basename(targetFilePath);
                // 複数並列処理するので、被らないようにラベルを設定する。（これがログファイル名になる）
                this.label = Utils.safeFileName(`${this.constructor.name}_${baseName}-${innerIndex.toString().padStart(3, '0')}-${sectionName.replaceAll('-', '_')}`); // Utils.safeFileNameはファイル名として使える文字だけにするメソッド。
                // 個別の指示を作成。
                this.chapters = [
                    {
                        title: `Instructions`,
                        contentJa: Utils.trimLines(`
                            COBOLで書かれたソースコードをPythonに書き換えてください。

                            - 補足は不要です
                            - 外部関数などのライブラリは既存のものとして扱ってよいです。追加で定義する必要はありません。
                            - コメントは日本語で
                        `),
                        contentEn: Utils.trimLines(`
                            Please convert the source code written in COBOL to Python.

                            - No explanation is required.
                            - Libraries such as external functions can be treated as existing ones. There is no need to define them additionally.
                            - Comments are in Japanese.
                        `),
                        children: [
                            {
                                titleJa: `変換サンプル`, titleEn: `Conversion sample`,
                                content: `変換サンプルは以下の通りです。注意深く参考にしてください。`,
                                children: [{
                                    titleJa: `変換前`, titleEn: `Before conversion`,
                                    content: Utils.setMarkdownBlock(SAMPLE_INSERT_COBOL, 'cobol'),
                                }, {
                                    titleJa: `変換後`, titleEn: `After conversion`,
                                    content: Utils.setMarkdownBlock(SAMPLE_INSERT_PYTHON, 'python'),
                                }]
                            },
                            {
                                titleJa: `変換対象のCOBOLソースコード`, titleEn: `COBOL source code to be converted`,
                                content: Utils.setMarkdownBlock(sectionCode, 'cobol'),
                            },
                        ]
                    }
                ];
            }
        }

        this.filePathList = fss.getFilesRecursively(COBOL_DIR).filter(filePath => filePath.endsWith('.pco') || filePath.endsWith('.cob'));

        // childStepListを組み立て。
        this.childStepList = this.filePathList.map(targetFilePath => {
            const cobolText = fs.readFileSync(targetFilePath, 'utf-8');
            console.log(`cobolText: ${path.basename(targetFilePath)} ${cobolText.split('\n').filter(line => line[6] === ' ').length} ${cobolText.split('\n').length}`);
            // サブルーチン毎に分割する
            const subroutineList = getSubroutineList(cobolText);
            return subroutineList.map((section, innerIndex) => {
                return new Step0010_SimpleConvertChil(targetFilePath, innerIndex, section.name, section.code.split('\n').filter(line => line[6] === ' ').join('\n'));
            });
        }).flat().filter((obj, idx) => idx < 10000000000000000);
    }

    postProcess(result: string[]): string[] {
        // 変換結果をファイルごとにまとめる。
        const codes = (this.childStepList as any as { targetFilePath: string, sectionName: string, sectionCode: string }[]).reduce((prev, curr, index) => {
            // ファイル名をキーにしたマップを作る
            if (curr.targetFilePath in prev) { } else { prev[curr.targetFilePath] = []; }
            // indexで結果と紐づける。
            prev[curr.targetFilePath].push(Utils.mdFirstCode(result[index]));
            return prev;
        }, {} as { [key: string]: string[] });

        // COPY句をロードして、「ファイルID：Dtoオブジェクト」の連想配列にする。
        const cpyMap = fss.getFilesRecursively(COBOL_DIR)
            .filter(filePath => filePath.endsWith('.cpy'))
            .reduce((prev, curr) => {
                const copyObj = parseWorkingStorageSection(fs.readFileSync(curr, 'utf-8'), {}, true);
                prev[path.basename(curr).replace(/\..+$/, '')] = copyObj;
                // prev[path.basename(curr)] = prev[path.basename(curr)];
                return prev;
            }, {} as { [key: string]: GroupClause });

        // 書き出し
        Object.entries(codes).forEach(([targetFilePath, sectionList]) => {
            const fileName = path.basename(targetFilePath).split('.')[0];
            const cobolText = fs.readFileSync(targetFilePath, 'utf-8');
            const dtoObject = parseWorkingStorageSection(cobolText, cpyMap);
            // console.dir(dtoObject, { depth: 10 });
            // const dtoArea = dtoObject.toPythonInit().replaceAll('\t', '    ');
            // レイヤー数が多きもの＝深い階層のものなので先に定義する
            const classList = Array.from(dtoObject.getClassRecursive()).filter(obj => obj.name !== 'root').sort((a, b) => b.layer - a.layer);
            // dtoObject.name = Utils.toPascalCase(fileName);
            // console.log(classList.map(cls => cls.name).sort());
            const duplicates = classList.map(cls => cls.name).sort().reduce((acc, el, _, arr) => {
                if (arr.indexOf(el) !== arr.lastIndexOf(el) && !acc.includes(el)) { acc.push(el); } else { }
                return acc;
            }, [] as string[]);

            // TODO クラス名が重複するものは後で個別の手当てが必要。
            console.log('[Duplicate]', fileName, JSON.stringify(duplicates));

            const dtoArea = classList.map(obj => (duplicates.includes(obj.name) ? '# Duplicate\n' : '') + obj.toPythonInit().replaceAll('\t', '    ')).join('\n\n');
            // console.log(dtoArea);
            // console.log(Object.keys(cpyMap));

            fss.writeFileSync(`./results/${this.agentName}/${PROJECT_NAME}/${fileName}.py`, dtoArea + '\n\n' + sectionList.join('\n\n'));
        });

        return result;
    }
}


/**
 * ソースから文書（詳細設計書）化
 */
export class Step0020_ConvertToDoc extends MultiStepCobol2Python {

    constructor() {
        super();
        class Step0020_ConvertToDocChil extends BaseStepCobol2Python {
            systemMessageJa = '経験豊富で優秀なソフトウェアエンジニア。専門はCOBOLシステムのモダナイズ。';
            systemMessageEn = 'An experienced and excellent software engineer. Specializes in modernizing COBOL systems.';
            // 共通定義を上書きする場合はここで定義する。
            constructor(public targetFilePath: string, public innerIndex: number, public sectionName: string, public sectionCode: string) {
                super();
                const baseName = path.basename(targetFilePath);
                // 複数並列処理するので、被らないようにラベルを設定する。（これがログファイル名になる）
                this.label = Utils.safeFileName(`${this.constructor.name}_${baseName}-${innerIndex.toString().padStart(3, '0')}-${sectionName.replaceAll('-', '_')}`); // Utils.safeFileNameはファイル名として使える文字だけにするメソッド。
                // 個別の指示を作成。
                this.chapters = [
                    {
                        title: `Instructions`,
                        contentJa: Utils.trimLines(`プログラムの詳細設計書を作成してください。ロジックを単に文章に変換するだけで良いです。ソースから読み取れないことは書かなくて良いです。`),
                        contentEn: Utils.trimLines(`Create a detailed design document for the program. It is sufficient to simply convert the logic into sentences. You do not need to write anything that cannot be read from the source.`),
                        children: [{
                            titleJa: `対象のCOBOLソースコード`, titleEn: `Target COBOL source code`,
                            content: Utils.setMarkdownBlock(sectionCode, 'cobol'),
                        },]
                    }
                ];
            }
        }
        // childStepListを組み立て。
        this.childStepList = getStepInstance(Step0010_SimpleConvert).childStepList.map(step0 => {
            const step = step0 as any as { targetFilePath: string, innerIndex: number, sectionName: string, sectionCode: string };
            return new Step0020_ConvertToDocChil(step.targetFilePath, step.innerIndex, step.sectionName, step.sectionCode);
        });
    }

    /**
     * 結果をファイル名ごとにサマる
     * @param result 
     */
    postProcess(result: string[]): string[] {
        // 結果をファイル名ごとにサマる
        const codes = (this.childStepList as any as { targetFilePath: string, sectionName: string }[]).reduce((prev, curr, index) => {
            const doc = `## ${curr.sectionName}\n\n${Utils.addMarkdownDepth(result[index], 2)}`;
            const name = path.basename(curr.targetFilePath).split('.')[0];
            // ファイル名をキーにしたマップを作る
            if (name in prev) {
                prev[name].push(doc);
            } else {
                prev[name] = [doc];
            }
            return prev;
        }, {} as { [key: string]: string[] });

        // 書き出し
        Object.entries(codes).forEach(([targetFilePath, documentList]) => {
            const name = path.basename(targetFilePath).split('.')[0];
            fss.writeFileSync(`./results/${this.agentName}/${PROJECT_NAME}/${name}.md`, `# ${name}\n\n${documentList.join('\n\n')}`);
        });
        return result;
    }
}

/**
 * ソースから文書（詳細設計書）化
 */
export class Step0030_DomainClassify extends MultiStepCobol2Python {

    // クラスとして普通に自由に変数を作ってもよい。
    filePathList!: string[];

    constructor() {
        super();
        class Step0030_DomainClassifyChil extends BaseStepCobol2Python {
            systemMessageJa = '経験豊富で優秀なソフトウェアエンジニア。専門はドメイン駆動設計とクリーンアーキテクチャ。';
            systemMessageEn = 'An experienced and excellent software engineer. Specializes in domain-driven design and clean architecture.';
            format: StepOutputFormat = StepOutputFormat.JSON;
            // 共通定義を上書きする場合はここで定義する。
            constructor(public targetFilePath: string, public innerIndex: number, public sectionName: string, public document: string) {
                super();
                const baseName = path.basename(targetFilePath);
                // 複数並列処理するので、被らないようにラベルを設定する。（これがログファイル名になる）
                this.label = Utils.safeFileName(`${this.constructor.name}_${baseName}-${innerIndex}-${sectionName.replaceAll('-', '_')}`); // Utils.safeFileNameはファイル名として使える文字だけにするメソッド。
                // 個別の指示を作成。
                this.chapters = [
                    {
                        title: `Instructions`,
                        contentJa: Utils.trimLines(`
                            これから示す設計書は詳細設計書は「譲渡益税管理システム」の一部です。
                            この詳細設計書が「譲渡益税管理システム」の全体に対してどのような位置づけになるか、以下の３つに分類してください。
                            - 業務ロジック（金額や数量、日付の計算、決済処理、複雑な条件分岐、条件付きのDBアクセス、など）
                            - サポートロジック（単純なファイル入出力の定義、DBコネクション接続、引数取得、エラーハンドリング、ログ出力、メール送信など）
                        `),
                        contentEn: Utils.trimLines(`
                        `),
                        children: [
                            {
                                titleJa: `対象の詳細設計書`, titleEn: `Target detailed design document`,
                                content: Utils.setMarkdownBlock(document, 'markdown'),
                            },
                            {
                                titleJa: `出力形式`, titleEn: `Output format`,
                                content: Utils.trimLines(`
                                    判定結果は以下のJSON形式で出力してください。
                                    {"businessLogic": true, "supportLogic": false, "other": false, "reason": "xxxxx"}
                                `),
                            }
                        ]
                    }
                ];
            }
        }

        // childStepListを組み立て。
        this.childStepList = getStepInstance(Step0020_ConvertToDoc).childStepList.map(step0 => {
            const step = step0 as any as { targetFilePath: string, innerIndex: number, sectionName: string, sectionCode: string, result: string };
            return new Step0030_DomainClassifyChil(step.targetFilePath, step.innerIndex, step.sectionName, step.result);
        });
    }

    postProcess(resultList: string[]): string[] {
        // console.log(summary);
        resultList.forEach((result, index) => {
            const aa = Utils.jsonParse(result) as { businessLogic: boolean, supportLogic: boolean, other: boolean, reason: string };;
            console.log(`${this.childStepList[index].label} ${aa.businessLogic} ${aa.supportLogic} ${aa.other}`);
        });
        return resultList;
    }
}

/**
 * ソースから文書（詳細設計書）化
 */
class Step0040_RebuildDocument extends MultiStepCobol2Python {

    // クラスとして普通に自由に変数を作ってもよい。
    filePathList!: string[];

    constructor() {
        super();
        class Step0040_RebuildDocumentChil extends BaseStepCobol2Python {
            systemMessageJa = '経験豊富で優秀なソフトウェアエンジニア。専門はドメイン駆動設計とクリーンアーキテクチャ。';
            systemMessageEn = 'An experienced and excellent software engineer. Specializes in domain-driven design and clean architecture.';
            // 共通定義を上書きする場合はここで定義する。
            constructor(public targetFilePath: string, public innerIndex: number, public sectionName: string, public document: string) {
                super();
                const baseName = path.basename(targetFilePath);
                // 複数並列処理するので、被らないようにラベルを設定する。（これがログファイル名になる）
                this.label = Utils.safeFileName(`${this.constructor.name}_${baseName}-${innerIndex}-${sectionName.replaceAll('-', '_')}`); // Utils.safeFileNameはファイル名として使える文字だけにするメソッド。
                // 個別の指示を作成。
                this.chapters = [{
                    title: `Instructions`,
                    contentJa: Utils.trimLines(`
                        以下の詳細設計書を、以下の章立てで分解して再構成してください。
                        - コアドメイン（ビジネスにとって最も価値が高い領域）、
                        - サポートドメイン（コアドメインを支援する領域）、
                        - 汎用ドメイン（業界全体で共通の機能やサービス）、
                    `),
                    contentEn: Utils.trimLines(`
                    `),
                    children: [
                        {
                            titleJa: `再構成サンプル`, titleEn: `Conversion sample`,
                            content: `再構成サンプルは以下の通りです。注意深く参考にしてください。`,
                            children: [{
                                titleJa: `再構成前`, titleEn: `Before conversion`,
                                content: Utils.setMarkdownBlock(FROM_DOC, 'markdown'),
                            }, {
                                titleJa: `再構成後`, titleEn: `After conversion`,
                                content: Utils.setMarkdownBlock(TO_DOC, 'markdown'),
                            }]
                        },
                        {
                            titleJa: `再構成対象の詳細設計書`, titleEn: `Target detailed design document`,
                            content: Utils.setMarkdownBlock(document, 'markdown'),
                        }]
                }];
            }
        }

        // childStepListを組み立て。
        const docList = getStepInstance(Step0020_ConvertToDoc);
        this.childStepList = docList.childStepList.map((step0, index) => {
            const step = step0 as any as { targetFilePath: string, innerIndex: number, sectionName: string };
            return new Step0040_RebuildDocumentChil(step.targetFilePath, step.innerIndex, step.sectionName, step0.result);
        });
    }
    postProcess(resultList: string[]): string[] {
        return resultList;
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
    }).then(() => {
        obj = getStepInstance(Step0010_SimpleConvert);
        obj.initPrompt();
        return obj.run();
        // obj.postProcess(obj.childStepList.map(chil => chil.result));
    }).then(() => {
        obj = getStepInstance(Step0020_ConvertToDoc);
        obj.initPrompt();
        return obj.run();
    }).then(() => {
        obj = getStepInstance(Step0030_DomainClassify);
        obj.initPrompt();
        return obj.run();
        // obj.postProcess(obj.childStepList.map(chil => chil.result));
    }).then(() => {
        obj = getStepInstance(Step0040_RebuildDocument);
        obj.initPrompt();
        return obj.run();
        // obj.postProcess(obj.childStepList.map(chil => chil.result));
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


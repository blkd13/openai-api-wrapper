import * as fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { BaseStep, MultiStep, StepOutputFormat } from "../../common/base-step.js";
import fss from '../../common/fss.js';
import { GPTModels } from '../../common/model-definition.js';
import { Utils } from '../../common/utils.js';

function getFilesRecursively(directory: string): string[] {
    const filesInDirectory = fs.readdirSync(directory);
    let filesList: string[] = [];

    for (const file of filesInDirectory) {
        const absolutePath = path.join(directory, file);
        if (fs.statSync(absolutePath).isDirectory()) {
            filesList = [...filesList, ...getFilesRecursively(absolutePath)];
        } else {
            filesList.push(absolutePath);
        }
    }

    return filesList;
}

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
abstract class BaseStepSample extends BaseStep {
    agentName: string = Utils.basename(Utils.dirname(import.meta.url));
    model: GPTModels = 'gpt-4-1106-preview';
    systemMessage = 'You are gifted programmer.'; // AI専門家
    temperature: number = 0.0; // ランダム度合い。0に近いほど毎回同じ結果になる。プログラムのようなものは 0 に、文章系は 1 にするのが良い。
    format = StepOutputFormat.MARKDOWN;
}

/**
 * 最初のプロンプト。
 * このエージェント用の共通クラスであるBaseStepSampleを拡張する。
 */
class Step0000_FirstStep extends BaseStepSample {

    // BaseStepSampleで指定したデフォルト値から変更したいものはここで定義すると上書きされる。
    format = StepOutputFormat.JSON;

    /**
     * コンストラクタの中で chapters というオブジェクトリストを組み立てる。
     * これが後のメソッドでMarkdownに変換されてプロンプトになる。
     */
    constructor() {
        super();
        // プロンプトを構造化しやすくするためのオブジェクト。
        this.chapters = [{
            // 指示を与えるChapter
            title: `Instructions`,
            content: `AIについて重要な要素を5個列挙してください`,
            children: [
                { title: `Prohibition`, content: `AIについての批判的な要素は対象外としてください。` },
                {
                    title: `Additional information`,
                    content: `必ずしも正確な情報でなくともかまいません。`,
                    children: [
                        { content: `- 例えば、とても古くて今では使われていないような情報でも良いです。` }
                    ]
                },
            ],
        }, {
            // 出力フォーマットを指定するChapter
            title: `Output format`,
            // 改行含む文章を入れるときは Utils.trimLines で囲うといい感じにインデントを除去してくれる。
            content: Utils.trimLines(`
                {"factors":["some answer",...]}
            `),
        }];
    }
}

/**
 * 最初のステップの結果を詳細化するステップ
 * 並列に展開するのでBaseStepではなく MultiStep を拡張する。
 * MultiStepではchapterではなく、childStepListを組み立てる。
 */
class Step0010_Usecase extends MultiStep {

    // クラスとして普通に自由に変数を作ってもよい。
    fileNameList!: string[];

    constructor() {
        super();

        /**
         * 実際のステップ定義はここで書く。
         */
        class Step0010_UsecaseChil extends BaseStepSample {
            // 共通定義を上書きする場合はここで定義する。
            constructor(public targetFilePath: string) {
                super();
                // 複数並列処理するので、被らないようにラベルを設定する。（これがログファイル名になる）
                this.label = `${this.constructor.name}_${Utils.safeFileName(path.basename(targetFilePath))}`; // Utils.safeFileNameはファイル名として使える文字だけにするメソッド。
                // 個別の指示を作成。
                this.chapters = [
                    {
                        title: `Instructions`,
                        content: Utils.trimLines(`
                        Javaで書かれたソースコードをGO言語に書き換えてください。

                        - 補足は不要です
                        - 外部関数などのライブラリは所与のものとして良い
                        - コメントは日本語で
                        - Aina model.ExAina は、引数で受け取るのではなく、ctxから取得してください。
                        `),
                        children: [
                            {
                                title: `変換サンプル`,
                                content: `変換サンプルは以下の通りです。注意深く参考にしてください。`,
                                children: [{
                                    title: `変換前`,
                                    content: Utils.setMarkdownBlock(fs.readFileSync('./src/main/java/example/usecase/SampleUsecase.java', 'utf-8'), 'java'),
                                }, {
                                    title: `変換後`,
                                    content: Utils.setMarkdownBlock(fs.readFileSync('sample-cc/domain/usecase/refactor_usecase_SampleUsecase.go', 'utf-8'), 'go'),
                                }]
                            },
                            {
                                title: `変換対象のjavaソースコード`,
                                content: Utils.setMarkdownBlock(fs.readFileSync(targetFilePath, 'utf-8'), 'java'),
                            },
                        ]
                    }
                ];
            }
        }
        this.fileNameList = getFilesRecursively('./src/main/java/example/usecase/').filter(filename => filename.endsWith('Usecase.java'));
        // childStepListを組み立て。
        this.childStepList = this.fileNameList.map(targetName => new Step0010_UsecaseChil(targetName));
    }

    /**
     * 後処理系は postProcess で。
     * @param result 
     * @returns 
     */
    postProcess(result: string[]): string[] {
        this.childStepList.forEach((chil, index) => {
            fs.writeFileSync(
                `results/usecase_${path.basename(this.fileNameList[index]).replace(/.java/g, '.go')}`,
                chil.result.trim().replace(/^```.*\n/g, '').replace(/\n```$/g, '')
            );
        });
        return result;
    }
}


class Step0010_Controller extends MultiStep {

    // クラスとして普通に自由に変数を作ってもよい。
    fileNameList!: string[];

    constructor() {
        super();

        /**
         * 実際のステップ定義はここで書く。
         */
        class Step0010_ControllerChil extends BaseStepSample {
            // 共通定義を上書きする場合はここで定義する。
            constructor(public targetFilePath: string) {
                super();
                // 複数並列処理するので、被らないようにラベルを設定する。（これがログファイル名になる）
                this.label = `${this.constructor.name}_${Utils.safeFileName(path.basename(targetFilePath))}`; // Utils.safeFileNameはファイル名として使える文字だけにするメソッド。
                // 個別の指示を作成。
                this.chapters = [
                    {
                        title: `Instructions`,
                        content: Utils.trimLines(`
                        Javaで書かれたソースコードをGO言語に書き換えてください。

                        - 補足は不要です
                        - 外部関数などのライブラリは所与のものとして良い
                        - コメントは日本語で
                        - Aina model.ExAina は、引数で受け取るのではなく、ctxから取得してください。
                        `),
                        children: [
                            {
                                title: `変換サンプル`,
                                content: `変換サンプルは以下の通りです。注意深く参考にしてください。`,
                                children: [{
                                    title: `変換前`,
                                    content: Utils.setMarkdownBlock(fs.readFileSync('./src/main/java/example/usecase/SampleUsecase.java', 'utf-8'), 'java'),
                                }, {
                                    title: `変換後`,
                                    content: Utils.setMarkdownBlock(fs.readFileSync('./src/main/go/example/usecase/SampleUsecase.go', 'utf-8'), 'go'),
                                }]
                            },
                            {
                                title: `変換対象のjavaソースコード`,
                                content: Utils.setMarkdownBlock(fs.readFileSync(targetFilePath, 'utf-8'), 'java'),
                            },
                        ]
                    }
                ];
            }
        }
        this.fileNameList = getFilesRecursively('./src/main/java/example/usecase/').filter(filename => filename.endsWith('Controller.java'));
        // childStepListを組み立て。
        this.childStepList = this.fileNameList.map(targetName => new Step0010_ControllerChil(targetName));
    }

    /**
     * 後処理系は postProcess で。
     * @param result 
     * @returns 
     */
    postProcess(result: string[]): string[] {
        this.childStepList.forEach((chil, index) => {
            fs.writeFileSync(
                `results/controller_${path.basename(this.fileNameList[index]).replace(/.java/g, '.go')}`,
                chil.result.trim().replace(/^```.*\n/g, '').replace(/\n```$/g, '')
            );
        });
        return result;
    }
}

class Step0010_RestRepository extends MultiStep {

    // クラスとして普通に自由に変数を作ってもよい。
    fileNameList!: string[];

    constructor() {
        super();

        /**
         * 実際のステップ定義はここで書く。
         */
        class Step0010_RestRepositoryChil extends BaseStepSample {
            // 共通定義を上書きする場合はここで定義する。
            constructor(public targetFilePath: string) {
                super();
                // 複数並列処理するので、被らないようにラベルを設定する。（これがログファイル名になる）
                this.label = `${this.constructor.name}_${Utils.safeFileName(path.basename(targetFilePath))}`; // Utils.safeFileNameはファイル名として使える文字だけにするメソッド。
                // 個別の指示を作成。
                this.chapters = [
                    {
                        title: `Instructions`,
                        content: Utils.trimLines(`
                        Javaで書かれたソースコードをGO言語に書き換えてください。

                        - 補足は不要です
                        - 外部関数などのライブラリは所与のものとして良い
                        - コメントは日本語で
                        - Aina model.ExAina は、引数で受け取るのではなく、ctxから取得してください。
                        `),
                        children: [
                            {
                                title: `変換サンプル`,
                                content: `変換サンプルは以下の通りです。注意深く参考にしてください。`,
                                children: [{
                                    title: `変換前`,
                                    content: Utils.setMarkdownBlock(fs.readFileSync('./src/main/java/example/usecase/SampleUsecase.java', 'utf-8'), 'java'),
                                }, {
                                    title: `変換後`,
                                    content: Utils.setMarkdownBlock(fs.readFileSync('./src/main/go/example/usecase/SampleUsecase.go', 'utf-8'), 'go'),
                                }]
                            },
                            {
                                title: `変換対象のjavaソースコード`,
                                content: Utils.setMarkdownBlock(fs.readFileSync(targetFilePath, 'utf-8'), 'java'),
                            },
                        ]
                    }
                ];
            }
        }
        this.fileNameList = getFilesRecursively('./src/main/java/example/usecase/').filter(filename => filename.endsWith('Repository.java'));
        // childStepListを組み立て。
        this.childStepList = this.fileNameList.map(targetName => new Step0010_RestRepositoryChil(targetName));
    }

    /**
     * 後処理系は postProcess で。
     * @param result 
     * @returns 
     */
    postProcess(result: string[]): string[] {
        this.childStepList.forEach((chil, index) => {
            fs.writeFileSync(
                `results/star_repository_${path.basename(this.fileNameList[index]).replace(/.java/g, '.go')}`,
                chil.result.trim().replace(/^```.*\n/g, '').replace(/\n```$/g, '')
            );
        });
        return result;
    }
}

class Step0010_Refactor extends MultiStep {

    // クラスとして普通に自由に変数を作ってもよい。
    fileNameList!: string[];

    constructor() {
        super();

        /**
         * 実際のステップ定義はここで書く。
         */
        class Step0010_RefactorChil extends BaseStepSample {
            // 共通定義を上書きする場合はここで定義する。
            constructor(public targetFilePath: string) {
                super();
                // 複数並列処理するので、被らないようにラベルを設定する。（これがログファイル名になる）
                this.label = `${this.constructor.name}_${Utils.safeFileName(path.basename(targetFilePath))}`; // Utils.safeFileNameはファイル名として使える文字だけにするメソッド。
                // 個別の指示を作成。
                this.chapters = [
                    {
                        title: `Instructions`,
                        content: Utils.trimLines(`
                            ソースコードのリファクタリングをしてください。
                            リファクタリングの前後サンプルを渡すので、良く見てリファクタリングの内容を把握して、ソースコードに適用してください。
                            リファクタリング後のソースコード以外を出力しないでください。
                        `),
                        children: [
                            {
                                title: `リファクタリングサンプル`,
                                content: ``,
                                children: [{
                                    title: `リファクタリング前`,
                                    content: Utils.setMarkdownBlock(fs.readFileSync('./src/main/go/example/usecase/example_usecase_SampleUsecase_bef.go', 'utf-8'), 'go'),
                                }, {
                                    title: `リファクタリング後`,
                                    content: Utils.setMarkdownBlock(fs.readFileSync('./src/main/go/example/usecase/example_usecase_SampleUsecase.go', 'utf-8'), 'go'),
                                }]
                            },
                            {
                                title: `リファクタリング対象のソースコード`,
                                content: Utils.setMarkdownBlock(fs.readFileSync(targetFilePath, 'utf-8'), 'go'),
                            },
                        ]
                    }
                ];
            }
        }
        this.fileNameList = getFilesRecursively('./domain/usecase/').filter(filename => path.basename(filename).startsWith('example_') || path.basename(filename).startsWith('usecase_'));
        // childStepListを組み立て。
        this.childStepList = this.fileNameList.map(targetName => new Step0010_RefactorChil(targetName));
    }

    /**
     * 後処理系は postProcess で。
     * @param result 
     * @returns 
     */
    postProcess(result: string[]): string[] {
        this.childStepList.forEach((chil, index) => {
            fs.writeFileSync(
                `results/refactor_${path.basename(this.fileNameList[index]).replace(/.java/g, '.go')}`,
                chil.result.trim().replace(/^```.*\n/g, '').replace(/\n```$/g, '')
            );
        });
        return result;
    }
}

class Step0010_Refactor2 extends MultiStep {

    // クラスとして普通に自由に変数を作ってもよい。
    fileNameList!: string[];

    constructor() {
        super();

        /**
         * 実際のステップ定義はここで書く。
         */
        class Step0010_Refactor2Chil extends BaseStepSample {
            // 共通定義を上書きする場合はここで定義する。
            constructor(public targetFilePath: string) {
                super();
                // 複数並列処理するので、被らないようにラベルを設定する。（これがログファイル名になる）
                this.label = `${this.constructor.name}_${Utils.safeFileName(path.basename(targetFilePath))}`; // Utils.safeFileNameはファイル名として使える文字だけにするメソッド。
                // 個別の指示を作成。
                this.chapters = [
                    {
                        title: `Instructions`,
                        content: Utils.trimLines(`
                            ソースコードのリファクタリングをしてください。
                            リファクタリングの前後サンプルを渡すので、良く見てリファクタリングの内容を把握して、ソースコードに適用してください。
                            リファクタリング後のソースコード以外を出力しないでください。
                        `),
                        children: [
                            {
                                title: `リファクタリングサンプル`,
                                content: ``,
                                children: [{
                                    title: `リファクタリング前`,
                                    content: Utils.setMarkdownBlock(fs.readFileSync('./adapter/httpclient/SampleRepository.go_bef', 'utf-8'), 'go'),
                                }, {
                                    title: `リファクタリング後`,
                                    content: Utils.setMarkdownBlock(fs.readFileSync('./adapter/httpclient/SampleRepository.go_aft', 'utf-8'), 'go'),
                                }]
                            },
                            {
                                title: `リファクタリング対象のソースコード`,
                                content: Utils.setMarkdownBlock(fs.readFileSync(targetFilePath, 'utf-8'), 'go'),
                            },
                        ]
                    }
                ];
            }
        }
        this.fileNameList = getFilesRecursively('./adapter/httpclient/').filter(filename => path.basename(filename).endsWith('.go'));
        // childStepListを組み立て。
        this.childStepList = this.fileNameList.map(targetName => new Step0010_Refactor2Chil(targetName));
    }

    /**
     * 後処理系は postProcess で。
     * @param result 
     * @returns 
     */
    postProcess(result: string[]): string[] {
        this.childStepList.forEach((chil, index) => {
            fss.writeFileSync(
                `results/refactor/${path.basename(this.fileNameList[index]).replace(/.java/g, '.go')}`,
                chil.result.trim().replace(/^```.*\n/g, '').replace(/\n```$/g, '')
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
        //     // obj = new Step0000_FirstStep();
        //     // obj.initPrompt();
        //     // return obj.run();
        // }).then(() => {
        //     obj = new Step0010_Usecase();
        //     obj.initPrompt();
        //     // return obj.run();
        //     // obj.postProcess(obj.childStepList.map(chil => chil.result));
        // }).then(() => {
        //     obj = new Step0010_Controller();
        //     obj.initPrompt();
        //     // return obj.run();
        //     // obj.postProcess(obj.childStepList.map(chil => chil.result));
        // }).then(() => {
        //     obj = new Step0010_RestRepository()
        // obj.initPrompt();
        // return obj.run();
        //     // obj.postProcess(obj.childStepList.map(chil => chil.result));
        // }).then(() => {
        //     obj = new Step0010_Refactor()
        //     obj.initPrompt();
        //     // return obj.run();
        //     // obj.postProcess(obj.childStepList.map(chil => chil.result));
    }).then(() => {
        obj = new Step0010_Refactor2()
        obj.initPrompt();
        // return obj.run();
        obj.postProcess(obj.childStepList.map(chil => chil.result));
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


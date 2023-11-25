import * as fs from 'fs';
import { fileURLToPath } from 'url';
import chalk from 'chalk';

import { Utils } from '../common/utils.js';

/**
 * ひな型を作成する。
 */
export async function main(getType: string, name: string) {
    if (getType === 'agent') {
        const dir = `./src/app/agent/${Utils.toKebabCase(name)}`;
        const files = [
            'runner.ts',
        ];
        fs.mkdirSync(dir, { recursive: true });
        files.forEach(file => {
            const path = `${dir}/${file}`;
            if (!fs.existsSync(path)) {
                fs.writeFileSync(path, templateMas[file].replace(/BaseStepSample/g, `BaseStep${Utils.toPascalCase(name)}`) || '');
                console.log(chalk.greenBright('Created: '), path);
            } else {
                console.log(chalk.red(`file already exists: ${path}`));
            }
        });
    } else {
    }
}

const templateMas: { [key: string]: string } = {
    'runner.ts': Utils.trimLines(`
        import { fileURLToPath } from 'url';

        import { BaseStep, MultiStep, StepOutputFormat } from "../../common/base-step.js";
        import { GPTModels } from '../../common/openai-api-wrapper.js';
        import { Utils } from '../../common/utils.js';
        import fss from '../../common/fss.js';
        
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
            systemMessage = 'Experts in AI.'; // AI専門家
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
                    title: \`Instructions\`,
                    content: \`AIについて重要な要素を5個列挙してください\`,
                    children: [
                        { title: \`Prohibition\`, content: \`AIについての批判的な要素は対象外としてください。\` },
                        {
                            title: \`Additional information\`,
                            content: \`必ずしも正確な情報でなくともかまいません。\`,
                            children: [
                                { content: \`- 例えば、とても古くて今では使われていないような情報でも良いです。\` }
                            ]
                        },
                    ],
                }, {
                    // 出力フォーマットを指定するChapter
                    title: \`Output format\`,
                    // 改行含む文章を入れるときは Utils.trimLines で囲うといい感じにインデントを除去してくれる。
                    content: Utils.trimLines(\`
                        {"factors":["some answer",...]}
                    \`),
                }];
        
                // 上記のchaterpsは投げるときに以下のようにmarkdownに変換される。
                /**
                 * # Instructions
                 * 
                 * AIについて重要な要素を5個列挙してください
                 * 
                 * 
                 * ## Prohibition
                 * 
                 * AIについての批判的な要素は対象外としてください。
                 * 
                 * 
                 * ## Additional information
                 * 
                 * 必ずしも正確な情報でなくともかまいません。
                 * 
                 * - 例えば、とても古くて今では使われていないような情報でも良いです。
                 * 
                 * 
                 * 
                 * # Output format
                 * 
                 * {"factors":["some answer",...]}
                 * 
                 */
            }
        }
        
        /**
         * 最初のステップの結果を詳細化するステップ
         * 並列に展開するのでBaseStepではなく MultiStep を拡張する。
         * MultiStepではchapterではなく、childStepListを組み立てる。
         */
        class Step0010_DrillDown extends MultiStep {
        
            // クラスとして普通に自由に変数を作ってもよい。
            factors!: string[];
        
            constructor() {
                super();
        
                /**
                 * 実際のステップ定義はここで書く。
                 */
                class Step0010_DrillDownChil extends BaseStepSample {
                    // 共通定義を上書きする場合はここで定義する。
                    systemMessage = 'You are someone who has been thinking about AI for a long time.'; // AIについて昔からずっと考えている人。
        
                    constructor(public factor: string) {
                        super();
                        // 複数並列処理するので、被らないようにラベルを設定する。（これがログファイル名になる）
                        this.label = \`\${this.constructor.name}_\${Utils.safeFileName(factor)}\`; // Utils.safeFileNameはファイル名として使える文字だけにするメソッド。
                        // 個別の指示を作成。
                        this.chapters = [
                            {
                                title: \`Instructions\`,
                                content: \`AIについて理解するための要素として、「\${factor}」について日本語で詳しくレポートしてください。\`,
                            },
                        ];
                    }
                }
        
                // 前のステップの結果を読み込む（ステップを new して .formed でそのステップの結果にアクセスできる）
                const firstStepResult = JSON.parse(new Step0000_FirstStep().formed) as { factors: string[] };
                this.factors = firstStepResult.factors;
                // childStepListを組み立て。
                this.childStepList = this.factors.map(targetName => new Step0010_DrillDownChil(targetName));
            }
        
            /**
             * 後処理系は postProcess で。
             * 結果を1つのファイルにまとめる。
             * @param result 
             * @returns 
             */
            postProcess(result: string[]): string[] {
                // タイトルを付けてレポート形式にする。
                const reportList = result.map((targetName: string, index: number) => \`# \${this.factors[index]}\n\n\${targetName}\`);
                // 全部まとめてファイルに出力する。
                const outputFileName = \`results/\${this.constructor.name}_\${Utils.formatDate(new Date(), 'yyyyMMddHHmmssSSS')}-report_all.md\`;
                fss.writeFileSync(outputFileName, reportList.join('\n\n---\n\n'));
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
                obj = new Step0000_FirstStep();
                obj.initPrompt();
                return obj.run();
            }).then(() => {
                obj = new Step0010_DrillDown();
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
    `),
};

if (fileURLToPath(import.meta.url) === process.argv[1]) {
    // このファイルが直接実行された場合のコード
    main(process.argv[2], process.argv[3]);
} else {
    // main実行じゃなかったら何もしない
}
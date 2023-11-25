import * as  fs from 'fs';
import { finalize, tap } from 'rxjs';
import { ChatCompletionMessageParam } from 'openai/resources/chat/completions';

import fss from './fss.js';
import { GPTModels, OpenAIApiWrapper } from "./openai-api-wrapper.js";
import { Utils } from './utils.js';

// aiApi as singleton (for queing requests)
export const aiApi = new OpenAIApiWrapper();

export interface StructuredPrompt {
    title?: string;
    content?: string;
    children?: StructuredPrompt[];

    // copilotに翻訳させるためにJp/Enという項目名も用意した。実際にはcontentを使うのでこれらは使われない。
    contentJp?: string;
    contentEn?: string;
}

/**
 * [{title: 'hoge', content: 'fuga', children: [{title: 'hoge', content: 'fuga'}]}]のようなオブジェクトをMarkdownに変換する
 * @param {{ title: string, content: string, children: any[] }} chapter
 * @param {number} layer
 * @returns {string}
 */
function toMarkdown(chapter: StructuredPrompt, layer: number = 1) {
    let sb = '';
    if (chapter.title) {
        sb += `\n${'#'.repeat(layer)} ${chapter.title}\n\n`;
    } else { }
    let content;
    content = chapter.contentJp || chapter.contentEn;
    content = chapter.content;
    if (content) {
        sb += `${content}\n\n`;
    } else { }
    if (chapter.children) {
        chapter.children.forEach(child => {
            // console.log(child);
            sb += toMarkdown(child, layer + 1);
        });
    } else { }
    return sb;
}

/**
 * Creates an instance of BaseStepInterface.
 * 途中から再実行しやすくするために、細かくステップに分けて経過をファイルI/Oにしておく。
 * @param {string} [_label]
 * @memberof BaseStepInterface
 * 
 */
export abstract class BaseStepInterface<T> {
    /** エージェントの名前。通常はrunnuerの置いてあるディレクトリ名にする。prompts_and_responsesのディレクトリ分けるのに使うだけ。 */
    abstract agentName: string;

    /** label */
    _label: string = '';

    get label() { return this._label || this.constructor.name; }
    set label(label) { this._label = label; }

    /** プロンプトを組み立ててファイルに書き込む。つまり、initPromptを呼ばなければファイルは上書きされない。 */
    abstract initPrompt(): T;
    /** プロンプトを加工したり投げる前に何かしたいときはここで。 */
    abstract preProcess(prompt: T): T;
    /** メイン処理 */
    abstract run(): Promise<T>;
    /** ファイル出力したりした後に何かしたいときはここで。 */
    abstract postProcess(result: T): T;
}

export enum StepOutputFormat {
    JSON = 'json',
    MARKDOWN = 'markdown',
    HTML = 'html',
    TEXT = 'text',
};

/**
 * ステップの基本クラス
 * プロンプトと結果をファイル出力する。
 */
export abstract class BaseStep extends BaseStepInterface<string> {

    /** default parameters */
    // model: GPTModels = 'gpt-3.5-turbo';
    // model: GPTModels = 'gpt-4';
    model: GPTModels = 'gpt-4-1106-preview';
    systemMessage = 'You are an experienced and talented software engineer.';
    assistantMessage = '';
    visionPath = ''; // 画像読み込ませるとき用のパス。現状は1ステップ1画像のみにしておく。
    temperature = 0.0;
    format: StepOutputFormat = StepOutputFormat.MARKDOWN;

    /** create prompt */
    chapters: StructuredPrompt[] = []; // {title: string, content: string, children: chapters[]}

    /** io */
    get promptPath() { return `./prompts_and_responses/${this.agentName}/${Utils.safeFileName(this.label)}.prompt.md`; }
    get resultPath() { return `./prompts_and_responses/${this.agentName}/${Utils.safeFileName(this.label)}.result.md`; }
    get formedPath() { return `./prompts_and_responses/${this.agentName}/${Utils.safeFileName(this.label)}.result.${{ markdown: 'md', text: 'txt' }[this.format as any as string] || this.format.toString()}`; }

    get prompt() { return fs.readFileSync(this.promptPath, 'utf-8'); }
    get result() { return fs.readFileSync(this.resultPath, 'utf-8'); }
    get formed() { return fs.readFileSync(this.formedPath, 'utf-8'); }

    initPrompt(): string {
        // chaptersをMarkdownに変換してpromptに書き込む。
        let prompt = this.chapters.map(chapter => toMarkdown(chapter)).join('\n');
        prompt = this.preProcess(prompt);
        fss.writeFileSync(this.promptPath, prompt);
        return prompt;
    }

    /**
     * promptを加工したり投げる前に何かしたいときはここで。
     * @param {string} prompt
     * @returns {string}
     * @memberof BaseStep
     */
    preProcess(prompt: string): string {
        return prompt;
    }

    /**
     * メイン処理。
     * initPromptで作ったものを手で修正して使うこともあるので、
     * 敢えてファイルからプロンプトを読み込ませるようにしてある。
     * @returns 
     */
    async run(): Promise<string> {
        return new Promise<string>((resolve, reject) => {
            fs.readFile(this.promptPath, 'utf-8', (err, prompt: string) => {
                // messages
                const messages: ChatCompletionMessageParam[] = [];
                if (this.systemMessage) {
                    messages.push({ role: 'system', content: this.systemMessage });
                } else { }

                if (this.visionPath) {
                    // 画像を読み込ませるときはモデルを変える。
                    this.model = 'gpt-4-vision-preview';
                    messages.push({
                        role: 'user', content: [
                            { type: 'text', text: prompt },
                            { type: 'image_url', image_url: { url: this.visionPath } }
                        ]
                    });
                } else {
                    messages.push({ role: 'user', content: prompt });
                }
                if (this.assistantMessage) {
                    messages.push({ role: 'assistant', content: this.assistantMessage });
                } else { }

                let content = '';
                let isInit = false;
                aiApi.chatCompletionObservableStream({
                    messages: messages,
                    model: this.model,
                    temperature: this.temperature,
                    response_format: { type: this.format === StepOutputFormat.JSON ? 'json_object' : 'text' },
                    stream: true,
                }, {
                    label: this.label
                }).pipe( // オペレータじゃなくSubscribeでも良かった。
                    // ストリームを結合する
                    tap(data => {
                        content += data;
                        (isInit ? fss.appendFile : fss.writeFile)(`${this.resultPath}.tmp`, data, (err: any) => { if (err) console.error(err); });
                        isInit = true;
                    }),
                    // ストリームの終了時に実行する処理
                    finalize(() => {
                        fss.waitQ(`${this.resultPath}.tmp`).then(() => {
                            fs.rename(`${this.resultPath}.tmp`, this.resultPath, () => {
                                // format
                                if (StepOutputFormat.JSON === this.format) {
                                    try {
                                        content = JSON.stringify(Utils.jsonParse(content, true), null, 2);
                                        fss.writeFile(this.formedPath, content, (err: any) => {
                                            if (err) reject(err);
                                            resolve(this.postProcess(content));
                                        });
                                    } catch (e: any) {
                                        // json整形に失敗する場合は整形用にもう一発。

                                        let correctPrompt = `Please correct the following JSON that is incorrect as JSON and output the correct one.\nPay particular attention to the number of parentheses and commas.\n`;
                                        correctPrompt += `\`\`\`json\n${content}\n\`\`\``;

                                        isInit = false;
                                        content = '';
                                        aiApi.chatCompletionObservableStream({
                                            messages: [
                                                { role: 'system', content: `All output is done in JSON.` },
                                                { role: 'user', content: correctPrompt },
                                            ],
                                            model: `gpt-3.5-turbo`,
                                            temperature: 0,
                                            stream: true,
                                        }, {
                                            label: `${this.label}JsonCorrect`,
                                        }).pipe(
                                            tap(data => {
                                                content += data;
                                                (isInit ? fss.appendFile : fss.writeFile)(`${this.resultPath}.tmp`, data, (err: any) => { if (err) console.error(err); });
                                                isInit = true;
                                            }),
                                            finalize(() => {
                                                fss.waitQ(`${this.resultPath}.tmp`).then(() => {
                                                    try {
                                                        content = JSON.stringify(Utils.jsonParse(content), null, 2);
                                                        fss.writeFile(this.formedPath, content, (err: any) => {
                                                            if (err) reject(err);
                                                            fs.unlink(`${this.resultPath}.tmp`, () => { });
                                                            resolve(this.postProcess(content));
                                                        });
                                                    } catch (e: any) {
                                                        reject(e);
                                                    }
                                                });
                                            }),
                                        ).subscribe({ error: (err: any) => { reject(err); } });
                                    }
                                } else {
                                    resolve(this.postProcess(content));
                                }
                            });
                        });
                    }),
                ).subscribe({ error: (err: any) => { reject(err); } });
            });
        });
    }

    /**
     * ファイル出力したりした後に何かしたいときはここで。
     * @param {string} result
     * @returns {string}
     * @memberof BaseStep
     */
    postProcess(result: string): string {
        return result;
    }
}

/**
 * 複数のステップを順番に実行するステップ
 */
export class MultiStep extends BaseStepInterface<string[]> {
    agentName: string = 'common';

    constructor(
        public childStepList: BaseStep[] = []
    ) {
        super();
    }

    initPrompt(): string[] {
        return this.childStepList.map(step => step.initPrompt());
    }

    preProcess(prompt: string[]): string[] {
        return prompt;
    }

    async run(): Promise<string[]> {
        return new Promise<string[]>((resolve, reject) => {
            Promise.all(this.childStepList.map(step => step.run())).then((resultList: string[]) => {
                resolve(this.postProcess(resultList));
            }).catch((err: any) => {
                reject(err);
            });
        });
    }

    postProcess(result: string[]): string[] {
        return result;
    }
}
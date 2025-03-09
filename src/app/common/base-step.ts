import * as  fs from 'fs';
import { Observable, defer, filter, finalize, forkJoin, map, of, tap, toArray } from 'rxjs';
import { ChatCompletionContentPart, ChatCompletionMessageParam } from 'openai/resources/chat/completions';

import fss from './fss.js';
import { GPTModels } from '../common/model-definition.js';
import { OpenAIApiWrapper } from "./openai-api-wrapper.js";
import { Utils } from './utils.js';

// aiApi as singleton (for queing requests)
export const aiApi = new OpenAIApiWrapper({ allowLocalFiles: true });

export interface StructuredPrompt {
    title?: string;
    content?: string;
    children?: StructuredPrompt[];

    // copilotに翻訳させるためにJa/Enという項目名も用意した。
    titleJa?: string;
    titleEn?: string;
    contentJa?: string;
    contentEn?: string;
    document?: string;
}
export type PromptLang = 'ja' | 'en';
export type Prompt = string | Partial<Record<PromptLang, string>>;

function toString(prompt: Prompt, lang: PromptLang) {
    if (typeof prompt === 'string') { return prompt; } else { return prompt[lang] || ''; }
}

/**
 * [{title: 'hoge', content: 'fuga', children: [{title: 'hoge', content: 'fuga'}]}]のようなオブジェクトをMarkdownに変換する
 * @param {{ title: string, content: string, children: any[] }} chapter
 * @param {number} layer
 * @returns {string}
 */
function toMarkdown(chapter: StructuredPrompt, lang: PromptLang, layer: number = 1): string {
    let sb = '';
    let title;
    title = (lang === 'ja' ? chapter.titleJa : chapter.titleEn) || chapter.title || '';
    if (title) {
        sb += `${'#'.repeat(layer)} ${title}\n\n`;
    } else { }
    let content;
    content = (lang === 'ja' ? chapter.contentJa : chapter.contentEn) || chapter.content || '';
    if (content) {
        sb += `${content}\n\n`;
    } else { }
    if (chapter.children) {
        chapter.children.forEach(child => {
            // console.log(child);
            sb += toMarkdown(child, lang, layer + 1);
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

    lang: PromptLang = 'ja';

    /** label */
    _label: string = '';

    get label() { return this._label || this.constructor.name; }
    set label(label) { this._label = label; }

    labelPrefix = '';
    isSkip = false; // ステップ定義側でスキップ指定する場合はこれをtrueにする。

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
    systemMessageJa = '経験豊富で優秀なソフトウェアエンジニア';
    systemMessageEn = 'You are an experienced and talented software engineer.';
    systemMessage = this.systemMessageEn;
    assistantMessageJa = '';
    assistantMessageEn = '';
    assistantMessage = '';
    temperature = 0.0;
    format: StepOutputFormat = StepOutputFormat.MARKDOWN;
    presetMessages: ChatCompletionMessageParam[] = []; // presetMessagesを使うと、presetMessagesをpromptの前にそのまま付与する。これはセルフリファインのために使う。
    refineMessages: ChatCompletionMessageParam[] = []; // refineMessages セルフリファイン用のメッセージ。promptの実行後にrefineMessagesを付与して自動実行する。

    /** create prompt */
    chapters: StructuredPrompt[] = []; // {title: string, content: string, children: chapters[]}
    // 画像とかメディアファイル読ませるとき用
    documents: string[] = []; // {title: string, content: string, children: chapters[]}

    /** io */
    get promptPath() { return `./prompts_and_responses/${this.agentName}/${this.labelPrefix}${Utils.safeFileName(this.label)}.prompt.md`; }
    get resultPath() { return `./prompts_and_responses/${this.agentName}/${this.labelPrefix}${Utils.safeFileName(this.label)}.result.md`; }
    get formedPath() { return `./prompts_and_responses/${this.agentName}/${this.labelPrefix}${Utils.safeFileName(this.label)}.result.${{ markdown: 'md', text: 'txt' }[this.format as any as string] || this.format.toString()}`; }

    get prompt() { return fs.readFileSync(this.promptPath, 'utf-8'); }
    get result() { return fs.readFileSync(this.resultPath, 'utf-8'); }
    get formed() { return fs.readFileSync(this.formedPath, 'utf-8'); }

    /** refine系 */
    getRefinePath(index: number) { return this.refineMessages.length === index ? this.resultPath : `./prompts_and_responses/${this.agentName}/${this.labelPrefix}${Utils.safeFileName(this.label)}.refine-${index}.md`; }
    getRefineData(index: number) { return fs.readFileSync(this.getRefinePath(index), 'utf-8'); }

    initPrompt(): string {
        // chaptersをMarkdownに変換してpromptに書き込む。
        let prompt = this.chapters.map(chapter => toMarkdown(chapter, this.lang)).join('\n');
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
     * @param {boolean} [isForce=false] resultファイルがあっても再実行する場合はtrueにする。refineIndexの機能には対応していないので注意。
     * @param {number} [refineIndex=0] セルフリファインの二周目以降から開始する場合はここで指定する。
     * @returns 
     */
    async run(isForce: boolean = false, refineIndex: number = 0): Promise<string> {
        // TODO refineIndexが指定されているときの!isForceの挙動が怪しい。
        if (!isForce && fs.existsSync(this.resultPath) && fs.statSync(this.resultPath).size > 0) {
            // console.log(this.resultPath);
            console.log(`${Utils.formatDate()} done ${this.label}`);
            return Promise.resolve(this.result);
        } else { }
        // スキップ指定されていたら既存の処理結果、もしくは空文字を返す。
        if (this.isSkip) {
            console.log(`${Utils.formatDate()} skip ${this.label}`);
            return Promise.resolve(this.result || '');
        } else { }
        return new Promise<string>((resolveRoot, rejectRoot) => {
            fs.readFile(this.promptPath, 'utf-8', (err, prompt: string) => {
                // messages
                const messages: ChatCompletionMessageParam[] = [];
                this.systemMessage = (this.lang === 'ja' ? this.systemMessageJa : this.systemMessageEn) || this.systemMessage || '';
                if (this.systemMessage) {
                    messages.push({ role: 'system', content: this.systemMessage });
                } else { }

                // presetMessages
                if (this.presetMessages.length > 0) {
                    messages.push(...this.presetMessages);
                } else { }

                const contents: ChatCompletionContentPart[] = [{ type: 'text', text: prompt }];
                messages.push({ role: 'user', content: contents });
                for (const doc of this.documents) { contents.push({ type: 'image_url', image_url: { url: doc } }); }

                this.assistantMessage = (this.lang === 'ja' ? this.assistantMessageJa : this.assistantMessageEn) || this.assistantMessage || '';
                if (this.assistantMessage) {
                    messages.push({ role: 'assistant', content: this.assistantMessage });
                } else { }

                for (let i = 0; i < refineIndex; i++) {
                    messages.push({ role: 'assistant', content: this.getRefineData(i) });
                    messages.push(this.refineMessages[i]);
                }

                // refineの回数がrefineMessagesの数より少ない間はrefineを掛ける。
                const refine = () => {
                    let outputPath: string;
                    if (refineIndex < this.refineMessages.length) {
                        outputPath = `./prompts_and_responses/${this.agentName}/${this.labelPrefix}${Utils.safeFileName(this.label)}.refine-${refineIndex}.md`; // refine用のファイルパス
                    } else {
                        outputPath = this.resultPath;
                    }
                    this.runStream(messages, outputPath).subscribe({
                        next: (result: string) => {
                            // refine
                            if (refineIndex < this.refineMessages.length) {
                                // 前回結果を追記してrefineを掛ける
                                messages.push({ role: 'assistant', content: result });
                                messages.push(this.refineMessages[refineIndex]);
                                refineIndex++;
                                refine();
                            } else {
                                // no refineMessages
                                resolveRoot(this.postProcess(result));
                            }
                        },
                        error: (err: any) => {
                            rejectRoot(err);
                        },
                    });
                };
                refine();
            });
        });
    }

    /**
     * メイン処理。
     * initPromptで作ったものを手で修正して使うこともあるので、
     * 敢えてファイルからプロンプトを読み込ませるようにしてある。
     * @param {boolean} [isForce=false] resultファイルがあっても再実行する場合はtrueにする。refineIndexの機能には対応していないので注意。
     * @param {number} [refineIndex=0] セルフリファインの二周目以降から開始する場合はここで指定する。
     * @returns 
     */
    runRx(isForce: boolean = false, refineIndex: number = 0): Observable<string> {
        // TODO refineIndexが指定されているときの!isForceの挙動が怪しい。
        if (!isForce && fs.existsSync(this.resultPath) && fs.statSync(this.resultPath).size > 0) {
            // console.log(this.resultPath);
            console.log(`${Utils.formatDate()} done ${this.label}`);
            return of(this.result);
        } else { }
        // スキップ指定されていたら既存の処理結果、もしくは空文字を返す。
        if (this.isSkip) {
            console.log(`${Utils.formatDate()} skip ${this.label}`);
            return of(this.result || '');
        } else { }
        return new Observable<string>(subscriber => {
            // return new Promise<string>((resolveRoot, rejectRoot) => {
            fs.readFile(this.promptPath, 'utf-8', (err, prompt: string) => {
                // messages
                const messages: ChatCompletionMessageParam[] = [];
                this.systemMessage = (this.lang === 'ja' ? this.systemMessageJa : this.systemMessageEn) || this.systemMessage || '';
                if (this.systemMessage) {
                    messages.push({ role: 'system', content: this.systemMessage });
                } else { }

                // presetMessages
                if (this.presetMessages.length > 0) {
                    messages.push(...this.presetMessages);
                } else { }

                const contents: ChatCompletionContentPart[] = [{ type: 'text', text: prompt }];
                messages.push({ role: 'user', content: contents });
                for (const doc of this.documents) { contents.push({ type: 'image_url', image_url: { url: doc } }); }

                this.assistantMessage = (this.lang === 'ja' ? this.assistantMessageJa : this.assistantMessageEn) || this.assistantMessage || '';
                if (this.assistantMessage) {
                    messages.push({ role: 'assistant', content: this.assistantMessage });
                } else { }

                for (let i = 0; i < refineIndex; i++) {
                    messages.push({ role: 'assistant', content: this.getRefineData(i) });
                    messages.push(this.refineMessages[i]);
                }

                // refineの回数がrefineMessagesの数より少ない間はrefineを掛ける。
                const refine = () => {
                    let outputPath: string;
                    if (refineIndex < this.refineMessages.length) {
                        outputPath = `./prompts_and_responses/${this.agentName}/${this.labelPrefix}${Utils.safeFileName(this.label)}.refine-${refineIndex}.md`; // refine用のファイルパス
                    } else {
                        outputPath = this.resultPath;
                    }
                    this.runStream(messages, outputPath).subscribe({
                        next: (result: string) => {
                            // refine
                            if (refineIndex < this.refineMessages.length) {
                                // 前回結果を追記してrefineを掛ける
                                messages.push({ role: 'assistant', content: result });
                                messages.push(this.refineMessages[refineIndex]);
                                refineIndex++;
                                refine();
                            } else {
                                // no refineMessages
                                subscriber.next(this.postProcess(result));
                            }
                        },
                        error: subscriber.error,
                    });
                };
                refine();
            });
        });
    }

    runStream(messages: ChatCompletionMessageParam[], outputPath: string): Observable<string> {
        let content = '';
        let isInit = false;
        return new Observable<string>(subscriber => {
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
                map(data => data.choices[0]?.delta?.content || ''),
                tap(data => {
                    content += data;
                    (isInit ? fss.appendFile : fss.writeFile)(`${outputPath}.tmp`, data, (err: any) => { if (err) console.error(err); });
                    isInit = true;
                }),
                toArray(), // ストリームを配列に変換する
                map(data => data.join('')), // 配列を文字列に変換する
                // ストリームの終了時に実行する処理
                finalize(() => {
                    fss.waitQ(`${outputPath}.tmp`).then(() => {
                        fs.rename(`${outputPath}.tmp`, outputPath, () => {
                            // format
                            if (StepOutputFormat.JSON === this.format) {
                                try {
                                    content = JSON.stringify(Utils.jsonParse(content, true), null, 2);
                                    fss.writeFile(this.formedPath, content, (err: any) => {
                                        if (err) throw err;
                                        subscriber.next(content);
                                        subscriber.complete();
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
                                        model: `gpt-3.5-turbo`, // JSON整形の失敗をやり直すだけなのでgpt-3.5-turboで十分。
                                        temperature: 0,
                                        stream: true,
                                    }, {
                                        label: `${this.label}JsonCorrect`,
                                    }).pipe(
                                        map(data => data.choices[0]?.delta?.content || ''),
                                        tap(data => {
                                            content += data;
                                            (isInit ? fss.appendFile : fss.writeFile)(`${outputPath}.tmp`, data, (err: any) => { if (err) console.error(err); });
                                            isInit = true;
                                        }),
                                        finalize(() => {
                                            fss.waitQ(`${outputPath}.tmp`).then(() => {
                                                try {
                                                    content = JSON.stringify(Utils.jsonParse(content), null, 2);
                                                    fss.writeFile(this.formedPath, content, (err: any) => {
                                                        if (err) throw err;
                                                        fs.unlink(`${outputPath}.tmp`, () => { });
                                                        subscriber.next(content);
                                                        subscriber.complete();
                                                    });
                                                } catch (err: any) {
                                                    throw err;
                                                }
                                            });
                                        }),
                                    ).subscribe({ error: (err: any) => { throw err; } });
                                }
                            } else {
                                subscriber.next(content);
                                subscriber.complete();
                            }
                        });
                    });
                }),
            ).subscribe({ error: (err: any) => { throw err; } })
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


    /**
     * 別のステップの結果をプリセットプロンプトとして読み込む。
     * @param step 
     */
    loadPresetMessagesFromStep(step: BaseStep) {
        // stepのpresetMessagesをpromptの前にそのまま付与する。
        step.presetMessages.forEach(message => {
            this.presetMessages.push(message);
        });
        // stepのpromptをそのまま付与する。
        this.presetMessages.push({ role: 'user', content: step.prompt });
        let refineIndex = 0;
        // stepのrefineMessageがあれば、まずはpromptの結果から追加する
        step.refineMessages.forEach(message => {
            this.presetMessages.push({ role: 'assistant', content: step.getRefineData(refineIndex) });
            this.presetMessages.push(message);
            refineIndex++;
        });
        // 最後の結果を追加する。
        this.presetMessages.push({ role: 'assistant', content: step.getRefineData(refineIndex) });
    }

    chooseContent(content: { contentJa?: string, contentEn?: string }): string {
        return this.lang === 'ja' ? content.contentJa || content.contentEn || '' : content.contentEn || content.contentJa || '';
    }

    chooseTitle(title: { titleJa?: string, titleEn?: string }): string {
        return this.lang === 'ja' ? title.titleJa || title.titleEn || '' : title.titleEn || title.titleJa || '';
    }
}

/**
 * 複数のステップを順番に実行するステップ
 */
export class MultiStep extends BaseStepInterface<string[]> {
    agentName!: string;

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

    get resultPath() { return `./prompts_and_responses/${this.agentName}/${this.labelPrefix}${Utils.safeFileName(this.label)}.result.md`; }
    get formedPath() { return `./prompts_and_responses/${this.agentName}/${this.labelPrefix}${Utils.safeFileName(this.label)}.result.json`; }

    get result() { return fs.readFileSync(this.resultPath, 'utf-8'); }
    get formed() { return fs.readFileSync(this.formedPath, 'utf-8'); }

    async run(isForce: boolean = false, refineIndex: number = 0): Promise<string[]> {
        this.agentName = this.childStepList[0]?.agentName || this.agentName;
        if (this.isSkip) {
            // スキップ指定されていたら空文字を返す。
            return new Promise<string[]>((resolve, reject) => {
                // skipの時は子ステップもskipにして一応実行しておく。もしかするとrunの中で微妙に細かいところやっておきたくなるかもしれないので。
                Promise.all(this.childStepList.map(step => { step.isSkip = this.isSkip; return step.run(); })).then((resultList: string[]) => {
                    // skipの時はpostProcessも呼ばない。
                    resolve(resultList);
                }).catch((err: any) => {
                    reject(err);
                });
            });
        } else {
            return new Promise<string[]>((resolve, reject) => {
                Promise.all(this.childStepList.map(step => step.run(isForce, refineIndex))).then((resultList: string[]) => {

                    // 全部まとめてファイルに出力する。
                    fss.writeFile(this.resultPath, resultList.join('\n\n---\n\n'), (err: any) => {
                        if (err) reject(err);
                        // まとめてJSONにもする。
                        const summary = this.childStepList.reduce((prev: any, step: BaseStep, index: number) => {
                            prev[step.label.substring(step.constructor.name.length + 1)] = resultList[index];
                            return prev;
                        }, {} as { [key: string]: string });
                        fss.writeFile(this.formedPath, JSON.stringify(summary), (err: any) => {
                            if (err) reject(err);
                            resolve(this.postProcess(resultList));
                        });
                    });
                }).catch((err: any) => {
                    reject(err);
                });
            });
        }
    }

    runRx(isForce: boolean = false, refineIndex: number = 0): Observable<string[]> {
        this.agentName = this.childStepList[0]?.agentName;
        if (this.isSkip) {
            // スキップ指定されていたら空文字を返す。
            // skipの時は子ステップもskipにして一応実行しておく。もしかするとrunの中で微妙に細かいところやっておきたくなるかもしれないので。
            return forkJoin(this.childStepList.map(step => { step.isSkip = this.isSkip; return step.runRx(); }));
        } else {
            return new Observable<string[]>((subscriber) => {
                forkJoin(this.childStepList.map(step => step.runRx(isForce, refineIndex))).pipe(
                    tap((resultList: string[]) => {
                        // 全部まとめてファイルに出力する。
                        fss.writeFile(this.resultPath, resultList.join('\n\n---\n\n'), (err: any) => {
                            if (err) subscriber.error(err);
                            // まとめてJSONにもする。
                            const summary = this.childStepList.reduce((prev: any, step: BaseStep, index: number) => {
                                prev[step.label.substring(step.constructor.name.length + 1)] = resultList[index];
                                return prev;
                            }, {} as { [key: string]: string });
                            fss.writeFile(this.formedPath, JSON.stringify(summary), (err: any) => {
                                if (err) subscriber.error(err);
                                subscriber.next(this.postProcess(resultList));
                            });
                        });
                    })
                ).subscribe({
                    // next: subscriber.next, // ファイル出力が完了してからnextを呼ぶのでここでは不要。
                    error: subscriber.error,
                    complete: subscriber.complete,
                });
            });
        }
    }

    postProcess(result: string[]): string[] {
        return result;
    }
}

const CONTAINER: Record<string, BaseStep | MultiStep> = {};

export function getStepInstance<T extends BaseStep | MultiStep>(stepClass: { new(): T }): T {
    if (CONTAINER[stepClass.name]) {
        return CONTAINER[stepClass.name] as T;
    } else {
        return CONTAINER[stepClass.name] = new stepClass();
    }
}

// それぞれのステップをObservableに変換する関数
export function runStep(stepClass: typeof BaseStepInterface<string | string[]>) {
    return defer(() => {
        let obj = getStepInstance(stepClass as any);
        obj.initPrompt();
        return obj.run();  // Observable<string>を返す
    });
}

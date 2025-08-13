import { exec } from 'child_process';
import { randomUUID } from 'crypto';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { promisify } from 'util';

import { map, toArray } from 'rxjs';
import TurndownService from 'turndown';
// import * as cheerio from 'cheerio';
import { AxiosInstance } from 'axios';

import createDOMPurify from 'dompurify';
import { JSDOM } from 'jsdom';
import { Browser } from 'puppeteer';
import { getAxios, getPuppeteer } from '../../common/http-client.js';
import { MyToolType, OpenAIApiWrapper } from '../../common/openai-api-wrapper.js';
import { EnhancedRequestLimiter, Utils } from '../../common/utils.js';
import { ExtApiClient, getExtApiClient } from '../controllers/auth.js';
import { getAIProvider, MessageArgsSet } from '../controllers/chat-by-project-model.js';
import { ds } from '../db.js';
import { OAuthAccountEntity } from '../entity/auth.entity.js';
import { ContentPartEntity, MessageEntity, MessageGroupEntity, PredictHistoryWrapperEntity } from '../entity/project-models.entity.js';
import { UserRequest } from '../models/info.js';


const turndownService = new TurndownService();
turndownService.remove(['script', 'style']); // 特定のHTML要素を削除

// 待機用のヘルパー関数
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const window = new JSDOM('').window;
const DOMPurify = createDOMPurify(window);

export function sanitizeHTML(dirty: string): string {
    return DOMPurify.sanitize(dirty, {
        USE_PROFILES: { html: true },
    });
}

export async function isPdfUrl(url: string): Promise<boolean> {
    try {
        const res = await fetch(url, { method: 'HEAD' });
        const type = res.headers.get('content-type') || '';
        if (type.toLowerCase().includes('application/pdf')) return true;
    } catch (_) { }

    // fallback: check file signature
    try {
        const res = await fetch(url);
        const buffer = await res.arrayBuffer();
        const signature = new Uint8Array(buffer.slice(0, 4));
        return signature[0] === 0x25 && signature[1] === 0x50 && signature[2] === 0x44 && signature[3] === 0x46; // %PDF
    } catch (_) {
        return false;
    }
}

/**
 * PDFをダウンロードしてBufferで返す
 */
export async function downloadPdfAsBufferWithFilename(url: string): Promise<{ buffer: Buffer; filename: string | null }> {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to fetch PDF: ${res.statusText}`);
    const arrayBuffer = await res.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    const contentDisposition = res.headers.get('content-disposition');
    const filename = extractFilenameFromContentDisposition(contentDisposition);

    return { buffer, filename };
}

function extractFilenameFromContentDisposition(header: string | null): string | null {
    if (!header) return null;
    const match = header.match(/filename\*?=(?:UTF-8''|")?([^";\n]+)/i);
    if (match && match[1]) {
        return decodeURIComponent(match[1]);
    }
    return null;
}

/**
 * Buffer → data: URL（base64）
 */
export function bufferToDataUrl(buffer: Buffer, mimeType = 'application/pdf'): string {
    const base64 = buffer.toString('base64');
    return `data:${mimeType};base64,${base64}`;
}

async function fetchRenderedText(browser: Browser, url: string, loadContentType: 'TEXT' | 'MARKDOWN' | 'HTML' = 'TEXT'): Promise<{ type: 'TEXT' | 'MARKDOWN' | 'HTML' | 'PDF' | 'ERROR', title: string, favicon: string, body: string }> {
    try {
        console.log(`puppeteer loadContentType=${loadContentType} url=${url}`);
        const page = await browser.newPage();

        // ユーザーエージェントを設定（より実際のブラウザに近いものを使用）
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36');

        // 追加の対策: WebDriverフラグを削除
        await page.evaluateOnNewDocument(() => {
            // WebDriverプロパティを削除
            Object.defineProperty(navigator, 'webdriver', {
                get: () => undefined
            });

            // 追加のブラウザ指紋対策
            // プラグインを模倣
            Object.defineProperty(navigator, 'plugins', {
                get: () => [1, 2, 3, 4, 5],
            });

            // 言語設定を一般的なものに
            Object.defineProperty(navigator, 'languages', {
                get: () => ['en-US', 'en'],
            });
        });

        // タイムアウトを長めに設定（Cloudflareのチャレンジに対応するため）
        // page.setDefaultNavigationTimeout(60000); の代わりに
        try {
            // ページに移動し、ネットワークがアイドル状態になるまで待機
            if (await isPdfUrl(url)) {
                console.log(`[PDF] ${url}`);
                const pdfObject = await downloadPdfAsBufferWithFilename(url);
                const dataUrl = bufferToDataUrl(pdfObject.buffer, 'application/pdf');
                return { type: 'PDF', title: pdfObject.filename || '', body: dataUrl, favicon: '' };
            } else { }
            await page.goto(url, {
                waitUntil: 'networkidle2',
                timeout: 60000 // タイムアウトを60秒に設定
            });

            // Cloudflareの「お待ちください」画面に対応するための追加の待機
            const cloudflareDetected = await page.evaluate(() => {
                try {
                    return document.body.innerText.includes('Checking your browser') ||
                        document.body.innerText.includes('Please wait') ||
                        document.body.innerText.includes('Just a moment') ||
                        document.body.innerText.includes('あなたが人間であることを確認');
                } catch (error) {
                    return false;
                }
            });

            if (cloudflareDetected) {
                console.log('Cloudflare challenge detected, waiting...');
                // waitForTimeoutの代わりにdelayを使用
                await delay(10000);

                // 追加：ページが完全に読み込まれるまで待機
                await page.waitForFunction(() => {
                    try {
                        return !document.body.innerText.includes('Checking your browser') &&
                            !document.body.innerText.includes('Please wait') &&
                            !document.body.innerText.includes('Just a moment') &&
                            !document.body.innerText.includes('あなたが人間であることを確認');
                    } catch (error) {
                        return false;
                    }
                }, { timeout: 30000 }).catch(e => {
                    console.log('Still on Cloudflare page after waiting, continuing anyway...');
                });
            }

            // ページのテキストを取得
            let result: { type: 'TEXT' | 'HTML' | 'MARKDOWN', title: string, body: string, favicon: string };

            // コンテンツの読み込みタイプを設定（デフォルトは'TEXT'）
            if (loadContentType === 'TEXT') {
                const text = await page.evaluate(() => {
                    try {
                        const link = document.querySelector('link[rel~="icon"]') as HTMLLinkElement | null;
                        return { title: document.title, body: document.body.innerText, favicon: link ? link.href : '' };
                    } catch (error) {
                        console.error('Error while extracting text content:', error);
                        return { title: '', body: '', favicon: '' };
                    }
                });
                result = { type: loadContentType, title: text.title, body: text.body, favicon: text.favicon };
            } else {
                const html = await page.evaluate(() => {
                    try {
                        const link = document.querySelector('link[rel~="icon"]') as HTMLLinkElement | null;
                        return { title: document.title, body: document.documentElement.outerHTML, favicon: link ? link.href : '' };
                    } catch (error) {
                        console.error('Error while extracting HTML content:', error);
                        return { type: 'ERROR', title: '', body: '', favicon: '' };
                    }
                });
                if (loadContentType === 'HTML') {
                    result = { type: loadContentType, title: html.title, body: html.body, favicon: html.favicon };
                } else {
                    result = {
                        type: loadContentType,
                        title: html.title,
                        body: turndownService.turndown(html.body),
                        favicon: html.favicon,
                    };
                }
            }

            return result;
        } catch (error) {
            console.error('Error during page navigation or processing:', error);
            throw error;
        }
    } catch (error) {
        console.error('Error while fetching rendered text:', error);
        throw error;
    }
}

// EnhancedRequestLimiterを使用した改善版
const puppeteerLimiter = new EnhancedRequestLimiter(
    5, // 最大並列実行数を5に制限（必要に応じて調整）
    3, // リトライ回数
    2000, // リトライ間隔（ms）
    (error: Error) => {
        // エラータイプに応じたリトライ戦略
        if (error.message.includes('Navigation timeout') ||
            error.message.includes('net::ERR_') ||
            error.message.includes('Protocol error')) {
            return { shouldRetry: true, retryCount: 2, retryDelay: 3000 };
        }
        // メモリ不足やブラウザクラッシュ系のエラーはリトライしない
        if (error.message.includes('Target closed') ||
            error.message.includes('Session closed')) {
            return { shouldRetry: false };
        }
        return { shouldRetry: true };
    }
);

const aiModels = [
    { 'model': 'gemini-2.0-flash-001', 'description': 'gemini-1.5-flashの次世代モデル。前世代を上回る性能。' },
    { 'model': 'gpt-4o', 'description': '高評価。自然な対話、速度とコスト効率の良さが評価されている。', },
    { 'model': 'o1', 'description': '内部推論モデル。超高精度だが遅くて、高コスト。', },
    { 'model': 'o3-mini', 'description': '内部推論モデル。超高精度だが遅くて、高コスト。', },
    // { 'model': 'gemini-1.5-flash', 'description': '高速かつ効率的、Gemini 1.5 Proの軽量版。大量の情報を迅速に処理するニーズに応え、コスト効率も高い。リアルタイム処理が求められる場面での活用が期待されている。', },
    { 'model': 'gemini-1.5-pro', 'description': '長文コンテキスト処理能力に優れる。大量のテキストやコードの解析に強みを発揮。特定のタスクにおいて既存モデルを超える性能を示す。', },
    { 'model': 'gemini-2.0-pro-exp-02-05', 'description': 'gemini-1.5-proの次世代モデル。前世代を上回る性能を持つが、試験運用版のためやや不安定な動作もある。' },
    { 'model': 'claude-3-5-sonnet-20241022', 'description': '推論、コーディング、コンテンツ作成など多様なタスクに対応。安全性と倫理的な配慮が重視されており、企業での利用に適している。バランスの取れた性能も評価されている。', },
    { 'model': 'claude-3-7-sonnet-20250219', 'description': '推論、コーディング、コンテンツ作成など多様なタスクに対応。安全性と倫理的な配慮が重視されており、企業での利用に適している。バランスの取れた性能も評価されている。ツール利用が得意', },
];

export function commonFunctionDefinitions(
    obj: { inDto: MessageArgsSet; messageSet: { messageGroup: MessageGroupEntity; message: MessageEntity; contentParts: ContentPartEntity[]; }; },
    req: UserRequest, aiApi: OpenAIApiWrapper, connectionId: string, streamId: string, message: MessageEntity, label: string,
): MyToolType[] {
    return [
        {
            info: { group: 'web', isActive: true, isInteractive: false, label: 'Web検索', },
            definition: {
                type: 'function', function: {
                    name: 'web_search',
                    description: `web検索を行う。`,
                    parameters: {
                        type: 'object',
                        properties: {
                            query: { type: 'string', description: '検索クエリ' },
                            num: { type: 'number', description: '検索結果の最大数', default: 30 },
                            // loadContentType: { type: 'string', description: `コンテンツの読込タイプ（'NONE'/'MARKDOWN'/'TEXT'）`, default: 'NONE' }, // HTML形式はバーストしがちなので消した。
                        },
                        required: ['query']
                    }
                }
            },
            handler: async (args: { query: string, num?: number, loadContentType?: 'NONE' | 'HTML' | 'MARKDOWN' | 'TEXT' }): Promise<{ title: string, link: string, snippet?: string, body?: string }[]> => {
                const { query, num = 10, loadContentType = 'NONE' } = args;
                const GOOGLE_CUSTOM_SEARCH_API_KEY = process.env.GOOGLE_CUSTOM_SEARCH_API_KEY || '';
                const GOOGLE_CSE_ID = process.env.GOOGLE_CSE_ID || '';

                // 10件ずつ分割してリクエストするための処理
                const maxResultsPerRequest = 10; // Google APIの制限
                const totalRequests = Math.min(Math.ceil(num / maxResultsPerRequest), 100); // 最大100リクエストまで
                let allItems: any[] = [];

                for (let i = 0; i < totalRequests; i++) {
                    // 何件目から取得するか (1-indexed)
                    const start = i * maxResultsPerRequest + 1;

                    // 残りの取得件数が10件未満の場合は残り件数だけリクエスト
                    const currentNum = Math.min(maxResultsPerRequest, num - (i * maxResultsPerRequest));

                    if (currentNum <= 0) break; // 既に必要な件数を取得済みの場合

                    const url = `https://www.googleapis.com/customsearch/v1?key=${encodeURIComponent(GOOGLE_CUSTOM_SEARCH_API_KEY)}&cx=${encodeURIComponent(GOOGLE_CSE_ID)}&q=${encodeURIComponent(query)}&num=${currentNum}&start=${start}`;
                    console.log(`Google Custom Search API URL (${i + 1}/${totalRequests}): ${url}`);

                    try {
                        const response = await (await getAxios(url)).get<CustomSearchResponse>(url);
                        const items = response.data.items || [];
                        allItems = [...allItems, ...items];

                        // 検索結果が期待より少ない場合は早期終了
                        if (!items.length || items.length < currentNum) {
                            console.log(`Received fewer results than requested (${items.length}/${currentNum}). Stopping pagination.`);
                            break;
                        }
                    } catch (error) {
                        console.error(`Error fetching search results for batch ${i + 1}:`, error);
                        break; // エラーが発生した場合はループを中断
                    }
                }

                // 指定された件数に制限
                allItems = allItems.slice(0, num);

                if (loadContentType === 'NONE' || loadContentType.toUpperCase() === 'NONE') {
                    return allItems.map(item => ({ title: item.title, snippet: item.snippet, link: item.link, }));
                } else {
                    const browser = await getPuppeteer();
                    const res = await Promise.all(allItems.map(async item => {
                        try {
                            const html = await fetchRenderedText(browser, item.link, loadContentType);
                            return { title: item.title, snippet: item.snippet, link: item.link, favicon: html.favicon, body: html.body };
                        } catch (error) {
                            console.log('fetchRenderedTextError');
                            console.error(error);
                            return { title: item.title, snippet: item.snippet, link: item.link, favicon: '', body: Utils.errorFormat(error) };
                        }
                    }));
                    await browser.close();
                    return res;
                }
            },
        },
        {
            info: { group: 'web', isActive: false, isInteractive: false, label: 'Web検索エージェント', },
            definition: {
                type: 'function', function: {
                    name: 'web_search_and_get_summary',
                    description: `web検索して対象ページのサマリを取得する`,
                    parameters: {
                        type: 'object',
                        properties: {
                            query: { type: 'string', description: '検索クエリ' },
                            num: { type: 'number', description: '検索結果の最大数', default: 30 },
                            loadContentType: { type: 'string', description: `コンテンツの読込タイプ（'SNIPPET':検索にヒットしたスニペットのみ。情報が少ないので速い。/'BODY':コンテンツの要約を取得する）`, default: 'SNIPPET' },
                            userPrompt: { type: 'string', description: 'htmlをAIに処理させる際のプロンプト。「情報の粒度・対象範囲」等を必要に応じて指定してください。', default: 'テキストに変換してください。文量が多すぎる場合は文意を損なわない程度に要約してもよいです。' },
                        },
                        required: ['query']
                    }
                }
            },
            handler: async (args: { query: string, num?: number, loadContentType: 'SNIPPET' | 'BODY', userPrompt?: string }): Promise<unknown[]> => {
                const { query, num = 30, loadContentType = 'SNIPPET', userPrompt = 'テキストに変換してください。文量が多すぎる場合は文意を損なわない程度に要約してもよいです。' } = args;
                const GOOGLE_CUSTOM_SEARCH_API_KEY = process.env.GOOGLE_CUSTOM_SEARCH_API_KEY || '';
                const GOOGLE_CSE_ID = process.env.GOOGLE_CSE_ID || '';

                const systemPrompt = 'アシスタントAI';
                const model = 'gemini-2.5-flash';
                const aiProvider = (await getAIProvider(req.info.user, model));

                // 10件ずつ分割してリクエストするための処理
                const maxResultsPerRequest = 10; // Google APIの制限
                const totalRequests = Math.min(Math.ceil(num / maxResultsPerRequest), 100); // 最大100リクエストまで
                let allItems: any[] = [];

                for (let i = 0; i < totalRequests; i++) {
                    // 何件目から取得するか (1-indexed)
                    const start = i * maxResultsPerRequest + 1;

                    // 残りの取得件数が10件未満の場合は残り件数だけリクエスト
                    const currentNum = Math.min(maxResultsPerRequest, num - (i * maxResultsPerRequest));

                    if (currentNum <= 0) break; // 既に必要な件数を取得済みの場合

                    const url = `https://www.googleapis.com/customsearch/v1?key=${encodeURIComponent(GOOGLE_CUSTOM_SEARCH_API_KEY)}&cx=${encodeURIComponent(GOOGLE_CSE_ID)}&q=${encodeURIComponent(query)}&num=${currentNum}&start=${start}`;
                    console.log(`Google Custom Search API URL (${i + 1}/${totalRequests}): ${url}`);

                    try {
                        const response = await (await getAxios(url)).get<CustomSearchResponse>(url);
                        const items = response.data.items || [];
                        allItems = [...allItems, ...items];

                        // 検索結果が期待より少ない場合は早期終了
                        if (!items.length || items.length < currentNum) {
                            console.log(`Received fewer results than requested (${items.length}/${currentNum}). Stopping pagination.`);
                            break;
                        }
                    } catch (error) {
                        console.error(`Error fetching search results for batch ${i + 1}:`, error);
                        break; // エラーが発生した場合はループを中断
                    }
                }

                // 指定された件数に制限
                allItems = allItems.slice(0, num);

                if (loadContentType === 'SNIPPET' || loadContentType.toUpperCase() === 'SNIPPET') {
                    return allItems.map(item => ({ title: item.title, snippet: item.snippet, link: item.link, }));
                } else { }

                const browser = await getPuppeteer();
                const tasks = allItems.map((item, index) =>
                    puppeteerLimiter.executeWithRetry(async () => {
                        try {
                            const html = await fetchRenderedText(browser, item.link, 'HTML');
                            const sanitizedBody = sanitizeHTML(html.body);

                            const inDto = Utils.deepCopyOmitting(obj.inDto, 'aiProviderClient');
                            inDto.args.model = model || inDto.args.model;

                            inDto.args.messages = [
                                { role: 'system', content: [{ type: 'text', text: systemPrompt }] },
                                {
                                    role: 'user', content: [
                                        { type: 'text', text: userPrompt },
                                        html.type === 'PDF'
                                            ? { type: 'image_url', image_url: { url: html.body } }
                                            : { type: 'text', text: `\`\`\`html ${item.link}\n${sanitizedBody}\n\`\`\`` },
                                    ],
                                },
                            ];

                            delete inDto.args.tool_choice;
                            delete inDto.args.tools;

                            const newLabel = `${label}-call_ai`;

                            // ヒストリー保存
                            const history = new PredictHistoryWrapperEntity();
                            history.orgKey = req.info.user.orgKey;
                            history.connectionId = connectionId;
                            history.streamId = streamId;
                            history.messageId = message.id;
                            history.label = newLabel;
                            history.model = inDto.args.model;
                            history.provider = aiProvider.type;
                            history.createdBy = req.info.user.id;
                            history.updatedBy = req.info.user.id;
                            history.createdIp = req.info.ip;
                            history.updatedIp = req.info.ip;
                            await ds.getRepository(PredictHistoryWrapperEntity).save(history);

                            return new Promise((resolve, reject) => {
                                let text = '';
                                aiApi.chatCompletionObservableStream(
                                    inDto.args, { label: newLabel }, aiProvider,
                                ).pipe(
                                    map(res => res.choices.map(choice => choice.delta.content).join('')),
                                    toArray(),
                                    map(res => res.join('')),
                                ).subscribe({
                                    next: next => {
                                        text += next;
                                    },
                                    error: error => {
                                        reject(error);
                                    },
                                    complete: () => {
                                        resolve({ title: item.title, snippet: item.snippet, link: item.link, favicon: html.favicon, body: text });
                                    },
                                });
                            });
                        } catch (error) {
                            console.log(`fetchRenderedTextError for ${item.link}`);
                            console.error(error);
                            return { title: item.title, snippet: item.snippet, link: item.link, favicon: '', body: Utils.errorFormat(error) };
                        }
                    })
                );

                // Promise.allSettledを使用して、一部が失敗しても他の処理を継続
                const results_raw = await Promise.allSettled(tasks);

                const res = results_raw.map((result, index) => {
                    if (result.status === 'fulfilled') {
                        return result.value;
                    } else {
                        console.error(`Task ${index} failed:`, result.reason);
                        // エラー時のフォールバック
                        return {
                            title: allItems[index].title,
                            snippet: allItems[index].snippet,
                            link: allItems[index].link,
                            favicon: '',
                            body: Utils.errorFormat(result.reason)
                        };
                    }
                });

                await browser.close();
                return res;
            },
        },
        {
            info: { group: 'web', isActive: false, isInteractive: false, label: 'Webページを開く（複数可）', },
            definition: {
                type: 'function', function: {
                    name: 'get_web_page_contents',
                    description: `Webページを開く。（複数可）`,
                    parameters: {
                        type: 'object',
                        properties: {
                            loadContentType: { type: 'string', description: `コンテンツの読込タイプ（'HTML'/'MARKDOWN'/'TEXT'）`, default: 'TEXT' },
                            urls: { type: 'array', description: 'URLの配列', items: { type: 'string' } },
                        },
                        required: ['urls']
                    }
                }
            },
            handler: async (args: { urls: string[], loadContentType: 'HTML' | 'MARKDOWN' | 'TEXT' }): Promise<{ title: string, url: string, body: string, favicon: string }[]> => {
                const { urls, loadContentType = 'TEXT' } = args;

                const browser = await getPuppeteer();
                const res = await Promise.all(urls.map(async url => {
                    try {
                        const html = await fetchRenderedText(browser, url, loadContentType);
                        return { title: html.title, url, body: html.body, favicon: html.favicon };
                    } catch (error) {
                        console.log('fetchRenderedTextError');
                        console.error(error);
                        return { title: 'error', url, body: Utils.errorFormat(error), favicon: '' };
                    }
                }));
                await browser.close();
                return res;
            },
        },
        {
            // TODO ファイル出力とかもできるようにしたい。主に画像だけど。リンクをどっか経由で返しておけばいいカナ的な。
            info: { group: 'command', isActive: true, isInteractive: false, label: 'Pythonコード実行', responseType: 'markdown' },
            definition: {
                type: 'function',
                function: {
                    name: 'run_python_code',
                    description: 'Pythonコードを実行し、必要であればライブラリもインストールしてから実行する。',
                    parameters: {
                        type: 'object',
                        properties: {
                            codeSet: {
                                type: 'array',
                                description: 'Pythonコードの配列。複数行のコードを実行する場合は、配列で渡すこと。',
                                items: {
                                    type: 'object',
                                    properties: {
                                        fullpath: { type: 'string', description: 'Pythonコードのフルパス', default: 'script.py' },
                                        code: { type: 'string', description: '実行するPythonコード' },
                                    },
                                    required: ['code']
                                }
                            },
                            entryPoint: { type: 'string', description: 'エントリーポイントのフルパス', default: 'script.py' },
                            requirements: {
                                type: 'array',
                                description: '必要なPythonライブラリ（pip installする）',
                                items: { type: 'string' },
                                default: []
                            },
                            pythonVersion: { type: 'string', description: 'Pythonのバージョン', default: '3.11' },
                        },
                        required: ['codeSet']
                    }
                }
            },
            handler: async (args: { codeSet: { code: string, fullpath?: string }[], entryPoint?: string, requirements?: string[], pythonVersion?: string }): Promise<string> => {
                const { codeSet, entryPoint = 'script.py', requirements = [], pythonVersion = '3.11' } = args;
                const execAsync = promisify(exec);

                // 一時ディレクトリのパス（tryブロックの外で定義）
                const uniqueId = randomUUID();
                const tmpDir = path.join(os.tmpdir(), `py-docker-${uniqueId}`);
                const formatter = (obj: { stdout: string, stderr: string }) => {
                    let stdoutType = 'text';
                    if (obj.stdout.startsWith('<?xml version="1.0" encoding="utf-8" standalone="no"?>') && obj.stdout.includes('<svg')) {
                        stdoutType = 'svg';
                    } else { }
                    return Utils.trimLines(`
                        # stdout
                        
                        \`\`\`${stdoutType}
                        ${obj.stdout}
                        \`\`\`
    
                        # stderr
                        \`\`\`text
                        ${obj.stderr}
                        \`\`\`
                    `);
                };

                try {
                    // プラットフォームの検出
                    const isWindows = os.platform() === 'win32';

                    // 一時ディレクトリの作成
                    await fs.mkdir(tmpDir, { recursive: true });

                    let isEntryPointExists = false;
                    try {
                        // Pythonスクリプトファイルの作成
                        for (const codeObj of codeSet) {
                            const { code, fullpath } = codeObj;
                            isEntryPointExists = isEntryPointExists || (fullpath === entryPoint);
                            const scriptPath = path.join(tmpDir, fullpath || 'script.py');
                            // console.log(`Writing Python script to: ${scriptPath}`);
                            // TODO インデント無視しちゃってるからダメだと思う。本当はmatplotのshowをオーバーライドしてしまうのが正攻法だとは思う。
                            await fs.writeFile(scriptPath, code.replaceAll(/plt.show\(\)/g, Utils.trimLines(`
                            # SVG形式でバイト列として保存
                            from io import BytesIO
                            buf = BytesIO()
                            plt.savefig(buf, format='svg')
                            buf.seek(0)

                            # 標準出力に書き込み
                            svg_content = buf.getvalue().decode('utf-8')
                            # print(svg_content)

                            # plt.show()の代わりに使用
                            plt.close()
                        `)));
                        }
                    } catch {
                        return formatter({
                            stdout: '',
                            stderr: '入力引数の型が不正です。codeSetは配列で、各要素はオブジェクトである必要があります。',
                        });
                    }

                    // エントリーポイントのフルパス
                    const scriptPath = path.join(tmpDir, isEntryPointExists ? entryPoint : codeSet[0].fullpath || 'script.py');
                    // console.log(`Entry point script path: ${scriptPath}`);

                    // 必要に応じて、requirements.txtファイルも作成
                    if (requirements.length > 0) {
                        const requirementsPath = path.join(tmpDir, 'requirements.txt');
                        // console.log(`Writing requirements to: ${requirementsPath}`);
                        await fs.writeFile(requirementsPath, requirements.join('\n'));
                    }

                    let command = '';
                    if (isWindows) {
                        // console.log('Running on Windows');
                        // Windows環境ではバッチファイルを使用
                        const batchPath = path.join(tmpDir, 'run.bat');
                        const batchContent = Utils.trimLines(`
                            @echo off
                            ${requirements.length > 0 ? `pip install -r "${path.join(tmpDir, 'requirements.txt')}" > nul 2>&1` : ''}
                            set PYTHONPATH=%PYTHONPATH%;${tmpDir}
                            python "${scriptPath}"
                        `);
                        // console.log(`Writing batch file to: ${batchPath}`);
                        // console.log(batchContent);
                        await fs.writeFile(batchPath, batchContent);

                        // バッチファイルを実行
                        command = `cmd /c "${batchPath}"`;
                    } else {
                        // Linux環境ではDockerを使用
                        const shellScriptPath = path.join(tmpDir, 'run.sh');
                        const shellScriptContent = Utils.trimLines(`
                            #!/bin/bash
                            set -e
                            ${requirements.length > 0 ? 'pip install -r /app/requirements.txt > /dev/null' : ''}
                            python /app/script.py
                        `);
                        await fs.writeFile(shellScriptPath, shellScriptContent);
                        await execAsync(`chmod +x "${shellScriptPath}"`);

                        // Dockerでコンテナを実行
                        command = `docker run --rm -v "${tmpDir}:/app" python:${pythonVersion}-slim /app/run.sh`;
                    }
                    // console.log(`Executing command: ${command}`);
                    // console.log(`Python version: ${pythonVersion}`);
                    // console.log(`Requirements: ${requirements.join(', ')}`);
                    // console.log(`Script path: ${scriptPath}`);
                    // console.log(`Entry point: ${entryPoint}`);
                    // console.log(`Requirements path: ${path.join(tmpDir, 'requirements.txt')}`);
                    // console.log(`Code:\n${codeSet.map(codeObj => codeObj.code).join('\n')}`);
                    // console.log(`Command: ${command}`);

                    // コマンドを実行
                    const result = await execAsync(command, { cwd: tmpDir });
                    return formatter(result);
                } catch (error: any) {
                    console.error('Error executing Python code:', error);
                    // エラーが発生した場合、標準出力と標準エラーを返す
                    // console.error('stdout:', error.stdout);
                    return formatter({
                        stdout: error.stdout || '',
                        stderr: error.stderr || error.message || '実行時にエラーが発生しました',
                    });
                } finally {
                    // console.log(`Cleaning up temporary directory: ${tmpDir}`);
                    // 終了後に一時ディレクトリを削除
                    try {
                        // await fs.rm(tmpDir, { recursive: true, force: true });
                    } catch (err) {
                        console.error('一時ディレクトリの削除に失敗しました', err);
                    }
                }
            }
        },
        {
            info: { group: 'command', isActive: false, isInteractive: true, label: '要約', },
            definition: {
                type: 'function', function: {
                    name: 'summarize_text',
                    description: `文書を要約する。`,
                    parameters: {
                        type: 'object',
                        properties: {
                            text: { type: 'string', description: '要約対象のテキスト' },
                        },
                        required: ['text']
                    }
                }
            },
            handler: async (args: { text: string }): Promise<string> => {
                return Promise.resolve(`summarize_text: ${args.text}`);
            },
        },
        {
            info: { group: 'command', isActive: false, isInteractive: true, label: 'AI呼び出し', },
            definition: {
                type: 'function', function: {
                    name: 'call_ai',
                    description: `AIを呼び出す。AIモデル:\n${JSON.stringify(aiModels)}`,
                    parameters: {
                        type: 'object',
                        properties: {
                            systemPrompt: { type: 'string', description: 'AIに渡すシステムプロンプト', default: 'アシスタントAI' },
                            userPrompt: { type: 'string', description: 'AIに渡すユーザープロンプト' },
                            model: { type: 'string', description: `AIモデル:\n${JSON.stringify(aiModels)}`, enum: aiModels.map(m => m.model), default: aiModels[0].model },
                            // style: { type: 'string', description: '要約のスタイル。箇条書き、短文など', enum: ['short', 'bullet'] }
                        },
                        required: ['userPrompt']
                    }
                }
            },
            handler: async (args: { systemPrompt: string, userPrompt: string, model: string }): Promise<string> => {
                let { systemPrompt, userPrompt, model } = args;
                systemPrompt = systemPrompt || 'アシスタントAI';
                if (!userPrompt) {
                    throw new Error('User prompt is required.');
                } else { }

                const inDto = Utils.deepCopyOmitting(obj.inDto, 'aiProviderClient');
                inDto.args.model = model || inDto.args.model; // modelが指定されていない場合は元のモデルを使う
                inDto.args.messages = [
                    { role: 'system', content: [{ type: 'text', text: systemPrompt }] },
                    { role: 'user', content: [{ type: 'text', text: userPrompt }] },
                ];
                // toolは使わないので空にしておく
                delete inDto.args.tool_choice;
                delete inDto.args.tools;

                const aiProvider = await getAIProvider(req.info.user, inDto.args.model);

                const newLabel = `${label}-call_ai-${model}`;
                // レスポンス返した後にゆるりとヒストリーを更新しておく。
                const history = new PredictHistoryWrapperEntity();
                history.orgKey = req.info.user.orgKey;
                history.connectionId = connectionId;
                history.streamId = streamId;
                history.messageId = message.id;
                history.label = newLabel;
                history.model = inDto.args.model;
                history.provider = aiProvider.type;
                history.createdBy = req.info.user.id;
                history.updatedBy = req.info.user.id;
                history.createdIp = req.info.ip;
                history.updatedIp = req.info.ip;
                await ds.getRepository(PredictHistoryWrapperEntity).save(history);

                return new Promise((resolve, reject) => {
                    let text = '';
                    // console.log(`call_ai: model=${model}, userPrompt=${userPrompt}`);
                    aiApi.chatCompletionObservableStream(
                        inDto.args, { label: newLabel }, aiProvider,
                    ).pipe(
                        map(res => res.choices.map(choice => choice.delta.content).join('')),
                        toArray(),
                        map(res => res.join('')),
                    ).subscribe({
                        next: next => {
                            text += next;
                        },
                        error: error => {
                            reject(error);
                        },
                        complete: () => {
                            resolve(text);
                        },
                    });;
                });
            },
        },
        {
            info: { group: 'command', isActive: false, isInteractive: true, label: 'ユーザーへの確認', },
            definition: {
                type: 'function', function: {
                    name: 'command_confirm',
                    description: `ユーザーに現在の方針のまま進めてよいか確認する。`,
                    parameters: {
                        type: 'object',
                        properties: {
                            text: { type: 'string', description: '確認メッセージ' },
                        },
                        required: ['text']
                    }
                }
            },
            handler: async (args: { text: string }): Promise<string> => {
                return Promise.resolve(`confirm: ${args.text}`);
            },
        },
        {
            info: { group: 'all', isActive: false, isInteractive: true, label: '選択肢を提示', },
            definition: {
                type: 'function', function: {
                    name: 'promptForChoice',
                    description: 'ユーザーに選択肢を提示して選択させる',
                    parameters: {
                        type: 'object',
                        properties: {
                            options: {
                                type: 'array', description: '選択肢の配列',
                                items: {
                                    type: 'object',
                                    properties: {
                                        label: {
                                            type: 'string',
                                            description: '選択肢の表示ラベル'
                                        },
                                        value: {
                                            type: 'string',
                                            description: '選択時に返される値'
                                        }
                                    },
                                    required: ['label', 'value']
                                }
                            },
                        },
                        required: ['options']
                    }
                }
            },
            handler: (args: { options: { label: string, value: string }[] }): Promise<string> => {
                console.log('Prompting for choice with options:+------------------------56', args);
                const { options } = args;
                if (!options) {
                    console.log('Prompting for choice with options:+------------------------------------------------', args);
                    throw new Error('Options are required.');
                }
                console.log('Prompting for choice with options:', options);
                return Promise.resolve('dummy2');
            }
        } as MyToolType,
    ]
}

export interface ElasticsearchResponse {
    took: number;
    timed_out: boolean;
    _shards: {
        total: number;
        successful: number;
        skipped: number;
        failed: number;
    };
    hits: {
        total: {
            value: number;
            relation: string;
        };
        max_score: number;
        hits: Array<{
            _index: string;
            _id: string;
            _score: number;
            _source: {
                'ai.content': string;
                'ai.title': string;
                filetype: string;
                completion: string;
                sitename: string;
                click_count: number;
                label: string[];
                last_modified: string;
                url: string;
                content_length: string;
            };
            highlight: {
                'ai.content': string[];
                'ai.title': string[];
                title_ja: string[];
                content_ja: string[];
            };
        }>;
    };
}


export async function getOAuthAccountForTool(req: UserRequest, provider: string): Promise<{ e: ExtApiClient, oAuthAccount: OAuthAccountEntity, axiosWithAuth: AxiosInstance }> {
    const e = await getExtApiClient(req.info.user.orgKey, provider);
    const user_id = req.info.user.id;
    if (!user_id) {
        throw new Error('User ID is required.');
    }
    const oAuthAccount = await ds.getRepository(OAuthAccountEntity).findOneOrFail({
        where: { orgKey: req.info.user.orgKey, provider, userId: req.info.user.id },
    });
    let axiosWithAuth;
    if (provider.startsWith('mattermost')) {
        // Mattermostの場合はCookieを使う
        axiosWithAuth = await getAxios(e.uriBase);
        axiosWithAuth.defaults.headers.common['Authorization'] = `Bearer ${req.cookies.MMAUTHTOKEN}`
        axiosWithAuth.defaults.headers.post['X-Requested-With'] = 'XMLHttpRequest';
    } else {
        axiosWithAuth = await e.axiosWithAuth.then(g => g(req.info.user.id));
    }
    return { e, oAuthAccount, axiosWithAuth };
}


export function reform(obj: any, deleteProps: boolean = true): any {
    // null、undefined、0の場合はundefinedを返す
    if (obj === null || obj === undefined || (typeof obj === 'number' && obj === 0)) {
        return undefined;
    }

    // Dateオブジェクトの場合はフォーマット済みの文字列に変換
    if (obj instanceof Date) {
        return Utils.formatDate(obj);
    }

    // オブジェクトの場合
    if (typeof obj === 'object') {
        const keys = Object.keys(obj);

        // 各キーに対して処理
        for (const key of keys) {
            // アンダースコアで始まるキーは削除
            if (key.startsWith('_')) {
                delete obj[key];
                continue;
            }

            // '_at'で終わるキーの特別処理（日付関連）
            if ((key.toLowerCase().endsWith('_at') || key.toLowerCase().endsWith('time')) && typeof obj[key] === 'number') {
                // console.log(`key=${key}, value=${obj[key]}  ${typeof obj[key]}`);
                obj[key] = Utils.formatDate(new Date(obj[key]));
            } else {

                // 通常のプロパティの処理
                if (obj[key] && typeof obj[key] === 'object' && Object.keys(obj[key]).length === 0 && deleteProps) {
                    delete obj[key];
                } else {

                    // 配列の場合
                    if (Array.isArray(obj[key])) {
                        if (obj[key].length > 5) {
                            // キーが全アイテムで一致していたらkeysとdataに分離してデータ圧縮する。
                            // const keys = Object.keys(obj[key][0]);
                            const keySet: Set<string> = new Set<string>();
                            let flag = false;
                            for (let i = 0; i < obj[key].length; i++) {
                                if (Array.isArray(obj[key][i])) {
                                    obj[key] = reform(obj[key]);
                                } else if (typeof obj[key][i] === 'object' && obj[key][i]) {
                                    flag = true;
                                    Object.keys(obj[key][i]).forEach(subKey => {
                                        if (Array.isArray(obj[key][i][subKey]) && obj[key][i][subKey].length === 0) {
                                        } else if (typeof obj[key][i][subKey] === 'object' && Object.keys(obj[key][i][subKey]).length === 0) {
                                        } else if (obj[key][i][subKey] === undefined || obj[key][i][subKey] === null || obj[key][i][subKey] === '') {
                                        } else {
                                            keySet.add(subKey);
                                        }
                                    });
                                }
                            }
                            if (flag) {
                                const keys = Array.from(keySet);
                                const dateIndexes = keys.map((key, index) => ({ index, isDate: key.toLowerCase().endsWith('_at') || key.toLowerCase().endsWith('time') })).filter(m => m.isDate).map(m => m.index);
                                obj[key] = {
                                    keys,
                                    data: obj[key].map((rec: any) => keys.map((key, index) => {
                                        if (dateIndexes.includes(index) && typeof rec[key] === 'number') {
                                            rec[key] = Utils.formatDate(new Date(rec[key]));
                                        } else {
                                            reform(rec[key]);
                                        }
                                        return rec[key];
                                    })),
                                };
                            } else {
                                // console.log(`keysString=${keysString}`);
                            }
                        } else {
                            // 5件以下の場合は圧縮しない
                        }

                        if (obj[key].length === 0) {
                            delete obj[key];
                        }

                        // 各要素に対して再帰的に処理
                        for (let i = 0; i < obj[key].length; i++) {
                            obj[key][i] = reform(obj[key][i], deleteProps);
                        }
                    } else {

                        const processed = reform(obj[key], deleteProps);
                        if (
                            (processed === undefined || processed === null || processed === '' || (typeof processed === 'number' && processed === 0))
                            && deleteProps
                        ) {
                            delete obj[key];
                        } else {
                            if (processed === 'true') {
                                obj[key] = true;
                            } else if (processed === 'false') {
                                obj[key] = false;
                            } else {
                                obj[key] = processed;
                            }
                        }
                    }
                }
            }
        }

        // すべてのキーが削除された場合はundefinedを返す
        if (Object.keys(obj).length === 0 && deleteProps) {
            return undefined;
        }

        return obj;
    }

    // 文字列やその他の型はそのまま返す
    return obj;
}


interface CustomSearchResponse {
    kind: string;
    url: UrlInfo;
    queries: Queries;
    context: Context;
    searchInformation: SearchInformation;
    items?: SearchResult[];
}

interface UrlInfo {
    type: string;
    template: string;
}

interface Queries {
    request: QueryRequest[];
    nextPage?: QueryRequest[];
}

interface QueryRequest {
    title: string;
    totalResults: string;
    searchTerms: string;
    count: number;
    startIndex: number;
    inputEncoding: string;
    outputEncoding: string;
    safe: string;
    cx: string;
}

interface Context {
    title: string;
}

interface SearchInformation {
    searchTime: number;
    formattedSearchTime: string;
    totalResults: string;
    formattedTotalResults: string;
}

interface SearchResult {
    kind: string;
    title: string;
    htmlTitle: string;
    link: string;
    displayLink: string;
    snippet: string;
    htmlSnippet: string;
    formattedUrl: string;
    htmlFormattedUrl: string;
    pagemap?: PageMap;
}

interface PageMap {
    cse_thumbnail?: Thumbnail[];
    metatags?: MetaTag[];
    cse_image?: Image[];
}

interface Thumbnail {
    src: string;
    width: string;
    height: string;
}

interface MetaTag {
    [key: string]: string;
}

interface Image {
    src: string;
}

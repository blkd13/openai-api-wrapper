// npm install fs https-proxy-agent image-size openai ts-node

/**
 * オリジナルのライブラリ無しで動くやつ。
 * プレーンに試したいとき用。
 */
import * as fs from 'fs';
import sizeOf from 'image-size';
import { fileURLToPath } from 'url';

import OpenAI from 'openai';
import { Stream } from 'openai/streaming';
import { ProxyAgent } from 'undici';

const openai = new OpenAI({
    apiKey: process.env['OPENAI_API_KEY'],
    // baseOptions: { timeout: 1200000, Configuration: { timeout: 1200000 } },
});

const logdir = `prompts_and_responses/vision-plain`;

/**
 * メイン処理
 */
async function visRun(imagePathList: string[] = []) {
    const distinctArray: string[] = [];
    console.log(`${formatDate()} [step1] detect image`);
    return Promise.all(imagePathList.map((fileURI: string, index: number) => (openai.chat.completions.create({
        model: 'gpt-4-vision-preview',
        messages: [
            // AIビジネスの専門家
            { role: 'system', content: 'Experts in AI-related businesses' },
            {
                role: 'user',
                content: [
                    { type: 'text', text: 'List the names of the companies or the services listed in this image. output JSON format.{"nameList":[...]}' },
                    {
                        type: 'image_url',
                        image_url: {
                            url: path2ImageBase64(fileURI),
                            // detail: 'auto', // low/high/auto
                        },
                    },
                ],
            },
        ],
        stream: true,
        max_tokens: 4096, // max_tokensを指定しないと凄く短く終わる。
    } as OpenAI.ChatCompletionCreateParams, getProxiedOptions()))
        .withResponse()
        .then(response => streamProc((response.data as Stream<OpenAI.ChatCompletionChunk>).toReadableStream().getReader(), `${logdir}/company-list-${getFileName(imagePathList[index])}.json`))
    ))
        // ストリームを結合してファイルに出力する。
        .then(imageToTextResponseAll => {
            console.log(`${formatDate()} [step2] generate report`);
            // toArray()で配列になっているのをjoin()で文字列に戻すしてからJSON.parse()する。
            const nameListAry = imageToTextResponseAll.map((text: string) => (jsonParse(text) as { nameList: string[] }).nameList);
            // JSON.parse()したらnameListを取り出してflat()で配列を直列化する。
            const nameList = nameListAry.flat();
            // 直列化したものをSetに入れて重複を削除し、ソートも掛けておく。
            const sordUniqAry = [...new Set(nameList)].sort();
            // 大文字小文字を区別しないように小文字に変換した配列を作る。
            const sordUniqLowerAry = sordUniqAry.map((name: string) => name.toLowerCase());
            // 重複を削除した配列を作る。
            distinctArray.push(...sordUniqAry.filter((name: string, index: number) => sordUniqLowerAry.indexOf(name.toLowerCase()) === index));

            return Promise.all(
                distinctArray.map((targetName) => (openai.chat.completions.create({
                    model: 'gpt-4-turbo-preview',
                    messages: [
                        // AIビジネスの専門家
                        { role: 'system', content: 'Experts in AI-related businesses' },
                        {
                            role: 'user',
                            content: `AI関連の企業もしくはサービスである「${targetName}」について日本語で詳しくレポートしてください。知らない場合はその旨を回答してください。最新情報じゃなくてもよいです。`,
                        },
                    ],
                    // response_format: { type: 'json_object' },
                    stream: true,
                }, getProxiedOptions()))
                    .withResponse()
                    .then(response => streamProc(response.data.toReadableStream().getReader(), `${logdir}/company-report-${safeFileName(targetName)}.md`))
                ));
        })
        .then(targetReportAll => {
            // タイトルを付けてレポート形式にする。
            const reportList = targetReportAll.map((text: string, index: number) => `# ${distinctArray[index]}\n\n${text}`);
            // 全部まとめてファイルに出力する。
            const outputFileName = safeFileName(`${logdir}/company-report-${formatDate(new Date(), 'yyyyMMddHHmmssSSS')}.md`);
            fs.writeFileSync(outputFileName, reportList.join('\n\n---\n\n'));
        });
}

// ここから下はユーティリティ

// Uint8Arrayを文字列に変換
const decoder = new TextDecoder();

function getFileName(filePath: string): string {
    // パスの区切り文字によって分割
    const parts = filePath.split(/[/\\]/);
    // 配列の最後の要素（ファイル名）を取得
    return parts.pop() || '';
}

/**
 * 画像ファイルを読み込んでbase64のデータURL形式にする。
 */
function path2ImageBase64(filePath: string): string {
    const data = fs.readFileSync(filePath);
    const metaInfo = sizeOf(data);
    return `data:image/${metaInfo.type === 'jpg' ? 'jpeg' : metaInfo.type};base64,${data.toString('base64')}`;
}

/**
 * プロキシ設定済みのOptionsにする。
 * @param baseOptions 
 * @returns 
 */
function getProxiedOptions(baseOptions: OpenAI.RequestOptions = {}): OpenAI.RequestOptions {
    const options = JSON.parse(JSON.stringify(baseOptions));
    // proxy設定判定用オブジェクト
    const proxyObj: { [key: string]: string | undefined } = {
        httpProxy: process.env['http_proxy'] as string || undefined,
        httpsProxy: process.env['https_proxy'] as string || undefined,
    };
    // プロキシが設定されていたらhttAgentを設定する。
    if (Object.keys(proxyObj).filter(key => proxyObj[key]).length > 0) {
        // options.httpAgent = new HttpsProxyAgent(proxyObj.httpsProxy || proxyObj.httpProxy || '');
        if (proxyObj.httpsProxy || proxyObj.httpProxy) {
            options.fetchOptions = { dispatcher: new ProxyAgent(proxyObj.httpsProxy || proxyObj.httpProxy || '') };
        } else { }
    } else {/* 何もしない */ }
    options.stream = true;
    return options;
}

/**
 * Streamを処理する
 * @param reader 
 * @param outputPath 
 * @returns 
 */
async function streamProc(reader: ReadableStreamDefaultReader, outputPath: string): Promise<string> {
    let tokenBuilder: string = '';
    while (true) {
        const { value, done } = await reader.read();
        if (done) {
            // ストリームが終了したらループを抜ける
            console.log(`fine ${outputPath}`);
            console.log(`${formatDate()} stream proc fine ${outputPath}`);
            // ファイルに書き出す
            // fs.writeFileSync(`${HISTORY_DIRE}/${idempotencyKey}-${attempts}.result.json`, tokenBuilder || '');
            return tokenBuilder;
        }
        // 中身を取り出す
        const content = decoder.decode(value);
        // 中身がない場合はスキップ
        if (!content) { continue; }
        // トークン数をカウント
        const text = JSON.parse(content).choices[0].delta.content || '';
        tokenBuilder += text;
        fs.appendFileSync(outputPath, text);
    }
}

/**
 * Markdownのコードブロックを```を外したものにする。
 * @param {*} str 
 * @returns 
 */
function mdTrim(str0: string): string {
    if (str0.indexOf('```') < 0) { return str0; }
    else {
        let flg = false;
        return str0.split('\n').filter(line => {
            if (line.trim().startsWith('```')) {
                flg = !flg;
                return false;
            } else {
            }
            return flg;
        }).join('\n');
    }
}

/**
 * JSONが1行ずつに分割されていても読めるようにする
 * @param {*} str 
 * @returns 
 */
function jsonParse<T>(str: string, isSilent: boolean = false): T {
    let str0 = mdTrim(str).replace(/{"":"[^"]*"[,]{0,1}}/g, 'null').replace(/,}/g, '}');
    try {
        return jsonParse0(str0, true);
    } catch (e0) {
        // 末尾の括弧を外す（よくあるエラーなので）
        const str1 = str0.substring(0, str0.length - 1);
        try {
            return jsonParse0(str1, true);
        } catch (e1) {
            // 先頭に括弧補充
            const str2 = `{${str0}`;
            try {
                return jsonParse0(str2, true);
            } catch (e2) {
                // 先頭に括弧補充2
                const str3 = mdTrim(`\`\`\`json\n{${str}`).replace(/{"":"[^"]*"[,]{0,1}}/g, 'null').replace(/,}/g, '}');
                return jsonParse0(str3, isSilent);
            }
        }
    }
}
function jsonParse0<T>(str: string, isSilent: boolean = false): T {
    try {
        return JSON.parse(str);
    } catch (e0) {
        try {
            const mid = str.replace(/^ *{|} *$/gm, '').split('\n').filter(line => line.trim().length > 0).join(',');
            return JSON.parse(`{${mid}}`);
        } catch (e1) {
            try {
                const mid = JSON.parse(`[${str}]`);
                let sum = {};
                mid.forEach((obj: any) => {
                    // console.log(sum);
                    sum = { ...sum, ...obj };
                });
                return sum as any;
            } catch (e2) {
                if (isSilent) {
                    // silent
                } else {
                    console.log(e2);
                    console.log(`[${str}]`);
                }
                throw e2;
            }
        }
    }
}

/**
 * 日付をフォーマットする関数
 * 
 * @param date フォーマットする日付
 * @param format フォーマット
 * @returns フォーマットされた文字列
 */
function formatDate(date: Date = new Date(), format: string = 'yyyy/MM/dd HH:mm:ss.SSS') {
    format = format.replace(/yyyy/g, '' + date.getFullYear());
    format = format.replace(/MM/g, ('0' + (date.getMonth() + 1)).slice(-2));
    format = format.replace(/dd/g, ('0' + date.getDate()).slice(-2));
    format = format.replace(/HH/g, ('0' + date.getHours()).slice(-2));
    format = format.replace(/mm/g, ('0' + date.getMinutes()).slice(-2));
    format = format.replace(/ss/g, ('0' + date.getSeconds()).slice(-2));
    format = format.replace(/SSS/g, ('00' + date.getMilliseconds()).slice(-3));
    return format;
}

/**
 * ファイル名に使えない文字を置換する
 * @param fileName
 * @returns 
 */
function safeFileName(fileName: string) {
    return fileName.replace(/[\\/:*?"<>|]/g, '_');
}

async function main() {
    // 結果ディレクトリを掘っとく。
    fs.mkdirSync('./result');

    // 画像ファイル群を指定して実行
    await visRun([
        'assets/ai-business-experts.png',
    ]);
}

/**
 * このファイルが直接実行された場合のコード。
 */
if (fileURLToPath(import.meta.url) === process.argv[1]) {
    main();
} else {
    // main実行じゃなかったら何もしない
}

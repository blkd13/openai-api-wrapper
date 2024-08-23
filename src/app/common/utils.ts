/**
 * Utilsクラスは、共通のユーティリティメソッドを提供するためのクラスです。
 */
export class Utils {

    /**
     * 文字列を kebab-case ケースに変換する関数
     * @param str - ケース変換する文字列
     * @returns kebab-case ケースに変換された文字列
     */
    static toKebabCase(str: string): string {
        return Utils.toCamelCase(str).replace(/[A-Z]/g, match => `-${match.toLowerCase()}`).replace(/^-/g, '');
    }

    /**
     * 文字列を snake_case に変換する関数
     * @param str - ケース変換する文字列
     * @returns snake_case に変換された文字列
     */
    static toSnakeCase(str: string): string {
        return Utils.toKebabCase(str).replace(/-/g, '_');
    }

    /**
     * 文字列を camelCase に変換する関数
     * @param str - ケース変換する文字列
     * @returns camelCase ケースに変換された文字列
     */
    static toCamelCase(str: string): string {
        return Utils.toAscii(str, true);
    }

    /**
     * 文字列を PascalCase ケースに変換する関数
     * @param str - ケース変換する文字列
     * @returns PascalCase に変換された文字列
     */
    static toPascalCase(str: string): string {
        return Utils.toAscii(str, false);
    }

    /**
     * 文字列を ASCII に変換する関数
     * @param str - ケース変換する文字列
     * @param isCamel - CamelCaseに変換するかどうか
     * @returns ASCII に変換された文字列
     * @private
     */
    private static toAscii(str: string, isCamel: boolean = true): string {
        // 空白やアンダースコアを区切り文字として分割します
        const words = str.split(/[-\s_]+/);
        // 分割された単語をCamelCaseに変換します
        const camelCaseWords = words.map((word: string, index: number) => {
            // 2番目以降の単語は先頭を大文字にして連結します
            const tail = word.slice(1);
            if (tail.match(/^[A-Z0-9]*$/g)) {
                // 2番目以降の単語がすべて大文字の場合は小文字にします
                word = word.toLowerCase();
            } else {
                // 混在する場合はそのままにします
                // console.log(`MIXED:${tail}`);
            }
            return (index === 0 && isCamel ? word.charAt(0).toLowerCase() : word.charAt(0).toUpperCase()) + word.slice(1);
        });
        // CamelCaseの文字列に変換して返します
        return camelCaseWords.join("");
    }

    /**
     * 文字列の最初の文字を大文字に変換する関数
     * @param str - 大文字に変換する文字列
     * @returns 大文字に変換された文字列
     */
    static capitalize(str: string) {
        return str.charAt(0).toUpperCase() + str.slice(1);
    }

    /**
     * 文字列の最初の文字を小文字に変換する関数
     * @param str - 小文字に変換する文字列
     * @returns 小文字に変換された文字列
     */
    static decapitalize(str: string) {
        return str.charAt(0).toLowerCase() + str.slice(1);
    }

    /**
     * TypeScriptコードを整形する関数
     * @param code - 整形するTypeScriptコード
     * @returns 整形されたTypeScriptコード
     */
    static tsForm(code: string) {
        const lines = code.replace(/\r/g, '').split("\n");
        const result = lines.map((line, index) => {
            if (index === lines.length - 1 || line.endsWith(";")) {
                return line.trim() + '\n'; // 行末が;で終わる行または最後の行はそのまま返す
            } else {
                return line.trim(); // 行頭と行末のスペースを削除する
            }
        }).join("");
        return result;
    }

    /**
     * スペースを正規化する関数
     * 
     * @param str 正規化する文字列
     * @returns 正規化された文字列
     */
    static spaceNormalize(str: string): string {
        const lines = str.split("\n"); // 改行コードで分割
        const result = lines.map(line => {
            const matches = line.match(/^(\s*)(\S+(?:\s+\S+)*)\s*$/); // 行頭のスペースと行末のスペースを取り出す
            if (!matches || matches.length < 3) { return line; }
            const indent = matches[1]; // 行頭のスペース
            const words = matches[2].replace(/\s+/g, " "); // スペースの連続を1つのスペースに置換
            return indent + words;
        }).join("\n"); // 改行コードで結合
        return result;
    }

    /**
     * 日付をフォーマットする関数
     * 
     * @param date フォーマットする日付
     * @param format フォーマット
     * @returns フォーマットされた文字列
     */
    static formatDate(date: Date = new Date(), format: string = 'yyyy/MM/dd HH:mm:ss.SSS') {
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
     * 配列を指定されたサイズごとに分割する関数
     * 
     * @param arr 分割する配列
     * @param chunkSize 一つの配列のサイズ
     * @returns 分割された配列
     */
    static toChunkArray(arr: any[], chunkSize: number): any[][] {
        return arr.reduce((acc, _, i) => {
            if (i % chunkSize === 0) acc.push(arr.slice(i, i + chunkSize));
            return acc;
        }, []);
    }

    /**
     * JSONを安全にstringifyする関数を生成する
     */
    static genJsonSafer(): any {
        const cache = new Set();
        return (key: string, value: any) => {
            if (typeof value === "object" && value !== null) {
                if (cache.has(value)) {
                    return null;
                } else {
                    // 
                }
                cache.add(value);
            } else {
                // 
            }
            return value;
        }
    }

    static trimExceptTabs(str: string): string {
        // 先頭と末尾の半角スペースと改行を削除（タブと全角スペースは残る）
        return str.replace(/^[ \r\n]+|[ \r\n]+$/g, '');
    }
    static trimStartExceptTabs(str: string): string {
        // 先頭の半角スペースと改行を削除（タブと全角スペースは残る）
        return str.replace(/^[ \r\n]+/g, '');
    }
    static trimEndExceptTabs(str: string): string {
        // 末尾の半角スペースと改行を削除（タブと全角スペースは残る）
        return str.replace(/[ \r\n]+$/g, '');
    }

    static TRIM_LINES_DELETE_LINE = 'XXXX_TRIM_LINES_DELETE_LINE_XXXX'; // この文字列が含まれている行は削除する
    /**
     * インデントを削除する
     * @param {string} str 
     * @returns {string}
     */
    static trimLines(str: string): string {
        const list = str.split('\n');
        const line = list.find((line, index) => Utils.trimExceptTabs(line).length > 0);
        if (line) { } else { return str; }
        const indent = line.length - Utils.trimStartExceptTabs(line).length;
        if (indent === 0) { return str; }
        const regex = new RegExp(`^ {${indent}}`, 'g');
        return Utils.trimExceptTabs(list.filter(line => !line.includes(Utils.TRIM_LINES_DELETE_LINE)).map(line => line.replace(regex, '')).join('\n'));
    }

    /**
     * JSONが1行ずつに分割されていても読めるようにする
     * @param {*} str 
     * @returns 
     */
    static jsonParse<T>(str: string, isSilent: boolean = false): T {
        let str0 = Utils.mdTrim(str).replace(/{"":"[^"]*"[,]{0,1}}/g, 'null').replace(/,}/g, '}');
        try {
            return Utils.jsonParse0(str0, true);
        } catch (e0) {
            // 末尾の括弧を外す（よくあるエラーなので）
            const str1 = str0.substring(0, str0.length - 1);
            try {
                return Utils.jsonParse0(str1, true);
            } catch (e1) {
                // 先頭に括弧補充
                const str2 = `{${str0}`;
                try {
                    return Utils.jsonParse0(str2, true);
                } catch (e2) {
                    // 先頭に括弧補充2
                    const str3 = Utils.mdTrim(`\`\`\`json\n{${str}`).replace(/{"":"[^"]*"[,]{0,1}}/g, 'null').replace(/,}/g, '}');
                    return Utils.jsonParse0(str3, isSilent);
                }
            }
        }
    }
    static jsonParse0<T>(str: string, isSilent: boolean = false): T {
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
     * Markdownのコードブロックを```を外したものにする。
     * @param {*} str 
     * @returns 
     */
    static mdTrim(str0: string): string {
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
     * Markdown がコードブロックを含むかどうかにかかわらず、
     * 最初のコードと思われれるものを返す。
     * @param str0 
     * @returns 
     */
    static mdFirstCode(str0: string): string {
        const codeBlocks = Utils.mdCodeBlockSpilt(str0);
        if (codeBlocks.length > 1) {
            // コードブロックがある場合は最初のコードブロックを返す
            return codeBlocks.find(obj => obj.brackets.length > 0)?.body || '';
        } else if (codeBlocks.length === 0) {
            console.log(str0);
            return str0;
        } else {
            // コードブロック分割されていない場合はそのまま返す
            // console.log(JSON.stringify(codeBlocks));
            return codeBlocks[0].body;
        }
    }

    /**
     * Markdownのコードブロックを```を外した配列にする
     * @param {*} str 
     * @returns 
     */
    static mdCodeBlockSpilt(str0: string): { brackets: string[], body: string }[] {
        const lines = str0.split('\n');
        const res = [];
        let block: { brackets: string[], body: string[] } = { brackets: [], body: [] };
        for (let idx = 0; idx < lines.length; idx++) {
            if (lines[idx].trim().startsWith('```')) {
                if (block.brackets.length === 0) {
                    // コードブロックの開始
                    // これまでのものをストックに入れて、コードブロックの中用の新しいオブジェクトを作る。
                    res.push(block);
                    block = { brackets: [], body: [] };
                    block.brackets.push(lines[idx]);
                } else {
                    // コードブロックの終了
                    // これまでのものをストックに入れて、コードブロックの外用の新しいオブジェクトを作る。
                    block.brackets.push(lines[idx]);
                    res.push(block);
                    block = { brackets: [], body: [] };
                }
            } else if (block.brackets.length > 0) {
                // コードブロックの中
                block.body.push(lines[idx]);
            } else {
                // コードブロックの外
                block.body.push(lines[idx]);
            }
        }
        if (block.body.length > 0 || block.brackets.length > 0) {
            res.push(block);
        } else { }
        return res
            .filter(obj => obj.body.length > 0 || obj.brackets.length > 0) // 中身が全くないものは除外する。
            .map(obj => ({ brackets: obj.brackets, body: obj.body.join('\n') }));
    }


    /**
     * 文字列リテラルやコメントブロックと、通常のコード部分を選り分けたうえで、
     * 通常のコード部分をスペースなどで分割する。
     */
    static escapedTokenize(str0: string, escapeSet: string[][] = [['"', '"'], ["'", "'"], ['//', '\n'], ['/*', '*/']], splitter: RegExp = / +/g): string[] {
        const ret: string[] = [];
        Utils.escapeBlockSpilt(str0, escapeSet).forEach(block => {
            if (block.brackets.length > 0) {
                // 括弧付きの場合は括弧を結合する。
                ret.push([block.brackets[0], block.body, block.brackets[1] || ''].join(''));
            } else {
                // 通常コードの場合はスプリッター展開
                ret.push(...block.body.split(splitter));
            }
        });
        return ret;
    }

    /**
     * 文字列リテラルやコメントブロックと、通常のコード部分を選り分ける。
     * @param {*} str 
     * @param {*} escapeSet
     * @returns 
     */
    static escapeBlockSpilt(str0: string, escapeSet: string[][] = [['"', '"'], ["'", "'"], ['//', '\n'], ['/*', '*/']]): { brackets: string[], body: string }[] {
        const n = str0.length;
        let escapeType = -1;
        let currBlockStartIndex = 0;
        let res = [];
        // console.log(str0);
        for (let idx = 0; idx < n; idx++) {
            // バックスラッシュがあったら問答無用で1文字飛ばす
            // console.log(str0[idx]);
            if (str0[idx] === '\\') { idx++; continue; } else { }

            if (escapeType === -1) {
                // エスケープ外。エスケープ開始文字と一致するかをチェックする。
                for (let iEscape = 0; iEscape < escapeSet.length; iEscape++) {
                    const escapeStartChar = escapeSet[iEscape][0];
                    // console.log(idx + '[s]:' + escapeStartChar + ':' + str0.substring(idx, idx + escapeStartChar.length))
                    if (escapeStartChar === str0.substring(idx, idx + escapeStartChar.length)) {
                        // 通常コード部分をブロックとして保存する
                        res.push({ brackets: [], body: str0.substring(currBlockStartIndex, idx) });

                        // エスケープ終了文字分だけカーソルを動かす
                        currBlockStartIndex = idx + escapeStartChar.length;
                        idx = currBlockStartIndex - 1; // idxはforループで1インクリメントされるので-1しておく
                        escapeType = iEscape;
                        break;
                    } else { }
                }
            } else {
                const escapeEndChar = escapeSet[escapeType][1];
                // console.log(idx + '[e]:' + escapeEndChar + ':' + str0.substring(idx, idx + escapeEndChar.length))
                // エスケープ中。エスケープ終了文字と一致するかをチェックする。
                if (escapeEndChar === str0.substring(idx, idx + escapeEndChar.length)) {
                    // エスケープ（文字列リテラル、コメント）コード部分をブロックとして保存する
                    res.push({ brackets: escapeSet[escapeType], body: str0.substring(currBlockStartIndex, idx) });

                    // エスケープ終了文字分だけカーソルを動かす
                    currBlockStartIndex = idx + escapeEndChar.length;
                    idx = currBlockStartIndex - 1; // idxはforループで1インクリメントされるので-1しておく
                    escapeType = -1;
                } else { }
            }
        }
        if (currBlockStartIndex < str0.length) {
            if (escapeType === -1) {
                res.push({ brackets: [], body: str0.substring(currBlockStartIndex, str0.length) });
            } else {
                // エスケープ開始文字が閉じられていないのでbracketsは片側だけ
                res.push({ brackets: [escapeSet[escapeType][0]], body: str0.substring(currBlockStartIndex, str0.length) });
            }
        } else { }
        return res;
    }

    // /**
    //  * Markdownのコードブロックを```を外したものにする。
    //  * @param {string} text - Markdown形式のテキスト
    //  * @returns {string} コメント形式に変換されたテキスト
    //  */
    // static mdCodeBlockToCode(text: string): string {
    //     let split = text.split(/```.*\n|```$/, -1);
    //     return split.map((code, index) => {
    //         if (code.length === 0) {
    //             return code;
    //         } else {
    //             if (index % 2 === 1) {
    //                 return code;
    //             } else {
    //                 return code.split('\n').map(line => `// ${line}`).join('\n');
    //             }
    //         }
    //     }).join('');
    // }

    static fillTemplate(data: { [key: string]: string }, template: string): string {
        return template.replace(/{{(\w+)}}/g, (match, key) => data[key] || "");
    }

    /**
     * ファイル名に使えない文字を置換する
     * @param fileName
     * @returns 
     */
    static safeFileName(fileName: string) {
        return fileName.replace(/[\\/:*?"<>|]/g, '_');
    }

    /**
     * path.basename相当。いちいちpathをインポートするのだるいから作った。
     * @param filepath 
     * @returns 
     */
    static basename(filepath: string): string {
        const parts = filepath.split(/\/|\\/);
        return parts[parts.length - 1];
    }

    /**
     * path.dirname相当。いちいちpathをインポートするのだるいから作った。
     * @param filepath 
     * @returns 
     */
    static dirname(filepath: string): string {
        if (filepath.endsWith('/') || filepath.endsWith('\\')) {
            // TODO ディレクトリの場合はそのまま返すべきかどうか結構悩む
        } else { }
        const fileChain = filepath.split(/\/|\\/);
        return fileChain.slice(0, fileChain.length - 1).join('/');
    }

    /**
     * UUIDを生成する
     * @returns {string}
     */
    static generateUUID(): string {
        let dt = new Date().getTime();
        const uuid = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
            const r = (dt + Math.random() * 16) % 16 | 0;
            dt = Math.floor(dt / 16);
            return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
        });
        return uuid;
    }

    static isUUID(uuid: string): boolean {
        const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[4][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
        return uuidRegex.test(uuid);
    }

    /**
     * Pythonのrangeのようなもの
     * @param start 
     * @param end 
     * @param step 
     */
    static *range(start: number, end?: number, step: number = 1): Generator<number> {
        // stepが0の場合は無限ループになるのでエラー
        if (step === 0) throw new Error('step cannot be 0');
        // endが指定されない場合はstartをendとして扱う
        if (end === undefined) [start, end] = [0, start];
        // stepが負の場合はstartとendを入れ替える
        if (step < 0) [start, end] = [end, start];
        // stepが正の場合はstartからendまでstepずつ増やしながらyieldする
        for (let i = start; i < end; i += step)  yield i;
    }

    /**
     * 配列をどんな次元のものでもフラットにする。
     * @param arr 
     * @returns 
     */
    static flatten(arr: any[]): any[] {
        return arr.reduce((acc, val) => Array.isArray(val) ? [...acc, ...Utils.flatten(val)] : [...acc, val], []);
    }

    /**
     * テンプレート文字列中の {{varName}} を変数で置換する。
     * ${varName}にしたいときは => \$\{([^}]+)\}
     * @param template 
     * @param variables 
     * @returns 
     */
    static replaceTemplateString(template: string, variables: { [key: string]: any }, patternString: string = '\{\{([^}]+)\}\}'): string {
        return template.replace(new RegExp(patternString, 'g'), (_, name) => {
            // console.log(name, variables);
            // ヒットしなかったら置換しない
            return variables[name] === null || variables[name] === undefined ? `{{${name}}}` : variables[name];
        });
    }

    /**
     * テンプレート文字列中の {{varName}} を変数で置換する。
     * ※変数がオブジェクトの場合はドットで区切って再帰的に置換する。
     * ${varName}にしたいときは => \$\{([^}]+)\}
     * @param template 
     * @param variables 
     * @returns 
     */
    static replaceTemplateStringDeep(template: string, variables: { [key: string]: any }, patternString: string = '\{\{([^}]+)\}\}'): string {
        return template.replace(new RegExp(patternString, 'g'), (_, name) => {
            const replace = name.split('.').reduce((acc: { [key: string]: any }, key: string) => {
                if (acc === null || acc === undefined) { return acc; }
                return acc[key];
            }, variables);
            // ヒットしなかったら置換しない
            return replace === null || replace === undefined ? `{{${name}}}` : replace;
        });
    }

    /**
     * jsonを適当に整形してmarkdownに変換する。
     * あんまりうまく行ってないのでライブラリ持ってきた方がいいかもしれない。
     * @param json 
     * @returns 
     */
    static jsonToMarkdown(json: any): string {
        const obj = Utils.jsonToMarkdown0(json, 0);
        // console.log(obj.list);
        let beforeLayer = 0;
        let arrayLayer = 0;
        const md = obj.list.map(obj => {
            let md = '';
            // 7階層以上のオブジェクトは配列に変換する
            // バグるので一旦やめる。けど7階層以上できてしまうので悩ましい。
            // if (obj.type === 'object' && obj.layer >= 6) { obj.type = 'array'; }

            if (obj.type === 'object') {
                md = `${'#'.repeat(obj.layer + 1)} ${obj.md}`;
                arrayLayer = 0;
            } else if (obj.type === 'array') {
                md = `${'  '.repeat(arrayLayer)}- ${obj.md}`;
                arrayLayer++;
            } else if (obj.type === 'literal') {
                if (beforeLayer > obj.layer) {
                    // ここに来ること自体が失敗。7階層以上をarrayにしようとするとやっぱり変になる。
                    arrayLayer = 0;
                } else { }
                md = `${'  '.repeat(arrayLayer)}- ${obj.md}`;
            } else {
                md = '';
            }
            beforeLayer = obj.layer;
            return md;
        }).join('\n');
        // console.log(md);
        return md;
    }
    protected static jsonToMarkdown0(json: any, layer: number): { md: string, hasBlock: boolean, list: { layer: number, type: 'object' | 'array' | 'literal', md: string }[] } {
        // console.log(JSON.stringify(json));
        const list: { layer: number, type: 'object' | 'array' | 'literal', md: string }[] = [];
        if (json === undefined || json === null) {
            return { md: '', hasBlock: false, list };
        } else if (Array.isArray(json)) {
            // オブジェクト型の場合
            // 途中にオブジェクト型が混ざるとリストの途中にブロックが入ってしまうので、一旦オブジェクトとリテラルを選り分けて、リテラルから先に処理する。
            const nullFilterd = json.filter(value => !(value === null || value === undefined));
            // console.log(nullFilterd);
            const objectKeyList = nullFilterd.filter(value => !Array.isArray(value) && typeof value === 'object');
            const arrayKeyList = nullFilterd.filter(value => Array.isArray(value));
            const literalKeyList = nullFilterd.filter(value => !(Array.isArray(value) || typeof value === 'object'));
            let hasBlock = false;
            [...literalKeyList, ...arrayKeyList, ...objectKeyList].forEach((value, index) => {
                if (value === null || value === undefined) {
                    // nullやundefinedは出力しない（keyごと削除）
                } else if (Array.isArray(value)) {
                    const obj = Utils.jsonToMarkdown0(value, layer + 1);
                    if (obj.hasBlock) {
                        hasBlock = true;
                        list.push({ layer, type: 'object', md: `${index}` });
                    } else {
                        list.push({ layer, type: 'array', md: `${index}` });
                    }
                    obj.list.forEach(obj => list.push(obj));
                } else if (typeof value === 'object') {
                    // オブジェクト型かつ子要素もオブジェクト型の場合はブロックとして表示する
                    const obj = Utils.jsonToMarkdown0(value, layer + 1);
                    if (obj.hasBlock) {
                        hasBlock = true;
                        list.push({ layer, type: 'object', md: `${index}` });
                    } else {
                        list.push({ layer, type: 'array', md: `${index}` });
                    }
                    obj.list.forEach(obj => list.push(obj));
                } else {
                    list.push({ layer, type: 'literal', md: `${index}: ${value}` });
                }
            });
            return { md: '', hasBlock, list };
        } else if (typeof json === 'object') {
            // オブジェクト型の場合
            // 途中にオブジェクト型が混ざるとリストの途中にブロックが入ってしまうので、一旦オブジェクトとリテラルを選り分けて、リテラルから先に処理する。
            const nullFilterd = Object.entries(json).filter(([key, value]) => !(value === null || value === undefined));
            const objectKeyList = nullFilterd.filter(([key, value]) => !Array.isArray(value) && typeof value === 'object').map(([key, value]) => key);
            const arrayKeyList = nullFilterd.filter(([key, value]) => Array.isArray(value)).map(([key, value]) => key);
            const literalKeyList = nullFilterd.filter(([key, value]) => !(Array.isArray(value) || typeof value === 'object')).map(([key, value]) => key);
            let hasBlock = false;
            [...literalKeyList, ...arrayKeyList, ...objectKeyList].forEach(key => {
                const value = json[key];
                if (value === null || value === undefined) {
                    // nullやundefinedは出力しない（keyごと削除）
                } else if (Array.isArray(value)) {
                    const obj = Utils.jsonToMarkdown0(value, layer + 1);
                    if (obj.hasBlock) {
                        hasBlock = true;
                        console.log(`array: ${key} ${list.length}`);
                        list.push({ layer, type: 'object', md: `${key}` });
                    } else {
                        list.push({ layer, type: 'array', md: `${key}` });
                    }
                    obj.list.forEach(obj => list.push(obj));
                } else if (typeof value === 'object') {
                    // オブジェクト型かつ子要素もオブジェクト型の場合はブロックとして表示する
                    const obj = Utils.jsonToMarkdown0(value, layer + 1);
                    hasBlock = true;
                    list.push({ layer, type: 'object', md: `${key}` });
                    obj.list.forEach(obj => list.push(obj));
                } else {
                    list.push({ layer, type: 'literal', md: `${key}: ${value}` });
                }
            });
            return { md: '', hasBlock, list };
        } else {
            list.push({ layer, type: 'literal', md: `${json}` });
            return { md: ``, hasBlock: false, list };
        }
    }

    /**
     * markdownのコードブロックを```で囲む。
     * @param {*} str
     * @returns
     */
    static setMarkdownBlock(text: string, blockType: string = ''): string {
        if (blockType === 'json') {
            if (text && (
                (text.startsWith('{') && text.endsWith('}'))
                || (text.startsWith('[') && text.endsWith(']'))
            )) {
                try {
                    JSON.stringify(JSON.parse(text));
                    return `\`\`\`${blockType}\n${text}\n\`\`\``;
                } catch (e) { /** json変換できないものはjson扱いにしない。 */ }
            } else { /** 最初と最後の文字で仮判定。 */ }
        } else {
        }
        return `\`\`\`${blockType}\n${text}\n\`\`\``;
    }

    /**
     * markdownの見出しのレベルを変更する。
     * @param {*} str
     * @returns
     */
    static addMarkdownDepth(text: string, num: number = 1): string {
        const add = '#'.repeat(num);
        let isCodeBlock = false;
        return text.split('\n').map(line => {
            if (line.startsWith('```')) {
                isCodeBlock = !isCodeBlock;
            } else {
            }
            if (isCodeBlock) {
                return line;
            } else {
                if (line.startsWith('#')) {
                    return `${add}${line}`;
                } else {
                    return line;
                }
            }
        }).join('\n');
    }

    static loadTableDataFromMarkdown(markdown: string, index = 0): { header: string[], data: string[][] } {
        const lines = markdown.split('\n');
        const header = [];
        const data: string[][] = [];
        for (let i = index; i < lines.length; i++) {
            const line = lines[i];
            if (line.startsWith('|')) {
                header.push(...line.split('|').filter((_, index) => index > 0 && index < line.split('|').length - 1).map(str => str.trim()));
                i++; // ヘッダーの次の行はスキップ
                for (let j = i + 1; j < lines.length; j++) {
                    const line = lines[j];
                    if (line.startsWith('|')) {
                        data.push(line.split('|').filter((_, index) => index > 0 && index < line.split('|').length - 1).map(str => str.trim()));
                        i = j;
                    } else {
                        break;
                    }
                }
            } else {

            }
        }
        return { header, data };
    }

    /**
     * 複数形の単語を単数形に変換する関数
     * @param word 
     * @returns 
     */
    static singularize(word: string): string {
        // 不規則な複数形の単語
        const irregulars: { [key: string]: string } = {
            children: 'child',
            men: 'man',
            women: 'woman',
            mice: 'mouse',
            geese: 'goose',
            feet: 'foot',
            teeth: 'tooth'
        };

        // 不規則形のチェック
        if (irregulars[word]) {
            return irregulars[word];
        }

        // 末尾が"ies"の場合（"flies" -> "fly"）
        if (word.endsWith('ies') && word.length > 3 && !'aeiou'.includes(word.charAt(word.length - 4))) {
            return word.slice(0, -3) + 'y';
        }

        // 末尾が"es"の場合（"watches" -> "watch"）、特定の単語を除外
        if (word.endsWith('es') && !word.endsWith('sses') && !word.endsWith('uses') && word.length > 2) {
            return word.slice(0, -2);
        }

        // 末尾が"s"の場合（"cats" -> "cat"）、特定の単語を除外
        if (word.endsWith('s') && !word.endsWith('ss') && !word.endsWith('us') && !word.endsWith('is') && word.length > 1) {
            return word.slice(0, -1);
        }

        // その他のケースでは、単語をそのまま返す
        return word;
    }

    /**
     * 単数形の単語を複数形に変換する関数
     * @param word 
     * @returns 
     */
    static pluralize(word: string): string {
        // 不規則な複数形の単語
        const irregulars: { [key: string]: string } = {
            child: 'children',
            man: 'men',
            woman: 'women',
            mouse: 'mice',
            goose: 'geese',
            foot: 'feet',
            tooth: 'teeth'
        };

        // 不規則形のチェック
        if (irregulars[word]) {
            return irregulars[word];
        }

        // 末尾が"f"または"fe"の場合
        if (word.endsWith('f')) {
            return word.slice(0, -1) + 'ves';
        }
        if (word.endsWith('fe')) {
            return word.slice(0, -2) + 'ves';
        }

        // 末尾が"y"で、その前が子音の場合
        if (word.endsWith('y') && word.length > 1 && !'aeiou'.includes(word.charAt(word.length - 2))) {
            return word.slice(0, -1) + 'ies';
        }

        // 末尾が"s", "x", "z", "ch", "sh"の場合
        if (word.endsWith('s') || word.endsWith('x') || word.endsWith('z') || word.endsWith('ch') || word.endsWith('sh')) {
            return word + 'es';
        }

        // その他のケースでは、単純に"s"を追加
        return word + 's';
    }

    // ここから下は失敗作

    /**
     * Markdownテキストを解析してJSONに変換する関数
     * @param markdown 
     */
    static markdownToObject(markdown: string): any {
        const obj0: any[] = [];
        this.markdownToObject0(markdown.split('\n'), 0, obj0, 1, 0);
        return obj0;
    }

    /**
     * Markdownテキストを解析してJSONに変換する関数
     * @param markdown 
     */
    static markdownToObject0(markdownLines: string[], rowIndex: number, obj: any[], blockLayer: number, listLayer: number): any {

        for (let i = rowIndex; i < markdownLines.length; i++) {
            const line = markdownLines[i];
            if (line.match(/^```/)) {
                let sb = line + '\n';
                for (let j = i + 1; j < markdownLines.length; j++) {
                    const line = markdownLines[j];
                    sb += line + '\n';
                    if (line.match(/^```/)) {
                        i = j;
                        break;
                    } else { }
                }
                obj.push(sb);
            } else {
                const match = line.match(/^(#+)\s/);
                if (match) {
                    match[1].length;
                    if (match[1].length === blockLayer) {
                        obj.push({ title: line, body: '' });
                    } else if (match[1].length < blockLayer) {
                        return i;
                    } else if (match[1].length > blockLayer) {
                        const obj0: any[] = [];
                        i = this.markdownToObject0(markdownLines, i, obj0, blockLayer + 1, 0);
                        obj.push(obj0);
                    }
                }
                obj.push(line);
            }
        }
        return obj;
    }
}

// const code = `
// Here is the JSON format for the Entities of the "User Management" Bounded Context:

// \`\`\`json
// {
//     "name": "hoge",
//     "age": 20,
//     "hobbies": [
//         "programming",
//         "reading",
//         "music"
//     ]
// }
// \`\`\`
// `;

// console.log(Utils.mdTrim(code));

// console.log('plane=' + Utils.toCamelCase('camelCaseCase'));
// console.log('plane=' + Utils.toCamelCase('snake_caseCase'));
// console.log('plane=' + Utils.toCamelCase('kebab-caseCase'));
// console.log('plane=' + Utils.toCamelCase('PascalCaseCase'));
// console.log('');
// console.log('camel=' + Utils.toCamelCase('camelCaseCase'));
// console.log('camel=' + Utils.toCamelCase('snake_caseCase'));
// console.log('camel=' + Utils.toCamelCase('kebab-caseCase'));
// console.log('camel=' + Utils.toCamelCase('PascalCaseCase'));
// console.log('');
// console.log('snake=' + Utils.toSnakeCase('camelCaseCase'));
// console.log('snake=' + Utils.toSnakeCase('snake_caseCase'));
// console.log('snake=' + Utils.toSnakeCase('kebab-caseCase'));
// console.log('snake=' + Utils.toSnakeCase('PascalCaseCase'));
// console.log('');
// console.log('kebab=' + Utils.toKebabCase('camelCaseCase'));
// console.log('kebab=' + Utils.toKebabCase('snake_caseCase'));
// console.log('kebab=' + Utils.toKebabCase('kebab-caseCase'));
// console.log('kebab=' + Utils.toKebabCase('PascalCaseCase'));
// console.log('');
// console.log('pascl=' + Utils.toPascalCase('camelCaseCase'));
// console.log('pascl=' + Utils.toPascalCase('snake_caseCase'));
// console.log('pascl=' + Utils.toPascalCase('kebab-caseCase'));
// console.log('pascl=' + Utils.toPascalCase('PascalCaseCase'));
// console.log('');


// console.log(Utils.escapeBlockSpilt(`
// asdiof aosdijfa;l  'askdf' ;lkajdfa "asd;lkf"
// asdfpijklaaaba:s;ld:asbacd:jasdfaaabac
// as;hthsa'dnasdl;kaklie"ii929\\'1083029'1l;a;lkj
// `));
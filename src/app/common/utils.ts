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
     * Markdownのコードブロックを```を外したものにする。
     * @param {string} text - Markdown形式のテキスト
     * @returns {string} コメント形式に変換されたテキスト
     */
    static convertCodeBlocks(text: string): string {
        let split = text.split(/```.*\n|```$/, -1);
        return split.map((code, index) => {
            if (code.length === 0) {
                return code;
            } else {
                if (index % 2 === 1) {
                    return code;
                } else {
                    return code.split('\n').map(line => `// ${line}`).join('\n');
                }
            }
        }).join('');
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

    /**
     * インデントを削除する
     * @param {string} str 
     * @returns {string}
     */
    static trimLines(str: string): string {
        const list = str.split('\n');
        const line = list.find((line, index) => line.trim().length > 0);
        if (line) { } else { return str; }
        const indent = line.length - line.trimLeft().length;
        const regex = new RegExp(`^ {${indent}}`, 'g');
        return list.map(line => line.replace(regex, '')).join('\n').trim();
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
        return new URL('.', filepath).pathname;
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

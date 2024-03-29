import iconv from 'iconv-lite';
import { Utils } from '../../common/utils.js';
function extractBytesFromPic(pic: string): number {
    let totalBytes = 0;
    const patterns = [
        { regex: /9\((\d+)\)/, bytesPerUnit: 1 }, // 数値
        { regex: /A\((\d+)\)/, bytesPerUnit: 1 }, // 英字
        { regex: /X\((\d+)\)/, bytesPerUnit: 1 }, // 任意の文字
        { regex: /S9\((\d+)\)/, bytesPerUnit: 1, additionalBytes: 1 }, // 符号付き数値
        { regex: /\+9\((\d+)\)/, bytesPerUnit: 1, additionalBytes: 1 } // 符号付き数値
    ];

    patterns.forEach(pattern => {
        let match;
        while ((match = pic.match(pattern.regex)) !== null) {
            const length = parseInt(match[1], 10);
            totalBytes += length * pattern.bytesPerUnit;
            if (pattern.additionalBytes) {
                totalBytes += pattern.additionalBytes;
            }
            pic = pic.replace(pattern.regex, ''); // マッチした部分を取り除く
        }
    });

    // 単独で指定された文字のカウント（例: `9`, `A`, `X`）
    totalBytes += (pic.match(/9/g) || []).length;
    totalBytes += (pic.match(/A/g) || []).length;
    totalBytes += (pic.match(/X/g) || []).length;

    return totalBytes;
}

export abstract class VarClause {
    constructor(public type: 'group' | 'copy' | 'pic', public layer: number, public name: string) { }
    // abstract output(): Buffer;
    // abstract getLength(): number;
    abstract toPython(depth: number): string;
}
export class GroupClause extends VarClause {
    public children: VarClause[] = [];
    // TODO COBOLソースが変なところがある
    //          05  CNS-WARNING-INFO-15. 
    constructor(public layer: number, public name: string, public occurs: number = 1) { super('group', layer, name); }
    // getLength(): number { return this.children.reduce((prev, curr) => prev + curr.getLength(), 0); };
    toPython(depth: number = 0): string {
        // const indent = '\t'.repeat(depth);
        const indent = '\t'.repeat(2);
        return Utils.trimLines(`${indent}self.${Utils.toSnakeCase(this.name)} = ${Utils.toSnakeCase(this.name)}`);
        // return Utils.trimLines(`${indent}self.${Utils.toSnakeCase(this.name)} = ${Utils.toPascalCase(this.name)}()`);
    }

    toPythonInit(depth: number = 0): string {
        // const indent = '\t'.repeat(depth);
        const indent = '';
        return Utils.trimLines(`
            ${indent}class ${Utils.toPascalCase(this.name)}:
            ${indent}    def __init__(self):
            ${this.children.filter(child => ['pic', 'copy', 'group'].includes(child.type)).map(child => child.toPython(depth + 2)).join('\n') || ('\t'.repeat(depth + 2) + 'pass')}

            ${indent}${Utils.toSnakeCase(this.name)} = ${Utils.toPascalCase(this.name)}()
        `);
    }
    getClassRecursive(m: Set<GroupClause> = new Set<GroupClause>()): Set<GroupClause> {
        m.add(this);
        this.children.filter(obj => obj.type === 'group').flatMap(child => (child as GroupClause).getClassRecursive(m));
        return m;
    }
}
export class CopyClause extends VarClause {
    constructor(public layer: number, public name: string) { super('copy', layer, name); }
    // getLength(): number {        return 0;    }
    toPython(depth: number = 0): string {
        const indent = '\t'.repeat(depth);
        return Utils.trimLines(`COPY${indent}${this.name}`);
    }
}
export class PicClause extends VarClause {
    public display: string | null = null;
    constructor(public layer: number, public name: string, public lenString: string, public value: string | null) { super('pic', layer, name); }
    // getLength(): number { return extractBytesFromPic(this.lenString); }
    toPython(depth: number = 0): string {
        // const indent = '\t'.repeat(depth);
        const indent = '\t'.repeat(2);
        return Utils.trimLines(`${indent}self.${Utils.toSnakeCase(this.name)} = ${toValueString(this.value)}`);
    }
}
function toValueString(value: string | null) {
    if (value == null) {
        return 'None';
    }
    const CONSTANT: any = {
        'ZERO': 0,
        'SPACE': "' '",
    };
    if (value in CONSTANT) {
        return CONSTANT[value];
    } else if (value.startsWith("'")) {
        return value;
    } else if (value.match(/[-0-9]/g)) {
        return value;
    }
    return value;
}


// テキストをSJISに変換し、72バイトで区切る関数
function trimRightComments(text: string): string {
    return text.split('\n').map(line => {
        // UTF-8のテキストをSJISに変換
        const sjisBuffer = iconv.encode(line, 'Shift_JIS');
        if (sjisBuffer.length > 72) {
            return iconv.decode(sjisBuffer.slice(0, 72), 'Shift_JIS');
        } else {
            return line;
        }
    }).join('\n');
}

/**
 * サブルーチン分割（改善版）
 * @param cobolText 
 * @returns 
 */
export function getSubroutineList(cobolText: string): { name: string, code: string }[] {
    // 右コメントをカット
    cobolText = trimRightComments(cobolText);

    const cobolLines = cobolText.split('\n');
    let line = '';
    let key = '';
    const sectionMap: { [key: string]: string[] } = {};
    for (let idx = 0; idx < cobolLines.length; idx++) {
        if (line.length === 0) {
            line = cobolLines[idx];
        } else {
            line += '\n' + cobolLines[idx];
        }
        if (cobolLines[idx][6] === ' ' && cobolLines[idx].trim().endsWith('.')) {
            // 文は必ずドットで終わる。ドットがあると邪魔なので削っておく。
            if (line.match(/\s+SECTION\.$/)) {
                const trimed = line.trim().split(/ +/g);
                // console.log(trimed);
                key = trimed[trimed.length - 2];
                // console.log(key);
                sectionMap[key] = [line];
            } else if (line.match(/\s+EXIT\.$/) || line.match(/\s+GOBACK\.$/)) {
                if (sectionMap[key]) {
                    sectionMap[key].push(line);
                } else { }
                key = '';
            } else if (key) {
                sectionMap[key].push(line);
            } else {
                // console.log(`unknown line: ${cobolLines[idx]}`);
            }
            line = '';
        } else {
            // ドットで終わらない行は改行ありの継続行。
        }
    }
    // console.log(sectionMap);
    return Object.entries(sectionMap)
        .filter(([key, value]) => !['', 'CONFIGURATION', 'INPUT-OUTPUT', 'FILE', 'WORKING-STORAGE', 'LOCAL-STORAGE', 'LINKAGE',].includes(key))
        .map(([key, value]) => ({ name: key.replaceAll(/-RTN/g, ''), code: value.join('\n') }));
}

export function grepCaller(prog: string, obj: { name: string, code: string }) {
    obj.code.split('\n').filter(line => line[6] === ' ').forEach(line => {
        if (line.trim().startsWith('CALL ')) {
            // console.log(`CALL: ${prog} ${obj.name} ${line.trim().split(/ +/g)[1]}`);
        } else {

        }
    });
}

/**
 * 項目定義系SECTIONの中身を正規化（コメント削除、1行1定義）した配列を返す
 * @param cobolText 
 * @param isWorkingStorage 
 * @returns 
 */
export function getWorkingStorageSection(cobolText: string, isWorkingStorage = false): string[] {
    // 右コメントをカット
    cobolText = trimRightComments(cobolText);
    // WORKING-STORAGE SECTION.
    const cobolLines = cobolText.split('\n');
    let line = '';
    const dtoLines = [];
    for (let idx = 0; idx < cobolLines.length; idx++) {
        if (cobolLines[idx][6] === ' ') {
            // 実コード
        } else {
            // コメント
            continue;
        }

        // 7byte目以降。右空白はゴミなので右トリムしておく。
        cobolLines[idx] = cobolLines[idx].substring(7).replaceAll(/\s*$/g, '');

        if (cobolLines[idx].trim().match(/^WORKING-STORAGE\s+SECTION\./)
            || cobolLines[idx].trim().match(/^LINKAGE\s+SECTION\./)
            || cobolLines[idx].trim().match(/^FILE\s+SECTION\./)
        ) {
            isWorkingStorage = true;
            continue;
        } else { }

        // console.log(cobolLines[idx]);
        if (cobolLines[idx].startsWith('PROCEDURE ')) {
            break;
        } else { }

        // workingStorageSection
        if (isWorkingStorage) {
            if (line.length === 0) {
                line = cobolLines[idx];
            } else {
                line += ' ' + cobolLines[idx].trim();
            }
            if (cobolLines[idx].trim().endsWith('.')) {
                // 文は必ずドットで終わる。ドットがあると邪魔なので削っておく。
                dtoLines.push(line.substring(0, line.length - 1));
                line = '';
            } else {
                // ドットで終わらない行は改行ありの継続行。
            }
        } else { }
    }
    return dtoLines;
}

/**
 * COBOLの WORKING-STORAGE-SECTION のような項目値を定義する行の集合をオブジェクトツリー構造に整形する。
 * @param dtoLines 
 * @param copyMas 
 * @returns 
 */
export function lineToObjet(dtoLines: string[], copyMas: { [key: string]: GroupClause }): GroupClause {
    const rootDto = new GroupClause(0, 'root');
    const depthChain: GroupClause[] = [rootDto];
    let rowIndex = 0;
    let cur: VarClause | null;

    let copyName = '';
    while (true) {
        if (rowIndex < dtoLines.length) {
        } else { break; }

        const dtoLine = dtoLines[rowIndex];
        const noIndentLine = dtoLine.trim();
        // console.log(noIndentLine);
        // 通常の項目行 
        const words = Utils.escapedTokenize(noIndentLine).filter(s => s);
        let curLayer = Number(words[0]);
        // const indent = indentChain.join('');
        // console.log(curLayer, depthChain[depthChain.length - 1].layer);
        if (curLayer > depthChain[depthChain.length - 1].layer || ['COPY', 'EXEC', 'FD'].includes(words[0])) {
            cur = null;
            copyName = '';
            if (words[0] === 'FD') {
                // FDはスキップ
            } else if (words[0] === 'COPY') {
                // COPY句
                copyName = words[1].split('.')[0].replaceAll(/["' ]/g, '');
            } else if (words[0] === 'EXEC') {
                // EXEC SQL句
                if (words[0] === 'EXEC' && words[1] === 'SQL') {
                    if (words[2] === 'INCLUDE' && words[4] === 'END-EXEC') {
                        if (words[3] === 'SQLCA') {
                            // SQLCAを読んでるだけなのでスキップ
                        } else {
                            // SQL COPY句インクルード
                            // console.log(`COPY = ${words[3].split('.')[0]}`);
                            copyName = words[3].split('.')[0];
                        }
                    } else {
                        // BEGINとかENDとかと思われる。無視する。
                    }
                } else {
                    console.log(`未対応の行:EXEC: ${dtoLine}`);
                }
            } else if (!isNaN(curLayer)) {
                // const curIndent = noIndentLine.replaceAll(regexDtoLine, '$1');
                if (words.length === 2) {
                    // グループ項目行
                    cur = new GroupClause(curLayer, words[1]);
                } else if (words.length >= 4 && words[2] === 'OCCURS') {
                    // グループ項目行(OCCURSあり)
                    cur = new GroupClause(curLayer, words[1], Number(words[3]));
                } else if (words.length >= 4 && words[2] === 'REDEFINES') {
                    // グループ項目行(REDEFINES)
                    // TODO REDEFINESは未対応なのでそのうち考える。
                    cur = new GroupClause(curLayer, words[1], Number(words[3]));
                } else if (words[2] === 'PIC') {
                    // PIC項目行
                    let valueIndex = 0;
                    if (['COMP', 'COMP-5'].includes(words[4])) {
                        cur = new PicClause(curLayer, words[1], words[3] + words[4], null);
                        valueIndex = 5;
                    } else {
                        cur = new PicClause(curLayer, words[1], words[3], null);
                        valueIndex = 4;
                    }
                    // console.log(words);
                    if (words[valueIndex] === 'VALUE') {
                        (cur as PicClause).value = words.slice(valueIndex + 1).join(' ');
                    } else if (words[valueIndex] === 'DISPLAY') {
                        (cur as PicClause).display = words.slice(valueIndex + 1).join(' ');
                    } else { }
                    // words.slice(5).join(' ') ||
                    // words.slice(6).join(' ') || null
                    // console.log(words, words[5]);
                } else if (words[2] === 'COMP-2') {
                    // 何故PICにしていないのかは不明だが、PICとして扱う
                    cur = new PicClause(curLayer, words[1], words[2], words[5] || null);
                } else if (words.slice(1).join(' ') === 'FILLER SIGN IS LEADING SEPARATE CHARACTER') {
                    // TODO この行をどう反映させるべきか不明
                    // console.log('FILLER SIGN IS LEADING SEPARATE CHARACTER');
                } else {
                    // console.log(`unknown ${(words.length === 4 && words[2] === 'OCCURS')} [${words.length}]${words}`);
                    console.log(`未対応の行:PIC: ${dtoLine}`);
                }
            } else {
                // ここに来ることはないと思う。
                console.log(`未対応の行: ${dtoLine}`);
            }
            // console.log(depthChain.map(obj => obj.name));
            if (copyName) {
                if (copyName in copyMas) {
                    copyMas[copyName].children.forEach(chil => {
                        // console.log(`COPY ${copyName} の子供 ${chil.name} ${chil.type} ${(chil as any).children}`);
                        depthChain[depthChain.length - 1].children.push(chil);
                    });
                    // console.log(`COPY ${copyName} は${copyMas[copyName].children.length}です。`);
                    if (copyMas[copyName].children.length === 0) {
                        console.log(`COPY ${copyName} は空です。`);
                    }
                } else {
                    console.log(`COPY ${copyName} がありません。`);
                    cur = new CopyClause(-1, copyName);
                }
            } else { }

            // 実体行だったらストックする。
            if (cur) {
                // console.log(depthChain);
                // console.log('Append', depthChain[depthChain.length - 1].name, cur.name);
                depthChain[depthChain.length - 1].children.push(cur);
                if (cur.type === 'group') {
                    depthChain.push(cur as GroupClause);
                } else { }
            } else { }
            rowIndex++;
        } else {
            // 階層ブレイク
            const pop = depthChain.pop();
            // console.log(`popName=${pop?.name}`);
            // layerChain.pop();
        }
    }
    return rootDto;
}
export function parseWorkingStorageSection(cobolText: string, copyMas: { [key: string]: GroupClause }, isWorkingStorage: boolean = false): GroupClause {
    const dtoLines = getWorkingStorageSection(cobolText, isWorkingStorage);
    const dtoObject = lineToObjet(dtoLines, copyMas);
    // console.log(JSON.stringify(rootDto, null, 2));
    // throw new Error('Not implemented');
    return dtoObject;
}


import * as fs from 'fs';
import path from 'path';

import fss from '../../common/fss.js';
const COBOL_DIR = 'COPY_DIR';

// COPY句をロードして、「ファイルID：Dtoオブジェクト」の連想配列にする。
const copyFileList = fss.getFilesRecursively(COBOL_DIR).filter(filePath => filePath.endsWith('.cpy'));
// COPY句は入れ子もありうるので2回ループしておく
const cpyMap = [...copyFileList, ...copyFileList].reduce((prev, curr) => {
    const copyObj = parseWorkingStorageSection(fs.readFileSync(curr, 'utf-8'), prev, true);
    prev[path.basename(curr).replace(/\..+$/, '')] = copyObj;
    // prev[path.basename(curr)] = prev[path.basename(curr)];
    return prev;
}, {} as { [key: string]: GroupClause });
console.log('copyLoaded');
const _path = `./sample.pco`;
const cobolText = fs.readFileSync(_path, 'utf8');

// console.log(cpyMap);
const obj = parseWorkingStorageSection(cobolText, cpyMap, false);
// console.dir(obj, { depth: 100 });
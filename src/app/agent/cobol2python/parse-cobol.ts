import { Utils } from '../../common/utils.js';
function extractBytesFromPic(pic: string): number {
    let totalBytes = 0;
    const patterns = [
        { regex: /9\((\d+)\)/, bytesPerUnit: 1 }, // 数値
        { regex: /A\((\d+)\)/, bytesPerUnit: 1 }, // 英字
        { regex: /X\((\d+)\)/, bytesPerUnit: 1 }, // 任意の文字
        { regex: /S9\((\d+)\)/, bytesPerUnit: 1, additionalBytes: 1 } // 符号付き数値
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
        const indent = '';
        return Utils.trimLines(`
            ${indent}class ${Utils.toPascalCase(this.name)}:
            ${indent}    def __init__(self):
            ${this.children.filter(child => ['pic', 'copy'].includes(child.type)).map(child => child.toPython(depth + 2)).join('\n') || ('\t'.repeat(depth + 2) + 'pass')}

            ${this.children.filter(child => ['group'].includes(child.type)).map(child => child.toPython(depth + 1)).join('\n\n')}
        `);
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
    const a: any = {
        'ZERO': 0,
        'SPACE': '',
    };
    if (value in a) {
        return a[value];
    } else if (value.startsWith("'")) {
        return value;
    } else if (value.match(/[-0-9]/g)) {
        return value;
    }
    return value;
}


// ルーチン名が可変であることを考慮した正規表現
const regexSection = /...... ([\w-]+)-RTN\s+SECTION\.[\s\S]*?\1-EXT\./g;
const regexSectionName = /^...... ([\w-]+)-RTN\s+SECTION.*$/g;
export function getSubroutineList(cobolText: string): { name: string, code: string }[] {
    // サブルーチン毎に分割する
    let match;
    const sectionList = [];
    while ((match = regexSection.exec(cobolText)) !== null) {
        // console.log(match[0]); // マッチした各ルーチンのテキスト
        sectionList.push(match[0]);
    }
    return sectionList.map((section, innerIndex) => ({ name: section.split('\n')[0].replace(regexSectionName, '$1'), code: section }));
}

const regexDtoLine = /^( *)[0-9]+ .*$/g;
export function getWorkingStorageSection(cobolText: string, isWorkingStorage = false): string[] {
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

        if (cobolLines[idx].trim().match(/^WORKING-STORAGE\s+SECTION\./) || cobolLines[idx].trim().match(/^LINKAGE\s+SECTION\./)) {
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
        if (curLayer > depthChain[depthChain.length - 1].layer || ['COPY', 'EXEC'].includes(words[0])) {
            cur = null;
            copyName = '';
            if (words[0] === 'COPY') {
                // COPY句
                copyName = words[1];
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
                } else if (words.length === 4 && words[2] === 'OCCURS') {
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
                } else {
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

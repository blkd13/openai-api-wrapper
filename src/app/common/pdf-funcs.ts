import _ from 'lodash';
import { promises as fs } from "fs";
// import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf";
import { fromPath } from "pdf2pic";
import path from 'path';
import pLimit from 'p-limit';
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";
import { PDFDocumentProxy } from 'pdfjs-dist/types/src/display/api.js';
import { EntityManager, In } from "typeorm/index.js";

import { FileBodyEntity } from '../service/entity/file-models.entity.js';

// PDFに変換するmime
export const convertToPdfMimeList = [
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-powerpoint',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-excel.sheet.macroEnabled.12',
];
export const convertToPdfMimeMap = Object.fromEntries(convertToPdfMimeList.map(mime => [mime, 'application/pdf']));

// メタ情報のインターフェース（必要に応じて詳細を追加）
export interface PdfMetaData {
    pdfDocument: PDFDocumentProxy;
    info: any;       // ドキュメント情報（例: タイトル、作成者、作成日など）
    metadata: any;   // XMP 形式などのカスタムメタデータ（存在する場合）
    outline: any;    // アウトライン／目次情報（存在する場合）
    textPages: string[]; // 各ページのテキスト
}
/**
 * PDF のテキスト、メタ情報、アウトラインを抽出する関数
 * @param pdfPath PDF ファイルのパス
 * @returns PdfMetaData オブジェクト
 */
export async function extractPdfData(pdfPath: string): Promise<PdfMetaData> {
    // 非同期で PDF ファイルを読み込む
    const fileBuffer = await fs.readFile(pdfPath);
    const data = new Uint8Array(fileBuffer);

    // PDF ドキュメントを取得
    const pdfDocument = await pdfjsLib.getDocument({ data }).promise;

    // --- メタ情報の取得 ---
    // getMetadata() は info と metadata を返します
    let info: any = null;
    let metadata: any = null;
    try {
        const meta = await pdfDocument.getMetadata();
        info = meta.info;
        metadata = meta.metadata;
    } catch (err) {
        console.warn("メタ情報の取得に失敗しました:", err);
    }

    // --- アウトライン／目次の取得 ---
    // getOutline() でアウトライン情報を取得（存在しない場合は null）
    let outline: any = null;
    try {
        outline = await pdfDocument.getOutline();
    } catch (err) {
        console.warn("アウトラインの取得に失敗しました:", err);
    }

    // --- 各ページのテキスト抽出 ---
    const numPages = pdfDocument.numPages;
    const textPages: string[] = [];

    for (let i = 1; i <= numPages; i++) {
        const page = await pdfDocument.getPage(i);
        const textContent = await page.getTextContent();
        // 各テキストアイテムの「str」プロパティを結合
        const pageText = textContent.items
            .map((item: any) => item.str)
            .join(" ");
        textPages.push(pageText);
    }

    return { pdfDocument, info, metadata, outline, textPages };
}

/**
 * 各ページの実寸（ポイント単位）から、最大辺が maxDim ピクセルになるような出力サイズを計算する関数
 * @param origWidth ページの元の幅
 * @param origHeight ページの元の高さ
 * @param maxDim 最大にしたいピクセル数（例：1024）
 * @returns { targetWidth, targetHeight } 出力画像の幅と高さ（height は参考値）
 */
function calculateTargetDimensions(origWidth: number, origHeight: number, maxDim: number): { targetWidth: number; targetHeight: number } {
    let targetWidth: number, targetHeight: number;
    if (origWidth >= origHeight) {
        // 横長または正方形の場合、幅を maxDim に合わせる
        targetWidth = maxDim;
        targetHeight = Math.round(maxDim * origHeight / origWidth);
    } else {
        // 縦長の場合、高さを maxDim に合わせるので、幅は以下のように計算
        targetHeight = maxDim;
        targetWidth = Math.round(maxDim * origWidth / origHeight);
    }
    return { targetWidth, targetHeight };
}

/**
 * PDF の各ページを動的なサイズで画像に変換する関数（height は pdf2pic には渡さず、width のみ指定）
 * @param pdfPath PDF ファイルのパス
 * @param maxDim 最大辺のピクセル数（例：1024）
 */
async function convertPdfPagesDynamically(pdfPath: string, pdfDocument: PDFDocumentProxy, maxDim: number = 1024): Promise<void> {
    // // PDF ファイルを非同期で読み込み
    // const fileBuffer = await fs.readFile(pdfPath);
    // const data = new Uint8Array(fileBuffer);

    // // pdfjs-dist を使って PDF ドキュメントを取得
    // const pdfDocument = await pdfjsLib.getDocument({ data }).promise;
    const numPages = pdfDocument.numPages;

    for (let i = 1; i <= numPages; i++) {
        const page = await pdfDocument.getPage(i);
        // scale:1 で元の寸法（ポイント単位）を取得
        const viewport = page.getViewport({ scale: 1 });
        const origWidth = viewport.width;
        const origHeight = viewport.height;

        // 各ページごとに出力サイズを計算
        const { targetWidth, targetHeight } = calculateTargetDimensions(origWidth, origHeight, maxDim);
        console.log(`Page ${i}: origWidth=${origWidth.toFixed(2)}, origHeight=${origHeight.toFixed(2)} => targetWidth=${targetWidth}, targetHeight=${targetHeight}`);
        const basePath = pdfPath.substring(0, pdfPath.lastIndexOf('.'));

        // pdf2pic のオプションを動的に設定（**height** は指定せず、width のみ）
        const options = {
            density: 150,               // 解像度（調整可能）
            saveFilename: path.basename(basePath),   // 出力ファイル名のプレフィックス
            savePath: path.dirname(pdfPath),       // 出力先ディレクトリ（事前に作成しておくこと）
            format: 'png',              // 画像フォーマット
            height: targetHeight,
            width: targetWidth,         // 動的に計算した幅のみ指定
        };

        const converter = fromPath(pdfPath, options);
        try {
            const result = await converter(i);
            // console.log(`Page ${i} converted:`, result);
        } catch (error) {
            console.error(`ページ ${i} の変換中にエラーが発生しました:`, error);
        }
    }
}

const limitPages = pLimit(16); // 同時に4ページまでレンダリング
async function convertPdfPagesDynamicallyParallel(pdfPath: string, pdfDocument: PDFDocumentProxy, maxDim: number = 1024): Promise<void> {
    // ES Modules 環境で dynamic import を利用
    const { fromPath } = await import('pdf2pic');
    const numPages = pdfDocument.numPages;

    // 全ページ分のタスクを生成
    const tasks = [];
    for (let i = 1; i <= numPages; i++) {
        tasks.push(
            limitPages(async () => {
                const page = await pdfDocument.getPage(i);
                const viewport = page.getViewport({ scale: 1 });
                const { width: origWidth, height: origHeight } = viewport;
                const { targetWidth, targetHeight } = calculateTargetDimensions(origWidth, origHeight, maxDim);
                const basePath = pdfPath.substring(0, pdfPath.lastIndexOf('.'));

                const options = {
                    density: 150,
                    saveFilename: path.basename(basePath),
                    savePath: path.dirname(pdfPath),
                    format: 'png',
                    width: targetWidth,
                    height: targetHeight,
                };

                const converter = fromPath(pdfPath, options);
                try {
                    await converter(i);
                    console.log(`[OK] Page ${i} converted`);
                } catch (error) {
                    console.error(`[NG] Page ${i} の変換に失敗:`, error);
                }
            })
        );
    }

    // 全ページの並行処理完了を待つ
    await Promise.all(tasks);
}
export async function convertPdf(tm: EntityManager, fileBody: FileBodyEntity): Promise<FileBodyEntity> {
    fileBody.innerPath = fileBody.innerPath.replaceAll(/\\/g, '/');
    const basePath = fileBody.innerPath.substring(0, fileBody.innerPath.lastIndexOf('.'));
    // const pathBase = file.innerPath.split('-')[0];
    // const innerPath = file.innerPath;
    // const basename = path.basename(innerPath);
    const pdfPath = `${basePath}.pdf`;
    console.log(`Processing PDF: ${pdfPath}`);
    try {
        const pdfData = await extractPdfData(pdfPath);
        console.log("----- PDF ドキュメント情報 -----");
        console.log("Info:", pdfData.info);
        console.log("Metadata:", JSON.stringify(pdfData.metadata));

        console.log("----- アウトライン／目次 -----");
        if (pdfData.outline) {
            // アウトラインは階層構造になっているため、再帰的に表示することも可能です
            console.log(JSON.stringify(pdfData.outline));
        } else {
            console.log("アウトライン情報はありません。");
        }

        const numPages = pdfData.pdfDocument.numPages;
        // メタデータをDB保存しておく
        const isEnable = pdfData.pdfDocument.numPages <= 1000;
        fileBody.metaJson = { isEnable, numPages: pdfData.pdfDocument.numPages };

        const pdfDocument = pdfData.pdfDocument;

        // json出力する前にpdfDocumentは落としておく
        delete (pdfData as any).pdfDocument;
        pdfData.metadata = pdfData.metadata || {};
        pdfData.metadata.numPages = numPages;
        pdfData.metadata.isEnable = isEnable;
        await fs.writeFile(`${basePath}.json`, JSON.stringify(pdfData, null, 2), 'utf-8');

        if (isEnable) {
            // 画像化
            await convertPdfPagesDynamicallyParallel(pdfPath, pdfDocument);
        } else {
            // 1000ページ以上のドキュメントは無視する
        }
    } catch (error) {
        fileBody.metaJson = { isEnable: false, numPages: -1 };
        console.error(pdfPath, error);
    }
    return fileBody;
}

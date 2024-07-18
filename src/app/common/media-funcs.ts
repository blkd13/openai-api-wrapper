import { Observable } from 'rxjs';
import ffmpeg, { FfprobeData } from 'fluent-ffmpeg';
import * as crypto from 'crypto';
import fs from 'fs';
import * as path from 'path';

// 取得したい動画ファイルのパスを指定
export function getMetaDataFromFile(filePath: string): Observable<FfprobeData> {
    return new Observable((observer) => {
        ffmpeg.ffprobe(filePath, (err, metadata) => {
            if (err) {
                observer.error(err);
            } else {
                observer.next(metadata);
                observer.complete();
            }
        });
    });
}

/**
 * dataURLをファイルに保存してメタ情報を取得する。
 * @param dataURL 
 * @param saveAs 
 * @returns 
 */
export function getMetaDataFromDataURL(dataURL: string, saveAs: string = ''): Observable<FfprobeData> {
    const buffer = Buffer.from(dataURL.substring(dataURL.indexOf(',')), 'base64');
    const hashSum = crypto.createHash('sha256');
    hashSum.update(buffer);
    const hash = hashSum.digest('hex');

    // format_name?: string | undefined;
    // format_long_name?: string | undefined;
    // start_time?: number | undefined;
    // duration?: number | undefined;
    // size?: number | undefined;
    // bit_rate?: number | undefined;
    // probe_score?: number | undefined;

    const extention = dataURL.split(/[/;]/g)[1];
    const filePath = saveAs || `./temp-${Date.now()}.${extention}`
    const startTime = Date.now();
    return new Observable((observer) => {
        // console.log(`writing file: ${filePath}`);
        fs.writeFile(filePath, buffer, (err) => {
            if (err) {
                observer.error(err);
            } else {
                // console.log(`file written: ${filePath}`);
                ffmpeg.ffprobe(filePath, (err, metadata) => {
                    const endTime = Date.now();
                    // console.log(`meta time: ${endTime - startTime}`);
                    if (err) {
                        observer.error(err);
                    } else {
                        // console.log(`metadata: ${metadata}`);
                        observer.next(metadata);
                        observer.complete();
                    }
                });
            }
        });
    });
}


import { lookup } from 'mime-types';
import { fileTypeFromFile } from 'file-type';

export async function detectMimeType(filePath: string, fileName: string): Promise<string> {
    // まず、file-typeライブラリを使用してファイルの内容からMIMEタイプを判定
    const fileType = await fileTypeFromFile(filePath);
    if (fileType) {
        return fileType.mime;
    }

    // file-typeで判定できなかった場合、mime-typesライブラリを使用して拡張子からMIMEタイプを推測
    const mimeType = lookup(fileName);
    if (mimeType) {
        return mimeType;
    }

    // テキストファイルの判定（簡易的な方法）
    const buffer = Buffer.alloc(1024);
    const fd = fs.openSync(filePath, 'r');
    const bytesRead = fs.readSync(fd, buffer, 0, 1024, 0);
    fs.closeSync(fd);

    if (bytesRead > 0) {
        // バイナリデータが含まれているかチェック
        const isText = !buffer.slice(0, bytesRead).some(b => b === 0);
        if (isText) {
            return 'text/plain';
        }
    }

    // どの方法でも判定できなかった場合
    return 'application/octet-stream';
}

// 使用例
// const filePath = '/path/to/your/file';
// detectMimeType(filePath).then(mimeType => {
//   console.log(`Detected MIME type: ${mimeType}`);
// });

import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export async function minimizeAudioForMinutes(inputFile: string, outputFile: string): Promise<string> {
    try {
        // FFmpegコマンドを構築
        const command = `ffmpeg -i "${inputFile}" \
      -af silenceremove=stop_periods=-1:stop_duration=1:stop_threshold=-50dB \
      -c:a libopus -b:a 12k -ac 1 -ar 16000 -vbr off \
      "${outputFile}.opus"`;

        // コマンドを実行
        const { stdout, stderr } = await execAsync(command);

        console.log('Audio processing completed successfully');
        console.log('Output:', stdout);

        if (stderr) {
            console.error('Errors:', stderr);
        }
    } catch (error) {
        console.error('An error occurred:', error);
        throw error;
    }
    return `${outputFile}.opus`;
}
export async function normalizeAndMinimizeAudio(inputFile: string, outputFile: string, outputFormat: 'opus' = 'opus'): Promise<string> {
    try {
        // FFmpegコマンドを構築
        const command = `ffmpeg -i "${inputFile}" \
        -af loudnorm=I=-16:TP=-1.5:LRA=11,acompressor=threshold=-16dB:ratio=4,volume=1.5,silenceremove=stop_periods=-1:stop_duration=1:stop_threshold=-50dB \
        -c:a libopus -b:a 12k -ac 1 -ar 16000 -vbr off \
        "${outputFile}.${outputFormat}"`;

        // コマンドを実行
        const { stdout, stderr } = await execAsync(command);

        console.log('Audio processing completed successfully');
        console.log('Output:', stdout);

        if (stderr) {
            console.error('Errors:', stderr);
        }
    } catch (error) {
        console.error('An error occurred:', error);
        throw error;
    }
    return `${outputFile}.${outputFormat}`;
}

export async function minimizeVideoForMinutes(inputFile: string, outputFile: string, outputFormat: 'mp4' | 'webm' | '3gpp' = 'mp4'): Promise<string> {
    try {
        // 出力フォーマットに基づいてコーデックとコンテナを選択
        let videoCodec, audioCodec, container;
        switch (outputFormat.toLowerCase()) {
            case 'webm':
                videoCodec = 'libvpx-vp9';
                audioCodec = 'libopus';
                container = 'webm';
                break;
            case '3gpp':
                videoCodec = 'libx264';
                audioCodec = 'aac';
                container = '3gp';
                break;
            case 'mp4':
            default:
                videoCodec = 'libx264';
                audioCodec = 'aac';
                container = 'mp4';
                break;
        }

        // FFmpegコマンドを構築
        const command = `ffmpeg -i "${inputFile}" \
        -vf "scale=640:480:force_original_aspect_ratio=decrease,pad=640:480:(ow-iw)/2:(oh-ih)/2,fps=15" \
        -c:v ${videoCodec} -crf 28 -preset veryslow \
        -c:a ${audioCodec} -b:a 32k -ac 1 -ar 16000 \
        -af loudnorm=I=-16:TP=-1.5:LRA=11,acompressor=threshold=-16dB:ratio=4,volume=1.5,silenceremove=stop_periods=-1:stop_duration=1:stop_threshold=-50dB \
        -movflags +faststart \
        "${outputFile}.${container}"`;

        // コマンドを実行
        const { stdout, stderr } = await execAsync(command);

        console.log('Video processing completed successfully');
        console.log('Output:', stdout);

        if (stderr) {
            console.error('Errors:', stderr);
        }
        return `${outputFile}.${container}`;
    } catch (error) {
        console.error('An error occurred:', error);
        throw error;
    }
}

export async function convertAndOptimizeImage(inputFile: string, outputFile: string): Promise<string> {
    const outputFilePNG = path.join(`${outputFile}.png`);
    const outputFileJPEG = path.join(`${outputFile}.jpg`);
    try {
        // ImageMagickを使用して画像情報を取得
        const { stdout: imageInfo } = await execAsync(`identify -format "%[opaque],%[fx:w],%[fx:h]" "${inputFile}"`);
        const [isOpaque, width, height] = imageInfo.split(',');

        // 画像が完全に不透明か、サイズが大きい場合はJPEGに、それ以外はPNGに変換
        const outputFormat = isOpaque === 'true' || (parseInt(width) * parseInt(height) > 1000000) ? 'jpeg' : 'png';
        const outputFile = outputFormat === 'jpeg' ? outputFileJPEG : outputFilePNG;

        // ImageMagickを使用して画像を変換・最適化
        let command: string;
        if (outputFormat === 'jpeg') {
            command = `convert "${inputFile}" -resize "1024x1024>" -quality 85 -strip "${outputFile}"`;
        } else {
            command = `convert "${inputFile}" -resize "1024x1024>" -strip PNG8:"${outputFile}"`;
        }

        await execAsync(command);

        console.log(`Image processed and saved as ${outputFile}`);

        // 元の画像と変換後の画像のサイズを比較
        const originalSize = await fs.statSync(inputFile).size;
        const newSize = fs.statSync(outputFile).size;
        console.log(`Original size: ${originalSize} bytes`);
        console.log(`New size: ${newSize} bytes`);
        console.log(`Size reduction: ${((originalSize - newSize) / originalSize * 100).toFixed(2)}%`);
        return `${outputFile}`;
    } catch (error) {
        console.error('An error occurred:', error);
        throw error;
    }
}

import { Observable } from 'rxjs';
import ffmpeg, { FfprobeData } from 'fluent-ffmpeg';
import fs from 'fs';

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

export function getMetaDataFromDataURL(dataURL: string): Observable<FfprobeData> {
    const buffer = Buffer.from(dataURL.substring(dataURL.indexOf(',')), 'base64');
    const extention = dataURL.split(/[/;]/g)[1];
    const filePath = `./temp-${Date.now()}.${extention}`
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
                    console.log(`meta time: ${endTime - startTime}`);
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


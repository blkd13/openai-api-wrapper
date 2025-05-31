import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import { PathOrFileDescriptor, WriteFileOptions, NoParamCallback } from 'fs';

/**
 * ファイルシステムの安全な書き込みを行う。
 * ChatGPT APIをstreamモードで動かすとファイル書き込みが前後してしまうことがあるので
 * キューを使って順序がずれないようにする。
 * また、ファイル出力先のディレクトリが無ければ掘るようにする。
 */
class FsSafeImpl {
    constructor() { }

    private qMap: { [key: string]: { lock: boolean, q: FsSafeParam[] } } = {};

    /**
     * ファイルに書き込むコールバックを作成する。
     * パスをパラメータとしたコールバックを作成するので直接の関数ではなくFactoryとしている。
     * @param filepath 
     * @returns 
     */
    private callbackFactory = (filepath: string, callback?: NoParamCallback): NoParamCallback => {
        // console.log(`callbackFactory:   ${JSON.stringify(callback)}`);
        return (err: NodeJS.ErrnoException | null) => {
            // ロック解除
            this.qMap[filepath].lock = false;
            // console.log(`CallBack:     ${callback}`);
            // コールバックを呼び出す
            (callback || (() => { }))(err);
            if (err) {
                console.log(err);
            } else {
                // キューがあれば書き込み
                const param = this.qMap[filepath].q.shift();
                if (param) {
                    this.qMap[filepath].lock = true;
                    if (param.type === 'writeFile') {
                        fs.writeFile(filepath, param.data as string | NodeJS.ArrayBufferView, this.callbackFactory(filepath, param.callback));
                    } else if (param.type === 'appendFile') {
                        fs.appendFile(filepath, param.data as string | Uint8Array, this.callbackFactory(filepath, param.callback));
                    } else {
                        console.log('error');
                    }
                } else {
                    // キューがなければ何もしない
                }
            }
        };
    };

    addQ = (type: 'writeFile' | 'appendFile', file: PathOrFileDescriptor, data: string | NodeJS.ArrayBufferView | Uint8Array, options?: WriteFileOptions | NoParamCallback, callback?: NoParamCallback): void => {
        const filepath = os.platform() === 'win32' ? `${'\\\\?\\'}${path.resolve(file.toString()).replace(/\//g, '\\')}` : file.toString();
        // console.log(`addQ: ${filepath} : ${type}`);
        // console.log(`addQ:${callback}`);
        // qMapの初期化
        if (!this.qMap[filepath]) {
            this.qMap[filepath] = { lock: false, q: [] };
        } else { }

        // キューに追加
        if (callback) {
            this.qMap[filepath].q.push({ type, file, data, options, callback });
        } else {
            this.qMap[filepath].q.push({ type, file, data, callback: options as NoParamCallback });
        }

        // ロックされているかどうか
        if (this.qMap[filepath].lock) {
        } else {
            // ロックされていない場合は書き込み
            this.callbackFactory(filepath, callback)(null);
        }
    }

    writeFile = (file: PathOrFileDescriptor, data: string | NodeJS.ArrayBufferView, options: WriteFileOptions | NoParamCallback, callback?: NoParamCallback): void => {
        // this.initDirectory(file.toString()); // 非同期の場合はディレクトリ存在チェックすると遅くなるのでやらない。
        this.addQ('writeFile', file, data, options, callback);
    }

    appendFile = (file: PathOrFileDescriptor, data: string | Uint8Array, options: WriteFileOptions | NoParamCallback, callback?: NoParamCallback): void => {
        // this.initDirectory(file.toString()); // 非同期の場合はディレクトリ存在チェックすると遅くなるのでやらない。
        this.addQ('appendFile', file, data, options, callback);
    }

    writeFileSync(file: PathOrFileDescriptor, data: string | NodeJS.ArrayBufferView, options?: WriteFileOptions): void {
        this.initDirectory(file.toString());
        const filePath = `${os.platform() === 'win32' ? '\\\\?\\' : ''}${file}`
        fs.writeFileSync(filePath, data, options);
    }

    appendFileSync(path: PathOrFileDescriptor, data: string | Uint8Array, options?: WriteFileOptions): void {
        this.initDirectory(path.toString());
        const filePath = `${os.platform() === 'win32' ? '\\\\?\\' : ''}${path}`
        fs.appendFileSync(filePath, data, options);
    }

    mkdirSync(path: fs.PathLike, options: fs.MakeDirectoryOptions & { recursive: true; } | (fs.MakeDirectoryOptions & { recursive?: false | undefined; }) | null): string | undefined {
        this.initDirectory(path.toString());
        return fs.mkdirSync(path, options);
    }

    initDirectory = (filepath: string): void => {
        const direname = path.dirname(filepath);
        // ディレクトリが無ければ掘る
        if (fs.existsSync(direname)) { } else { fs.mkdirSync(direname, { recursive: true }); console.log(`Directory ${direname} created.`); }
    }

    waitQ = (path: PathOrFileDescriptor): Promise<void> => {
        return new Promise<void>((resolve, reject) => {
            const qMap = this.qMap;
            const func = (path: string) => {
                if (!qMap[path] || qMap[path].lock || qMap[path].q.length) {
                    // console.log(`wait ${this.qMap[path.toString()].q.length} : ${path}`);
                    setTimeout(func, 100, path.toString());
                } else {
                    resolve();
                }
            };
            func(path.toString());
        });
    }

    /**
     * ディレクトリを再帰的に読み込む。
     * @param directory 
     * @returns 
     */
    getFilesRecursively(directory: string): string[] {
        const filesInDirectory = fs.readdirSync(directory);
        let filesList: string[] = [];

        for (const file of filesInDirectory) {
            const absolutePath = path.join(directory, file);
            if (fs.statSync(absolutePath).isDirectory()) {
                filesList = [...filesList, ...this.getFilesRecursively(absolutePath)];
            } else {
                filesList.push(absolutePath);
            }
        }

        return filesList;
    }
}

interface FsSafeParam {
    type: 'writeFile' | 'appendFile' | 'writeFileSync' | 'appendFileSync' | 'mkdirSync';
    file: PathOrFileDescriptor;
    data: string | NodeJS.ArrayBufferView | Uint8Array;
    options?: WriteFileOptions | NoParamCallback;
    callback?: NoParamCallback;
}

interface FsSafe {

    waitQ: (path: PathOrFileDescriptor) => Promise<void>;

    /**
     * When `file` is a filename, asynchronously writes data to the file, replacing the
     * file if it already exists. `data` can be a string or a buffer.
     *
     * When `file` is a file descriptor, the behavior is similar to calling`fs.write()` directly (which is recommended). See the notes below on using
     * a file descriptor.
     *
     * The `encoding` option is ignored if `data` is a buffer.
     *
     * The `mode` option only affects the newly created file. See {@link open} for more details.
     *
     * ```js
     * import { writeFile } from 'node:fs';
     * import { Buffer } from 'node:buffer';
     *
     * const data = new Uint8Array(Buffer.from('Hello Node.js'));
     * writeFile('message.txt', data, (err) => {
     *   if (err) throw err;
     *   console.log('The file has been saved!');
     * });
     * ```
     *
     * If `options` is a string, then it specifies the encoding:
     *
     * ```js
     * import { writeFile } from 'node:fs';
     *
     * writeFile('message.txt', 'Hello Node.js', 'utf8', callback);
     * ```
     *
     * It is unsafe to use `fs.writeFile()` multiple times on the same file without
     * waiting for the callback. For this scenario, {@link createWriteStream} is
     * recommended.
     *
     * Similarly to `fs.readFile` \- `fs.writeFile` is a convenience method that
     * performs multiple `write` calls internally to write the buffer passed to it.
     * For performance sensitive code consider using {@link createWriteStream}.
     *
     * It is possible to use an `AbortSignal` to cancel an `fs.writeFile()`.
     * Cancelation is "best effort", and some amount of data is likely still
     * to be written.
     *
     * ```js
     * import { writeFile } from 'node:fs';
     * import { Buffer } from 'node:buffer';
     *
     * const controller = new AbortController();
     * const { signal } = controller;
     * const data = new Uint8Array(Buffer.from('Hello Node.js'));
     * writeFile('message.txt', data, { signal }, (err) => {
     *   // When a request is aborted - the callback is called with an AbortError
     * });
     * // When the request should be aborted
     * controller.abort();
     * ```
     *
     * Aborting an ongoing request does not abort individual operating
     * system requests but rather the internal buffering `fs.writeFile` performs.
     * @since v0.1.29
     * @param file filename or file descriptor
     */
    writeFile(file: PathOrFileDescriptor, data: string | NodeJS.ArrayBufferView, options: WriteFileOptions, callback: NoParamCallback): void;
    /**
     * Asynchronously writes data to a file, replacing the file if it already exists.
     * @param path A path to a file. If a URL is provided, it must use the `file:` protocol.
     * If a file descriptor is provided, the underlying file will _not_ be closed automatically.
     * @param data The data to write. If something other than a Buffer or Uint8Array is provided, the value is coerced to a string.
     */
    writeFile(file: PathOrFileDescriptor, data: string | NodeJS.ArrayBufferView, callback: NoParamCallback): void;

    /**
     * Asynchronously append data to a file, creating the file if it does not yet
     * exist. `data` can be a string or a `Buffer`.
     *
     * The `mode` option only affects the newly created file. See {@link open} for more details.
     *
     * ```js
     * import { appendFile } from 'node:fs';
     *
     * appendFile('message.txt', 'data to append', (err) => {
     *   if (err) throw err;
     *   console.log('The "data to append" was appended to file!');
     * });
     * ```
     *
     * If `options` is a string, then it specifies the encoding:
     *
     * ```js
     * import { appendFile } from 'node:fs';
     *
     * appendFile('message.txt', 'data to append', 'utf8', callback);
     * ```
     *
     * The `path` may be specified as a numeric file descriptor that has been opened
     * for appending (using `fs.open()` or `fs.openSync()`). The file descriptor will
     * not be closed automatically.
     *
     * ```js
     * import { open, close, appendFile } from 'node:fs';
     *
     * function closeFd(fd) {
     *   close(fd, (err) => {
     *     if (err) throw err;
     *   });
     * }
     *
     * open('message.txt', 'a', (err, fd) => {
     *   if (err) throw err;
     *
     *   try {
     *     appendFile(fd, 'data to append', 'utf8', (err) => {
     *       closeFd(fd);
     *       if (err) throw err;
     *     });
     *   } catch (err) {
     *     closeFd(fd);
     *     throw err;
     *   }
     * });
     * ```
     * @since v0.6.7
     * @param path filename or file descriptor
     */
    appendFile(file: PathOrFileDescriptor, data: string | Uint8Array, options: WriteFileOptions, callback: NoParamCallback): void;
    /**
     * Asynchronously append data to a file, creating the file if it does not exist.
     * @param file A path to a file. If a URL is provided, it must use the `file:` protocol.
     * If a file descriptor is provided, the underlying file will _not_ be closed automatically.
     * @param data The data to write. If something other than a Buffer or Uint8Array is provided, the value is coerced to a string.
     */
    appendFile(file: PathOrFileDescriptor, data: string | Uint8Array, callback: NoParamCallback): void;

    /**
     * Returns `undefined`.
     *
     * The `mode` option only affects the newly created file. See {@link open} for more details.
     *
     * For detailed information, see the documentation of the asynchronous version of
     * this API: {@link writeFile}.
     * @since v0.1.29
     * @param file filename or file descriptor
     */
    writeFileSync(file: PathOrFileDescriptor, data: string | NodeJS.ArrayBufferView, options?: WriteFileOptions): void;

    /**
     * Synchronously append data to a file, creating the file if it does not yet
     * exist. `data` can be a string or a `Buffer`.
     *
     * The `mode` option only affects the newly created file. See {@link open} for more details.
     *
     * ```js
     * import { appendFileSync } from 'node:fs';
     *
     * try {
     *   appendFileSync('message.txt', 'data to append');
     *   console.log('The "data to append" was appended to file!');
     * } catch (err) {
     *   // Handle the error
     * }
     * ```
     *
     * If `options` is a string, then it specifies the encoding:
     *
     * ```js
     * import { appendFileSync } from 'node:fs';
     *
     * appendFileSync('message.txt', 'data to append', 'utf8');
     * ```
     *
     * The `path` may be specified as a numeric file descriptor that has been opened
     * for appending (using `fs.open()` or `fs.openSync()`). The file descriptor will
     * not be closed automatically.
     *
     * ```js
     * import { openSync, closeSync, appendFileSync } from 'node:fs';
     *
     * let fd;
     *
     * try {
     *   fd = openSync('message.txt', 'a');
     *   appendFileSync(fd, 'data to append', 'utf8');
     * } catch (err) {
     *   // Handle the error
     * } finally {
     *   if (fd !== undefined)
     *     closeSync(fd);
     * }
     * ```
     * @since v0.6.7
     * @param path filename or file descriptor
     */
    appendFileSync(path: PathOrFileDescriptor, data: string | Uint8Array, options?: WriteFileOptions): void;

    /**
     * Synchronously creates a directory. Returns `undefined`, or if `recursive` is`true`, the first directory path created.
     * This is the synchronous version of {@link mkdir}.
     *
     * See the POSIX [`mkdir(2)`](http://man7.org/linux/man-pages/man2/mkdir.2.html) documentation for more details.
     * @since v0.1.21
     */
    mkdirSync(path: fs.PathLike, options: fs.MakeDirectoryOptions & { recursive: true; }): string | undefined;
    /**
     * Synchronous mkdir(2) - create a directory.
     * @param path A path to a file. If a URL is provided, it must use the `file:` protocol.
     * @param options Either the file mode, or an object optionally specifying the file mode and whether parent folders
     * should be created. If a string is passed, it is parsed as an octal integer. If not specified, defaults to `0o777`.
     */
    mkdirSync(path: fs.PathLike, options?: | fs.Mode | (fs.MakeDirectoryOptions & { recursive?: false | undefined; }) | null): void;
    /**
     * Synchronous mkdir(2) - create a directory.
     * @param path A path to a file. If a URL is provided, it must use the `file:` protocol.
     * @param options Either the file mode, or an object optionally specifying the file mode and whether parent folders
     * should be created. If a string is passed, it is parsed as an octal integer. If not specified, defaults to `0o777`.
     */
    mkdirSync(path: fs.PathLike, options?: fs.Mode | fs.MakeDirectoryOptions | null): string | undefined;


    /**
     * ディレクトリを再帰的に読み込む。
     * @param directory 
     * @returns 
     */
    getFilesRecursively(directory: string): string[];
}
export default new FsSafeImpl() as FsSafe;
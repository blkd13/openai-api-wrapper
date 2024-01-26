import { fileURLToPath } from 'url';
import * as http from 'http';
import * as url from 'url';
import { ChatCompletionCreateParamsStreaming } from 'openai/resources/chat/completions';

import { OpenAIApiWrapper } from '../common/openai-api-wrapper.js';

interface Client {
    id: string;
    response: http.ServerResponse;
}

const basePath = '/api';
const clients: Record<string, Client> = {};

export const aiApi = new OpenAIApiWrapper();

let serverOptions: { cors: boolean } = { cors: false };

const server = http.createServer((req, res) => {
    const reqUrl = url.parse(req.url || '', true);
    // console.log(`${req.method} ${reqUrl.pathname}`);
    console.log(`${req.method} ${req.url}`);
    if (req.method === 'GET' && reqUrl.pathname === '/') {
        // HTML文字列を返す
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`
        <!DOCTYPE html>
        <html>
        
        <head>
            <title>SSE Chat Client</title>
        </head>
        
        <body>
            <h1>SSE Chat</h1>
            <form action="javascript:void(0);" method="post">
                <input type="text" name="prompt" />
                <input type="submit" value="Send" />
            </form>
            <div id="chat"></div>
        
            <script>
                const chat = document.getElementById('chat');
                const form = document.querySelector('form');
                const prompt = form.querySelector('input[name="prompt"]');
        
                form.addEventListener('submit', function (e) {
                    // フォームの送信をキャンセル
                    e.preventDefault();
        
                    let isSend = false;
                    // uuidを生成
                    const clientId = Math.random().toString(36).slice(-8);
                    const eventSource = new EventSource('/api/events?id=' + clientId);
                    eventSource.addEventListener('open', function (e) {
                        console.log('open');
                        if (!isSend) {
                            isSend = true;
                            // 初回のみサーバーにメッセージを送信
                            const data = { prompt: prompt.value };
                            const xhr = new XMLHttpRequest();
                            xhr.open('POST', '/api/send?id=' + clientId, true);
                            xhr.setRequestHeader('Content-Type', 'application/json');
                            xhr.addEventListener('load', function () {
                                prompt.value = '';
                            });
                            xhr.send(JSON.stringify(data));
                        } else { /** do nothing */ }
                    });
        
                    const chatResponse = document.createElement('div');
                    chat.appendChild(chatResponse);
                    eventSource.addEventListener('message', function (e) {
                        e.data.split('\\n').forEach(function (line) {
                            if (line.startsWith('[DONE]')) {
                                eventSource.close();
                                chatResponse.innerText += 'DONE';
                            } else if (line.startsWith('{')) {
                                const data = JSON.parse(line);
                                chatResponse.innerText += data.data;
                            }
                        });
                    });
        
                    eventSource.addEventListener('error', function (e) {
                        if (e.readyState == EventSource.CLOSED) {
                            eventSource.close();
                            chatResponse.innerText += 'CLOSED';
                        } else {
                            chatResponse.innerText += 'ERROR';
                        }
                    });
                });
            </script>
        </body>
        
        </html>
        `);
    } else if (reqUrl.pathname === '/api/events') {
        // console.log(`${req.method} ${req.url}`);
        // idがクエリパラメータに含まれていなければ400エラー
        if (!reqUrl.query['id']) {
            res.writeHead(400);
            res.end();
            return;
        } else { /** do nothing */ }
        // クライアントIDを取得
        const clientId = reqUrl.query['id'] as string;

        // TODO 再接続の場合もありうる？
        // // クライアントが存在していればID重複なので400エラー
        // if (clients[reqUrl.query['id'] as string]) {
        //     res.writeHead(400);
        //     res.end();
        //     return;
        // } else { /** do nothing */ }

        // クライアントIDを登録
        clients[clientId] = { id: clientId, response: res };

        req.on('close', () => {
            delete clients[clientId]; // クライアントが切断した場合、リストから削除
            console.log(`${req.method} ${req.url} req.on(close)`)
        });

        if (serverOptions.cors) {
            res.setHeader('Access-Control-Allow-Origin', '*'); // CORS許可設定
        } else { /** do nothing */ }
        // レスポンスヘッダーを設定
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
        });
        console.log(`${req.method} ${req.url} event-stream open`)

        // クライアントに接続したことを通知
        // res.flushHeaders(); // flushHeaders()がないとヘッダーが飛ばない
        // 開始イベントを送信する。こうするとクライアント側でonopenが呼ばれる
        clients[clientId]?.response.write('event: chatCompletionStream\n\n');
    } else if (['POST', 'OPTIONS', 'GET'].includes(req.method || '') && reqUrl.pathname === '/api/send') {
        // console.log(`${req.method} ${req.url} ${reqUrl.query['id']} ${reqUrl.query['threadId']}`);

        if (serverOptions.cors) {
            // CORS許可設定
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Access-Control-Allow-Headers, Authorization, X-Requested-With');
            res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS, GET');
            if ('OPTIONS' === req.method) {
                // preflightリクエストの場合は200を返す
                res.writeHead(200);
                res.end();
                return;
            } else { }
        } else { }

        // idがクエリパラメータに含まれていなければ400エラー
        if (!reqUrl.query['id'] || !reqUrl.query['threadId']) {
            console.log(`${req.method} ${req.url} ${reqUrl.query['id']} not id or thread ${reqUrl.query['threadId']}`);
            res.writeHead(400);
            res.end();
            return;
        } else { /** do nothing */ }
        // クライアントIDを取得
        const clientId = reqUrl.query['id'] as string;
        const threadId = reqUrl.query['threadId'] as string;

        // クライアントが存在していなければ初期化漏れなので400エラー
        if (!clients[reqUrl.query['id'] as string]) {
            console.log(`${req.method} ${req.url} ${reqUrl.query['id']} not clients ${Object.keys(clients)}`);
            res.writeHead(400);
            res.end();
            return;
        } else { /** do nothing */ }

        let body = '';
        req.on('data', chunk => {
            body += chunk.toString(); // データを文字列として結合
        });
        req.on('end', () => {
            // データの受信が完了したらチャットメッセージを生成
            const json = JSON.parse(body) as { args: ChatCompletionCreateParamsStreaming, options?: { idempotencyKey?: string }, };
            // console.log(body);

            json.args.model = json.args.model || 'gpt-4-turbo-preview';
            let text = '';
            aiApi.chatCompletionObservableStream(
                json.args, {
                label: `chat-${clientId}-${threadId}`,
            }).subscribe({
                next: next => {
                    const resObj = {
                        data: { threadId, content: next },
                        event: 'message',
                    };
                    clients[clientId]?.response.write(`data: ${JSON.stringify(resObj)}\n\n`);
                    text += next;
                },
                error: error => {
                    console.log(error);
                    clients[clientId]?.response.end(error);
                },
                complete: () => {
                    clients[clientId]?.response.write(`data: [DONE] ${threadId}\n\n`);
                    // console.log(text);
                },
            });
            res.end(JSON.stringify({ status: 'ok' }));
            req.on('close', () => {
                res.end();
            });
        });
    } else {
        res.writeHead(404);
        res.end();
    }
});

export function main(hostname: string = 'localhost', port: number = 3000, allowLocalFiles: boolean = true, cors: boolean = false) {
    aiApi.wrapperOptions.allowLocalFiles = allowLocalFiles;
    serverOptions.cors = cors;
    server.listen(port, hostname, () => {
        console.log(`Server running at http://${hostname}:${port}/`);
        console.log(`allowLocalFiles=${allowLocalFiles}`);
    });
}

/**
 * このファイルが直接実行された場合のコード。
 */
if (fileURLToPath(import.meta.url) === process.argv[1]) {
    main(process.argv[2], Number(process.argv[3]), process.argv[4] === 'true', process.argv[5] === 'true');
} else {
    // main実行じゃなかったら何もしない
}

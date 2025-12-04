
// import { OpenAI } from 'openai/client.js';
// import fss from '../../fss.js';
// import { HISTORY_DIRE } from '../../openai-api-wrapper.js';
// import { Utils } from '../../utils.js';
// import { MyVertexAiClient } from './my-vertexai.js';
// import { ExecutorContext } from './types.js';

// export class MyGemini extends MyVertexAiClient{
//     counter = 0;

//     // constructor(public params: OpenAIConfig[]) {
//     //     this.clients = params.flatMap(param =>
//     //         param.endpoints.map(endpoint => new googleGenerativeAI.GoogleGenerativeAI(endpoint.apiKey))
//     //     );
//     // }

//     // get client(): googleGenerativeAI.GoogleGenerativeAI {
//     //     const client = this.clients[this.counter % this.clients.length];
//     //     this.counter++;
//     //     return client;
//     // }

//     async executor(
//         ctx: ExecutorContext,
//     ): Promise<void> {
//         const args = ctx.commonArgs;
//         const options = ctx.options || {};
        
//         // vertexホストのllamaとか。
//         for (const key of ['safetySettings', 'cachedContent', 'gcpProjectId', 'isGoogleSearch']) delete (args as any)[key]; // Gemini用プロパティを消しておく
//         fss.writeFile(`${HISTORY_DIRE}/${ctx.idempotencyKey}-${ctx.attempts}.request.json`, JSON.stringify({ args, options }, Utils.genJsonSafer()), {}, (err) => { });
//         // vertexai でllama3を使う場合。
//         const runPromise = this.client.getAccessToken().then(async token => {
//             const REGION = 'us-central1';

//             // const ENDPOINT = `us-central1-aiplatform.googleapis.com`;
//             const ENDPOINT = `us-central1-${GCP_API_BASE_PATH}`;
//             const client = new OpenAI({
//                 apiKey: token,
//                 baseURL: `https://${ENDPOINT}/v1beta1/projects/${GCP_PROJECT_ID}/locations/${REGION}/endpoints/openapi/`,
//             });

//             // llama3は構造化されたcontentに対応していないのでただのstringにする
//             args.messages.forEach(message => {
//                 if (!message.content) {
//                 } else if (typeof message.content === 'string') {
//                     // 文字列ならそのまま
//                 } else if (typeof message.content === 'object') {
//                     // 構造化contextになっていたらただのstringに戻す。
//                     if (Array.isArray(message.content)) {
//                         message.content = message.content.map(content => {
//                             content.type;
//                             if (content.type === 'text') {
//                                 return content.text;
//                             } else if (content.type === 'image_url') {
//                                 if (content.image_url && content.image_url.url) {
//                                     return content.image_url.url;
//                                 } else { }
//                                 // } else if (content.type === 'input_audio') {
//                                 //     // TODO 
//                                 // } else if (content.type === 'refusal') {
//                                 //     // TODO 
//                             } else { }
//                         }).join('\n');
//                     } else { }
//                 }
//             });
//             await (client.chat.completions.create(args, options) as APIPromise<Stream<OpenAI.ChatCompletionChunk>>)
//                 .withResponse().then(async (response) => {
//                     response.response.headers.get('x-ratelimit-limit-requests') && (ratelimitObj.limitRequests = Number(response.response.headers.get('x-ratelimit-limit-requests')));
//                     response.response.headers.get('x-ratelimit-limit-tokens') && (ratelimitObj.limitTokens = Number(response.response.headers.get('x-ratelimit-limit-tokens')));
//                     response.response.headers.get('x-ratelimit-remaining-requests') && (ratelimitObj.remainingRequests = Number(response.response.headers.get('x-ratelimit-remaining-requests')));
//                     response.response.headers.get('x-ratelimit-remaining-tokens') && (ratelimitObj.remainingTokens = Number(response.response.headers.get('x-ratelimit-remaining-tokens')));
//                     response.response.headers.get('x-ratelimit-reset-requests') && (ratelimitObj.resetRequests = response.response.headers.get('x-ratelimit-reset-requests') || '');
//                     response.response.headers.get('x-ratelimit-reset-tokens') && (ratelimitObj.resetTokens = response.response.headers.get('x-ratelimit-reset-tokens') || '');

//                     const headers: { [key: string]: string } = {};
//                     response.response.headers.forEach((value, key) => {
//                         // console.log(`${key}: ${value}`);
//                         headers[key] = value;
//                     });
//                     fss.writeFile(`${HISTORY_DIRE}/${idempotencyKey}-${attempts}.response.json`, JSON.stringify({ args, options, response: { status: response.response.status, headers } }, Utils.genJsonSafer()), {}, (err) => { });

//                     // ストリームからデータを読み取るためのリーダーを取得
//                     const reader = response.data.toReadableStream().getReader();

//                     let tokenBuilder: string = '';
//                     let isThinking = false;
//                     const _that = this;

//                     // ストリームからデータを読み取る非同期関数
//                     async function readStream() {
//                         while (true) {
//                             const { value, done } = await reader.read();
//                             if (done) {
//                                 // ストリームが終了したらループを抜ける
//                                 tokenCount.cost = tokenCount.calcCost();
//                                 console.log(logObject.output('fine', ''));
//                                 observer.complete();

//                                 _that.openApiWrapper.fire();

//                                 // ファイルに書き出す
//                                 const trg = args.response_format?.type === 'json_object' ? 'json' : 'md';
//                                 fss.writeFile(`${HISTORY_DIRE}/${idempotencyKey}-${attempts}.result.${trg}`, tokenBuilder || '', {}, () => { });
//                                 break;
//                             }
//                             // 中身を取り出す
//                             const content = decoder.decode(value).replaceAll(/\\\\n/g, '\\n');
//                             // console.log(content);

//                             // 中身がない場合はスキップ
//                             if (!content) { continue; }
//                             // ファイルに書き出す
//                             fss.appendFile(`${HISTORY_DIRE}/${idempotencyKey}-${attempts}.txt`, content || '', {}, () => { });
//                             // console.log(`${tokenCount.completion_tokens}: ${data.toString()}`);
//                             // トークン数をカウント
//                             tokenCount.completion_tokens++;
//                             const obj = JSON.parse(content) as OpenAI.ChatCompletionChunk;
//                             const text = obj.choices[0].delta.content || '';

//                             // <think></think> タグがある場合は、isThinkingをtrueにする。
//                             if (!tokenBuilder && text.trim() === '<think>') {
//                                 isThinking = true;
//                                 obj.choices.forEach(choice => delete choice.delta.content);
//                             } else if (isThinking) {
//                                 if (text.trim() === '</think>') {
//                                     isThinking = false;
//                                 } else {
//                                     obj.choices.forEach(choice => {
//                                         delete choice.delta.content;
//                                         (choice.delta as any).thinking = text;
//                                     });
//                                 }
//                             }
//                             // streamHandlerを呼び出す
//                             observer.next(obj);
//                         }
//                         return;
//                     }
//                     // ストリームの読み取りを開始
//                     return await readStream();
//                 });
//         })
//     }
// }




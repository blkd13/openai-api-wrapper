import { promises as fs } from 'fs';
import { detect } from 'jschardet';
import { map, toArray } from "rxjs";

import { convertPptxToPdf } from '../../common/media-funcs.js';
import { MyToolType, OpenAIApiWrapper, plainExtensions, plainMime } from "../../common/openai-api-wrapper.js";
import { convertToPdfMimeList } from '../../common/pdf-funcs.js';
import { Utils } from "../../common/utils.js";
import { boxDownloadCore } from "../api/api-box.js";
import { getAIProvider, MessageArgsSet } from "../controllers/chat-by-project-model.js";
import { ds } from "../db.js";
import { BoxApiItemCollection, BoxFileBodyEntity } from "../entity/api-box.entity.js";
import { ContentPartEntity, MessageEntity, MessageGroupEntity, PredictHistoryWrapperEntity } from "../entity/project-models.entity.js";
import { UserRequest } from "../models/info.js";
import { getOAuthAccountForTool, reform } from "./common.js";


// 1. 関数マッピングの作成
export async function boxFunctionDefinitions(
    providerName: string,
    obj: { inDto: MessageArgsSet; messageSet: { messageGroup: MessageGroupEntity; message: MessageEntity; contentParts: ContentPartEntity[]; }; },
    req: UserRequest, aiApi: OpenAIApiWrapper, connectionId: string, streamId: string, message: MessageEntity, label: string,
): Promise<MyToolType[]> {
    const provider = `box-${providerName}`;
    return [
        // Box コンテンツ取得 API
        {
            info: { group: provider, isActive: true, isInteractive: false, label: `BOXのAIにファイルについて問い合わせる`, responseType: 'markdown' },
            definition: {
                type: 'function',
                function: {
                    name: `box_${providerName}_ai_content`,
                    description: `指定されたファイルIDに基づいてBOX-AIに問い合わせる`,
                    parameters: {
                        type: 'object',
                        properties: {
                            file_id: {
                                type: 'string',
                                description: '取得するファイルのID'
                            },
                            userPrompt: {
                                type: 'string',
                                description: 'AIに質問する内容'
                            },
                            // max_pages: {
                            //     type: 'integer', default: 10, description: '取得する最大ページ数（PDFなどのページがあるファイル形式に適用）',
                            // },
                            // format: {
                            //     type: 'string',
                            //     enum: ['text', 'json', 'binary'],
                            //     description: '返却するコンテンツの形式',
                            //     default: 'text'
                            // }
                        },
                        required: ['file_id'],
                    }
                }
            },
            handler: async (args: { file_id: string, userPrompt?: string, }): Promise<any> => {
                const { e } = await getOAuthAccountForTool(req, provider);
                const { file_id, userPrompt = 'ファイルの内容を教えてください。' } = args;
                const boxFile = await boxDownloadCore(e, file_id, req.info.user.id, req.info.ip);
                const boxFileBody = await ds.getRepository(BoxFileBodyEntity).findOneOrFail({
                    where: { sha256: boxFile.sha256Digest },
                });

                if (boxFile.fileSize > 1024 * 1024 * 1024 * 30) {
                    throw new Error('30MB以上のファイルの内容は処理できません。');
                } else { }

                let buffer;

                if (convertToPdfMimeList.includes(boxFileBody.fileType)) {
                    const outputPath = boxFileBody.innerPath.replaceAll(/\.[^.]*$/g, '.pdf');
                    boxFileBody.fileType = 'application/pdf';
                    try {
                        console.log(outputPath);
                        buffer = await fs.readFile(outputPath);
                        console.log(`Already converted. ${outputPath}`);
                    } catch (error) {
                        console.log(`Convert to PDF. ${outputPath}`);
                        await convertPptxToPdf(boxFileBody.innerPath, outputPath);
                        buffer = await fs.readFile(outputPath);
                    }
                } else {
                    buffer = await fs.readFile(boxFileBody.innerPath);
                }

                if (boxFileBody.fileType.startsWith('text/') || plainExtensions.includes(boxFileBody.innerPath) || plainMime.includes(boxFileBody.fileType) || boxFileBody.fileType.endsWith('+xml')) {

                    boxFileBody.fileType = (boxFileBody.fileType === 'application/octet-stream') ? 'text/plain' : boxFileBody.fileType;
                    let decodedString;
                    // テキストファイルの場合はデコードしてテキストにしてしまう。
                    if (buffer && buffer.length > 0) {
                        const data = buffer;
                        const detectedEncoding = detect(data);
                        if (detectedEncoding.encoding === 'ISO-8859-2') {
                            detectedEncoding.encoding = 'Windows-31J'; // 文字コード自動判定でSJISがISO-8859-2ことがあるので
                        } else if (!detectedEncoding.encoding) {
                            detectedEncoding.encoding = 'Windows-31J'; // nullはおかしいのでとりあえず
                        }
                        if (['UTF-8', 'ascii'].includes(detectedEncoding.encoding)) {
                        } else {
                            // 他の文字コードの場合は変換しておく
                            const decoder = new TextDecoder(detectedEncoding.encoding);
                            decodedString = decoder.decode(data);
                            buffer = Buffer.from(decodedString);
                            // console.log(`time ${new Date()} ${detectedEncoding.encoding} ${decodedString.substring(0, 20)}`);
                            // console.log(`time ${new Date()} ${ext} ${fileType} ${detectedEncoding.encoding} ${innerPath} ${pathBase}-original${ext}`);
                            // console.log(`time ${new Date()} ${ext} ${detectedEncoding.encoding} ${fileType}`);
                            // await fs.rename(boxFileBody.innerPath, `${pathBase}-original${ext}`);
                            // await fs.writeFile(boxFileBody.innerPath, decodedString);
                        }
                    } else {
                        // 空の場合はデコーダーに掛けると面倒なので直接空文字を入れる
                        decodedString = '';
                    }
                } else { }

                const base64String = buffer.toString('base64');
                const dataURL = `data:${boxFileBody.fileType};base64,${base64String}`;

                const systemPrompt = 'アシスタントAI';
                const model = 'gemini-2.5-pro';

                const inDto = Utils.deepCopyOmitting(obj.inDto, 'aiProviderClient');
                inDto.args.model = model || inDto.args.model; // modelが指定されていない場合は元のモデルを使う
                inDto.args.messages = [
                    { role: 'system', content: [{ type: 'text', text: systemPrompt }] },
                    {
                        role: 'user', content: [
                            { type: 'text', text: userPrompt },
                            { type: 'image_url', image_url: { url: dataURL, } },
                        ],
                    },
                ];
                // toolは使わないので空にしておく
                delete inDto.args.tool_choice;
                delete inDto.args.tools;

                const aiProvider = await getAIProvider(req.info.user, inDto.args.model);

                const newLabel = `${label}-call_ai-${model}`;
                // レスポンス返した後にゆるりとヒストリーを更新しておく。
                const history = new PredictHistoryWrapperEntity();
                history.orgKey = req.info.user.orgKey;
                history.connectionId = connectionId;
                history.streamId = streamId;
                history.messageId = message.id;
                history.label = newLabel;
                history.model = inDto.args.model;
                history.provider = aiProvider.type;
                history.createdBy = req.info.user.id;
                history.updatedBy = req.info.user.id;
                history.createdIp = req.info.ip;
                history.updatedIp = req.info.ip;
                await ds.getRepository(PredictHistoryWrapperEntity).save(history);

                return new Promise((resolve, reject) => {
                    let text = '';
                    // console.log(`call_ai: model=${model}, userPrompt=${userPrompt}`);
                    aiApi.chatCompletionObservableStream(
                        inDto.args, { label: newLabel }, aiProvider,
                    ).pipe(
                        map(res => res.choices.map(choice => choice.delta.content).join('')),
                        toArray(),
                        map(res => res.join('')),
                    ).subscribe({
                        next: next => {
                            text += next;
                        },
                        error: error => {
                            reject(error);
                        },
                        complete: () => {
                            resolve(text);
                        },
                    });;
                });
            }
        },
        // // AI 要約 API
        // {
        //     info: { group: provider, isActive: true, isInteractive: false, label: `BOXのファイルコンテンツをAIで要約`, },
        //     definition: {
        //         type: 'function',
        //         function: {
        //             name: 'box_ai_summarize',
        //             description: `指定されたBOXファイルのコンテンツについてAIに質問をします。`,
        //             parameters: {
        //                 type: 'object',
        //                 properties: {
        //                     file_id: {
        //                         type: 'string',
        //                         description: '対象のファイルのID'
        //                     },
        //                     prompt: {
        //                         type: 'string',
        //                         description: 'AIに提示する質問の内容'
        //                     },
        //                 },
        //                 required: ['file_id']
        //             }
        //         }
        //     },
        //     handler: async (args: {
        //         file_id: string,
        //         prompt: string,
        //     }): Promise<any> => {
        //         const provider = provider;
        //         const e = readOAuth2Env(provider);

        //         // まず、ファイルコンテンツ取得APIを内部的に呼び出す
        //         const oAuthAccount = await ds.getRepository(OAuthAccountEntity).findOneOrFail({
        //             where: { provider, userId: req.info.user.id }
        //         });

        //         // ファイルの詳細情報を取得
        //         const fileInfoUrl = `${e.uriBase}/2.0/files/${args.file_id}`;
        //         const fileInfo = (await e.axios.get(fileInfoUrl, {
        //             headers: { 'Authorization': `Bearer ${oAuthAccount.accessToken}`, 'Content-Type': 'application/json' }
        //         })).data;

        //         // ファイルのコンテンツを取得
        //         const contentUrl = `${e.uriBase}/2.0/files/${args.file_id}/content`;
        //         const contentResponse = await e.axios.get(contentUrl, {
        //             headers: { 'Authorization': `Bearer ${oAuthAccount.accessToken}` },
        //             responseType: 'text'
        //         });

        //         const content = contentResponse.data;

        //         // AIモデルへの入力を準備
        //         let prompt = args.prompt || `以下のテキストを要約してください：\n\n${content}\n\n`;


        //         // AIモデルを使用して要約を生成
        //         const summary = await providerPrediction(aiApi, {
        //             messages: [{ role: 'user', content: prompt }],
        //             temperature: 0.3,
        //             max_tokens: 1000
        //         }, {
        //             connectionId,
        //             streamId,
        //             message,
        //             label: label + '-summary'
        //         });

        //         const result = {
        //             file_info: {
        //                 id: fileInfo.id,
        //                 name: fileInfo.name,
        //                 size: fileInfo.size,
        //                 created_at: fileInfo.created_at,
        //                 modified_at: fileInfo.modified_at,
        //                 extension: fileInfo.extension,
        //                 owner: fileInfo.owned_by.name
        //             },
        //             summary: summary.choices[0].message.content,
        //             uriBase: e.uriBase
        //         };

        //         reform(result);
        //         return result;
        //     }
        // },
        {
            info: { group: provider, isActive: true, isInteractive: false, label: `BOXのコンテンツを検索`, responseType: 'text' },
            definition: {
                type: 'function',
                function: {
                    name: `box_${providerName}_search`,
                    description: `ユーザーのコンテンツまたは会社全体でファイル、フォルダ、ウェブリンク、および共有ファイルを検索します。`,
                    parameters: {
                        type: 'object',
                        properties: {
                            query: {
                                type: 'string',
                                description: Utils.trimLines(`
                                    検索する文字列。以下の演算子がサポートされます：
                                        - "" - 二重引用符で囲むと完全一致検索
                                        - AND - 両方の検索語句を含む項目を検索 (例: marketing AND BoxWorks)
                                        - OR - いずれかの検索語句を含む項目を検索
                                        - NOT - 指定された検索語句を除外 (例: marketing AND NOT BoxWorks)
                                `)
                            },
                            type: {
                                type: 'string',
                                enum: ['file', 'folder', 'web_link'],
                                description: '検索結果を特定のタイプに絞り込み（file=ファイル、folder=フォルダ、web_link=ウェブリンク）'
                            },
                            content_types: {
                                type: 'array',
                                items: { type: 'string' },
                                description: Utils.trimLines(`
                                    検索対象とする項目の部分を指定：
                                        - name: 項目の名前
                                        - description: 項目の説明
                                        - file_content: ファイルの実際のコンテンツ
                                        - comments: コメントのコンテンツ
                                        - tags: 項目に適用されるタグ
                                `)
                            },
                            file_extensions: {
                                type: 'array', items: { type: 'string' },
                                description: '検索対象のファイル拡張子（例: ["pdf", "png", "gif"]）'
                            },
                            created_at_range: {
                                type: 'array', items: { type: 'string' },
                                description: '作成日の範囲をRFC3339形式で指定（例: ["2014-05-15T13:35:01-07:00", "2014-05-17T13:35:01-07:00"]）'
                            },
                            updated_at_range: {
                                type: 'array', items: { type: 'string' },
                                description: '更新日の範囲をRFC3339形式で指定'
                            },
                            size_range: {
                                type: 'array', items: { type: 'integer' },
                                description: 'ファイルサイズの範囲をバイト単位で指定（例: [1000000, 5000000]）'
                            },
                            sort: {
                                type: 'string', enum: ['relevance', 'modified_at'], default: 'relevance',
                                description: '結果の並び順（relevance=関連度順、modified_at=更新日時順）'
                            },
                            direction: {
                                type: 'string', enum: ['DESC', 'ASC'], default: 'DESC',
                                description: '並び順の方向（DESC=降順、ASC=昇順）'
                            },
                            limit: {
                                type: 'integer', minimum: 1, maximum: 200, default: 30,
                                description: '1ページあたりの最大結果数（1-200）'
                            },
                            offset: {
                                type: 'integer', minimum: 0, maximum: 10000, default: 0,
                                description: '結果の開始位置（10000以下）'
                            },
                            trash_content: {
                                type: 'string',
                                enum: ['non_trashed_only', 'trashed_only', 'all_items'],
                                default: 'non_trashed_only',
                                description: 'ごみ箱の検索設定（non_trashed_only=通常項目のみ、trashed_only=ごみ箱のみ、all_items=すべて）'
                            }
                        },
                        required: ['query']
                    }
                }
            },
            handler: async (args: {
                query: string,
                type?: string,
                content_types?: string[],
                file_extensions?: string[],
                created_at_range?: string[],
                updated_at_range?: string[],
                size_range?: number[],
                sort?: string,
                direction?: string,
                limit?: number,
                offset?: number,
                trash_content?: string
            }): Promise<any> => {
                const { e, axiosWithAuth } = await getOAuthAccountForTool(req, provider);
                // クエリパラメータの構築
                const params = new URLSearchParams();
                params.append('query', args.query);

                // オプショナルパラメータの追加
                if (args.type) params.append('type', args.type);
                if (args.content_types) params.append('content_types', args.content_types.join(','));
                if (args.file_extensions) params.append('file_extensions', args.file_extensions.join(','));
                if (args.created_at_range) params.append('created_at_range', args.created_at_range.join(','));
                if (args.updated_at_range) params.append('updated_at_range', args.updated_at_range.join(','));
                if (args.size_range) params.append('size_range', args.size_range.join(','));
                if (args.sort) params.append('sort', args.sort);
                if (args.direction) params.append('direction', args.direction);
                if (args.limit) params.append('limit', args.limit.toString());
                if (args.offset) params.append('offset', args.offset.toString());
                if (args.trash_content) params.append('trash_content', args.trash_content);

                const url = `${e.uriBase}/2.0/search?${params.toString()}`;

                const resultResponse = (await axiosWithAuth.get(url)).data;
                const columns = [
                    'type',
                    'id',
                    // 'file_version',
                    // 'sequence_id',
                    // 'etag',
                    // 'sha1',
                    'name',
                    'description',
                    'size',
                    // 'path_collection',
                    // 'created_at',
                    // 'modified_at',
                    // 'trashed_at',
                    // 'purged_at',
                    // 'content_created_at',
                    // 'content_modified_at',
                    // 'created_by',
                    // 'modified_by',
                    // 'owned_by',
                    // 'shared_link',
                    // 'item_status',
                ];
                const items = resultResponse as BoxApiItemCollection;
                const text = items.entries.map(e => {
                    const path = ((e as any).path_collection.entries as any[]).map(entry => entry.name).join('/');
                    return `${e.type === 'folder' ? 'd' : '-'}\t${e.id}\t${(e as any).size}\t${path}/${e.name}`;
                }).join('\n');
                return `uriBase=${e.uriBase}\n\n${text}\n\n`;
            }
        },
        {
            info: { group: provider, isActive: true, isInteractive: false, label: `box：自分のユーザー情報`, },
            definition: {
                type: 'function', function: {
                    name: `box_${providerName}user_info`,
                    description: `box：自分のユーザー情報`,
                    parameters: { type: 'object', properties: {}, }
                }
            },
            handler: async (args: {}): Promise<any> => {
                const { e, axiosWithAuth } = await getOAuthAccountForTool(req, provider);
                let url;
                url = `${e.uriBase}${e.pathUserInfo}`;
                const result = (await axiosWithAuth.get(url)).data;
                reform(result);
                result.uriBase = e.uriBase;
                return result;
            }
        },
    ]
};

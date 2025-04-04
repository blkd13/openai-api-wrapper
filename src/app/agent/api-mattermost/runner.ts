import * as glob from 'glob';
import * as fs from 'fs';
import { fileURLToPath } from 'url';

import { Utils } from '../../common/utils.js';
import fss from '../../common/fss.js';
import { ds } from './../../service/db.js';
import { MmUserEntity, MmUserPreEntity } from './../../service/entity/api-mattermost.entity.js';
import { ApiMattermostService, GetChannelsPostsResponse, MattermostChannel, MattermostTeam } from './api.js';

function sleep(ms: number) {
    if (ms < 0) {
        return Promise.resolve();
    } else {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

async function getAllEmoji(api: ApiMattermostService) {
    let result;
    let counter = 0;
    const perPage = 200;
    while (true) {
        const before = Date.now();
        result = await api.emojiAll(perPage, counter); // 実行する非同期処理
        console.log(result.data.length);
        fss.writeFileSync(`results/api-mattermost/emoji/emoji-${counter * perPage}-${(counter + 1) * perPage}.json`, JSON.stringify(result.data));
        await sleep(1000 - (Date.now() - before));

        // 条件をチェックして更新
        if (result.data.length >= perPage) {
            // break;
        } else {
            break;
        }
        counter++;
    }
    console.log('Condition met, stopping execution');
}

/***
 * バッチでユーザー取得
 */
async function getAllUsers(api: ApiMattermostService) {
    let result;
    let counter = 0;
    const perPage = 200;
    while (true) {
        const before = Date.now();
        result = await api.usersAll(perPage, counter); // 実行する非同期処理
        console.log(`${result.data.length} ${counter * perPage}-${(counter + 1) * perPage}`);
        fss.writeFileSync(`results/api-mattermost/users/user-${counter * perPage}-${(counter + 1) * perPage}.json`, JSON.stringify(result.data));
        await sleep(1000 - (Date.now() - before));

        // 条件をチェックして更新
        if (result.data.length === perPage) {
            // break;
        } else {
            break;
        }
        counter++;
    }
    console.log('Condition met, stopping execution');
}

// DBインサート
async function insert() {
    const files = glob.sync('results/api-mattermost/users/user-*.json');
    console.log(files);

    let seq = 1;
    await ds.transaction(async tm => {
        const queryRunner = tm.queryRunner;
        const tableName = `mm_user_pre_entity`;
        if (queryRunner) {
            try {
                await queryRunner.query(`TRUNCATE TABLE ${tableName}`);
            } catch (error) {
                console.error('Error truncating table in transaction:', error);
                throw error; // エラーを再スローしてトランザクションをロールバックさせる
            }
            return files.map(async (file, index) => {
                const jsonString = fs.readFileSync(file, 'utf-8');
                const jsonObject = JSON.parse(jsonString) as MmUserPreEntity[];
                jsonObject.forEach(obj => {
                    obj.tenantKey = 'common';
                    obj.seq = seq;
                    seq++;
                    if (obj.delete_at) {
                        obj.delete_at = new Date(obj.delete_at);
                    } else {
                        obj.delete_at = undefined;
                    }
                    obj.create_at = new Date(obj.create_at);
                    obj.update_at = new Date(obj.update_at);
                })
                // const allUsers = await ds.getRepository(MmUserEntity).find();
                console.log(jsonObject.length, index);
                return tm.insert(MmUserPreEntity, jsonObject);
            })
        } else {
            //
        }
    });
}


async function channels(api: ApiMattermostService) {
    let result;
    const perPage = 200;
    const userChannels = await api.userChannels('me', 0, true);
    // キャッシュ使う場合はこっち
    // const userChannels = {} as Record<string, MattermostChannel[]>;
    // userChannels.data = JSON.parse(fs.readFileSync(`results/api-mattermost/channels.json`, 'utf-8')) as MattermostChannel[];
    // console.log(userChannels.data);
    fss.writeFileSync(`results/api-mattermost/channels.json`, JSON.stringify(userChannels.data));

    let channelIndex = 0;
    for (const channel of userChannels.data) {
        // // console.log(channel.total_msg_count, channel.total_msg_count_root, channel.display_name);
        // if (channel.id == 'c6i8epjrp7dpid6so3iu4q1mey') {
        //     // 1abnffpuk3bmurip6z6c9qds8a
        // } else {
        //     continue;
        // }
        let counter = 0;
        while (true) {
            const before = Date.now();
            result = await api.mattermostChannelsPosts(channel.id, counter, perPage, undefined, undefined, undefined, false); // 実行する非同期処理
            let index = '';
            const posts = result.data.posts;
            const keys = result.data.order;
            if (keys?.length === 0) {
                // 中身無しチャネルは何もしないで終了。
                break;
            }
            // console.log(result.data);
            if (posts && keys) {
                index = `${result.data.next_post_id || 'curr'}_${posts[keys[0]].id || 'noposts'}_${keys.length}_${Object.keys(posts).length}_${posts[keys[keys.length - 1]].id}_${result.data.prev_post_id || 'root'}`;
            }
            fss.writeFileSync(`results/api-mattermost/channels-posts/${channel.id}/posts-${counter}-${index}.json`, JSON.stringify(result.data));
            // console.log(new Date);
            await sleep(1000 - (Date.now() - before));

            console.log(!!result.data.posts, keys?.length, Object.keys(result.data.posts || {}).length);
            // 条件をチェックして更新
            if (result.data.posts && keys?.length === perPage) {

            } else {
                console.log(`channelIndex ${channelIndex}`);
                break;
            }
            counter++;
        }
        channelIndex++;
    }
}

// DBインサート
async function insertPost() {
    const teams = JSON.parse(fs.readFileSync(`results/api-mattermost/teams.json`, 'utf-8')) as MattermostTeam[];
    teams.forEach(team => {
        const header = [
            team.id,
            Utils.formatDate(new Date(team.create_at)),
            Utils.formatDate(new Date(team.update_at)),
            Utils.formatDate(new Date(team.delete_at)),
            team.display_name,
        ];
        // console.log(header.join('\t'));
    });
    const channels = JSON.parse(fs.readFileSync(`results/api-mattermost/channels.json`, 'utf-8')) as MattermostChannel[];
    channels.forEach(channel => {
        const header = [
            channel.team_id,
            channel.id,
            Utils.formatDate(new Date(channel.create_at)),
            Utils.formatDate(new Date(channel.update_at)),
            Utils.formatDate(new Date(channel.delete_at)),
            channel.type,
            channel.display_name
        ]
        // console.log(header.join('\t'));
    });

    const files = glob.sync('results/api-mattermost/channels-posts/**/*.json');
    // console.log(files);
    const mmUsers = await ds.getRepository(MmUserEntity).find({ select: ['id', 'first_name', 'last_name', 'nickname'] });
    const mmUserMas = mmUsers.reduce((mas, curr) => {
        mas[curr.id] = curr;
        return mas;
    }, {} as { [key: string]: MmUserEntity });
    let seq = 1;
    files.sort((a, b) => {

        const dirA = Utils.basename(Utils.dirname(a));
        const dirB = Utils.basename(Utils.dirname(b));

        if (dirA > dirB) return 1;
        if (dirA < dirB) return -1;

        const fileNumA = Number(Utils.basename(a).split('-')[1]);
        const fileNumB = Number(Utils.basename(b).split('-')[1]);

        return fileNumA - fileNumB;
    }).forEach(async (file, index) => {
        // if (file.includes('zk9he85iofdpfy4bh4dotfcowo')) {
        // } else {
        //     // return;
        // }
        const jsonString = fs.readFileSync(file, 'utf-8');
        const jsonObject = JSON.parse(jsonString) as GetChannelsPostsResponse;
        // const posts = jsonObject.posts || {};
        // const sortedKeys = (jsonObject.order || []).reverse().map(key => {
        //     const obj = posts[key];
        //     if (obj.delete_at) {
        //         // obj.delete_at = new Date(obj.delete_at);
        //     } else {
        //         obj.delete_at = undefined;
        //     }
        //     const date = Utils.formatDate(new Date(obj.create_at || 0), 'yyyy/MM/dd HH:mm:ss');
        //     // console.log(date + '\n' + obj.message?.replaceAll(/\n/g, '\\n').substring(0, 75) + '\n');
        //     // console.log(date + ' ' + mmUserMas[obj.user_id || ''].nickname + '\n' + obj.message + '\n');
        //     // console.log(`---\n`);
        //     // obj.create_at = new Date(obj.create_at);
        //     // obj.update_at = new Date(obj.update_at);
        //     return obj;
        // }).sort((a, b) => (b.create_at || 0) - (a.create_at || 0)).map(obj => obj.id);

        // console.log(sortedKeys);
        // console.log(jsonObject.order);

        // await ds.transaction(async manager => {
        //     manager.insert(MmUserEntity, jsonObject);
        // })
        // // const allUsers = await ds.getRepository(MmUserEntity).find();
        // console.log(index, jsonObject.order?.length);
        console.log(index, jsonObject.order?.length, Utils.dirname(file), Utils.basename(file));
    });
}


import WebSocket from 'ws';


// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

const MAX_WEBSOCKET_FAILS = 7;
const MIN_WEBSOCKET_RETRY_TIME = 3000; // 3 sec
const MAX_WEBSOCKET_RETRY_TIME = 300000; // 5 mins
const JITTER_RANGE = 2000; // 2 sec

const WEBSOCKET_HELLO = 'hello';

export type MessageListener = (msg: WebSocketMessage) => void;
export type FirstConnectListener = () => void;
export type ReconnectListener = () => void;
export type MissedMessageListener = () => void;
export type ErrorListener = (event: Event) => void;
export type CloseListener = (connectFailCount: number) => void;

export default class WebSocketClient {
    private conn: WebSocket | null;
    private connectionUrl: string | null;

    // responseSequence is the number to track a response sent
    // via the websocket. A response will always have the same sequence number
    // as the request.
    private responseSequence: number;

    // serverSequence is the incrementing sequence number from the
    // server-sent event stream.
    private serverSequence: number;
    private connectFailCount: number;
    private responseCallbacks: { [x: number]: ((msg: any) => void) };

    /**
     * @deprecated Use messageListeners instead
     */
    private eventCallback: MessageListener | null = null;

    /**
     * @deprecated Use firstConnectListeners instead
     */
    private firstConnectCallback: FirstConnectListener | null = null;

    /**
     * @deprecated Use reconnectListeners instead
     */
    private reconnectCallback: ReconnectListener | null = null;

    /**
     * @deprecated Use missedMessageListeners instead
     */
    private missedEventCallback: MissedMessageListener | null = null;

    /**
     * @deprecated Use errorListeners instead
     */
    private errorCallback: ErrorListener | null = null;

    /**
     * @deprecated Use closeListeners instead
     */
    private closeCallback: CloseListener | null = null;

    private messageListeners = new Set<MessageListener>();
    private firstConnectListeners = new Set<FirstConnectListener>();
    private reconnectListeners = new Set<ReconnectListener>();
    private missedMessageListeners = new Set<MissedMessageListener>();
    private errorListeners = new Set<ErrorListener>();
    private closeListeners = new Set<CloseListener>();

    private connectionId: string | null;
    private postedAck: boolean;

    constructor() {
        this.conn = null;
        this.connectionUrl = null;
        this.responseSequence = 1;
        this.serverSequence = 0;
        this.connectFailCount = 0;
        this.responseCallbacks = {};
        this.connectionId = '';
        this.postedAck = false;
    }

    // on connect, only send auth cookie and blank state.
    // on hello, get the connectionID and store it.
    // on reconnect, send cookie, connectionID, sequence number.
    initialize(connectionUrl = this.connectionUrl, token?: string, postedAck?: boolean) {
        if (this.conn) {
            return;
        }

        if (connectionUrl == null) {
            console.log('websocket must have connection url'); //eslint-disable-line no-console
            return;
        }

        if (this.connectFailCount === 0) {
            console.log('websocket connecting to ' + connectionUrl); //eslint-disable-line no-console
        }

        if (typeof postedAck != 'undefined') {
            this.postedAck = postedAck;
        }

        // Add connection id, and last_sequence_number to the query param.
        // We cannot use a cookie because it will bleed across tabs.
        // We cannot also send it as part of the auth_challenge, because the session cookie is already sent with the request.
        this.conn = new WebSocket(`${connectionUrl}?connection_id=${this.connectionId}&sequence_number=${this.serverSequence}${this.postedAck ? '&posted_ack=true' : ''}`);
        this.connectionUrl = connectionUrl;

        this.conn.onopen = () => {
            if (token) {
                this.sendMessage('authentication_challenge', { token });
            }

            if (this.connectFailCount > 0) {
                console.log('websocket re-established connection'); //eslint-disable-line no-console

                this.reconnectCallback?.();
                this.reconnectListeners.forEach((listener) => listener());
            } else if (this.firstConnectCallback || this.firstConnectListeners.size > 0) {
                this.firstConnectCallback?.();
                this.firstConnectListeners.forEach((listener) => listener());
            }

            this.connectFailCount = 0;
        };

        this.conn.onclose = () => {
            this.conn = null;
            this.responseSequence = 1;

            if (this.connectFailCount === 0) {
                console.log('websocket closed'); //eslint-disable-line no-console
            }

            this.connectFailCount++;

            this.closeCallback?.(this.connectFailCount);
            this.closeListeners.forEach((listener) => listener(this.connectFailCount));

            let retryTime = MIN_WEBSOCKET_RETRY_TIME;

            // If we've failed a bunch of connections then start backing off
            if (this.connectFailCount > MAX_WEBSOCKET_FAILS) {
                retryTime = MIN_WEBSOCKET_RETRY_TIME * this.connectFailCount * this.connectFailCount;
                if (retryTime > MAX_WEBSOCKET_RETRY_TIME) {
                    retryTime = MAX_WEBSOCKET_RETRY_TIME;
                }
            }

            // Applying jitter to avoid thundering herd problems.
            retryTime += Math.random() * JITTER_RANGE;

            setTimeout(
                () => {
                    this.initialize(connectionUrl, token, postedAck);
                },
                retryTime,
            );
        };

        this.conn.onerror = (evt) => {
            if (this.connectFailCount <= 1) {
                console.log('websocket error'); //eslint-disable-line no-console
                console.log(evt); //eslint-disable-line no-console
            }

            this.errorCallback?.(evt as any);
            this.errorListeners.forEach((listener) => listener(evt as any));
        };

        this.conn.onmessage = (evt) => {
            console.log(evt.data);

            const msg = JSON.parse(evt.data as any);
            if (msg.seq_reply) {
                // This indicates a reply to a websocket request.
                // We ignore sequence number validation of message responses
                // and only focus on the purely server side event stream.
                if (msg.error) {
                    console.log(msg); //eslint-disable-line no-console
                }

                if (this.responseCallbacks[msg.seq_reply]) {
                    this.responseCallbacks[msg.seq_reply](msg);
                    Reflect.deleteProperty(this.responseCallbacks, msg.seq_reply);
                }
            } else if (this.eventCallback || this.messageListeners.size > 0) {
                // We check the hello packet, which is always the first packet in a stream.
                if (msg.event === WEBSOCKET_HELLO && (this.missedEventCallback || this.missedMessageListeners.size > 0)) {
                    console.log('got connection id ', msg.data.connection_id); //eslint-disable-line no-console
                    // If we already have a connectionId present, and server sends a different one,
                    // that means it's either a long timeout, or server restart, or sequence number is not found.
                    // Then we do the sync calls, and reset sequence number to 0.
                    if (this.connectionId !== '' && this.connectionId !== msg.data.connection_id) {
                        console.log('long timeout, or server restart, or sequence number is not found.'); //eslint-disable-line no-console

                        this.missedEventCallback?.();

                        for (const listener of this.missedMessageListeners) {
                            try {
                                listener();
                            } catch (e) {
                                console.log(`missed message listener "${listener.name}" failed: ${e}`); // eslint-disable-line no-console
                            }
                        }

                        this.serverSequence = 0;
                    }

                    // If it's a fresh connection, we have to set the connectionId regardless.
                    // And if it's an existing connection, setting it again is harmless, and keeps the code simple.
                    this.connectionId = msg.data.connection_id;
                }

                // Now we check for sequence number, and if it does not match,
                // we just disconnect and reconnect.
                if (msg.seq !== this.serverSequence) {
                    console.log('missed websocket event, act_seq=' + msg.seq + ' exp_seq=' + this.serverSequence); //eslint-disable-line no-console
                    // We are not calling this.close() because we need to auto-restart.
                    this.connectFailCount = 0;
                    this.responseSequence = 1;
                    this.conn?.close(); // Will auto-reconnect after MIN_WEBSOCKET_RETRY_TIME.
                    return;
                }
                this.serverSequence = msg.seq + 1;

                this.eventCallback?.(msg);
                this.messageListeners.forEach((listener) => listener(msg));
            }
        };
    }

    /**
     * @deprecated Use addMessageListener instead
     */
    setEventCallback(callback: MessageListener) {
        this.eventCallback = callback;
    }

    addMessageListener(listener: MessageListener) {
        this.messageListeners.add(listener);

        if (this.messageListeners.size > 5) {
            // eslint-disable-next-line no-console
            console.warn(`WebSocketClient has ${this.messageListeners.size} message listeners registered`);
        }
    }

    removeMessageListener(listener: MessageListener) {
        this.messageListeners.delete(listener);
    }

    /**
     * @deprecated Use addFirstConnectListener instead
     */
    setFirstConnectCallback(callback: FirstConnectListener) {
        this.firstConnectCallback = callback;
    }

    addFirstConnectListener(listener: FirstConnectListener) {
        this.firstConnectListeners.add(listener);

        if (this.firstConnectListeners.size > 5) {
            // eslint-disable-next-line no-console
            console.warn(`WebSocketClient has ${this.firstConnectListeners.size} first connect listeners registered`);
        }
    }

    removeFirstConnectListener(listener: FirstConnectListener) {
        this.firstConnectListeners.delete(listener);
    }

    /**
     * @deprecated Use addReconnectListener instead
     */
    setReconnectCallback(callback: ReconnectListener) {
        this.reconnectCallback = callback;
    }

    addReconnectListener(listener: ReconnectListener) {
        this.reconnectListeners.add(listener);

        if (this.reconnectListeners.size > 5) {
            // eslint-disable-next-line no-console
            console.warn(`WebSocketClient has ${this.reconnectListeners.size} reconnect listeners registered`);
        }
    }

    removeReconnectListener(listener: ReconnectListener) {
        this.reconnectListeners.delete(listener);
    }

    /**
     * @deprecated Use addMissedMessageListener instead
     */
    setMissedEventCallback(callback: MissedMessageListener) {
        this.missedEventCallback = callback;
    }

    addMissedMessageListener(listener: MissedMessageListener) {
        this.missedMessageListeners.add(listener);

        if (this.missedMessageListeners.size > 5) {
            // eslint-disable-next-line no-console
            console.warn(`WebSocketClient has ${this.missedMessageListeners.size} missed message listeners registered`);
        }
    }

    removeMissedMessageListener(listener: MissedMessageListener) {
        this.missedMessageListeners.delete(listener);
    }

    /**
     * @deprecated Use addErrorListener instead
     */
    setErrorCallback(callback: ErrorListener) {
        this.errorCallback = callback;
    }

    addErrorListener(listener: ErrorListener) {
        this.errorListeners.add(listener);

        if (this.errorListeners.size > 5) {
            // eslint-disable-next-line no-console
            console.warn(`WebSocketClient has ${this.errorListeners.size} error listeners registered`);
        }
    }

    removeErrorListener(listener: ErrorListener) {
        this.errorListeners.delete(listener);
    }

    /**
     * @deprecated Use addCloseListener instead
     */
    setCloseCallback(callback: CloseListener) {
        this.closeCallback = callback;
    }

    addCloseListener(listener: CloseListener) {
        this.closeListeners.add(listener);

        if (this.closeListeners.size > 5) {
            // eslint-disable-next-line no-console
            console.warn(`WebSocketClient has ${this.closeListeners.size} close listeners registered`);
        }
    }

    removeCloseListener(listener: CloseListener) {
        this.closeListeners.delete(listener);
    }

    close() {
        this.connectFailCount = 0;
        this.responseSequence = 1;
        if (this.conn && this.conn.readyState === WebSocket.OPEN) {
            this.conn.onclose = () => { };
            this.conn.close();
            this.conn = null;
            console.log('websocket closed'); //eslint-disable-line no-console
        }
    }

    sendMessage(action: string, data: any, responseCallback?: (msg: any) => void) {
        const msg = {
            action,
            seq: this.responseSequence++,
            data,
        };

        if (responseCallback) {
            this.responseCallbacks[msg.seq] = responseCallback;
        }

        if (this.conn && this.conn.readyState === WebSocket.OPEN) {
            this.conn.send(JSON.stringify(msg));
        } else if (!this.conn || this.conn.readyState === WebSocket.CLOSED) {
            this.conn = null;
            this.initialize();
        }
    }

    userTyping(channelId: string, parentId: string, callback?: () => void) {
        const data = {
            channel_id: channelId,
            parent_id: parentId,
        };
        this.sendMessage('user_typing', data, callback);
    }

    updateActiveChannel(channelId: string, callback?: (msg: any) => void) {
        const data = {
            channel_id: channelId,
        };
        this.sendMessage('presence', data, callback);
    }

    updateActiveTeam(teamId: string, callback?: (msg: any) => void) {
        const data = {
            team_id: teamId,
        };
        this.sendMessage('presence', data, callback);
    }

    updateActiveThread(isThreadView: boolean, channelId: string, callback?: (msg: any) => void) {
        const data = {
            thread_channel_id: channelId,
            is_thread_view: isThreadView,
        };
        this.sendMessage('presence', data, callback);
    }

    userUpdateActiveStatus(userIsActive: boolean, manual: boolean, callback?: () => void) {
        const data = {
            user_is_active: userIsActive,
            manual,
        };
        this.sendMessage('user_update_active_status', data, callback);
    }

    acknowledgePostedNotification(postId: string, status: string, reason?: string, postedData?: string) {
        const data = {
            post_id: postId,
            user_agent: window.navigator.userAgent,
            status,
            reason,
            data: postedData,
        };

        this.sendMessage('posted_notify_ack', data);
    }

    getStatuses(callback?: () => void) {
        this.sendMessage('get_statuses', null, callback);
    }

    getStatusesByIds(userIds: string[], callback?: () => void) {
        const data = {
            user_ids: userIds,
        };
        this.sendMessage('get_statuses_by_ids', data, callback);
    }
}

export type WebSocketBroadcast = {
    omit_users: Record<string, boolean>;
    user_id: string;
    channel_id: string;
    team_id: string;
}

export type WebSocketMessage<T = any> = {
    event: string;
    data: T;
    broadcast: WebSocketBroadcast;
    seq: number;
}

/**
 * 必ず main() という関数を定義する。
 * promiseチェーンで順次実行させる。
 * 
 * 1. newでオブジェクトを作る。
 * 2. initPromptでプロンプトをファイルに出力。
 * 3. run()で実行
 * 
 * 途中まで行ってたらコメントアウトして再ランする。
 * 例えば、promptを手修正したかったらinitPromptだけコメントアウトすれば手修正したファイルがそのまま飛ぶ。
 */
export async function main() {
    try {
        const api: ApiMattermostService = new ApiMattermostService();
        // getAllEmoji(api);
        const client = new WebSocketClient();
        // client.initialize('https://may-chat.beafland.com/api/v4/websocket', 'e6hbkjjon7gaxnznujzo6n19ge');
        // user全部持ってくるやつ
        await getAllUsers(api);
        // 持ってきたやつをインサート
        await insert();
        // ポストを取ってくるやつ。
        // await channels(api);

        // // await insertPost();

        // // return api.usersAll().then(res =>
        // //     console.log(res)
        // // );
        // return api.userChannels().then((res) => {
        //     // console.log(res.data);
        // }).then((res) => {

        // }).catch((err) => {
        //     console.log(err);
        // });

    } catch (e) {
        console.log(e);
    }
    let obj;
    // return Promise.resolve().then(() => {
    //     obj = new Step0000_FirstStep();
    //     obj.initPrompt();
    //     return obj.run();
    // }).then(() => {
    //     obj = new Step0010_DrillDown();
    //     obj.initPrompt();
    //     return obj.run();
    // }).then(() => {
    // });
}


/**
 * このファイルが直接実行された場合のコード。
 */
if (fileURLToPath(import.meta.url) === process.argv[1]) {
    main();
} else {
    // main実行じゃなかったら何もしない
}
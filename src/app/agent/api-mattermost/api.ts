import { AxiosResponse } from "axios";
import axios from 'axios';
const { MATTERMOST_TOKEN, OAUTH2_MATTERMOST_URI_BASE } = process.env;
import https from 'https';
const agent = new https.Agent({ rejectUnauthorized: false });

// プロキシ無しaxios
// export const axiosMattermost = axios.create({ proxy: false, httpAgent: false, httpsAgent: agent, headers: { 'Authorization': `Bearer ${MATTERMOST_TOKEN}` } });
export const axiosMattermost = axios.create({ proxy: false, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${MATTERMOST_TOKEN}` } });

import { paths, components } from "./mattermost-openapi-v4.js";

// type GetUsersResponse = paths.Get['/users']['responses']['200']['content']['application/json'];
export type GetUsersResponse = paths['/api/v4/users/login']['post']['responses'][201]['content']['application/json'];
export type User = components['schemas']['User'];

export type GetChannelsForUserResponse = paths['/api/v4/users/{user_id}/channels']['get']['responses'][200]['content']['application/json'];
export type GetChannelsPostsResponse = paths['/api/v4/channels/{channel_id}/posts']['get']['responses'][200]['content']['application/json'];

export class ApiMattermostService {

    public baseUrl = `${OAUTH2_MATTERMOST_URI_BASE}/api/v4`;

    mattermostTeams(userId: string): Promise<AxiosResponse<MattermostTeam[]>> {
        const url = `${this.baseUrl}/users/${userId}/teams`;
        return axiosMattermost.get<MattermostTeam[]>(url);
    }
    mattermostTeamsUnread(userId: string): Promise<AxiosResponse<MattermostTeamUnread[]>> {
        const url = `${this.baseUrl}/users/${userId}/teams/unread`;
        return axiosMattermost.get<MattermostTeamUnread[]>(url);
    }
    usersAll(perPage: number = 60, page: number = 0): Promise<AxiosResponse<MattermostUser[]>> {
        const url = `${this.baseUrl}/users?per_page=${perPage}&page=${page}`;
        return axiosMattermost.get<MattermostUser[]>(url);
    }
    emojiAll(perPage: number = 60, page: number = 0): Promise<AxiosResponse<MattermostEmoji[]>> {
        const url = `${this.baseUrl}/emoji?per_page=${perPage}&page=${page}`;
        return axiosMattermost.get<MattermostEmoji[]>(url);
    }
    user(userId: string = 'me'): Promise<AxiosResponse<MattermostUser>> {
        const url = `${this.baseUrl}/users/${userId}`;
        return axiosMattermost.get<MattermostUser>(url);
    }
    userChannels(userId: string = 'me', last_delete_at: number = 0, include_deleted = false): Promise<AxiosResponse<MattermostChannel[]>> {
        const url = `${this.baseUrl}/users/${userId}/channels?last_delete_at=${last_delete_at}&include_deleted=${include_deleted}`;
        return axiosMattermost.get<MattermostChannel[]>(url);
    }

    mattermostChannels(teamId: string): Promise<AxiosResponse<MattermostChannel[]>> {
        const url = `${this.baseUrl}/teams/${teamId}/channels`;
        return axiosMattermost.get<MattermostChannel[]>(url);
    }
    mattermostChannel(teamId: string, channelId: string): Promise<AxiosResponse<MattermostChannel[]>> {
        const url = `${this.baseUrl}/channels/${channelId}`;
        return axiosMattermost.get<MattermostChannel[]>(url);
    }
    mattermostThreads(teamId: string): Promise<AxiosResponse<{ threads: MattermostThread[] }>> {
        const url = `${this.baseUrl}/users/me/teams/${teamId}/threads`;
        return axiosMattermost.get<{ threads: MattermostThread[] }>(url);
    }
    // mattermostPosts(teamId: string, channelId: string): Promise<AxiosResponse<{ posts: MattermostPost[] }> {
    //   const url = `${this.baseUrl}/users/me/channels/${channelId}/posts/unread`;
    //   return axiosMattermost.get<{ posts: MattermostPost[] }>(url);
    // }

    channels: MattermostChannel[] = [];
    /** これが自身の関与チャネル全量 */
    mattermostUserChannels(userId: string = 'me', last_delete_at: number = 0, include_deleted = false): Promise<AxiosResponse<MattermostChannel[]>> {
        const url = `${this.baseUrl}/users/${userId}/channels?last_delete_at=${last_delete_at}&include_deleted=${include_deleted}`;
        return axiosMattermost.get<MattermostChannel[]>(url);
    }
    mattermostChannelsPosts(channelId: string, page: number = 0, per_page: number = 60, since?: number, before?: string, after?: string, include_deleted: boolean = false): Promise<AxiosResponse<GetChannelsPostsResponse>> {
        const url = `${this.baseUrl}/channels/${channelId}/posts?page=${page}&per_page=${per_page}&include_deleted=${include_deleted}`;
        console.log(url);
        return axiosMattermost.get<GetChannelsPostsResponse>(url);
    }
}

export interface MattermostTeam {
    id: string;
    create_at: number;
    update_at: number;
    delete_at: number;
    display_name: string;
    name: string;
    description: string;
    email: string;
    type: 'O' | 'I';  // 'O' for open, 'I' for invite-only
    company_name: string;
    allowed_domains: string;
    invite_id: string;
    allow_open_invite: boolean;
    last_team_icon_update: number;
    scheme_id: string | null;
    group_constrained: boolean;
    policy_id: string | null;
}

export interface MattermostTeamUnread {
    team_id: string;
    msg_count: number;
    mention_count: number;
}

export type MattermostTeamForView = MattermostTeam & MattermostTeamUnread & { isChecked: boolean };

export interface MattermostChannel {
    id: string;
    create_at: number;
    update_at: number;
    delete_at: number;
    team_id: string;
    type: 'O' | 'P' | 'G' | 'D';  // 'O' for public, 'P' for private
    display_name: string;
    name: string;
    header: string;
    purpose: string;
    last_post_at: number;
    last_root_post_at: number;
    creator_id: string;
    scheme_id: string | null;
    group_constrained: boolean;
    total_msg_count: number;
    total_msg_count_root: number;
}
export interface MattermostThread {
    id: string;
    reply_count: number;
    last_reply_at: number;
    participants: MattermostUser[];
    is_following: boolean;
    post: MattermostPost;
    unread_mentions: number;
    unread_replies: number;
}

export interface MattermostUser {
    id: string;
    create_at: number;
    update_at: number;
    delete_at: number;
    username: string;
    auth_data: string;
    auth_service: string;
    email: string;
    nickname: string;
    first_name: string;
    last_name: string;
    position: string;
    roles: string;
    locale: string;
    timezone: {
        automaticTimezone: string;
        manualTimezone: string;
        useAutomaticTimezone: boolean;
    };
    disable_welcome_email: boolean;
}


// export interface MattermostPost {
//     id: string;                     // ポストの一意のID
//     create_at: number;              // ポストが作成されたタイムスタンプ (ミリ秒)
//     update_at: number;              // ポストが更新されたタイムスタンプ (ミリ秒)
//     edit_at: number;                // ポストが編集されたタイムスタンプ (ミリ秒)
//     delete_at: number;              // ポストが削除されたタイムスタンプ (ミリ秒)
//     is_pinned: boolean;             // ポストがピン留めされているかどうか
//     user_id: string;                // ポストを作成したユーザーのID
//     channel_id: string;             // ポストが属するチャネルのID
//     root_id: string;                // スレッドの親ポストのID (スレッドのリプライでない場合は空)
//     original_id: string;            // 元のポストのID (エディタで変更される前のポストのID)
//     message: string;                // ポストのメッセージ内容
//     type: string;                   // ポストの種類 (通常は "system" や "custom" などの値)
//     props: Record<string, any>;     // カスタムプロパティ
//     hashtags: string;               // ポストに含まれるハッシュタグ
//     pending_post_id: string;        // クライアント側で生成された一時的なID (サーバーに送信される前のID)
//     reply_count: number;            // スレッドのリプライ数
//     last_reply_at: number;          // 最後にリプライされたタイムスタンプ (ミリ秒)
//     participants: string[];         // スレッドの参加者のユーザーIDリスト
//     metadata: MattermostPostMetadata;         // ポストに関連するメタデータ (ファイル、反応、メンションなど)
// }
export interface MattermostPost {
    id: string;
    create_at: number;
    update_at: number;
    delete_at: number;
    edit_at: number;
    user_id: string;
    channel_id: string;
    root_id: string;
    original_id: string;
    message: string;
    type: string;
    props: object;
    hashtag: string;
    file_ids: string[];
    pending_post_id: string;
    metadata: MattermostMetadata;
}

export interface MattermostEmoji {
    id: string;
    creator_id: string;
    name: string;
    create_at: number;
    update_at: number;
    delete_at: number;
    // 勝手に追加した項目
    reactions?: {
        user_id: string,
        nickname: string,
    }[];
    // 勝手に追加した項目
    reactions_text?: string;
}

export interface MattermostAcknowledgement {
    user_id: string;
    post_id: string;
    acknowledged_at: number;
}

export interface MattermostReaction {
    user_id: string;
    post_id: string;
    emoji_name: string;
    create_at: number;
    update_at: number;
    delete_at: number;
    remote_id: string;
    channel_id: string;
}

export interface MattermostFile {
    id: string;
    user_id: string;
    post_id: string;
    create_at: number;
    update_at: number;
    delete_at: number;
    name: string;
    extension: string;
    size: number;
    mime_type: string;
    width: number;
    height: number;
    has_preview_image: boolean;
}

export interface MattermostMetadata {
    embeds: MattermostEmbed[];
    emojis: MattermostEmoji[];
    files: MattermostFile[];
    images: object;
    reactions: MattermostReaction[];
    priority: {
        priority: string;
        requested_ack: boolean;
    };
    acknowledgements: MattermostAcknowledgement[];
}

export interface MattermostFile {
    id: string;
    user_id: string;
    post_id: string;
    create_at: number;
    update_at: number;
    delete_at: number;
    name: string;
    extension: string;
    size: number;
    mime_type: string;
    width: number;
    height: number;
    has_preview_image: boolean;
}

export interface Post {
    id: string;
    create_at: number;
    update_at: number;
    edit_at: number;
    delete_at: number;
    is_pinned: boolean;
    user_id: string;
    channel_id: string;
    root_id: string;
    original_id: string;
    message: string;
    type: string;
    props: {};
    hashtags: string;
    pending_post_id: string;
    reply_count: number;
    last_reply_at: number;
    participants: null;
    metadata: {
        emojis?: MattermostEmoji[];
        reactions?: {
            user_id: string;
            post_id: string;
            emoji_name: string;
            create_at: number;
            update_at: number;
            delete_at: number;
            remote_id: string;
            channel_id: string;
        }[];
        files?: { id: string, name: string, mime_type: string, dataUrl?: string }[];
    };
    has_reactions?: boolean;
}

type MattermostPostMetadata = {
    embeds: MattermostEmbed[];                // 埋め込みメディアの情報
    emojis: MattermostMetaEmoji[];                // カスタム絵文字
    files: MattermostFileInfo[];              // 添付ファイル情報
    images: Record<string, MattermostImage>;  // ポストに含まれる画像情報
    reactions: MattermostMetaReaction[];          // ポストに対するリアクション
    mentions: MattermostMention[];            // メンションされたユーザー
};

type MattermostEmbed = {
    type: string;                   // 埋め込みの種類 (リンクプレビュー、画像など)
    url: string;                    // 埋め込みのURL
    data: Record<string, any>;      // 埋め込みの詳細データ
};

type MattermostMetaEmoji = {
    name: string;                   // 絵文字の名前
    unified: string;                // 絵文字のコードポイント
    custom: boolean;                // カスタム絵文字かどうか
};

type MattermostFileInfo = {
    id: string;                     // ファイルのID
    name: string;                   // ファイル名
    extension: string;              // ファイルの拡張子
    size: number;                   // ファイルサイズ (バイト単位)
    mime_type: string;              // MIMEタイプ
    has_preview_image: boolean;     // プレビュー画像があるかどうか
};

type MattermostImage = {
    url: string;                    // 画像のURL
    height: number;                 // 画像の高さ
    width: number;                  // 画像の幅
};

type MattermostMetaReaction = {
    user_id: string;                // リアクションを付けたユーザーのID
    post_id: string;                // リアクションが付いたポストのID
    emoji_name: string;             // 使用された絵文字の名前
};

type MattermostMention = {
    user_id: string;                // メンションされたユーザーのID
};

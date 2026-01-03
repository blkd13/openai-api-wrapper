import { In } from 'typeorm';

import { MattermostChannel, MattermostUser } from '../../agent/api-mattermost/api.js';
import { MyToolType } from '../../common/openai-api-wrapper.js';
import { Utils } from '../../common/utils.js';
import { AIClientLike, getServiceAIClient } from '../common/ai-client.js';
import { getAIProvider, MessageArgsSet } from '../controllers/chat-by-project-model.js';
import { ds } from '../db.js';
import { MmUserEntity } from '../entity/api-mattermost.entity.js';
import { ContentPartEntity, MessageEntity, MessageGroupEntity } from '../entity/project-models.entity.js';
import { UserRequest } from '../models/info.js';
import { getOAuthAccountForTool, reform } from './common.js';
import { getPredictHistoryWrapperLoggerForRequest } from '../common/predict-history-logger.js';
import { map, timeout, toArray } from 'rxjs';



const _aiApi = getServiceAIClient();

// 1. 関数マッピングの作成
export async function mattermostFunctionDefinitions(
    providerName: string,
    obj: { inDto: MessageArgsSet; messageSet: { messageGroup: MessageGroupEntity; message: MessageEntity; contentParts: ContentPartEntity[]; }; },
    req: UserRequest, aiApi: AIClientLike, connectionId: string, streamId: string, message: MessageEntity, label: string,
): Promise<MyToolType[]> {
    const aiApi_ = aiApi || _aiApi; // フォールバック
    const provider = `mattermost-${providerName}`;
    const wrapperLogger = getPredictHistoryWrapperLoggerForRequest(req);
    return [
        {
            info: { group: provider, isActive: true, isInteractive: false, label: `投稿を検索`, },
            definition: {
                type: 'function', function: {
                    name: `mm_${providerName}_search_team_posts`,
                    description: `[Mattermost] 指定された条件に基づいてMattermost投稿を検索する。チームを跨いだ検索はできないが、詳細な条件を指定した検索が可能。\n投稿内容を提示する際はリンクもセットで提示するよ良い。`,
                    parameters: {
                        type: 'object',
                        properties: {
                            limit: { type: 'number', description: '取得する最大数', default: 50, minimum: 1, maximum: 200 },
                            teamName: { type: 'string', description: 'チーム名' },
                            term: {
                                type: 'string',
                                description: Utils.trimLines(`
                                    検索キーワード。以下の特殊な検索構文が利用可能：
                                        - from:ユーザー名  → 特定のユーザーからの投稿を検索
                                        - in:チャンネル名  → 特定のチャンネル内の投稿を検索（表示名ではなくチャンネル名を使用）
                                        - "完全一致フレーズ" → ダブルクォートで囲むとフレーズとして完全一致検索
                                        - before:日付 → 指定日付より前（指定日は含まない）の投稿を検索
                                        - after:日付 → 指定日付より後（指定日は含まない）の投稿を検索
                                        - on:日付 → 指定日付の投稿を検索
                                    例：
                                        - from:john in:general "重要な会議"
                                        - in:developers after:2023-01-01 バグ修正
                                        - from:sarah before:2023-12-31 プロジェクト
                                    `),
                            },

                        },
                        required: ['teamName', 'term'],
                    },
                }
            },
            handler: async (args: { limit: number, teamName: string, term: string }): Promise<any> => {
                const { e, axiosWithAuth } = await getOAuthAccountForTool(req, provider);
                let { limit, term } = args;
                limit = Math.max(Math.min(limit || 50, 200), 1); // 1以上200以下
                const user_id = req.info.user.id;
                if (!user_id) {
                    throw new Error('User ID is required.');
                }

                // チーム名からチームIDを取得
                const { teamName } = args;
                const teamInfoUrl = `${e.uriBase}/api/v4/teams/name/${teamName}`;
                const teamInfo = (await axiosWithAuth.get(teamInfoUrl)).data;
                const teamId = teamInfo.id;

                let url, data;
                url = `${e.uriBase}/api/v4/teams/${teamId}/posts/search`;
                data = { 'terms': `${term}`, 'is_or_search': false, 'include_deleted_channels': false, 'time_zone_offset': 32400, 'page': 0, 'per_page': limit };
                const result = (await axiosWithAuth.post(url, data)).data;
                reform(result);
                // console.dir(result);
                // result.me = reform(userInfo);
                result.uriBase = e.uriBase;
                return result;
            }
        },
        {
            info: { group: provider, isActive: true, isInteractive: false, label: `mattermost：自分のユーザー情報`, },
            definition: {
                type: 'function', function: {
                    name: `mm_${providerName}_user_info`,
                    description: `[Mattermost] 自分のユーザー情報`,
                    parameters: { type: 'object', properties: {}, }
                }
            },
            handler: async (args: {}): Promise<any> => {
                const { e, axiosWithAuth } = await getOAuthAccountForTool(req, provider);
                let url;
                url = `${e.uriBase}${e.pathUserInfo}`;
                const result = (await axiosWithAuth.get(url)).data;
                reform(result);
                // console.log(result);
                result.uriBase = e.uriBase;
                return result;
            }
        },
        {
            info: { group: provider, isActive: true, label: 'ユーザー検索', },
            definition: {
                type: 'function',
                function: {
                    name: `mm_${providerName}_find_users`,
                    description: '[Mattermost] 指定された条件に基づいてMattermostユーザーを検索する',
                    parameters: {
                        type: 'object',
                        properties: {
                            term: { type: 'string', description: '検索するユーザー名、フルネーム、ニックネーム、またはメールアドレスの一部または全部。' },
                            team_id: { type: 'string', description: '検索対象のチームID。指定された場合、このチーム内のユーザーのみが検索される。' },
                            not_in_team_id: { type: 'string', description: '除外するチームID。指定された場合、このチームに所属しないユーザーが検索される。' },
                            in_channel_id: { type: 'string', description: '検索対象のチャンネルID。指定された場合、このチャンネル内のユーザーのみが検索される。' },
                            not_in_channel_id: { type: 'string', description: '除外するチャンネルID。指定された場合、このチャンネルに所属しないユーザーが検索される。team_id と共に使用する必要がある。' },
                            in_group_id: { type: 'string', description: '検索対象のグループID。指定された場合、このグループ内のユーザーのみが検索される。manage_system 権限が必要。' },
                            group_constrained: { type: 'boolean', description: 'not_in_channel_id または not_in_team_id と共に使用。trueの場合、グループ制約で参加可能なユーザーのみを返す。', default: false },
                            allow_inactive: { type: 'boolean', description: 'trueの場合、無効化されたユーザーも検索結果に含める。', default: false },
                            without_team: { type: 'boolean', description: 'trueの場合、どのチームにも所属していないユーザーを検索する。team_id, in_channel_id, not_in_channel_id より優先される。', default: false },
                            limit: { type: 'integer', description: '返すユーザーの最大数。', default: 100 },
                            allow_full_names: { type: 'boolean', description: 'v5.37以降。falseの場合、氏名での部分一致検索を行わない。(完全一致検索に近づける)', default: true, },
                            allow_emails: { type: 'boolean', description: 'v5.37以降。falseの場合、メールアドレスでの部分一致検索を行わない。(完全一致検索に近づける)', default: true }
                        },
                        required: ['term']
                    }
                }
            },
            handler: async (args: { term: string, team_id?: string, not_in_team_id?: string, in_channel_id?: string, not_in_channel_id?: string, in_group_id?: string, group_constrained?: boolean, allow_inactive?: boolean, without_team?: boolean, limit?: number, allow_full_names?: boolean, allow_emails?: boolean, }):
                Promise<{ name: string, id: string, text: string }[]> => {
                const { e, axiosWithAuth } = await getOAuthAccountForTool(req, provider);
                const keys = ['term', 'team_id', 'not_in_team_id', 'in_channel_id', 'not_in_channel_id', 'in_group_id', 'group_constrained', 'allow_inactive', 'without_team', 'limit', 'allow_full_names', 'allow_emails'];

                // APIリクエストのbodyを作成
                const requestBody: any = { term: args.term, };

                // オプションパラメータをリクエストボディに追加
                if (args.team_id) requestBody.team_id = args.team_id;
                if (args.not_in_team_id) requestBody.not_in_team_id = args.not_in_team_id;
                if (args.in_channel_id) requestBody.in_channel_id = args.in_channel_id;
                if (args.not_in_channel_id) requestBody.not_in_channel_id = args.not_in_channel_id;
                if (args.in_group_id) requestBody.in_group_id = args.in_group_id;
                if (args.group_constrained !== undefined) requestBody.group_constrained = args.group_constrained || false;
                if (args.allow_inactive !== undefined) requestBody.allow_inactive = args.allow_inactive || false;
                if (args.without_team !== undefined) requestBody.without_team = args.without_team || false;
                if (args.limit !== undefined) requestBody.limit = args.limit || 100;
                if (args.allow_full_names !== undefined) requestBody.allow_full_names = args.allow_full_names || true;
                if (args.allow_emails !== undefined) requestBody.allow_emails = args.allow_emails || true;

                const url = `${e.uriBase}/api/v4/users/search`;
                const resultList = (await axiosWithAuth.post(url, requestBody)).data;

                const result = {} as any;
                result.list = resultList;
                reform(result);
                // result.me = reform(userInfo);
                result.uriBase = e.uriBase;
                return result;
            }
        },
        {
            info: { group: provider, isActive: true, label: 'ユーザー検索', },
            definition: {
                type: 'function',
                function: {
                    name: `mm_${providerName}_find_user_alter_name_by_ids`,
                    description: '[Mattermost] 指定されたMattermostユーザーIDのリストを元に、ユーザーのメンション用キーワード（username）と表示用名（nickname）を取得する。',
                    parameters: {
                        type: 'object',
                        properties: {
                            ids: {
                                type: 'array',
                                items: { type: 'string', description: 'ユーザーID' },
                                description: '属性情報を取得する対象のユーザIDのリスト'
                            },
                        },
                        required: ['ids'],
                    },
                },
            },
            handler: async (args: { ids: string[], }):
                Promise<{ name: string, id: string, text: string }[]> => {
                const { e, axiosWithAuth } = await getOAuthAccountForTool(req, provider);
                const { ids } = args;
                const resultList = await ds.getRepository(MmUserEntity).find({
                    select: ['id', 'username', 'nickname'],
                    where: { id: In(ids) },
                });

                const result = {} as any;
                result.list = resultList;
                // console.dir(resultList);
                reform(result);
                // result.me = reform(userInfo);
                result.uriBase = e.uriBase;
                return result;
            }
        }, {
            info: { group: provider, isActive: true, isInteractive: false, label: `チャンネル一覧を取得`, },
            definition: {
                type: 'function',
                function: {
                    name: `mm_${providerName}_get_channels`,
                    description: Utils.trimLines(`
                        [Mattermost] ユーザーの所属する全チャンネルの一覧を取得する。
                        取得可能な項目が多く、データ量が爆発しやすいので必要な項目のみに絞って取得すること。
                        取得可能な項目：id,create_at,update_at,delete_at,team_id,type,display_name,name,header,purpose,last_post_at,total_msg_count,extra_update_at,creator_id,scheme_id,props,group_constrained,shared,total_msg_count_root,policy_id,last_root_post_at
                        termを指定すると、display_name, name, header, purposeのいずれかに部分一致するチャンネルのみを返す。
                    `),
                    parameters: {
                        type: 'object',
                        properties: {
                            term: {
                                type: 'string',
                                description: `チャンネル名の絞り込み文字列（display_name, name, header, purposeを対象に部分一致検索）`,
                            },
                            columns: {
                                type: 'array',
                                items: { type: 'string' },
                                description: Utils.trimLines(`取得対象の項目名リスト`)
                            },
                            not_associated_to_group: {
                                type: 'string',
                                description: `[optional] 指定されたグループIDに関連付けられていないチャンネルのみを取得。空文字列を指定すると、グループに関連付けられていないすべてのチャンネルを取得。`,
                            },
                            page: {
                                type: 'integer',
                                description: 'ページ番号',
                                default: 0
                            },
                            per_page: {
                                type: 'integer',
                                description: '1ページあたりのチャンネル数',
                                default: 0
                            },
                            exclude_default_channels: {
                                type: 'boolean',
                                description: 'デフォルトチャンネル（Town Square、Off-Topicなど）を除外するかどうか',
                                default: false
                            },
                            include_deleted: {
                                type: 'boolean',
                                description: 'アーカイブ（削除）されたチャンネルを含めるかどうか',
                                default: false
                            },
                            include_total_count: {
                                type: 'boolean',
                                description: 'レスポンスに総チャンネル数を含めるかどうか',
                                default: false
                            },
                            exclude_policy_constrained: {
                                type: 'boolean',
                                description: 'データ保持ポリシーの対象となっているチャンネルを除外するかどうか。sysconsole_read_compliance権限が必要。サーバーバージョン5.35以上が必要。',
                                default: false
                            }
                        },
                        required: ['term'],
                    }
                }
            },
            handler: async (args: {
                term: string,
                columns: string[],
                not_associated_to_group?: string,
                page?: number,
                per_page?: number,
                exclude_default_channels?: boolean,
                include_deleted?: boolean,
                include_total_count?: boolean,
                exclude_policy_constrained?: boolean
            }): Promise<any> => {
                const { e, oAuthAccount, axiosWithAuth } = await getOAuthAccountForTool(req, provider);
                const userInfo = oAuthAccount.userInfo as MattermostUser;

                // クエリパラメータの構築
                const queryParams = new URLSearchParams();
                // if (args.term !== undefined) {
                //     queryParams.append('term', args.term);
                // }
                if (!args.columns || args.columns.length === 0) {
                    args.columns = ['id', 'create_at', 'update_at', 'type', 'display_name', 'name', 'last_post_at', 'total_msg_count', 'team_id'];
                }
                if (!args.columns.includes('team_id')) {
                    args.columns.push('team_id');
                }
                if (args.not_associated_to_group !== undefined) {
                    queryParams.append('not_associated_to_group', args.not_associated_to_group);
                }
                if (args.page !== undefined) {
                    queryParams.append('page', args.page.toString());
                }
                if (args.per_page !== undefined) {
                    queryParams.append('per_page', args.per_page.toString());
                }
                if (args.exclude_default_channels !== undefined) {
                    queryParams.append('exclude_default_channels', args.exclude_default_channels.toString());
                }
                if (args.include_deleted !== undefined) {
                    queryParams.append('include_deleted', args.include_deleted.toString());
                }
                if (args.include_total_count !== undefined) {
                    queryParams.append('include_total_count', args.include_total_count.toString());
                }
                if (args.exclude_policy_constrained !== undefined) {
                    queryParams.append('exclude_policy_constrained', args.exclude_policy_constrained.toString());
                }

                const url = `${e.uriBase}/api/v4/users/me/channels${queryParams.toString() ? '?' + queryParams.toString() : ''}`;

                const resultResponse = (await axiosWithAuth.get(url)).data;
                let channels = resultResponse as MattermostChannel[];
                const result = {} as any;

                result.channels = channels;
                // ダイレクトチャネルとグループチャネルの個人名を補充する。
                const ids = new Set<string>();
                const names = new Set<string>();
                channels.forEach(mmChannel => {
                    let groupMemberIdList = [];
                    if (mmChannel.display_name) {
                        if (mmChannel.type === 'G') {
                            // 空白を削ってカンマで区切ってnameに入れる
                            groupMemberIdList = mmChannel.display_name.replaceAll(/ /g, '').split(',');
                            groupMemberIdList.forEach(username => names.add(username));
                            groupMemberIdList = groupMemberIdList.filter(id => id !== userInfo.username);
                        } else {
                            // グループ以外は無視
                        }
                    } else {
                        if (mmChannel.type === 'D') {
                            // 無名のダイレクトチャネルは名前を取ってくる。
                            groupMemberIdList = mmChannel.name.split('__');
                            groupMemberIdList.forEach(id => ids.add(id));
                            groupMemberIdList = groupMemberIdList.filter(id => id !== userInfo.id);
                            if (groupMemberIdList.length === 0 && userInfo) {
                                groupMemberIdList = [userInfo.id];
                            } else { }
                        } else {
                            // ダイレクトチャネル以外は無視
                        }
                    }
                });
                const idMas = await ds.getRepository(MmUserEntity).find({
                    select: ['id', 'username', 'nickname'],
                    where: { id: In(Array.from(ids)) },
                }).then(list => {
                    const mas = {} as any;
                    list.forEach(user => { mas[user.id] = user; });
                    return mas;
                });
                const nameMas = await ds.getRepository(MmUserEntity).find({
                    select: ['id', 'username', 'nickname'],
                    where: { username: In(Array.from(names)) },
                }).then(list => {
                    const mas = {} as any;
                    list.forEach(user => { mas[user.username] = user; });
                    return mas;
                });

                // console.dir(idMas);
                // console.dir(nameMas);
                channels.forEach(mmChannel => {
                    // console.log(`mmChannel.display_name: ${mmChannel.display_name}`);
                    if (mmChannel.display_name) {
                        if (mmChannel.type === 'G') {
                            // 空白を削ってカンマで区切ってnameに入れる
                            mmChannel.display_name = 'dummy';
                            mmChannel.display_name = mmChannel.display_name.replaceAll(/ /g, '').split(',').filter(username => username !== userInfo.username).map(username => nameMas[username]?.nickname || nameMas[username]?.username || '').filter(name => name.trim()).join(', ');
                            // console.log(mmChannel.display_name);
                        } else {
                            // グループ以外は無視
                        }
                    } else {
                        if (mmChannel.type === 'D') {
                            // console.log(`mmChannel.name: ${mmChannel.name}`);
                            // 無名のダイレクトチャネルは名前を取ってくる。
                            if (mmChannel.name === `${userInfo.id}__${userInfo.id}`) {
                                mmChannel.display_name = userInfo.nickname || userInfo.username || '';
                                // console.log(`mmChannel.display_name type1: ${mmChannel.display_name}`);
                            } else {
                                mmChannel.display_name = 'dummy';
                                mmChannel.display_name = mmChannel.name.split('__').filter(id => id !== userInfo.id).map(id => idMas[id]?.nickname || idMas[id]?.username || '').filter(name => name.trim()).join(', ');
                                // console.log(`mmChannel.display_name type2: ${mmChannel.display_name}`);
                            }
                            // console.log(mmChannel.display_name);
                        } else {
                            // ダイレクトチャネル以外は無視
                        }
                    }
                    Object.keys(mmChannel).forEach(key => {
                        if (!args.columns.includes(key)) {
                            delete (mmChannel as any)[key];
                        } else { }
                    });
                });

                // termによる絞り込み（display_name, name, header, purposeを対象）
                if (args.term && args.term.trim()) {
                    const termLower = args.term.toLowerCase();
                    result.channels = channels.filter(ch => {
                        const displayName = (ch.display_name || '').toLowerCase();
                        const name = (ch.name || '').toLowerCase();
                        const header = (ch.header || '').toLowerCase();
                        const purpose = (ch.purpose || '').toLowerCase();
                        return displayName.includes(termLower) || name.includes(termLower) || header.includes(termLower) || purpose.includes(termLower);
                    });
                } else { }

                reform(result, true);
                // result.resultCsvHeader = args.columns.join(',');
                // result.resultCsvData = channels.map(channel => {
                //     return args.columns.map(col => (channel as any)[col]).join(',');
                // }).join('\n');
                // delete result.channels;

                // result.me = reform(userInfo);
                result.uriBase = e.uriBase;
                return result;
            }
        }, {
            info: { group: provider, isActive: true, isInteractive: false, label: `チャンネルをAI検索`, },
            definition: {
                type: 'function',
                function: {
                    name: `mm_${providerName}_search_channels_by_ai`,
                    description: Utils.trimLines(`
                        [Mattermost] AIを使ってチャンネルをセマンティック検索する。
                        「開発関連のチャンネル」「プロジェクトXの議論をしているところ」のような曖昧なクエリに対応。
                        チャンネル名、ヘッダー、目的（purpose）を元にAIが関連度の高いチャンネルを選定する。
                        正確なキーワード検索にはmm_${providerName}_get_channelsのtermパラメータを使用する。
                    `),
                    parameters: {
                        type: 'object',
                        properties: {
                            query: {
                                type: 'string',
                                description: '検索したいチャンネルの説明（例：「開発関連」「〇〇プロジェクトの議論」「雑談系」など）'
                            },
                            limit: {
                                type: 'number',
                                description: '返すチャンネルの最大数',
                                default: 10,
                            },
                        },
                        required: ['query'],
                    }
                }
            },
            handler: async (args: {
                query: string,
                limit?: number,
            }): Promise<any> => {
                const { e, oAuthAccount, axiosWithAuth } = await getOAuthAccountForTool(req, provider);
                const userInfo = oAuthAccount.userInfo as MattermostUser;
                const limit = args.limit || 10;

                // Step 1: 全チャンネルを取得
                const channelsUrl = `${e.uriBase}/api/v4/users/me/channels`;
                const allChannels = (await axiosWithAuth.get(channelsUrl)).data as MattermostChannel[];

                // Step 2: チャンネル情報を整形（AIに渡すデータを作成）
                const channelSummaries = allChannels.map((ch, idx) => ({
                    index: idx,
                    id: ch.id,
                    type: ch.type,
                    display_name: ch.display_name || '',
                    name: ch.name || '',
                    header: ch.header || '',
                    purpose: ch.purpose || '',
                }));

                // Step 3: AIにチャンネル選定を依頼
                const systemPrompt = Utils.trimLines(`
                    あなたはMattermostチャンネルの検索アシスタントです。
                    ユーザーのクエリに基づいて、最も関連性の高いチャンネルを選定してください。
                    
                    チャンネルタイプ：
                    - O: 公開チャンネル
                    - P: プライベートチャンネル
                    - D: ダイレクトメッセージ
                    - G: グループメッセージ
                    
                    回答は以下のJSON形式で返してください：
                    {
                        "selected_indices": [0, 3, 5],
                        "reasoning": "選定理由の簡単な説明"
                    }
                    
                    JSONのみを返し、他の説明は不要です。
                `);

                const userPrompt = Utils.trimLines(`
                    以下のチャンネル一覧から「${args.query}」に関連するチャンネルを最大${limit}件選んでください。
                    
                    チャンネル一覧：
                    ${JSON.stringify(channelSummaries, null, 2)}
                `);

                const model = 'gemini-2.5-pro';
                const { aiProviderClient, aiModel, aiPrice } = await getAIProvider(req.info.user, model);

                const newLabel = `${label}-web_search_by_gemini`;

                // レスポンス返した後にゆるりとヒストリーを更新しておく。
                await wrapperLogger.log({
                    connectionId,
                    streamId,
                    messageId: message?.id,
                    label: newLabel,
                    model: model,
                    provider: aiProviderClient.name,
                });

                try {
                    let text = '';
                    const aiResultAsText = await new Promise<{ body: string }>((resolve, reject) => {
                        aiApi_.chatCompletionObservableStream({
                            model: 'gemini-2.5-flash',
                            messages: [
                                { role: 'system', content: [{ type: 'text', text: systemPrompt }] },
                                { role: 'user', content: [{ type: 'text', text: userPrompt }] },
                            ],
                            stream: true,
                        }, { label: newLabel }, aiProviderClient, aiModel, aiPrice
                        ).pipe(
                            timeout(30_000), // ← 30秒のタイムアウトを設定（ミリ秒）
                            map(res => res.choices.map(choice => choice.delta.content).join('')),
                            toArray(),
                            map(res => res.join('')),
                        ).subscribe({
                            next: next => {
                                text += next;
                            },
                            error: async error => {
                                resolve({ body: 'error' });
                            },
                            complete: async () => {
                                resolve({ body: text });
                            },
                        });
                    });
                    if (aiResultAsText.body === 'error') {

                    } else {
                        text = aiResultAsText.body;
                    }
                    try {
                        const aiResult = JSON.parse(aiResultAsText.body);

                        const selectedIndices: number[] = aiResult.selected_indices || [];

                        // Step 4: 選定されたチャンネルを返す
                        const selectedChannels = selectedIndices
                            .filter(idx => idx >= 0 && idx < allChannels.length)
                            .map(idx => ({
                                id: allChannels[idx].id,
                                type: allChannels[idx].type,
                                display_name: allChannels[idx].display_name,
                                name: allChannels[idx].name,
                                header: allChannels[idx].header,
                                purpose: allChannels[idx].purpose,
                                team_id: allChannels[idx].team_id,
                            }));

                        const result = {
                            query: args.query,
                            reasoning: aiResult.reasoning || '',
                            channels: selectedChannels,
                            total_searched: allChannels.length,
                            uriBase: e.uriBase,
                        };
                        reform(result);
                        return result;

                    } catch (error) {
                        throw new Error(`AI検索に失敗しました: ${error}`);
                    }
                } catch (error) {
                    throw new Error(`AI検索に失敗しました: ${error}`);
                }
            }
        },
        {
            info: { group: provider, isActive: true, isInteractive: false, label: 'チャンネル投稿検索（チーム不要）', },
            definition: {
                type: 'function',
                function: {
                    name: `mm_${providerName}_search_channel_posts`,
                    description: Utils.trimLines(`
                        [Mattermost] チャンネルIDを指定して投稿を検索する。DMチャンネル・グループチャンネルを含む全てのチャンネルタイプに対応。
                        チーム名の指定が不要なので、DMやグループチャンネルの投稿検索に最適。
                        キーワードなしで呼び出すとチャンネル内の全投稿を取得する。
                        投稿内容を提示する際はリンクもセットで提示すると良い。
                    `),
                    parameters: {
                        type: 'object',
                        properties: {
                            channel_id: { type: 'string', description: 'チャンネルID（DMチャンネルID、グループチャンネルIDも可）' },
                            term: {
                                type: 'string',
                                description: Utils.trimLines(`
                                    検索キーワード（省略可）。以下の特殊な検索構文が利用可能：
                                        - from:ユーザー名  → 特定のユーザーからの投稿を検索
                                        - "完全一致フレーズ" → ダブルクォートで囲むとフレーズとして完全一致検索
                                        - before:日付 → 指定日付より前（指定日は含まない）の投稿を検索
                                        - after:日付 → 指定日付より後（指定日は含まない）の投稿を検索
                                        - on:日付 → 指定日付の投稿を検索
                                    例：
                                        - from:john "重要な会議"
                                        - after:2023-01-01 バグ修正
                                    `),
                            },
                            limit: { type: 'number', description: '取得する最大数', default: 60, minimum: 1, maximum: 200 },
                        },
                        required: ['channel_id'],
                    },
                }
            },
            handler: async (args: { channel_id: string, term?: string, limit?: number }): Promise<any> => {
                const { e, axiosWithAuth } = await getOAuthAccountForTool(req, provider);
                const limit = Math.max(Math.min(args.limit || 60, 200), 1);

                // チャンネル情報を取得してチームIDを特定
                const channelInfoUrl = `${e.uriBase}/api/v4/channels/${args.channel_id}`;
                const channelInfo = (await axiosWithAuth.get(channelInfoUrl)).data;

                let result;
                if (args.term && args.term.trim()) {
                    // キーワードありの場合: チャンネル内検索
                    // in:チャンネル名 を使った検索を行う
                    const searchTerm = `in:${channelInfo.name} ${args.term}`;

                    if (channelInfo.team_id) {
                        // チーム所属チャンネルの場合
                        const url = `${e.uriBase}/api/v4/teams/${channelInfo.team_id}/posts/search`;
                        const data = { 'terms': searchTerm, 'is_or_search': false, 'include_deleted_channels': false, 'time_zone_offset': 32400, 'page': 0, 'per_page': limit };
                        result = (await axiosWithAuth.post(url, data)).data;
                    } else {
                        // DM/グループチャンネルの場合: 全投稿取得してからフィルタリング
                        const postsUrl = `${e.uriBase}/api/v4/channels/${args.channel_id}/posts?per_page=${limit}`;
                        result = (await axiosWithAuth.get(postsUrl)).data;

                        // 簡易的なキーワードフィルタリング
                        const termLower = args.term.toLowerCase();
                        if (result.posts) {
                            const filteredOrder: string[] = [];
                            const filteredPosts: any = {};
                            for (const postId of result.order || []) {
                                const post = result.posts[postId];
                                if (post && post.message && post.message.toLowerCase().includes(termLower)) {
                                    filteredOrder.push(postId);
                                    filteredPosts[postId] = post;
                                }
                            }
                            result.order = filteredOrder;
                            result.posts = filteredPosts;
                        }
                    }
                } else {
                    // キーワードなしの場合: 全投稿取得
                    const postsUrl = `${e.uriBase}/api/v4/channels/${args.channel_id}/posts?per_page=${limit}`;
                    result = (await axiosWithAuth.get(postsUrl)).data;
                }

                reform(result);
                result.channel_id = args.channel_id;
                result.channel_name = channelInfo.name;
                result.channel_display_name = channelInfo.display_name;
                result.uriBase = e.uriBase;
                return result;
            }
        },
        {
            info: { group: provider, isActive: true, isInteractive: false, label: 'チャンネル投稿一覧取得', },
            definition: {
                type: 'function',
                function: {
                    name: `mm_${providerName}_get_channel_posts`,
                    description: Utils.trimLines(`
                        [Mattermost] チャンネルIDを指定して投稿一覧を取得する。DMチャンネルを含む全てのチャンネルタイプに対応。
                        DMチャンネルの内容を読み取る場合はこのツールを使用する。
                        投稿内容を提示する際はリンクもセットで提示すると良い。
                    `),
                    parameters: {
                        type: 'object',
                        properties: {
                            channel_id: { type: 'string', description: 'チャンネルID（DMチャンネルIDも可）' },
                            per_page: { type: 'number', description: '1ページあたりの取得件数', default: 60, minimum: 1, maximum: 200 },
                            page: { type: 'number', description: 'ページ番号（0始まり）', default: 0 },
                            before: { type: 'string', description: 'この投稿IDより前の投稿を取得' },
                            after: { type: 'string', description: 'この投稿IDより後の投稿を取得' },
                            since: { type: 'number', description: 'このUnixタイムスタンプ（ミリ秒）以降の投稿を取得' },
                            include_deleted: { type: 'boolean', description: '削除済み投稿を含めるかどうか', default: false },
                        },
                        required: ['channel_id'],
                    },
                }
            },
            handler: async (args: { channel_id: string, per_page?: number, page?: number, before?: string, after?: string, since?: number, include_deleted?: boolean }): Promise<any> => {
                const { e, axiosWithAuth } = await getOAuthAccountForTool(req, provider);

                // クエリパラメータの構築
                const queryParams = new URLSearchParams();
                const perPage = Math.max(Math.min(args.per_page || 60, 200), 1);
                queryParams.append('per_page', perPage.toString());
                if (args.page !== undefined) queryParams.append('page', args.page.toString());
                if (args.before) queryParams.append('before', args.before);
                if (args.after) queryParams.append('after', args.after);
                if (args.since !== undefined) queryParams.append('since', args.since.toString());
                if (args.include_deleted) queryParams.append('include_deleted', 'true');

                const url = `${e.uriBase}/api/v4/channels/${args.channel_id}/posts?${queryParams.toString()}`;
                const result = (await axiosWithAuth.get(url)).data;
                reform(result);
                result.uriBase = e.uriBase;
                return result;
            }
        },
        {
            info: { group: provider, isActive: true, isInteractive: false, label: 'DM投稿一覧取得', },
            definition: {
                type: 'function',
                function: {
                    name: `mm_${providerName}_get_dm_posts`,
                    description: Utils.trimLines(`
                        [Mattermost] 指定したユーザーとのダイレクトメッセージ（DM）の投稿一覧を取得する。
                        ユーザーID、ユーザー名（username）、ニックネーム（nickname）のいずれかでDM相手を指定可能。
                        DMチャンネルの特定と投稿取得を一括で行う簡易ツール。
                        「〇〇さんとのDMを見て」というタスクに最適。
                        グループチャンネルも含めて検索したい場合はmm_${providerName}_get_conversations_with_userを使用する。
                    `),
                    parameters: {
                        type: 'object',
                        properties: {
                            user_id: { type: 'string', description: 'DM相手のユーザーID（user_id, username, nicknameのいずれか1つを指定）' },
                            username: { type: 'string', description: 'DM相手のユーザー名（メンション時に使う@の後ろの名前）' },
                            nickname: { type: 'string', description: 'DM相手のニックネーム（表示名）' },
                            limit: { type: 'number', description: '取得する最大件数', default: 60, minimum: 1, maximum: 200 },
                        },
                        required: [],
                    },
                }
            },
            handler: async (args: { user_id?: string, username?: string, nickname?: string, limit?: number }): Promise<any> => {
                const { e, oAuthAccount, axiosWithAuth } = await getOAuthAccountForTool(req, provider);
                const userInfo = oAuthAccount.userInfo as MattermostUser;
                const limit = Math.max(Math.min(args.limit || 60, 200), 1);

                // ユーザーIDを特定
                let targetUserId = args.user_id;
                if (!targetUserId) {
                    if (args.username) {
                        // usernameで検索
                        const user = await ds.getRepository(MmUserEntity).findOne({
                            select: ['id'],
                            where: { username: args.username },
                        });
                        if (user) {
                            targetUserId = user.id;
                        } else {
                            // DBになければAPIで検索
                            const searchUrl = `${e.uriBase}/api/v4/users/username/${args.username}`;
                            try {
                                const userResult = (await axiosWithAuth.get(searchUrl)).data;
                                targetUserId = userResult.id;
                            } catch {
                                throw new Error(`ユーザー名 "${args.username}" が見つかりません。`);
                            }
                        }
                    } else if (args.nickname) {
                        // nicknameで検索（DBから）
                        const user = await ds.getRepository(MmUserEntity).findOne({
                            select: ['id'],
                            where: { nickname: args.nickname },
                        });
                        if (user) {
                            targetUserId = user.id;
                        } else {
                            // nicknameはAPI検索が必要
                            const searchUrl = `${e.uriBase}/api/v4/users/search`;
                            const searchResult = (await axiosWithAuth.post(searchUrl, { term: args.nickname, limit: 10 })).data;
                            const matchedUser = searchResult.find((u: any) => u.nickname === args.nickname);
                            if (matchedUser) {
                                targetUserId = matchedUser.id;
                            } else {
                                throw new Error(`ニックネーム "${args.nickname}" が見つかりません。`);
                            }
                        }
                    } else {
                        throw new Error('user_id, username, nicknameのいずれかを指定してください。');
                    }
                }

                // Step 1: DMチャンネルを取得または作成
                const dmChannelUrl = `${e.uriBase}/api/v4/channels/direct`;
                const dmChannelResult = (await axiosWithAuth.post(dmChannelUrl, [userInfo.id, targetUserId])).data;
                const channelId = dmChannelResult.id;

                // Step 2: チャンネルから投稿を取得
                const postsUrl = `${e.uriBase}/api/v4/channels/${channelId}/posts?per_page=${limit}`;
                const result = (await axiosWithAuth.get(postsUrl)).data;
                reform(result);
                result.dm_channel_id = channelId;
                result.dm_partner_user_id = targetUserId;
                result.uriBase = e.uriBase;
                return result;
            }
        },
        {
            info: { group: provider, isActive: true, isInteractive: false, label: 'ユーザーとのやり取り取得', },
            definition: {
                type: 'function',
                function: {
                    name: `mm_${providerName}_get_conversations_with_user`,
                    description: Utils.trimLines(`
                        [Mattermost] 指定したユーザーとのやり取りがあるチャンネル（DM・グループチャンネル）を検索し、投稿を取得する。
                        ユーザーID、ユーザー名（username）、ニックネーム（nickname）のいずれかで相手を指定可能。
                        「〇〇さんとのやり取りを見て」「〇〇さんとの会話」というタスクに最適。
                        DMだけでなく、指定ユーザーが参加しているグループチャンネルも対象になる。
                    `),
                    parameters: {
                        type: 'object',
                        properties: {
                            user_id: { type: 'string', description: '相手のユーザーID（user_id, username, nicknameのいずれか1つを指定）' },
                            username: { type: 'string', description: '相手のユーザー名（メンション時に使う@の後ろの名前）' },
                            nickname: { type: 'string', description: '相手のニックネーム（表示名）' },
                            include_group_channels: { type: 'boolean', description: 'グループチャンネルも含めるか（falseの場合はDMのみ）', default: true },
                            limit_per_channel: { type: 'number', description: 'チャンネルごとの取得投稿数', default: 30, minimum: 1, maximum: 100 },
                        },
                        required: [],
                    },
                }
            },
            handler: async (args: { user_id?: string, username?: string, nickname?: string, include_group_channels?: boolean, limit_per_channel?: number }): Promise<any> => {
                const { e, oAuthAccount, axiosWithAuth } = await getOAuthAccountForTool(req, provider);
                const userInfo = oAuthAccount.userInfo as MattermostUser;
                const limitPerChannel = Math.max(Math.min(args.limit_per_channel || 30, 100), 1);
                const includeGroup = args.include_group_channels !== false;

                // ユーザーIDを特定（共通処理）
                let targetUserId = args.user_id;
                let targetUserInfo: { id: string, username?: string, nickname?: string } | null = null;

                if (!targetUserId) {
                    if (args.username) {
                        const user = await ds.getRepository(MmUserEntity).findOne({
                            select: ['id', 'username', 'nickname'],
                            where: { username: args.username },
                        });
                        if (user) {
                            targetUserId = user.id;
                            targetUserInfo = user;
                        } else {
                            const searchUrl = `${e.uriBase}/api/v4/users/username/${args.username}`;
                            try {
                                const userResult = (await axiosWithAuth.get(searchUrl)).data;
                                targetUserId = userResult.id;
                                targetUserInfo = userResult;
                            } catch {
                                throw new Error(`ユーザー名 "${args.username}" が見つかりません。`);
                            }
                        }
                    } else if (args.nickname) {
                        const user = await ds.getRepository(MmUserEntity).findOne({
                            select: ['id', 'username', 'nickname'],
                            where: { nickname: args.nickname },
                        });
                        if (user) {
                            targetUserId = user.id;
                            targetUserInfo = user;
                        } else {
                            const searchUrl = `${e.uriBase}/api/v4/users/search`;
                            const searchResult = (await axiosWithAuth.post(searchUrl, { term: args.nickname, limit: 10 })).data;
                            const matchedUser = searchResult.find((u: any) => u.nickname === args.nickname);
                            if (matchedUser) {
                                targetUserId = matchedUser.id;
                                targetUserInfo = matchedUser;
                            } else {
                                throw new Error(`ニックネーム "${args.nickname}" が見つかりません。`);
                            }
                        }
                    } else {
                        throw new Error('user_id, username, nicknameのいずれかを指定してください。');
                    }
                }

                // Step 1: 自分の全チャンネルを取得
                const myChannelsUrl = `${e.uriBase}/api/v4/users/me/channels`;
                const myChannels = (await axiosWithAuth.get(myChannelsUrl)).data as MattermostChannel[];

                // Step 2: DM・グループチャンネルをフィルタ
                const targetChannels: MattermostChannel[] = [];
                for (const channel of myChannels) {
                    if (channel.type === 'D') {
                        // DMチャンネル: nameに両ユーザーIDが含まれる
                        if (channel.name.includes(targetUserId!)) {
                            targetChannels.push(channel);
                        }
                    } else if (channel.type === 'G' && includeGroup) {
                        // グループチャンネル: メンバー一覧を取得して確認
                        const membersUrl = `${e.uriBase}/api/v4/channels/${channel.id}/members`;
                        try {
                            const members = (await axiosWithAuth.get(membersUrl)).data;
                            const isMember = members.some((m: any) => m.user_id === targetUserId);
                            if (isMember) {
                                targetChannels.push(channel);
                            }
                        } catch {
                            // メンバー取得に失敗した場合はスキップ
                        }
                    }
                }

                // Step 3: 各チャンネルから投稿を取得
                const conversations: any[] = [];
                for (const channel of targetChannels) {
                    const postsUrl = `${e.uriBase}/api/v4/channels/${channel.id}/posts?per_page=${limitPerChannel}`;
                    try {
                        const posts = (await axiosWithAuth.get(postsUrl)).data;
                        conversations.push({
                            channel_id: channel.id,
                            channel_type: channel.type,
                            channel_display_name: channel.display_name || (channel.type === 'D' ? 'ダイレクトメッセージ' : 'グループチャンネル'),
                            posts: posts,
                        });
                    } catch {
                        // 投稿取得に失敗した場合はスキップ
                    }
                }

                const result = {
                    target_user: targetUserInfo || { id: targetUserId },
                    channels_found: targetChannels.length,
                    conversations: conversations,
                    uriBase: e.uriBase,
                };
                reform(result);
                return result;
            }
        },
        {
            info: { group: provider, isActive: true, isInteractive: true, label: 'メッセージ送信', },
            definition: {
                type: 'function',
                function: {
                    name: `mm_${providerName}_send_message`,
                    description: 'チャンネルに新しい投稿を作成する。他の投稿へのコメントとして作成する場合はroot_idを指定する。',
                    parameters: {
                        type: 'object',
                        properties: {
                            channel_id: { type: 'string', description: '投稿先のチャンネルID。channel_nameではないので注意が必要。' },
                            channel_display_name: { type: 'string', description: '投稿先のチャンネル名。チャンネル一覧を検索して取得したチャンネルIDとセットの名前。' },
                            message: { type: 'string', description: 'メッセージの内容。Markdownでフォーマット可能' },
                            root_id: { type: 'string', description: 'コメント対象の投稿ID' },
                            file_ids: { type: 'array', items: { type: 'string' }, description: '投稿に添付するファイルIDのリスト。最大5つまで' },
                            props: { type: 'object', description: '投稿に付加する任意のJSONプロパティ' },
                            metadata: { type: 'object', description: '投稿のメタデータ（優先度など）を追加するためのJSONオブジェクト' },
                            set_online: { type: 'boolean', description: 'ユーザーのステータスをオンラインに設定するかどうか' }
                        },
                        required: ['channel_id', 'channel_display_name', 'message']
                    }
                }
            },
            handler: async (args: { channel_id: string, message: string, root_id?: string, file_ids?: string[], props?: any, metadata?: any, set_online?: boolean }): Promise<any> => {
                const { e, axiosWithAuth } = await getOAuthAccountForTool(req, provider);
                // クエリパラメータの構築
                const queryParams = args.set_online !== undefined ? `?set_online=${args.set_online}` : '';

                // リクエストボディの構築
                const requestBody: any = {
                    channel_id: args.channel_id,
                    message: args.message
                };

                // オプショナルフィールドの追加
                if (args.root_id) requestBody.root_id = args.root_id;
                if (args.file_ids) requestBody.file_ids = args.file_ids;
                if (args.props) requestBody.props = args.props;
                if (args.metadata) requestBody.metadata = args.metadata;

                const url = `${e.uriBase}/api/v4/posts${queryParams}`;

                const result = (await axiosWithAuth.post(url, requestBody)).data;
                reform(result);
                // result.me = reform(userInfo);
                result.uriBase = e.uriBase;
                return result;
            }
        },
    ];
};

import { MyToolType, OpenAIApiWrapper, providerPrediction } from "../../common/openai-api-wrapper.js";
import { UserRequest } from "../models/info.js";
import { ContentPartEntity, MessageEntity, MessageGroupEntity, PredictHistoryWrapperEntity } from "../entity/project-models.entity.js";
import { MessageArgsSet } from "../controllers/chat-by-project-model.js";
import { getOAuthAccountForTool, reform } from "./common.js";

/**
 * Jira-Star API ツール定義
 * 
 * ## 概要
 * このファイルは Jira REST API v2 をラップした各種ツールを提供します。
 * 主に課題の作成・更新・検索・削除、およびメタデータ取得機能を含みます。
 * 
 * ## JIRA API の課題と解決方法
 * 
 * ### 背景：なぜメタデータ取得が必要か
 * - Jira プロジェクトでは、管理者が「必須フィールド」「カスタムフィールド」を頻繁に変更する
 * - 課題作成時に必須項目が不足すると HTTP 400 エラーが発生し、エラーメッセージから推測する必要がある
 * - プロジェクトごと・課題タイプごとに異なるフィールド設定があり、GUI での目視確認が困難
 * - API 自動化時にトライ＆エラーでフィールド要件を特定するのは非効率
 * 
 * ### 解決策：メタデータ API の活用
 * 1. **事前調査**: `get_create_meta` で必須フィールドを確認してから課題作成
 * 2. **編集前確認**: `get_edit_meta` で編集可能なフィールドを事前チェック
 * 3. **ワークフロー対応**: `get_transition_fields` でステータス変更時の必要項目を把握
 * 
 * ## 推奨ワークフロー
 * 
 * ### 課題作成の場合
 * ```
 * 1. jira_star_get_create_meta で必須フィールドを取得
 *    → projects[].issuetypes[].fields で required: true のフィールドを確認
 * 2. 必要なフィールドを全て用意
 * 3. jira_star_create_issue で課題作成（400 エラーが激減）
 * ```
 * 
 * ### 課題編集の場合
 * ```
 * 1. jira_star_get_edit_meta で編集可能フィールドを確認
 * 2. jira_star_update_issue で更新
 * ```
 * 
 * ### ステータス変更の場合
 * ```
 * 1. jira_star_get_transitions で利用可能な遷移を取得
 * 2. jira_star_get_transition_fields で遷移時の必須フィールドを確認
 * 3. jira_star_transition_issue でステータス変更
 * ```
 * 
 * ## 各メタデータ API の使い分け
 * 
 * | API | 用途 | 主要レスポンス |
 * |-----|------|---------------|
 * | get_create_meta | 新規課題作成前の必須フィールド確認 | projects[].issuetypes[].fields |
 * | get_edit_meta | 既存課題編集前の権限・フィールド確認 | fields (編集可能性含む) |
 * | get_transition_fields | ステータス変更時の必須フィールド確認 | transitions[].fields |
 * 
 * ## 注意事項
 * - プロジェクトキーは大文字小文字を区別します
 * - カスタムフィールドは `customfield_xxxxx` 形式の ID で指定
 * - 必須フィールドは `required: true` で判定
 * - レート制限を考慮し、メタデータは適度にキャッシュすることを推奨
 */

// 1. 関数マッピングの作成
export async function jiraFunctionDefinitions(providerSubName: string,
    obj: { inDto: MessageArgsSet; messageSet: { messageGroup: MessageGroupEntity; message: MessageEntity; contentParts: ContentPartEntity[]; }; },
    req: UserRequest, aiApi: OpenAIApiWrapper, connectionId: string, streamId: string, message: MessageEntity, label: string,
): Promise<MyToolType[]> {
    const provider = `jira-${providerSubName}`;
    return [
        {
            info: { group: provider, isActive: true, isInteractive: false, label: `jira-${providerSubName}：自分のユーザー情報`, },
            definition: {
                type: 'function', function: {
                    name: `jira_${providerSubName}_user_info`,
                    description: `jira-${providerSubName}：自分のユーザー情報と良く使うプロジェクト`,
                    parameters: { type: 'object', properties: {}, }
                }
            },
            handler: async (args: {}): Promise<any> => {
                const { e, axiosWithAuth } = await getOAuthAccountForTool(req, provider);
                // ユーザー情報を取得
                const result = (await axiosWithAuth.get(`${e.uriBase}${e.pathUserInfo}`)).data;

                // 参照履歴を取得
                const historyUrl = `${e.uriBase}/rest/api/1.0/menus/browse_link?inAdminMode=false`;
                const resultCurrent = (await axiosWithAuth.get(historyUrl, { headers: { 'Content-Type': 'application/json' } })).data;

                reform(result);
                result.current = resultCurrent;
                result.uriBase = e.uriBase;
                return result;
            }
        },
        {
            info: { group: provider, isActive: true, isInteractive: false, label: `jira-${providerSubName}：JQL v2での検索`, },
            definition: {
                type: 'function', function: {
                    name: `jira_${providerSubName}_jql_v2_search`,
                    description: `jira-${providerSubName}：JQL v2での検索`,
                    parameters: {
                        type: 'object',
                        properties: {
                            maxResults: { type: 'number', description: '取得する最大数。1以上200以下', default: 10, minimum: 1, maximum: 20 },
                            jql: {
                                type: 'string',
                                description: `JQL (Jira Query Language)の"v2"での検索条件指定。`,
                            },

                        },
                        required: ['jql'],
                    },
                }
            },
            handler: async (args: { jql: string, maxResults: number }): Promise<any> => {
                const { e, axiosWithAuth } = await getOAuthAccountForTool(req, provider);
                const { jql, maxResults = 10 } = args;

                // ユーザー情報を取得
                const url = `${e.uriBase}/rest/api/2/search?jql=${encodeURIComponent(jql)}&maxResults=${maxResults}`;
                const result = (await axiosWithAuth.get(url)).data;

                reform(result);
                result.uriBase = e.uriBase;
                return result;
            }
        },
        {
            info: { group: provider, isActive: true, isInteractive: true, label: `jira-${providerSubName}：Issue作成`, },
            definition: {
                type: 'function', function: {
                    name: `jira_${providerSubName}_create_issue`,
                    description: `jira-${providerSubName}：新しいIssueを作成`,
                    parameters: {
                        type: 'object',
                        properties: {
                            projectKey: { type: 'string', description: 'プロジェクトキー（例: TEST, PROJ）' },
                            summary: { type: 'string', description: 'Issue のタイトル' },
                            description: { type: 'string', description: 'Issue の説明', default: '' },
                            issueType: { type: 'string', description: 'Issue タイプ（例: Bug, Task, Story）', default: 'Task' },
                            priority: { type: 'string', description: '優先度（例: High, Medium, Low）', default: 'Medium' },
                            assignee: { type: 'string', description: '担当者のユーザー名', default: null },
                            labels: { type: 'array', items: { type: 'string' }, description: 'ラベルの配列', default: [] }
                        },
                        required: ['projectKey', 'summary']
                    }
                }
            },
            handler: async (args: { projectKey: string, summary: string, description?: string, issueType?: string, priority?: string, assignee?: string, labels?: string[] }): Promise<any> => {
                const { e, axiosWithAuth } = await getOAuthAccountForTool(req, provider);
                const { projectKey, summary, description = '', issueType = 'Task', priority = 'Medium', assignee, labels = [] } = args;

                const issueData = {
                    fields: {
                        project: { key: projectKey },
                        summary: summary,
                        description: description,
                        issuetype: { name: issueType },
                        priority: { name: priority },
                        labels: labels
                    }
                };

                if (assignee) {
                    (issueData.fields as any)['assignee'] = { name: assignee };
                }

                const url = `${e.uriBase}/rest/api/2/issue`;
                const result = (await axiosWithAuth.post(url, issueData)).data;

                reform(result);
                result.uriBase = e.uriBase;
                return result;
            }
        },
        {
            info: { group: provider, isActive: true, isInteractive: true, label: `jira-${providerSubName}：Issue更新`, },
            definition: {
                type: 'function', function: {
                    name: `jira_${providerSubName}_update_issue`,
                    description: `jira-${providerSubName}：既存のIssueを更新`,
                    parameters: {
                        type: 'object',
                        properties: {
                            issueIdOrKey: { type: 'string', description: 'Issue ID または Key（例: TEST-123）' },
                            summary: { type: 'string', description: '新しいタイトル' },
                            description: { type: 'string', description: '新しい説明' },
                            assignee: { type: 'string', description: '新しい担当者のユーザー名' },
                            priority: { type: 'string', description: '新しい優先度（例: High, Medium, Low）' },
                            labels: { type: 'array', items: { type: 'string' }, description: '新しいラベルの配列' }
                        },
                        required: ['issueIdOrKey']
                    }
                }
            },
            handler: async (args: { issueIdOrKey: string, summary?: string, description?: string, assignee?: string, priority?: string, labels?: string[] }): Promise<any> => {
                const { e, axiosWithAuth } = await getOAuthAccountForTool(req, provider);
                const { issueIdOrKey, summary, description, assignee, priority, labels } = args;

                const updateData: any = { fields: {} };

                if (summary) updateData.fields.summary = summary;
                if (description) updateData.fields.description = description;
                if (assignee) updateData.fields.assignee = { name: assignee };
                if (priority) updateData.fields.priority = { name: priority };
                if (labels) updateData.fields.labels = labels.map(label => ({ add: label }));

                const url = `${e.uriBase}/rest/api/2/issue/${encodeURIComponent(issueIdOrKey)}`;
                const result = (await axiosWithAuth.put(url, updateData)).data;

                reform(result);
                result.uriBase = e.uriBase;
                return result;
            }
        },
        {
            info: { group: provider, isActive: true, isInteractive: true, label: `jira-${providerSubName}：Issueステータス変更`, },
            definition: {
                type: 'function', function: {
                    name: `jira_${providerSubName}_transition_issue`,
                    description: `jira-${providerSubName}：Issueのステータスを変更（例: To Do → In Progress → Done）`,
                    parameters: {
                        type: 'object',
                        properties: {
                            issueIdOrKey: { type: 'string', description: 'Issue ID または Key（例: TEST-123）' },
                            transitionId: { type: 'string', description: 'トランジションID' },
                            comment: { type: 'string', description: 'ステータス変更時のコメント', default: '' }
                        },
                        required: ['issueIdOrKey', 'transitionId']
                    }
                }
            },
            handler: async (args: { issueIdOrKey: string, transitionId: string, comment?: string }): Promise<any> => {
                const { e, axiosWithAuth } = await getOAuthAccountForTool(req, provider);
                const { issueIdOrKey, transitionId, comment = '' } = args;

                const transitionData: any = {
                    transition: { id: transitionId }
                };

                if (comment) {
                    transitionData.update = {
                        comment: [{ add: { body: comment } }]
                    };
                }

                const url = `${e.uriBase}/rest/api/2/issue/${encodeURIComponent(issueIdOrKey)}/transitions`;
                const result = (await axiosWithAuth.post(url, transitionData)).data;

                reform(result);
                result.uriBase = e.uriBase;
                return result;
            }
        },
        {
            info: { group: provider, isActive: true, isInteractive: true, label: `jira-${providerSubName}：Issue利用可能トランジション取得`, },
            definition: {
                type: 'function', function: {
                    name: `jira_${providerSubName}_get_transitions`,
                    description: `jira-${providerSubName}：Issueで利用可能なトランジション（ステータス変更）を取得`,
                    parameters: {
                        type: 'object',
                        properties: {
                            issueIdOrKey: { type: 'string', description: 'Issue ID または Key（例: TEST-123）' }
                        },
                        required: ['issueIdOrKey']
                    }
                }
            },
            handler: async (args: { issueIdOrKey: string }): Promise<any> => {
                const { e, axiosWithAuth } = await getOAuthAccountForTool(req, provider);
                const { issueIdOrKey } = args;

                const url = `${e.uriBase}/rest/api/2/issue/${encodeURIComponent(issueIdOrKey)}/transitions`;
                const result = (await axiosWithAuth.get(url)).data;

                reform(result);
                result.uriBase = e.uriBase;
                return result;
            }
        },
        {
            info: { group: provider, isActive: true, isInteractive: true, label: `jira-${providerSubName}：コメント追加`, },
            definition: {
                type: 'function', function: {
                    name: `jira_${providerSubName}_add_comment`,
                    description: `jira-${providerSubName}：Issueにコメントを追加`,
                    parameters: {
                        type: 'object',
                        properties: {
                            issueIdOrKey: { type: 'string', description: 'Issue ID または Key（例: TEST-123）' },
                            body: { type: 'string', description: 'コメント内容' },
                            visibility: { type: 'string', description: 'コメントの可視性（例: group, role）', default: null }
                        },
                        required: ['issueIdOrKey', 'body']
                    }
                }
            },
            handler: async (args: { issueIdOrKey: string, body: string, visibility?: string }): Promise<any> => {
                const { e, axiosWithAuth } = await getOAuthAccountForTool(req, provider);
                const { issueIdOrKey, body, visibility } = args;

                const commentData: any = { body: body };

                if (visibility) {
                    commentData.visibility = {
                        type: visibility,
                        value: visibility
                    };
                }

                const url = `${e.uriBase}/rest/api/2/issue/${encodeURIComponent(issueIdOrKey)}/comment`;
                const result = (await axiosWithAuth.post(url, commentData)).data;

                reform(result);
                result.uriBase = e.uriBase;
                return result;
            }
        },
        {
            info: { group: provider, isActive: true, isInteractive: true, label: `jira-${providerSubName}：Issue削除`, },
            definition: {
                type: 'function', function: {
                    name: `jira_${providerSubName}_delete_issue`,
                    description: `jira-${providerSubName}：Issueを削除`,
                    parameters: {
                        type: 'object',
                        properties: {
                            issueIdOrKey: { type: 'string', description: 'Issue ID または Key（例: TEST-123）' },
                            deleteSubtasks: { type: 'boolean', description: 'サブタスクも削除するか', default: false }
                        },
                        required: ['issueIdOrKey']
                    }
                }
            },
            handler: async (args: { issueIdOrKey: string, deleteSubtasks?: boolean }): Promise<any> => {
                const { e, axiosWithAuth } = await getOAuthAccountForTool(req, provider);
                const { issueIdOrKey, deleteSubtasks = false } = args;

                const url = `${e.uriBase}/rest/api/2/issue/${encodeURIComponent(issueIdOrKey)}?deleteSubtasks=${deleteSubtasks}`;
                const result = (await axiosWithAuth.delete(url)).data;

                reform(result);
                result.uriBase = e.uriBase;
                return result;
            }
        },
        {
            info: { group: provider, isActive: true, isInteractive: false, label: `jira-${providerSubName}：課題作成メタデータ取得`, },
            definition: {
                type: 'function', function: {
                    name: `jira_${providerSubName}_get_create_meta`,
                    description: `jira-${providerSubName}：課題作成前に必須フィールドを事前確認するAPI。Jiraでは管理者がプロジェクトごと・課題タイプごとに必須フィールドを頻繁に変更するため、課題作成時に400エラーが発生しやすい。このAPIで事前に必須フィールド（required: true）を取得することで、確実に課題作成できるデータを準備可能。レスポンスのprojects[].issuetypes[].fieldsで各フィールドの必須/任意を判定し、customfield_xxxxxのようなカスタムフィールドも含めて全必須項目を把握できる。`,
                    parameters: {
                        type: 'object',
                        properties: {
                            projectKeys: { 
                                type: 'array', 
                                items: { type: 'string' },
                                description: 'プロジェクトキーの配列（例: ["EBANGO", "TEST"]）',
                                minItems: 1,
                                maxItems: 20
                            },
                            issueTypeNames: { 
                                type: 'array', 
                                items: { type: 'string' },
                                description: '課題タイプ名の配列（例: ["タスク", "バグ"]）。未指定なら全課題タイプ' 
                            },
                            issueTypeIds: { 
                                type: 'array', 
                                items: { type: 'number' },
                                description: '課題タイプIDの配列（例: [1, 2]）。issueTypeNamesと同時指定不可' 
                            },
                            expandFields: { 
                                type: 'boolean', 
                                description: 'フィールド詳細を展開するか',
                                default: true 
                            }
                        },
                        required: ['projectKeys']
                    }
                }
            },
            handler: async (args: { projectKeys: string[], issueTypeNames?: string[], issueTypeIds?: number[], expandFields?: boolean }): Promise<any> => {
                const { e, axiosWithAuth } = await getOAuthAccountForTool(req, provider);
                const { projectKeys, issueTypeNames, issueTypeIds, expandFields = true } = args;

                // バリデーション: issueTypeNames と issueTypeIds の同時指定禁止
                if (issueTypeNames && issueTypeIds) {
                    throw new Error('issueTypeNames と issueTypeIds は同時に指定できません');
                }

                const params = new URLSearchParams();
                
                // プロジェクトキー
                projectKeys.forEach(key => params.append('projectKeys', key));
                
                // 課題タイプ指定
                if (issueTypeNames) {
                    issueTypeNames.forEach(name => params.append('issuetypeNames', name));
                }
                if (issueTypeIds) {
                    issueTypeIds.forEach(id => params.append('issuetypeIds', id.toString()));
                }
                
                // フィールド展開
                if (expandFields) {
                    params.append('expand', 'projects.issuetypes.fields');
                }

                const url = `${e.uriBase}/rest/api/2/issue/createmeta?${params.toString()}`;
                const result = (await axiosWithAuth.get(url)).data;

                reform(result);
                result.fetchedAt = new Date().toISOString();
                result.sourceUrl = url;
                result.uriBase = e.uriBase;
                return result;
            }
        },
        {
            info: { group: provider, isActive: true, isInteractive: false, label: `jira-${providerSubName}：課題編集メタデータ取得`, },
            definition: {
                type: 'function', function: {
                    name: `jira_${providerSubName}_get_edit_meta`,
                    description: `jira-${providerSubName}：既存課題の編集可能フィールドを事前確認するAPI。課題更新前にユーザーが編集権限を持つフィールド一覧を取得し、権限不足による403エラーを防ぐ。レスポンスには各フィールドの現在値と編集可否情報が含まれるため、update_issueの実行前に安全に更新可能なフィールドを特定できる。ワークフローの制約やプロジェクト権限により編集不可になっているフィールドも判別可能。`,
                    parameters: {
                        type: 'object',
                        properties: {
                            issueIdOrKey: { type: 'string', description: 'Issue ID または Key（例: TEST-123）' }
                        },
                        required: ['issueIdOrKey']
                    }
                }
            },
            handler: async (args: { issueIdOrKey: string }): Promise<any> => {
                const { e, axiosWithAuth } = await getOAuthAccountForTool(req, provider);
                const { issueIdOrKey } = args;

                const url = `${e.uriBase}/rest/api/2/issue/${encodeURIComponent(issueIdOrKey)}/editmeta`;
                const result = (await axiosWithAuth.get(url)).data;

                reform(result);
                result.fetchedAt = new Date().toISOString();
                result.sourceUrl = url;
                result.uriBase = e.uriBase;
                return result;
            }
        },
        {
            info: { group: provider, isActive: true, isInteractive: false, label: `jira-${providerSubName}：ステータス遷移フィールド取得`, },
            definition: {
                type: 'function', function: {
                    name: `jira_${providerSubName}_get_transition_fields`,
                    description: `jira-${providerSubName}：ステータス遷移時の必須フィールドを事前確認するAPI。Jiraワークフローでは遷移ごとに異なるフィールドが必須になる場合があり（例：「完了」への遷移時のみ「解決方法」が必須）、事前確認なしにtransition_issueを実行すると400エラーが発生する。このAPIでtransitions[].fieldsを取得し、各遷移で必要なフィールドとその必須/任意を把握してからステータス変更を実行することで確実な遷移処理が可能。`,
                    parameters: {
                        type: 'object',
                        properties: {
                            issueIdOrKey: { type: 'string', description: 'Issue ID または Key（例: TEST-123）' }
                        },
                        required: ['issueIdOrKey']
                    }
                }
            },
            handler: async (args: { issueIdOrKey: string }): Promise<any> => {
                const { e, axiosWithAuth } = await getOAuthAccountForTool(req, provider);
                const { issueIdOrKey } = args;

                const url = `${e.uriBase}/rest/api/2/issue/${encodeURIComponent(issueIdOrKey)}/transitions?expand=transitions.fields`;
                const result = (await axiosWithAuth.get(url)).data;

                reform(result);
                result.fetchedAt = new Date().toISOString();
                result.sourceUrl = url;
                result.uriBase = e.uriBase;
                return result;
            }
        },
    ];
};

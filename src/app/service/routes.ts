import { Router } from 'express';
import { changePassword, deleteUser, patchDepartmentMember, getDepartment, getDepartmentList, getUser, guestLogin, onetimeLogin, passwordReset, requestForPasswordReset, updateUser, userLogin, getUserList, userLoginOAuth2, userLoginOAuth2Callback, logout, getOAuthAccountList, oAuthEmailAuth, getDepartmentMemberLog, getDepartmentMemberLogForUser, genApiToken, getOAuthAccount, getDepartmentMemberForUser, getScopeLabels, getJournal, getDepartmentMemberLogSummaryForUser } from './controllers/auth.js';
import { authenticateInviteToken, authenticateOAuthUser, authenticateUserTokenMiddleGenerator } from './middleware/authenticate.js';
import { chatCompletion, chatCompletionStream, codegenCompletion, geminiCountTokens, geminiCreateContextCache, geminiDeleteContextCache, geminiUpdateContextCache, initEvent } from './controllers/chat.js';
import {
    createTeam,
    getTeamList,
    getTeam,
    updateTeam,
    deleteTeam,
    addTeamMember,
    getTeamMembers,
    updateTeamMember,
    removeTeamMember,
    createProject,
    getProjectList,
    getProject,
    updateProject,
    deleteProject,
    getThreadGroupList,
    deleteThreadGroup,
    getMessageGroupList,
    deleteMessageGroup,
    deleteMessage,
    upsertMessageWithContents,
    getMessageGroupDetails,
    getMessageContentParts,
    deleteContentPart,
    moveThreadGroup,
    upsertThreadGroup,
    updateMessageOrMessageGroupTimestamp,
    upsertMessageWithContents3,
    threadClone,
    threadGroupClone,
    editMessageWithContents,
    updateThreadGroupTitleAndDescription,
} from './controllers/project-models.js';

// import { addDevelopmentStages, addDiscussions, addDocuments, addStatements, addTasks, createProject, deleteDevelopmentStage, deleteDiscussion, deleteDocument, deleteProject, deleteStatement, deleteTask, getDevelopmentStage, getDevelopmentStageList, getDiscussion, getDiscussionList, getDocument, getDocumentList, getProject, getProjectDeep, getProjectList, getStatement, getStatementList, getTask, getTaskList, updateDevelopmentStage, updateDiscussion, updateDocument, updateProject, updateStatement, updateTask } from './controllers/project-models.js';
import { deleteFile, downloadFile, getFileGroup, getFileList, updateFileAccess, fileActivate, updateFileMetadata, uploadFiles } from './controllers/file-manager.js';
import { chatCompletionByProjectModel, geminiCountTokensByProjectModel, geminiCountTokensByThread, geminiCreateContextCacheByProjectModel, geminiDeleteContextCacheByProjectModel, geminiUpdateContextCacheByProjectModel } from './controllers/chat-by-project-model.js';
import { UserRoleType } from './entity/auth.entity.js';
import { getOAuthApiProxy } from './api/api-proxy.js';
import { createTimeline, deleteTimeline, getMmUsers, getTimelines, mattermostToAi, updateTimeline, updateTimelineChannel } from './api/api-mattermost.js';
import { getUserSetting, upsertUserSetting, deleteUserSetting, getApiProviders, upsertApiProvider, deleteApiProvider, getApiProviderTemplates, upsertApiProviderTemplate, deleteApiProviderTemplate, getOrganizations, upsertOrganization, deactivateOrganization, getOrganizationUsers } from './controllers/user.js';
import * as gitlab from './api/api-gitlab.js';
import * as gitea from './api/api-gitea.js';
import { boxApiCollection, boxApiItem, boxDownload, boxUpload, upsertBoxApiCollection } from './api/api-box.js';
import { registApiKey, deleteApiKey, getApiKeys, getFunctionDefinitions, getToolCallGroup, getToolCallGroupByToolCallId } from './controllers/tool-call.js';
import { upsertMCPServer, getMCPServers, deleteMCPServer } from './controllers/mcp-manager.js';
import { deleteAIProvider, deleteAIProviderTemplate, deleteBaseModel, deleteModelPricing, deleteTag, getAIProviders, getAIProviderTemplates, getAllTags, getBaseModels, getModelPricings, upsertAIProvider, upsertAIProviderTemplate, upsertBaseModel, upsertModelPricing, upsertTag } from './controllers/ai-model-manager.js';
import { vertexAIByAnthropicAPI, vertexAIByAnthropicAPIStream } from './controllers/claude-proxy.js';
import { getDivisionMembers, updateDivisionMember, removeDivisionMember, getDivisionList, getDivision, deleteDivision, getAllDivisions, upsertDivisionMember, upsertDivision } from './controllers/division.js';

// routers/index.ts

// 認証種別によってルーターを分ける
export const authNoneRouter = Router();
export const authUserRouter = Router();
export const authOAuthRouter = Router();
export const authAdminRouter = Router();
export const authMaintainerRouter = Router();
export const authInviteRouter = Router();

// 認証種別ごとのミドルウェアを設定
authUserRouter.use(authenticateUserTokenMiddleGenerator(UserRoleType.User, true));
authAdminRouter.use(authenticateUserTokenMiddleGenerator(UserRoleType.Admin, true));
authMaintainerRouter.use(authenticateUserTokenMiddleGenerator(UserRoleType.Maintainer, true));

authInviteRouter.use(authenticateInviteToken);

// 個別コントローラーの設定
// authNoneRouter.post('/login', userLogin);
authNoneRouter.post('/:orgKey/login', userLogin);
authNoneRouter.get('/logout', logout);
authNoneRouter.post('/:orgKey/onetime', onetimeLogin);
authNoneRouter.post('/:orgKey/request-for-password-reset', requestForPasswordReset);
// authNoneRouter.post('/onetime', onetimeLogin);
// authNoneRouter.post('/rwequest-for-password-reset', requestForPasswordReset);
// authNoneRouter.post('/guest', guestLogin);
authInviteRouter.post('/password-reset', passwordReset);
authInviteRouter.post('/oauth-emailauth', oAuthEmailAuth);

// OAuth2
authNoneRouter.get('/oauth/:orgKey/:provider/login', userLoginOAuth2);
authNoneRouter.get('/oauth/callback', userLoginOAuth2Callback); // 認証があっても無くても動くようにしておく

// ユーザー認証系
authUserRouter.get('/user', getUser);
authUserRouter.patch('/user', updateUser);
authUserRouter.patch('/change-password', changePassword);
authUserRouter.delete('/user', deleteUser);
authUserRouter.get(`/predict-history`, getDepartmentMemberLogForUser);
authUserRouter.get(`/predict-history/summary`, getDepartmentMemberLogSummaryForUser);

// authUserRouter.get('/access-token', genAccessToken);
authUserRouter.post('/api-token', genApiToken);

authUserRouter.get(`/user-list`, getUserList); // メンバー追加時のサジェスト

authUserRouter.get(`/user-setting/:userId/:key`, getUserSetting);
authUserRouter.post(`/user-setting/:userId/:key`, upsertUserSetting);
authUserRouter.delete(`/user-setting/:userId/:key`, deleteUserSetting);

// チャット系
authUserRouter.get('/event', initEvent);
authUserRouter.post('/chat-completion', chatCompletion);
authUserRouter.post('/v1/chat/completions', chatCompletionStream);
authUserRouter.post('/codegen/completions', codegenCompletion);
authUserRouter.post('/create-cache', geminiCreateContextCache);
authUserRouter.post('/v2/chat-completion', chatCompletionByProjectModel);
authUserRouter.post('/v2/cache', geminiCreateContextCacheByProjectModel);
authUserRouter.patch('/v2/cache', geminiUpdateContextCacheByProjectModel);
authUserRouter.delete('/v2/cache', geminiDeleteContextCacheByProjectModel);
authUserRouter.post('/v2/count-tokens', geminiCountTokensByProjectModel); // count-tokenのv2はプロジェクト情報を参照するのでauthに変更.
// チャット系（認証不要）
authNoneRouter.post('/count-tokens', geminiCountTokens);

// 関数定義取得
authUserRouter.get('/function-definitions', getFunctionDefinitions);
authUserRouter.get('/tool-call-group/:id', getToolCallGroup);
authUserRouter.get('/tool-call-group-by-tool-call-id/:id', getToolCallGroupByToolCallId);

// チーム関連
authUserRouter.post('/team', createTeam);
authUserRouter.get('/team', getTeamList);
authUserRouter.get('/team/:id', getTeam);
authUserRouter.patch('/team/:id', updateTeam);
authUserRouter.delete('/team/:id', deleteTeam);

// チームメンバー関連
authUserRouter.post('/team/:teamId/member', addTeamMember);
authUserRouter.get('/team/:teamId/members', getTeamMembers);
authUserRouter.patch('/team/:teamId/member/:userId', updateTeamMember);
authUserRouter.delete('/team/:teamId/member/:userId', removeTeamMember);

// Division関連
authUserRouter.get('/divisions', getDivisionList);
authAdminRouter.post('/division', upsertDivision); // 管理者はDivisionを追加できる
authAdminRouter.patch('/division/:divisionId', upsertDivision); // 管理者はDivisionを更新できる
authAdminRouter.delete('/division/:divisionId', deleteDivision); // 管理者はDivisionを削除できる

// Divisionメンバー関連
authAdminRouter.post('/division/:divisionId/member', upsertDivisionMember);
authUserRouter.get('/division/:divisionId/members', getDivisionMembers);
authAdminRouter.patch('/division/:divisionId/member/:userId', upsertDivisionMember);
authAdminRouter.delete('/division/:divisionId/member/:userId', removeDivisionMember);

// プロジェクト関連
authUserRouter.post('/project', createProject);
authUserRouter.patch('/project/:id', updateProject);
authUserRouter.delete('/project/:id', deleteProject);

// プロジェクト取得（認証あり・なし両方に対応）
// authNoneRouter.get('/project', getProjectList);
// authNoneRouter.get('/project/:id', getProject);
authUserRouter.get('/project', getProjectList);
authUserRouter.get('/project/:id', getProject);

// スレッド関連
authUserRouter.post('/project/:projectId/thread-group', upsertThreadGroup);
authUserRouter.patch('/project/:projectId/thread-group', updateThreadGroupTitleAndDescription);
authUserRouter.get('/project/:projectId/thread-group', getThreadGroupList);
// authUserRouter.get('/thread/:id', getThread);
// authUserRouter.patch('/thread/:id', updateThread);
authUserRouter.put('/thread-group/:id', moveThreadGroup);
authUserRouter.delete('/thread-group/:id', deleteThreadGroup);


// メッセージ関連
authUserRouter.post('/thread/:threadId/messages', upsertMessageWithContents);
authUserRouter.patch('/thread/:type/:id', updateMessageOrMessageGroupTimestamp);
authUserRouter.post('/thread/clone/:threadId', threadClone);
authUserRouter.post('/thread-group/clone/:threadGroupId', threadGroupClone);

authUserRouter.get('/thread/:threadGroupId/message-groups', getMessageGroupList);
authUserRouter.post('/thread/:threadId/message-group', upsertMessageWithContents3); // 更新はスレッドグループではなくスレッド単位で行う
authUserRouter.put('/thread/:threadId/message-group', upsertMessageWithContents3); // 更新はスレッドグループではなくスレッド単位で行う

authUserRouter.get('/message-group/:messageGroupId', getMessageGroupDetails);
authUserRouter.delete('/message-group/:messageGroupId', deleteMessageGroup);
authUserRouter.delete('/message/:messageId', deleteMessage);
authUserRouter.get('/message/:messageId/content-parts', getMessageContentParts);
authUserRouter.patch('/message/:messageId/content-parts', editMessageWithContents);
authUserRouter.delete('/content-part/:contentPartId', deleteContentPart);

authUserRouter.get('/file-group/:id', getFileGroup); // ファイルグループ取得
authUserRouter.patch('/file-activate', fileActivate); // ファイルのisActiveフラグを変更
authUserRouter.post('/upload', uploadFiles); // ファイル操作関連
authUserRouter.get('/:id/download', downloadFile); // ファイルダウンロード
// authUserRouter.patch('/:id/metadata', updateFileMetadata); // ファイルメタデータ更新
// authUserRouter.delete('/:id', deleteFile); // ファイル削除
authUserRouter.get('/list', getFileList); // ファイル一覧取得
authUserRouter.put('/:id/access', updateFileAccess); // ファイルアクセス権の更新

// // 認証なしでのメッセージグループ詳細取得
// authNoneRouter.get('/message-group/:messageGroupId', getMessageGroupDetails);

// // ディレクトリツリー系
// authUserRouter.get('/directory-tree/:path/*', getDirectoryTree); // 最低1階層は必要
// authUserRouter.get('/file/:path/*', getFile); // 最低1階層は必要
// authUserRouter.post('/file/:path/*', saveFile); // 最低1階層は必要

// 部管理用
// authUserRouter.get(`/department`, getDepartmentList); // 部署一覧取得
// authUserRouter.get(`/department-member`, getDepartmentMemberForUser); // 部署情報取得
authAdminRouter.get(`/department`, getDepartment); // 部署情報取得
authAdminRouter.patch(`/department/:departmentId`, patchDepartmentMember);
authAdminRouter.get(`/predict-history/:userId`, getDepartmentMemberLog);


// Mattermost
authUserRouter.get(`/mattermost/:providerName/user`, getMmUsers); // 自作のmattermost user取得API
authUserRouter.post(`/mattermost/:providerName/user`, getMmUsers); // 自作のmattermost user取得API
authUserRouter.get(`/mattermost/:providerName/timeline`, getTimelines);
authUserRouter.post(`/mattermost/:providerName/timeline`, createTimeline);
authUserRouter.patch(`/mattermost/:providerName/timeline/:id`, updateTimeline);
authUserRouter.patch(`/mattermost/:providerName/timeline/:timelineId/channel/:timelineChannelId`, updateTimelineChannel);
authUserRouter.delete(`/mattermost/:providerName/timeline/:id`, deleteTimeline);
authUserRouter.post(`/mattermost/:providerName/timeline/to-ai`, mattermostToAi);

// OAuth2 マスタ
authUserRouter.get(`/oauth/account`, getOAuthAccountList);
authUserRouter.get(`/oauth/account/:providerType/:providerName`, getOAuthAccount);
// OAuth2 API連携（クライアント側のApiInterceptorと連動しているので、必ず二つ目のパスを:providerにしておくこと）
authUserRouter.use('/oauth/api', authOAuthRouter);

authUserRouter.get('/oauth/api-keys', getApiKeys);
authUserRouter.post('/oauth/api-keys/:provider', registApiKey);
authUserRouter.delete('/oauth/api-keys/:provider/:id', deleteApiKey);

authOAuthRouter.use(authenticateOAuthUser);
// authUserRouter.get(`/proxy/mattermost/websocket`, getOAuthApiWebSocketProxy);
authOAuthRouter.get(`/proxy/:providerType/:providerName/*`, getOAuthApiProxy);
authOAuthRouter.put(`/proxy/:providerType/:providerName/*`, getOAuthApiProxy);
authOAuthRouter.post(`/proxy/:providerType/:providerName/*`, getOAuthApiProxy);
authOAuthRouter.patch(`/proxy/:providerType/:providerName/*`, getOAuthApiProxy);
authOAuthRouter.delete(`/proxy/:providerType/:providerName/*`, getOAuthApiProxy);
// authOAuthRouter.options(`/proxy/:providerType/:providerName/*`, getOAuthApiProxy);  // 利かない
authOAuthRouter.get(`/basic-api/:providerType/:providerName/*`, getOAuthApiProxy);
authOAuthRouter.post(`/basic-api/:providerType/:providerName/*`, getOAuthApiProxy);

// gitlab
// authOAuthRouter.post(`/gitlab/:provider/files/:gitlabProjectId`, gitlab.fetchCommit);
authOAuthRouter.post(`/custom-api/gitlab/:providerName/files/:gitlabProjectId/:refType/*`, gitlab.fetchCommit);
// gitea
// authOAuthRouter.post(`/gitea/:provider/files/:owner/:repo`, gitea.fetchCommit);
authOAuthRouter.post(`/custom-api/gitea/:providerName/files/:owner/:repo/:refType/*`, gitea.fetchCommit);

// box
authOAuthRouter.get(`/custom-api/box/:providerName/2.0/:types/:itemId`, boxApiItem); // folder用
authOAuthRouter.get(`/custom-api/box/:providerName/2.0/:types/:itemId/items`, boxApiItem); // collections用
authOAuthRouter.get(`/custom-api/box/:providerName/2.0/collections`, boxApiCollection);
authOAuthRouter.post(`/custom-api/box/:providerName/2.0/collections`, upsertBoxApiCollection);
authOAuthRouter.post(`/custom-api/box/:providerName/2.0/files/content`, boxUpload);
authOAuthRouter.get(`/custom-api/box/:providerName/2.0/files/:fileId/content`, boxDownload);
authOAuthRouter.post(`/custom-api/box/:providerName/2.0/files/:fileId/content`, boxUpload);

authNoneRouter.get('/:orgKey/ext-api-providers', getApiProviders);
authUserRouter.get('/ext-api-providers', getApiProviders);
authAdminRouter.post('/ext-api-provider', upsertApiProvider);
authAdminRouter.put('/ext-api-provider/:id', upsertApiProvider);
authAdminRouter.delete('/ext-api-provider/:id', deleteApiProvider);

authAdminRouter.get(`/ext-api-provider-templates`, getApiProviderTemplates); // 
authMaintainerRouter.post('/ext-api-provider-template', upsertApiProviderTemplate); //
authMaintainerRouter.put('/ext-api-provider-template/:id', upsertApiProviderTemplate); //
authMaintainerRouter.delete('/ext-api-provider-template/:id', deleteApiProviderTemplate); //

authAdminRouter.get('/ai-provider-templates', getAIProviderTemplates);
authMaintainerRouter.post('/ai-provider-template', upsertAIProviderTemplate);
authMaintainerRouter.put('/ai-provider-template/:providerId', upsertAIProviderTemplate);
authMaintainerRouter.delete('/ai-provider-template/:providerId', deleteAIProviderTemplate);

authAdminRouter.get('/ai-providers', getAIProviders);
authAdminRouter.post('/ai-provider', upsertAIProvider);
authAdminRouter.put('/ai-provider/:providerId', upsertAIProvider);
authAdminRouter.delete('/ai-provider/:providerId', deleteAIProvider);

authUserRouter.get('/ai-models', getBaseModels);
authAdminRouter.post('/ai-model', upsertBaseModel);
authAdminRouter.put('/ai-model/:modelId', upsertBaseModel);
authAdminRouter.delete('/ai-model/:modelId', deleteBaseModel);
authUserRouter.get('/ai-model/:modelId/pricing', getModelPricings);
authAdminRouter.post('/ai-model/:modelId/pricing', upsertModelPricing);
authAdminRouter.put('/ai-model/:modelId/pricing/:id?', upsertModelPricing);
authAdminRouter.delete('/ai-model/:modelId/pricing/:id', deleteModelPricing);
authUserRouter.get('/tags', getAllTags);
authAdminRouter.post('/tag', upsertTag);
authAdminRouter.put('/tag/:tagId', upsertTag);
authAdminRouter.delete('/tag/:tagId', deleteTag);

authAdminRouter.get('/organizations/users', getOrganizationUsers); // 組織一覧取得

authMaintainerRouter.get('/organizations', getOrganizations); // 組織一覧取得
authMaintainerRouter.post('/organizations', upsertOrganization); // 組織登録・更新
authMaintainerRouter.put('/organizations/:orgKey', upsertOrganization); // 組織登録・更新
authMaintainerRouter.delete('/organizations/:orgKey', deactivateOrganization); // 組織無効化

authUserRouter.get('/scope-labels', getScopeLabels);

// Claude Code用プロキシ
authUserRouter.post('/vertexai-claude-proxy/v1/messages', vertexAIByAnthropicAPIStream);
authUserRouter.post('/vertexai-claude-proxy/v1/projects/:project/locations/:location/publishers/anthropic/models/:model\\:rawPredict', vertexAIByAnthropicAPI);
authUserRouter.post('/vertexai-claude-proxy/v1/projects/:project/locations/:location/publishers/anthropic/models/:model\\:streamRawPredict', vertexAIByAnthropicAPIStream);


authUserRouter.get('/predict-journal/:idempotencyKey/:argsHash/:type', getJournal);

// MCP Server Management
authAdminRouter.get('/mcp-servers', getMCPServers);
authAdminRouter.post('/mcp-server', upsertMCPServer);
authAdminRouter.put('/mcp-server/:id', upsertMCPServer);
authAdminRouter.delete('/mcp-server/:id', deleteMCPServer);

import { Router } from 'express';
import { changePassword, deleteUser, patchDepartmentMember, getDepartment, getDepartmentList, getUser, guestLogin, onetimeLogin, passwordReset, requestForPasswordReset, updateUser, userLogin, getUserList, userLoginOAuth2, userLoginOAuth2Callback, logout, getOAuthAccountList, oAuthEmailAuth, getDepartmentMemberLog, getDepartmentMemberLogForUser, genApiToken, getOAuthAccount } from './controllers/auth.js';
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
} from './controllers/project-models.js';

// import { addDevelopmentStages, addDiscussions, addDocuments, addStatements, addTasks, createProject, deleteDevelopmentStage, deleteDiscussion, deleteDocument, deleteProject, deleteStatement, deleteTask, getDevelopmentStage, getDevelopmentStageList, getDiscussion, getDiscussionList, getDocument, getDocumentList, getProject, getProjectDeep, getProjectList, getStatement, getStatementList, getTask, getTaskList, updateDevelopmentStage, updateDiscussion, updateDocument, updateProject, updateStatement, updateTask } from './controllers/project-models.js';
import { deleteFile, downloadFile, getFileGroup, getFileList, updateFileAccess, fileActivate, updateFileMetadata, uploadFiles } from './controllers/file-manager.js';
import { chatCompletionByProjectModel, geminiCountTokensByProjectModel, geminiCreateContextCacheByProjectModel, geminiDeleteContextCacheByProjectModel, geminiUpdateContextCacheByProjectModel } from './controllers/chat-by-project-model.js';
import { UserRoleType } from './entity/auth.entity.js';
import { getOAuthApiProxy } from './api/api-proxy.js';
import { createTimeline, deleteTimeline, getMmUsers, getTimelines, mattermostToAi, updateTimeline, updateTimelineChannel } from './api/api-mattermost.js';
import { createApiProvider, createTenant, deleteApiProvider, deleteOAuth2Config, deleteTenant, deleteUserSetting, getApiProviderById, getApiProviderByProvider, getApiProviderByTypeAndUri, getApiProviders, getMyTenant, getTenantById, getTenants, getTenantStats, getUserSetting, toggleTenantActive, updateApiProvider, updateOAuth2Config, updateTenant, upsertOAuthProvider, upsertUserSetting } from './controllers/user.js';
import * as gitlab from './api/api-gitlab.js';
import * as gitea from './api/api-gitea.js';
import { boxApiCollection, boxApiItem, boxDownload, boxUpload, upsertBoxApiCollection } from './api/api-box.js';
import { registApiKey, deleteApiKey, getApiKeys, getFunctionDefinitions, getToolCallGroup, getToolCallGroupByToolCallId } from './controllers/tool-call.js';

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
authNoneRouter.post('/login', userLogin);
authNoneRouter.post('/:tenantKey/login', userLogin);
authNoneRouter.get('/logout', logout);
authNoneRouter.post('/onetime', onetimeLogin);
authNoneRouter.post('/:tenantKey/onetime', onetimeLogin);
authNoneRouter.post('/request-for-password-reset', requestForPasswordReset);
authNoneRouter.post('/:tenantKey/request-for-password-reset', requestForPasswordReset);
// authNoneRouter.post('/guest', guestLogin);
authInviteRouter.post('/password-reset', passwordReset);
authInviteRouter.post('/oauth-emailauth', oAuthEmailAuth);

// OAuth2
authNoneRouter.get('/oauth/:tenantKey/:provider/login', userLoginOAuth2);
authNoneRouter.get('/oauth/:provider/callback', userLoginOAuth2Callback); // 認証があっても無くても動くようにしておく
authNoneRouter.get('/oauth/callback', userLoginOAuth2Callback); // 認証があっても無くても動くようにしておく

// ユーザー認証系
authUserRouter.get('/user', getUser);
authUserRouter.patch('/user', updateUser);
authUserRouter.patch('/change-password', changePassword);
authUserRouter.delete('/user', deleteUser);
authUserRouter.get(`/predict-history`, getDepartmentMemberLogForUser);
// authUserRouter.get('/access-token', genAccessToken);
authUserRouter.post('/api-token', genApiToken);

authUserRouter.get(`/user-list`, getUserList); // 部署情報取得（メンバー追加時のサジェスト）

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

// 関数定義取得（認証不要）
authNoneRouter.get('/function-definitions', getFunctionDefinitions);
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

// プロジェクト関連
authUserRouter.post('/project', createProject);
authUserRouter.patch('/project/:id', updateProject);
authUserRouter.delete('/project/:id', deleteProject);

// プロジェクト取得（認証あり・なし両方に対応）
authNoneRouter.get('/project', getProjectList);
authNoneRouter.get('/project/:id', getProject);
authUserRouter.get('/project', getProjectList);
authUserRouter.get('/project/:id', getProject);

// スレッド関連
authUserRouter.post('/project/:projectId/thread-group', upsertThreadGroup);
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

// 認証なしでのメッセージグループ詳細取得
authNoneRouter.get('/message-group/:messageGroupId', getMessageGroupDetails);

// // ディレクトリツリー系
// authUserRouter.get('/directory-tree/:path/*', getDirectoryTree); // 最低1階層は必要
// authUserRouter.get('/file/:path/*', getFile); // 最低1階層は必要
// authUserRouter.post('/file/:path/*', saveFile); // 最低1階層は必要

// 部管理用
authUserRouter.get(`/department`, getDepartmentList); // 部署一覧取得
authAdminRouter.get(`/department`, getDepartment); // 部署情報取得
authAdminRouter.patch(`/department/:departmentId`, patchDepartmentMember);
authAdminRouter.get(`/predict-history/:userId`, getDepartmentMemberLog);


// Mattermost
authUserRouter.get(`/mattermost/user`, getMmUsers); // 自作のmattermost user取得API
authUserRouter.post(`/mattermost/user`, getMmUsers); // 自作のmattermost user取得API
authUserRouter.get(`/mattermost/timeline`, getTimelines);
authUserRouter.post(`/mattermost/timeline`, createTimeline);
authUserRouter.patch(`/mattermost/timeline/:id`, updateTimeline);
authUserRouter.patch(`/mattermost/timeline/:timelineId/channel/:timelineChannelId`, updateTimelineChannel);
authUserRouter.delete(`/mattermost/timeline/:id`, deleteTimeline);
authUserRouter.post(`/mattermost/timeline/to-ai`, mattermostToAi);

// OAuth2 マスタ
authUserRouter.get(`/oauth/account`, getOAuthAccountList);
authUserRouter.get(`/oauth/account/:provider`, getOAuthAccount);
// OAuth2 API連携（クライアント側のApiInterceptorと連動しているので、必ず二つ目のパスを:providerにしておくこと）
authUserRouter.use('/oauth/api', authOAuthRouter);

authUserRouter.get('/oauth/api-keys', getApiKeys);
authUserRouter.post('/oauth/api-keys/:provider', registApiKey);
authUserRouter.delete('/oauth/api-keys/:provider/:id', deleteApiKey);

authOAuthRouter.use(authenticateOAuthUser);
// authUserRouter.get(`/proxy/mattermost/websocket`, getOAuthApiWebSocketProxy);
authOAuthRouter.get(`/proxy/:provider/*`, getOAuthApiProxy);
authOAuthRouter.put(`/proxy/:provider/*`, getOAuthApiProxy);
authOAuthRouter.post(`/proxy/:provider/*`, getOAuthApiProxy);
authOAuthRouter.patch(`/proxy/:provider/*`, getOAuthApiProxy);
authOAuthRouter.delete(`/proxy/:provider/*`, getOAuthApiProxy);
// authOAuthRouter.options(`/proxy/:provider/*`, getOAuthApiProxy);  // 利かない
authOAuthRouter.get(`/basic-api/:provider/*`, getOAuthApiProxy);
authOAuthRouter.post(`/basic-api/:provider/*`, getOAuthApiProxy);

// gitlab
// authOAuthRouter.post(`/gitlab/:provider/files/:gitlabProjectId`, gitlab.fetchCommit);
authOAuthRouter.post(`/gitlab/:provider/files/:gitlabProjectId/:refType/*`, gitlab.fetchCommit);
// gitea
// authOAuthRouter.post(`/gitea/:provider/files/:owner/:repo`, gitea.fetchCommit);
authOAuthRouter.post(`/gitea/:provider/files/:owner/:repo/:refType/*`, gitea.fetchCommit);

// box
authOAuthRouter.get(`/box/:provider/2.0/:types/:itemId`, boxApiItem); // folder用
authOAuthRouter.get(`/box/:provider/2.0/:types/:itemId/items`, boxApiItem); // collections用
authOAuthRouter.get(`/box/:provider/2.0/collections`, boxApiCollection);
authOAuthRouter.post(`/box/:provider/2.0/collections`, upsertBoxApiCollection);
authOAuthRouter.post(`/box/:provider/2.0/files/content`, boxUpload);
authOAuthRouter.get(`/box/:provider/2.0/files/:fileId/content`, boxDownload);
authOAuthRouter.post(`/box/:provider/2.0/files/:fileId/content`, boxUpload);

authAdminRouter.post(`/ext-api-provider/:type`, upsertOAuthProvider); // 
authUserRouter.get('/ext-api-providers', getApiProviders);
authUserRouter.get('/ext-api-provider/id/:id', getApiProviderById);
authUserRouter.get('/ext-api-provider/provider/:provider', getApiProviderByProvider);
// authUserRouter.get('/ext-api-provider/type/:type/uri/:uriBase', getApiProviderByTypeAndUri);
authAdminRouter.post('/ext-api-provider', createApiProvider);
authAdminRouter.put('/ext-api-provider/:id', updateApiProvider);
authAdminRouter.delete('/ext-api-provider/:id', deleteApiProvider);
authAdminRouter.patch('/ext-api-provider/:id/oauth2', updateOAuth2Config);
authAdminRouter.delete('/ext-api-provider/:id/oauth2', deleteOAuth2Config);

authUserRouter.get('/tenant/my', getMyTenant);
authUserRouter.get('/tenant/:id', getTenantById);
authMaintainerRouter.get('/tenants', getTenants);
authMaintainerRouter.get('/tenant/stats', getTenantStats);
authMaintainerRouter.post('/tenant/', createTenant);
authMaintainerRouter.put('/tenant/:id', updateTenant);
authMaintainerRouter.patch('/tenant/:id/active', toggleTenantActive);
authMaintainerRouter.delete('/tenant/:id', deleteTenant);

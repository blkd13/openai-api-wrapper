import { Router } from 'express';
import { changePassword, deleteUser, getUser, onetimeLogin, passwordReset, requestForPasswordReset, updateUser, userLogin } from './controllers/auth.js';
import { authenticateInviteToken, authenticateUserToken } from './middleware/authenticate.js';
import { chatCompletion, geminiCountTokens, geminiCreateContextCache, geminiDeleteContextCache, geminiUpdateContextCache, initEvent } from './controllers/chat.js';
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
    createThread,
    getThreadList,
    getThread,
    updateThread,
    deleteThread,
    getMessageGroupList,
    deleteMessageGroup,
    deleteMessage,
    upsertMessageWithContents,
    getMessageGroupDetails,
    getMessageContentParts,
    deleteContentPart,
} from './controllers/project-models.js';

// import { addDevelopmentStages, addDiscussions, addDocuments, addStatements, addTasks, createProject, deleteDevelopmentStage, deleteDiscussion, deleteDocument, deleteProject, deleteStatement, deleteTask, getDevelopmentStage, getDevelopmentStageList, getDiscussion, getDiscussionList, getDocument, getDocumentList, getProject, getProjectDeep, getProjectList, getStatement, getStatementList, getTask, getTaskList, updateDevelopmentStage, updateDiscussion, updateDocument, updateProject, updateStatement, updateTask } from './controllers/project-models.js';
import { getDirectoryTree, getFile, saveFile } from './controllers/directory-tree.js';
import { deleteFile, downloadFile, getFileList, updateFileAccess, updateFileMetadata, uploadFiles } from './controllers/file-manager.js';
import { chatCompletionByProjectModel, geminiCountTokensByProjectModel, geminiCreateContextCacheByProjectModel, geminiDeleteContextCacheByProjectModel, geminiUpdateContextCacheByProjectModel } from './controllers/chat-by-project-model.js';

// routers/index.ts

// 認証種別によってルーターを分ける
export const authNoneRouter = Router();
export const authUserRouter = Router();
export const authInviteRouter = Router();

// 認証種別ごとのミドルウェアを設定
authUserRouter.use(authenticateUserToken);
authInviteRouter.use(authenticateInviteToken);


// 個別コントローラーの設定
authNoneRouter.post('/login', userLogin);
authNoneRouter.post('/onetime', onetimeLogin);
authNoneRouter.post('/request-for-password-reset', requestForPasswordReset);
authInviteRouter.post('/password-reset', passwordReset);

authUserRouter.get('/user', getUser);
authUserRouter.patch('/user', updateUser);
authUserRouter.patch('/change-password', changePassword);
authUserRouter.delete('/user', deleteUser);

// チャット系
authUserRouter.get('/event', initEvent);
authUserRouter.post('/chat-completion', chatCompletion);
authUserRouter.post('/create-cache', geminiCreateContextCache);
authUserRouter.post('/v2/chat-completion', chatCompletionByProjectModel);
authUserRouter.post('/v2/cache', geminiCreateContextCacheByProjectModel);
authUserRouter.patch('/v2/cache', geminiUpdateContextCacheByProjectModel);
authUserRouter.delete('/v2/cache', geminiDeleteContextCacheByProjectModel);
authUserRouter.post('/v2/count-tokens', geminiCountTokensByProjectModel); // count-tokenのv2はプロジェクト情報を参照するのでauthに変更.
// チャット系（認証不要）
authNoneRouter.post('/count-tokens', geminiCountTokens);


// チーム関連
authUserRouter.post('/team', createTeam);
authUserRouter.get('/team', getTeamList);
authUserRouter.get('/team/:id', getTeam);
authUserRouter.patch('/team/:id', updateTeam);
authUserRouter.delete('/team/:id', deleteTeam);

// チームメンバー関連
authUserRouter.post('/team-member', addTeamMember);
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
authUserRouter.post('/project/:projectId/threads', createThread);
authUserRouter.get('/project/:projectId/threads', getThreadList);
authUserRouter.get('/thread/:id', getThread);
authUserRouter.patch('/thread/:id', updateThread);
authUserRouter.delete('/thread/:id', deleteThread);

// メッセージ関連
authUserRouter.post('/thread/:threadId/messages', upsertMessageWithContents);
authUserRouter.get('/thread/:threadId/message-groups', getMessageGroupList);
authUserRouter.get('/message-group/:messageGroupId', getMessageGroupDetails);
authUserRouter.delete('/message-group/:messageGroupId', deleteMessageGroup);
authUserRouter.delete('/message/:messageId', deleteMessage);
authUserRouter.get('/message/:messageId/content-parts', getMessageContentParts);
authUserRouter.delete('/content-part/:contentPartId', deleteContentPart);

authUserRouter.post('/upload', uploadFiles); // ファイル操作関連
authUserRouter.get('/:id/download', downloadFile); // ファイルダウンロード
authUserRouter.patch('/:id/metadata', updateFileMetadata); // ファイルメタデータ更新
authUserRouter.delete('/:id', deleteFile); // ファイル削除
authUserRouter.get('/list', getFileList); // ファイル一覧取得
authUserRouter.put('/:id/access', updateFileAccess); // ファイルアクセス権の更新

// 認証なしでのメッセージグループ詳細取得
authNoneRouter.get('/message-group/:messageGroupId', getMessageGroupDetails);

// ディレクトリツリー系
authUserRouter.get('/directory-tree/:path/*', getDirectoryTree); // 最低1階層は必要
authUserRouter.get('/file/:path/*', getFile); // 最低1階層は必要
authUserRouter.post('/file/:path/*', saveFile); // 最低1階層は必要

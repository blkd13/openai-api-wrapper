import { Router } from 'express';
import { deleteUser, getUser, onetimeLogin, passwordReset, requestForPasswordReset, updateUser, userLogin } from './controllers/auth.js';
import { authenticateInviteToken, authenticateUserToken } from './middleware/authenticate.js';
import { chatCompletion, initEvent } from './controllers/chat.js';
import { addDevelopmentStage, addDiscussion, addDocument, addStatement, addTask, createProject, deleteDevelopmentStage, deleteDiscussion, deleteDocument, deleteProject, deleteStatement, deleteTask, getDevelopmentStage, getDevelopmentStageList, getDiscussion, getDiscussionList, getDocument, getDocumentList, getProject, getProjectList, getStatement, getStatementList, getTask, getTaskList, updateDevelopmentStage, updateDiscussion, updateDocument, updateProject, updateStatement, updateTask } from './controllers/project-models.js';

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

authUserRouter.get('/get-user', getUser);
authUserRouter.post('/update-user', updateUser);
authUserRouter.post('/delete-user', deleteUser);

authUserRouter.get('/event', initEvent);
authUserRouter.post('/chat-completion', chatCompletion);


// プロジェクト系
authUserRouter.put('/project', createProject);
authUserRouter.get('/project-list', getProjectList);
authUserRouter.get('/project/:id', getProject);
authUserRouter.post('/project/:id', updateProject);
authUserRouter.delete('/project/:id', deleteProject);

// ステージ系
authUserRouter.put('/project/:projectId/development-stage', addDevelopmentStage);
authUserRouter.get('/project/:projectId/development-stage-list', getDevelopmentStageList);
authUserRouter.get('/development-stage/:id', getDevelopmentStage);
authUserRouter.post('/development-stage/:id', updateDevelopmentStage);
authUserRouter.delete('/development-stage/:id', deleteDevelopmentStage);

// タスク系
authUserRouter.put('/development-stage/:stageId/task', addTask);
authUserRouter.get('/development-stage/:stageId/task-list', getTaskList);
authUserRouter.get('/task/:id', getTask);
authUserRouter.post('/task/:id', updateTask);
authUserRouter.delete('/task/:id', deleteTask);

// ドキュメント系
authUserRouter.put('/task/:taskId/document', addDocument);
authUserRouter.get('/task/:taskId/document-list', getDocumentList);
authUserRouter.get('/document/:id', getDocument);
authUserRouter.post('/document/:id', updateDocument);
authUserRouter.delete('/document/:id', deleteDocument);

// 議事録系
authUserRouter.put('/task/:taskId/discussion', addDiscussion);
authUserRouter.get('/task/:taskId/discussion-list', getDiscussionList);
authUserRouter.get('/discussion/:id', getDiscussion);
authUserRouter.post('/discussion/:id', updateDiscussion);
authUserRouter.delete('/discussion/:id', deleteDiscussion);

// 発言系
authUserRouter.put('/discussion/:discussionId/statement', addStatement);
authUserRouter.get('/discussion/:discussionId/statement-list', getStatementList);
authUserRouter.get('/statement/:id', getStatement);
authUserRouter.post('/statement/:id', updateStatement);
authUserRouter.delete('/statement/:id', deleteStatement);

import { Request, Response } from 'express';
// import { Document, Discussion, Task, DevelopmentStage, Project, DocumentModel, DiscussionModel, ProjectModel } from '../models/project-models.js';
import { UserRequest } from '../models/info.js';
import { validationErrorHandler } from '../middleware/validation.js';
import { body, param, query } from 'express-validator';


// Document Handlers
// export const getDocumentList = [
//     param('id').trim().notEmpty(),
//     validationErrorHandler,
//     (_req: Request, res: Response) => {
//         const req = _req as UserRequest;
//         DocumentModel.findAll().then((document) => {
//             if (document == null) { res.status(401); }
//             else { res.json({ document: document }); }
//         });
//     }
// ];

// // Document Handlers
// export const getDocument = [
//     param('id').trim().notEmpty(),
//     validationErrorHandler,
//     (_req: Request, res: Response) => {
//         const req = _req as UserRequest;
//         DocumentModel.findByPk(req.params.id).then((document) => {
//             if (document == null) { res.status(401); }
//             else { res.json({ document: document }); }
//         });
//     }
// ];

// export const createDocument = [
//     body('document').notEmpty(),
//     validationErrorHandler,
//     (_req: Request, res: Response) => {
//         const req = _req as UserRequest;
//         DocumentModel.create(req.body.document).then((document) => {
//             res.json({ document: document });
//         });
//     }
// ];

// export const updateDocument = [
//     body('document').notEmpty(),
//     validationErrorHandler,
//     (_req: Request, res: Response) => {
//         const req = _req as UserRequest;
//         DocumentModel.findByPk(req.body.id).then((document) => {
//             if (document == null) { res.status(401); }
//             else {
//                 document.dataValues.type = req.body.document.type;
//                 document.dataValues.subType = req.body.document.subType;
//                 document.dataValues.title = req.body.document.title;
//                 document.dataValues.content = req.body.document.content;
//                 document.dataValues.status = req.body.document.status;
//                 document.save();
//                 res.status(200);
//             }
//         });
//         DocumentModel.update(req.body.document.id, req.body.document).then((document) => {
//             res.json({ document: document });
//         });
//     }
// ];

// export const deleteDocument = [
//     param('id').trim().notEmpty(),
//     validationErrorHandler,
//     (_req: Request, res: Response) => {
//         const req = _req as UserRequest;
//         DocumentModel.findByPk(req.params.id).then((document) => {
//             if (document == null) { res.status(401); }
//             else { document.destroy(), res.status(200); }
//         });
//     }
// ];

// // Discussion Handlers
// export const getDiscussion = [
//     param('id').trim().notEmpty(),
//     validationErrorHandler,
//     (_req: Request, res: Response) => {
//         const req = _req as UserRequest;
//         DiscussionModel.findByPk(req.params.id).then((discussion) => {
//             if (discussion == null) { res.status(401); }
//             else { res.json({ discussion: discussion }); }
//         });
//     }
// ];

// // 他のCRUD操作に対応するDiscussionハンドラーも同様に定義...

// // Task Handlers
// export const getTask = async (req: Request, res: Response) => {
//     // タスクを取得するロジック...
// };

// // 他のCRUD操作に対応するTaskハンドラーも同様に定義...

// // DevelopmentStage Handlers
// export const getDevelopmentStage = async (req: Request, res: Response) => {
//     // 開発ステージを取得するロジック...
// };

// // 他のCRUD操作に対応するDevelopmentStageハンドラーも同様に定義...

// // Project Handlers
// export const getProject = async (req: Request, res: Response) => {
//     // プロジェクトを取得するロジック...
// };

// // 他のCRUD操作に対応するProjectハンドラーも同様に定義...

// // 以下、各モデルに対応するcreate, update, deleteハンドラーも同様に実装...

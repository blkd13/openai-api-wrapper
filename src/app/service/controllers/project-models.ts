import { Request, Response } from 'express';

import { ProjectEntity, DevelopmentStageEntity, DiscussionEntity, DocumentEntity, StatementEntity, TaskEntity, } from '../entity/project-models.entity.js';
import { ds } from '../db.js';
import { body, param } from 'express-validator';
import { validationErrorHandler } from '../middleware/validation.js';
import { UserRequest } from '../models/info.js';
import { EntityNotFoundError, Not } from 'typeorm';
import { ProjectStatus } from '../models/values.js';

/**
 * Create系は動くと思うがそれ以外は未検証
 */
// const sequencial = true;
const sequencial = false;

/**
 * [user認証] プロジェクト作成
 */
export const createProject = [
    body('name').trim().notEmpty(),
    body('status').trim().notEmpty(),
    body('label').trim().notEmpty(),
    validationErrorHandler,
    (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        const project = new ProjectEntity();
        project.name = req.body.name;
        project.status = req.body.status;
        project.description = req.body.description || '';
        project.label = req.body.label;
        ds.transaction(tx => {
            return tx.save(ProjectEntity, project);
        }).then(savedProject => {
            res.status(201).json(savedProject);
        }).catch(error => {
            console.error(error);
            res.status(error instanceof EntityNotFoundError ? 404 : 500).json({ message: `Error creating project` });
        });
    }
];

/**
 * [user認証] プロジェクト一覧取得
 */
export const getProjectList = [
    validationErrorHandler,
    (_req: Request, res: Response) => {
        ds.getRepository(ProjectEntity).find({ where: { status: Not(ProjectStatus.Deleted) } }).then((projects) => {
            res.status(200).json(projects);
        }).catch((error) => {
            console.error(error);
            res.status(error instanceof EntityNotFoundError ? 404 : 500).json({ message: `Error getting projects` });
        });
    }
];

/**
 * [user認証] プロジェクト取得
 */
export const getProject = [
    param('id').trim().notEmpty(),
    validationErrorHandler,
    (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        ds.getRepository(ProjectEntity).findOneOrFail({ where: { id: Number(req.params.id) }, relations: ['stages'] }).then((project) => {
            project.stages || [];
            res.status(200).json(project);
        }).catch((error) => {
            console.error(error);
            res.status(error instanceof EntityNotFoundError ? 404 : 500).json({ message: `Error getting project ${req.params.id}` });
        });
    }
];

/**
 * [user認証] プロジェクト更新
 */
export const updateProject = [
    param('id').trim().notEmpty(),
    validationErrorHandler,
    (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        ds.transaction(tx => {
            return tx.findOneOrFail(ProjectEntity, {
                where: { id: Number(req.params.id) }, relations: ['stages']
            }).then(project => {
                if (req.body.name) {
                    project.name = req.body.name;
                } else {/* do nothing */ }
                if (req.body.status) {
                    project.status = req.body.status;
                } else {/* do nothing */ }
                // if (req.body.stages) {
                //     project.stages = req.body.stages;
                // } else {/* do nothing */ }
                return tx.save(ProjectEntity, project);
            }).then(project => {
                project.stages = project.stages || [];
                res.status(200).json(project);
            });
        }).catch(error => {
            console.error(error);
            res.status(error instanceof EntityNotFoundError ? 404 : 500).json({ message: `Error updating project ${req.params.id}` });
        });
    }
];

/**
 * [user認証] プロジェクト削除
 */
export const deleteProject = [
    param('id').trim().notEmpty(),
    validationErrorHandler,
    (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        ds.transaction(tx => {
            return tx.findOneOrFail(ProjectEntity, { where: { id: Number(req.params.id) }, relations: ['stages'] }).then(project => {
                project.status = ProjectStatus.Deleted;
                return project.save();
            });
        }).then(result => {
            res.status(200).json(result);
        }).catch((error) => {
            console.error(error);
            res.status(error instanceof EntityNotFoundError ? 404 : 500).json({ message: `Error deleting project ${req.params.id}` });
        });
    }
];


/**
 * [user認証] ステージ追加
 */
export const addDevelopmentStages = [
    param('projectId').trim().notEmpty(),
    body('stages.*.type').trim().notEmpty(),
    body('stages.*.name').trim().notEmpty(),
    body('stages.*.status').trim().notEmpty(),
    validationErrorHandler,
    (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        ds.transaction(tx => {
            return tx.findOneOrFail(ProjectEntity, { where: { id: Number(req.params.projectId) } })
                .then((project) => {
                    req.body.stages = req.body.stages || [];
                    if (sequencial) {
                        // 逐次処理
                        return req.body.stages.reduce((promise: Promise<DevelopmentStageEntity[]>, _stage: any) => {
                            return promise.then((before) => {
                                const stage = new DevelopmentStageEntity();
                                stage.project = project;
                                stage.type = _stage.type;
                                stage.name = _stage.name;
                                stage.status = _stage.status;
                                stage.tasks = [];
                                return tx.save(DevelopmentStageEntity, stage).then((savedStage) => {
                                    before.push(savedStage);
                                    project.stages = project.stages || [];
                                    project.stages.push(savedStage);
                                    return tx.save(ProjectEntity, project).then((_project) => {
                                        project.stages = []; // 循環参照を切るためにあえてprojectのstagesを空にする
                                        return before;
                                    });
                                });
                            });
                        }, Promise.resolve([]));
                    } else {
                        // 並列処理
                        return Promise.all(req.body.stages.map((_stage: any) => {
                            const stage = new DevelopmentStageEntity();
                            stage.project = project;
                            stage.type = _stage.type;
                            stage.name = _stage.name;
                            stage.status = _stage.status;
                            stage.tasks = [];
                            return tx.save(DevelopmentStageEntity, stage);
                        })).then((savedStages: DevelopmentStageEntity[]) => {
                            project.stages = project.stages || [];
                            project.stages.push(...savedStages);
                            return tx.save(ProjectEntity, project).then((_project) => {
                                project.stages = []; // 循環参照を切るためにあえてprojectのstagesを空にする
                                return savedStages;
                            });
                        });
                    }
                }).then((stages) => {
                    res.status(201).json(stages);
                });
        }).catch((error) => {
            console.error(error);
            res.status(error instanceof EntityNotFoundError ? 404 : 500).json({ message: `Error adding stage to project ${req.params.projectId}` });
        });
    }
];

/**
 * [user認証] ステージ一覧取得
 */
export const getDevelopmentStageList = [
    param('projectId').trim().notEmpty(),
    validationErrorHandler,
    (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        ds.getRepository(ProjectEntity).findOneOrFail({ where: { id: Number(req.params.projectId) }, relations: ['stages'] }).then((project) => {
            res.status(200).json(project.stages || []);
        }).catch((error) => {
            console.error(error);
            res.status(error instanceof EntityNotFoundError ? 404 : 500).json({ message: `Error getting stages of project ${req.params.projectId}` });
        });
    }
];

/**
 * [user認証] ステージ取得
 */
export const getDevelopmentStage = [
    param('id').trim().notEmpty(),
    validationErrorHandler,
    (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        ds.getRepository(DevelopmentStageEntity).findOneOrFail({ where: { id: Number(req.params.id) }, relations: ['tasks'] }).then((stage) => {
            stage.tasks = stage.tasks || [];
            res.status(200).json(stage);
        }).catch((error) => {
            console.error(error);
            res.status(error instanceof EntityNotFoundError ? 404 : 500).json({ message: `Error getting stage ${req.params.id}` });
        });
    }
];

/**
 * [user認証] ステージ更新
 */
export const updateDevelopmentStage = [
    param('id').trim().notEmpty(),
    body('type').trim().notEmpty(),
    body('name').trim().notEmpty(),
    body('status').trim().notEmpty(),
    validationErrorHandler,
    (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        ds.transaction(tx => {
            return tx.findOneOrFail(DevelopmentStageEntity, { where: { id: Number(req.params.id) }, relations: ['tasks'] }).then((stage) => {
                if (req.body.type) {
                    stage.type = req.body.type;
                } else {/* do nothing */ }
                if (req.body.name) {
                    stage.name = req.body.name;
                } else {/* do nothing */ }
                if (req.body.status) {
                    stage.status = req.body.status;
                } else {/* do nothing */ }
                return tx.save(DevelopmentStageEntity, stage).then((stage) => {
                    stage.tasks = stage.tasks || [];
                    res.status(200).json(stage);
                });
            });
        }).catch((error) => {
            console.error(error);
            res.status(error instanceof EntityNotFoundError ? 404 : 500).json({ message: `Error updating stage ${req.params.id}` });
        });
    }
];

/**
 * [user認証] ステージ削除
 */
export const deleteDevelopmentStage = [
    param('id').trim().notEmpty(),
    validationErrorHandler,
    (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        ds.transaction(tx => {
            return tx.delete(TaskEntity, { id: Number(req.params.id) });
        }).then(result => {
            res.status(200).json(result);
        }).catch((error) => {
            console.error(error);
            res.status(error instanceof EntityNotFoundError ? 404 : 500).json({ message: `Error deleting stage ${req.params.id}` });
        });
    }
];


/**
 * [user認証] タスク追加
 */
export const addTasks = [
    param('stageId').trim().notEmpty(),
    body('tasks.*.name').trim().notEmpty(),
    body('tasks.*.status').trim().notEmpty(),
    validationErrorHandler,
    (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        ds.transaction(tx => {
            return tx.findOneOrFail(DevelopmentStageEntity, { where: { id: Number(req.params.stageId) } })
                .then((stage) => {
                    req.body.tasks = req.body.tasks || [];
                    if (sequencial) {
                        // 逐次処理
                        return req.body.tasks.reduce((promise: Promise<TaskEntity[]>, _task: any) => {
                            return promise.then((before) => {
                                const task = new TaskEntity();
                                task.stage = stage;
                                task.name = _task.name;
                                task.status = _task.status;
                                task.documents = [];
                                task.discussions = [];
                                return tx.save(TaskEntity, task).then((savedTask) => {
                                    before.push(savedTask);
                                    stage.tasks = stage.tasks || [];
                                    stage.tasks.push(savedTask);
                                    return tx.save(DevelopmentStageEntity, stage).then((_stage) => {
                                        stage.tasks = []; // 循環参照を切るためにあえてstageのtasksを空にする
                                        return before;
                                    });
                                });
                            });
                        }, Promise.resolve([]));
                    } else {
                        // 並列処理
                        return Promise.all(req.body.tasks.map((_task: any) => {
                            const task = new TaskEntity();
                            task.stage = stage;
                            task.name = _task.name;
                            task.status = _task.status;
                            task.documents = [];
                            task.discussions = [];
                            return tx.save(TaskEntity, task);
                        })).then((savedTasks: TaskEntity[]) => {
                            stage.tasks = stage.tasks || [];
                            stage.tasks.push(...savedTasks); // idが振られたtaskをstageに追加して保存
                            return tx.save(DevelopmentStageEntity, stage).then((_stage) => {
                                stage.tasks = []; // 循環参照を切るためにあえてstageのtasksを空にする
                                return savedTasks;
                            })
                        });
                    }
                });
        }).then((tasks: TaskEntity[]) => {
            res.status(201).json(tasks);
        }).catch((error) => {
            console.error(error);
            res.status(error instanceof EntityNotFoundError ? 404 : 500).json({ message: `Error adding task to stage ${req.params.stageId}` });
        });
    }
];

/**
 * [user認証] タスク一覧取得
 */
export const getTaskList = [
    param('stageId').trim().notEmpty(),
    validationErrorHandler,
    (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        ds.getRepository(DevelopmentStageEntity).findOneOrFail({ where: { id: Number(req.params.stageId) }, relations: ['tasks'] }).then((stage) => {
            res.status(200).json(stage.tasks || []);
        }).catch((error) => {
            console.error(error);
            res.status(error instanceof EntityNotFoundError ? 404 : 500).json({ message: `Error getting tasks of stage ${req.params.stageId}` });
        });
    }
];

/**
 * [user認証] タスク取得
 */
export const getTask = [
    param('id').trim().notEmpty(),
    validationErrorHandler,
    (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        ds.getRepository(TaskEntity).findOneOrFail({ where: { id: Number(req.params.id) }, relations: ['documents', 'discussions'] }).then((task) => {
            task.documents = task.documents || [];
            task.discussions = task.discussions || [];
            res.status(200).json(task);
        }).catch((error) => {
            console.error(error);
            res.status(error instanceof EntityNotFoundError ? 404 : 500).json({ message: `Error getting task ${req.params.id}` });
        });
    }
];

/**
 * [user認証] タスク更新
 */
export const updateTask = [
    param('id').trim().notEmpty(),
    body('name').trim().notEmpty(),
    body('status').trim().notEmpty(),
    validationErrorHandler,
    (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        ds.transaction(tx => {
            return tx.findOneOrFail(TaskEntity, {
                where: { id: Number(req.params.id) }, relations: ['documents', 'discussions']
            }).then((task) => {
                if (req.body.name) {
                    task.name = req.body.name;
                } else {/* do nothing */ }
                if (req.body.status) {
                    task.status = req.body.status;
                } else {/* do nothing */ }
                return tx.save(TaskEntity, task);
            }).then((task) => {
                task.documents = task.documents || [];
                task.discussions = task.discussions || [];
                res.status(200).json(task);
            });
        }).catch((error) => {
            console.error(error);
            res.status(error instanceof EntityNotFoundError ? 404 : 500).json({ message: `Error updating task ${req.params.id}` });
        });
    }
];

/**
 * [user認証] タスク削除
 */
export const deleteTask = [
    param('id').trim().notEmpty(),
    validationErrorHandler,
    (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        ds.transaction(tx => {
            return tx.delete(TaskEntity, { id: Number(req.params.id) });
        }).then(result => {
            res.status(200).json(result);
        }).catch((error) => {
            console.error(error);
            res.status(error instanceof EntityNotFoundError ? 404 : 500).json({ message: `Error deleting task ${req.params.id}` });
        });
    }
];


/**
 * [user認証] ドキュメント追加
 */
export const addDocuments = [
    param('taskId').trim().notEmpty(),
    body('documents.*.type').trim().notEmpty(),
    body('documents.*.subType').trim().notEmpty(),
    body('documents.*.title').trim().notEmpty(),
    // body('documents.*.content').trim().notEmpty(),
    body('documents.*.status').trim().notEmpty(),
    validationErrorHandler,
    (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        let task: TaskEntity;
        ds.transaction(tx => {
            return tx.findOneOrFail(TaskEntity, { where: { id: Number(req.params.taskId) } }).then((_task) => {
                task = _task;
                req.body.documents = req.body.documents || [];
                if (sequencial) {
                    // 逐次処理
                    return req.body.documents.reduce((promise: Promise<DocumentEntity[]>, _document: any) => {
                        return promise.then((before) => {
                            const document = new DocumentEntity();
                            document.type = _document.type;
                            document.subType = _document.subType;
                            document.title = _document.title;
                            document.content = _document.content;
                            document.status = _document.status;
                            return tx.save(DocumentEntity, document).then((savedDocument) => {
                                before.push(savedDocument);
                                return before;
                            });
                        });
                    }, Promise.resolve([]));
                } else {
                    // 並列処理
                    return Promise.all(req.body.documents.map((_document: any) => {
                        const document = new DocumentEntity();
                        document.type = _document.type;
                        document.subType = _document.subType;
                        document.title = _document.title;
                        document.content = _document.content;
                        document.status = _document.status;
                        return tx.save(DocumentEntity, document);
                    }));
                }
            }).then((documents) => {
                // idが振られたdocumentをtaskに追加して保存
                task.documents = task.documents || [];
                task.documents.push(...documents);
                return tx.save(TaskEntity, task).then((_task) => {
                    return task.documents || [];
                });
            });
        }).then((documents) => {
            res.status(201).json(documents);
        }).catch((error) => {
            console.error(error);
            res.status(error instanceof EntityNotFoundError ? 404 : 500).json({ message: `Error adding document to task ${req.params.taskId}` });
        });
    }
];

/**
 * [user認証] ドキュメント一覧取得
 */
export const getDocumentList = [
    param('taskId').trim().notEmpty(),
    validationErrorHandler,
    (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        ds.getRepository(TaskEntity).findOneOrFail({ where: { id: Number(req.params.taskId) } }).then((task) => {
            res.status(200).json(task.documents || []);
        }).catch((error) => {
            console.error(error);
            res.status(error instanceof EntityNotFoundError ? 404 : 500).json({ message: `Error getting documents of task ${req.params.taskId}` });
        });
    }
];

/**
 * [user認証] ドキュメント取得
 */
export const getDocument = [
    param('id').trim().notEmpty(),
    validationErrorHandler,
    (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        ds.getRepository(DocumentEntity).findOneOrFail({ where: { id: Number(req.params.id) } }).then((document) => {
            res.status(200).json(document);
        }).catch((error) => {
            console.error(error);
            res.status(error instanceof EntityNotFoundError ? 404 : 500).json({ message: `Error getting document ${req.params.id}` });
        });
    }
];

/**
 * [user認証] ドキュメント更新
 */
export const updateDocument = [
    param('id').trim().notEmpty(),
    body('type').trim().notEmpty(),
    body('subType').trim().notEmpty(),
    body('title').trim().notEmpty(),
    body('content').trim().notEmpty(),
    body('status').trim().notEmpty(),
    validationErrorHandler,
    (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        ds.transaction(tx => {
            return tx.findOneOrFail(DocumentEntity, { where: { id: Number(req.params.id) } }).then((document) => {
                if (req.body.type) {
                    document.type = req.body.type;
                } else {/* do nothing */ }
                if (req.body.subType) {
                    document.subType = req.body.subType;
                } else {/* do nothing */ }
                if (req.body.title) {
                    document.title = req.body.title;
                } else {/* do nothing */ }
                if (req.body.content) {
                    document.content = req.body.content;
                } else {/* do nothing */ }
                if (req.body.status) {
                    document.status = req.body.status;
                } else {/* do nothing */ }
                return tx.save(DocumentEntity, document);
            });
        }).then((document) => {
            res.status(200).json(document);
        }).catch((error) => {
            console.error(error);
            res.status(error instanceof EntityNotFoundError ? 404 : 500).json({ message: `Error updating document ${req.params.id}` });
        });
    }
];

/**
 * [user認証] ドキュメント削除
 */
export const deleteDocument = [
    param('id').trim().notEmpty(),
    validationErrorHandler,
    (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        ds.transaction(tx => {
            return tx.delete(DocumentEntity, { id: Number(req.params.id) });
        }).then(result => {
            res.status(200).json(result);
        }).catch((error) => {
            console.error(error);
            res.status(error instanceof EntityNotFoundError ? 404 : 500).json({ message: `Error deleting document ${req.params.id}` });
        });
    }
];


/**
 * [user認証] 議事録追加
 */
export const addDiscussions = [
    param('taskId').trim().notEmpty(),
    body('discussions.*.topic').trim().notEmpty(),
    body('discussions.*.participants').trim().notEmpty(),
    validationErrorHandler,
    (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        ds.transaction(tx => {
            return tx.findOneOrFail(TaskEntity, { where: { id: Number(req.params.taskId) }, relations: ['discussions'] }).then((task) => {
                req.body.discussions = req.body.discussions || [];
                if (sequencial) {
                    // 逐次処理
                    return req.body.discussions.reduce((promise: Promise<DiscussionEntity[]>, _discussion: any) => {
                        return promise.then((before) => {
                            const discussion = new DiscussionEntity();
                            discussion.topic = _discussion.topic;
                            discussion.participants = _discussion.participants;
                            discussion.statements = [];
                            return tx.save(DiscussionEntity, discussion).then((savedDiscussion) => {
                                before.push(savedDiscussion);
                                task.discussions = task.discussions || [];
                                task.discussions.push(savedDiscussion);
                                return tx.save(TaskEntity, task).then((_task) => {
                                    task.discussions = []; // 循環参照を切るためにあえてtaskのdiscussionsを空にする
                                    return before;
                                });
                            });
                        });
                    }, Promise.resolve([]));
                } else {
                    // 並列処理
                    return Promise.all(req.body.discussions.map((_discussion: any) => {
                        const discussion = new DiscussionEntity();
                        discussion.topic = _discussion.topic;
                        discussion.participants = _discussion.participants;
                        discussion.statements = [];
                        return tx.save(DiscussionEntity, discussion);
                    })).then((savedDiscussions: DiscussionEntity[]) => {
                        task.discussions = task.discussions || [];
                        task.discussions.push(...savedDiscussions);
                        return tx.save(TaskEntity, task).then((_task) => {
                            task.discussions = []; // 循環参照を切るためにあえてtaskのdiscussionsを空にする
                            return savedDiscussions;
                        });
                    });
                }
            });
        }).then((discussions) => {
            res.status(201).json(discussions);
        }).catch((error) => {
            console.error(error);
            res.status(error instanceof EntityNotFoundError ? 404 : 500).json({ message: `Error adding discussion to task ${req.params.taskId}` });
        });
    }
];

/**
 * [user認証] 議事録一覧取得
 */
export const getDiscussionList = [
    param('taskId').trim().notEmpty(),
    validationErrorHandler,
    (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        ds.getRepository(TaskEntity).findOneOrFail({ where: { id: Number(req.params.taskId) }, relations: ['discussions'] }).then((task) => {
            res.status(200).json(task.discussions || []);
        }).catch((error) => {
            console.error(error);
            res.status(error instanceof EntityNotFoundError ? 404 : 500).json({ message: `Error getting discussions of task ${req.params.taskId}` });
        });
    }
];

/**
 * [user認証] 議事録取得
 */
export const getDiscussion = [
    param('id').trim().notEmpty(),
    validationErrorHandler,
    (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        ds.getRepository(DiscussionEntity).findOneOrFail({ where: { id: Number(req.params.id) }, relations: ['statements'] }).then((discussion) => {
            discussion.statements = discussion.statements || [];
            res.status(200).json(discussion);
        }).catch((error) => {
            console.error(error);
            res.status(error instanceof EntityNotFoundError ? 404 : 500).json({ message: `Error getting discussion ${req.params.id}` });
        });
    }
];

/**
 * [user認証] 議事録更新
 */
export const updateDiscussion = [
    param('id').trim().notEmpty(),
    body('topic').trim().notEmpty(),
    body('status').trim().notEmpty(),
    body('participants').trim().notEmpty(),
    validationErrorHandler,
    (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        ds.transaction(tx => {
            return tx.findOneOrFail(DiscussionEntity, { where: { id: Number(req.params.id) }, relations: ['statements'] }).then((discussion) => {
                if (req.body.topic) {
                    discussion.topic = req.body.topic;
                } else {/* do nothing */ }
                if (req.body.participants && req.body.participants.length > 0) {
                    discussion.participants = req.body.participants;
                } else {/* do nothing */ }
                return tx.save(DiscussionEntity, discussion);
            }).then((discussion) => {
                discussion.statements = discussion.statements || [];
                res.status(200).json(discussion);
            });
        }).catch((error) => {
            console.error(error);
            res.status(error instanceof EntityNotFoundError ? 404 : 500).json({ message: `Error updating discussion ${req.params.id}` });
        });
    }
];

/**
 * [user認証] 議事録削除
 */
export const deleteDiscussion = [
    param('id').trim().notEmpty(),
    validationErrorHandler,
    (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        ds.transaction(tx => {
            return tx.delete(DiscussionEntity, { id: Number(req.params.id) });
        }).then(result => {
            res.status(200).json(result);
        }).catch((error) => {
            console.error(error);
            res.status(error instanceof EntityNotFoundError ? 404 : 500).json({ message: `Error deleting discussion ${req.params.id}` });
        });
    }
];


/**
 * [user認証] 発言追加
 */
export const addStatements = [
    param('discussionId').trim().notEmpty(),
    body('statements.*.sequence').trim().notEmpty(),
    body('statements.*.speaker').trim().notEmpty(),
    body('statements.*.content').trim().notEmpty(),
    validationErrorHandler,
    (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        ds.transaction(tx => {
            return tx.findOneOrFail(DiscussionEntity, { where: { id: Number(req.params.discussionId) } }).then((discussion) => {
                req.body.statements = req.body.statements || [];
                return Promise.all(req.body.statements.map((_statement: any) => {
                    const statement = new StatementEntity();
                    statement.discussion = discussion;
                    statement.sequence = _statement.sequence;
                    statement.speaker = _statement.speaker;
                    statement.content = _statement.content;
                    return tx.save(StatementEntity, statement);
                })).then((savedStatements: StatementEntity[]) => {
                    discussion.statements = discussion.statements || [];
                    discussion.statements.push(...savedStatements);
                    return tx.save(DiscussionEntity, discussion).then((_discussion) => {
                        discussion.statements = []; // 循環参照を切るためにあえてdiscussionのstatementsを空にする
                        return savedStatements;
                    });
                });
            });
        }).then((statements) => {
            res.status(201).json(statements);
        }).catch((error) => {
            console.error(error);
            res.status(error instanceof EntityNotFoundError ? 404 : 500).json({ message: `Error adding statement to discussion ${req.params.discussionId}` });
        });
    }
];

/**
 * [user認証] 発言一覧取得
 */
export const getStatementList = [
    param('discussionId').trim().notEmpty(),
    validationErrorHandler,
    (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        ds.getRepository(DiscussionEntity).findOneOrFail({ where: { id: Number(req.params.discussionId) }, relations: ['statements'] }).then((discussion) => {
            res.status(200).json(discussion.statements || []);
        }).catch((error) => {
            console.error(error);
            res.status(error instanceof EntityNotFoundError ? 404 : 500).json({ message: `Error getting statements of discussion ${req.params.discussionId}` });
        });
    }
];

/**
 * [user認証] 発言取得
 * @deprecated
 */
export const getStatement = [
    param('id').trim().notEmpty(),
    validationErrorHandler,
    (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        ds.getRepository(StatementEntity).findOneOrFail({ where: { id: Number(req.params.id) } }).then((statement) => {
            res.status(200).json(statement);
        }).catch((error) => {
            console.error(error);
            res.status(error instanceof EntityNotFoundError ? 404 : 500).json({ message: `Error getting statement ${req.params.id}` });
        });
    }
];

/**
 * [user認証] 発言更新
 */
export const updateStatement = [
    param('id').trim().notEmpty(),
    body('sequence').trim().notEmpty(),
    body('speaker').trim().notEmpty(),
    body('content').trim().notEmpty(),
    validationErrorHandler,
    (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        ds.transaction(tx => {
            return tx.findOneOrFail(StatementEntity, { where: { id: Number(req.params.id) } }).then((statement) => {
                if (req.body.sequence) {
                    statement.sequence = req.body.sequence;
                } else {/* do nothing */ }
                if (req.body.speaker) {
                    statement.speaker = req.body.speaker;
                } else {/* do nothing */ }
                if (req.body.content) {
                    statement.content = req.body.content;
                } else {/* do nothing */ }
                return tx.save(StatementEntity, statement);
            }).then((statement) => {
                res.status(200).json(statement);
            });
        }).catch((error) => {
            console.error(error);
            res.status(error instanceof EntityNotFoundError ? 404 : 500).json({ message: `Error updating statement ${req.params.id}` });
        });
    }
];

/**
 * [user認証] 発言削除
 */
export const deleteStatement = [
    param('id').trim().notEmpty(),
    validationErrorHandler,
    (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        ds.transaction(tx => {
            return tx.delete(StatementEntity, { id: Number(req.params.id) });
        }).then(result => {
            res.status(200).json(result);
        }).catch((error) => {
            console.error(error);
            res.status(error instanceof EntityNotFoundError ? 404 : 500).json({ message: `Error deleting statement ${req.params.id}` });
        });
    }
];

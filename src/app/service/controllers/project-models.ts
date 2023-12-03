import { Request, Response } from 'express';

import { ProjectEntity, DevelopmentStageEntity, DiscussionEntity, DocumentEntity, StatementEntity, TaskEntity, } from '../entity/project-models.entity.js';
import { ds } from '../db.js';
import { body, param } from 'express-validator';
import { validationErrorHandler } from '../middleware/validation.js';
import { UserRequest } from '../models/info.js';

/**
 * [user認証] プロジェクト作成
 */
export const createProject = [
    body('name').trim().notEmpty(),
    body('status').trim().notEmpty(),
    validationErrorHandler,
    (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        const project = new ProjectEntity();
        project.name = req.body.name;
        project.status = req.body.status;
        ds.getRepository(ProjectEntity).save(project).then((project) => {
            res.status(201).json(project);
        }).catch((err) => {
            res.status(500).json({ message: err });
        });
    }
];

/**
 * [user認証] プロジェクト一覧取得
 */
export const getProjectList = [
    validationErrorHandler,
    (_req: Request, res: Response) => {
        ds.getRepository(ProjectEntity).find().then((projects) => {
            res.status(200).json(projects);
        }).catch((err) => {
            res.status(500).json({ message: err });
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
        ds.getRepository(ProjectEntity).find({ where: { id: req.body.id }, relations: ['stages'] }).then((projects) => {
            res.status(200).json(projects);
        }).catch((err) => {
            res.status(500).json({ message: err });
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
        ds.getRepository(ProjectEntity).findOne({ where: { id: req.body.id } }).then((project) => {
            if (project) {
                if (req.body.name) {
                    project.name = req.body.name;
                } else {/* do nothing */ }
                if (req.body.status) {
                    project.status = req.body.status;
                } else {/* do nothing */ }
                ds.getRepository(ProjectEntity).save(project).then((project) => {
                    res.status(200).json(project);
                }).catch((err) => {
                    res.status(500).json({ message: err });
                });
            } else {
                res.status(404).json({ message: 'project not found' });
            }
        }).catch((err) => {
            res.status(500).json({ message: err });
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
        ds.getRepository(ProjectEntity).delete({ id: req.body.id }).then((result) => {
            res.status(200).json(result);
        }).catch((err) => {
            res.status(500).json({ message: err });
        });
    }
];


/**
 * [user認証] ステージ追加
 */
export const addDevelopmentStage = [
    param('projectId').trim().notEmpty(),
    body('type').trim().notEmpty(),
    body('name').trim().notEmpty(),
    body('status').trim().notEmpty(),
    validationErrorHandler,
    (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        ds.getRepository(ProjectEntity).findOne({ where: { id: req.body.projectId } }).then((project) => {
            if (project) {
                const stage = new DevelopmentStageEntity();
                stage.project = project;
                stage.type = req.body.type;
                stage.name = req.body.name;
                stage.status = req.body.status;
                ds.getRepository(DevelopmentStageEntity).save(stage).then((stage) => {
                    project.stages.push(stage);
                    ds.getRepository(ProjectEntity).save(project).then((project) => {
                        res.status(201).json(stage);
                    }).catch((err) => {
                        res.status(500).json({ message: err });
                    });
                }).catch((err) => {
                    res.status(500).json({ message: err });
                });
            } else {
                res.status(404).json({ message: 'project not found' });
            }
        }).catch((err) => {
            res.status(500).json({ message: err });
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
        ds.getRepository(ProjectEntity).findOne({ where: { id: req.body.projectId }, relations: ['stages'] }).then((project) => {
            if (project) {
                res.status(200).json(project.stages);
            } else {
                res.status(404).json({ message: 'project not found' });
            }
        }).catch((err) => {
            res.status(500).json({ message: err });
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
        ds.getRepository(DevelopmentStageEntity).find({ where: { id: req.body.id }, relations: ['tasks'] }).then((stages) => {
            res.status(200).json(stages);
        }).catch((err) => {
            res.status(500).json({ message: err });
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
        ds.getRepository(DevelopmentStageEntity).findOne({ where: { id: req.body.id } }).then((stage) => {
            if (stage) {
                if (req.body.type) {
                    stage.type = req.body.type;
                } else {/* do nothing */ }
                if (req.body.name) {
                    stage.name = req.body.name;
                } else {/* do nothing */ }
                if (req.body.status) {
                    stage.status = req.body.status;
                } else {/* do nothing */ }
                ds.getRepository(DevelopmentStageEntity).save(stage).then((stage) => {
                    res.status(200).json(stage);
                }).catch((err) => {
                    res.status(500).json({ message: err });
                });
            } else {
                res.status(404).json({ message: 'stage not found' });
            }
        }).catch((err) => {
            res.status(500).json({ message: err });
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
        ds.getRepository(DevelopmentStageEntity).delete({ id: req.body.id }).then((result) => {
            res.status(200).json(result);
        }).catch((err) => {
            res.status(500).json({ message: err });
        });
    }
];


/**
 * [user認証] タスク追加
 */
export const addTask = [
    param('stageId').trim().notEmpty(),
    body('name').trim().notEmpty(),
    body('status').trim().notEmpty(),
    validationErrorHandler,
    (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        ds.getRepository(DevelopmentStageEntity).findOne({ where: { id: req.body.stageId } }).then((stage) => {
            if (stage) {
                const task = new TaskEntity();
                task.stage = stage;
                task.name = req.body.name;
                task.status = req.body.status;
                ds.getRepository(TaskEntity).save(task).then((task) => {
                    stage.tasks.push(task);
                    ds.getRepository(DevelopmentStageEntity).save(stage).then((stage) => {
                        res.status(201).json(task);
                    }).catch((err) => {
                        res.status(500).json({ message: err });
                    });
                }).catch((err) => {
                    res.status(500).json({ message: err });
                });
            } else {
                res.status(404).json({ message: 'stage not found' });
            }
        }).catch((err) => {
            res.status(500).json({ message: err });
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
        ds.getRepository(DevelopmentStageEntity).findOne({ where: { id: req.body.stageId }, relations: ['tasks'] }).then((stage) => {
            if (stage) {
                res.status(200).json(stage.tasks);
            } else {
                res.status(404).json({ message: 'stage not found' });
            }
        }).catch((err) => {
            res.status(500).json({ message: err });
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
        ds.getRepository(TaskEntity).find({ where: { id: req.body.id }, relations: ['documents', 'discussions'] }).then((tasks) => {
            res.status(200).json(tasks);
        }).catch((err) => {
            res.status(500).json({ message: err });
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
        ds.getRepository(TaskEntity).findOne({ where: { id: req.body.id } }).then((task) => {
            if (task) {
                if (req.body.name) {
                    task.name = req.body.name;
                } else {/* do nothing */ }
                if (req.body.status) {
                    task.status = req.body.status;
                } else {/* do nothing */ }
                ds.getRepository(TaskEntity).save(task).then((task) => {
                    res.status(200).json(task);
                }).catch((err) => {
                    res.status(500).json({ message: err });
                });
            } else {
                res.status(404).json({ message: 'task not found' });
            }
        }).catch((err) => {
            res.status(500).json({ message: err });
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
        ds.getRepository(TaskEntity).delete({ id: req.body.id }).then((result) => {
            res.status(200).json(result);
        }).catch((err) => {
            res.status(500).json({ message: err });
        });
    }
];


/**
 * [user認証] ドキュメント追加
 */
export const addDocument = [
    param('taskId').trim().notEmpty(),
    body('type').trim().notEmpty(),
    body('subType').trim().notEmpty(),
    body('title').trim().notEmpty(),
    body('content').trim().notEmpty(),
    body('status').trim().notEmpty(),
    validationErrorHandler,
    (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        ds.getRepository(TaskEntity).findOne({ where: { id: req.body.taskId } }).then((task) => {
            if (task) {
                const document = new DocumentEntity();
                document.type = req.body.type;
                document.subType = req.body.subType;
                document.title = req.body.title;
                document.content = req.body.content;
                document.status = req.body.status;
                ds.getRepository(DocumentEntity).save(document).then((document) => {
                    task.documents.push(document);
                    ds.getRepository(TaskEntity).save(task).then((task) => {
                        res.status(201).json(document);
                    }).catch((err) => {
                        res.status(500).json({ message: err });
                    });
                }).catch((err) => {
                    res.status(500).json({ message: err });
                });
            } else {
                res.status(404).json({ message: 'project not found' });
            }
        }).catch((err) => {
            res.status(500).json({ message: err });
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
        ds.getRepository(TaskEntity).findOne({ where: { id: req.body.taskId } }).then((document) => {
            if (document) {
                res.status(200).json(document?.documents);
            } else {
                res.status(404).json({ message: 'task not found' });
            }
        }).catch((err) => {
            res.status(500).json({ message: err });
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
        ds.getRepository(DocumentEntity).find({ where: { id: req.body.id } }).then((documents) => {
            res.status(200).json(documents);
        }).catch((err) => {
            res.status(500).json({ message: err });
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
        ds.getRepository(DocumentEntity).findOne({ where: { id: req.body.id } }).then((document) => {
            if (document) {
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
                ds.getRepository(DocumentEntity).save(document).then((document) => {
                    res.status(200).json(document);
                }).catch((err) => {
                    res.status(500).json({ message: err });
                });
            } else {
                res.status(404).json({ message: 'document not found' });
            }
        }).catch((err) => {
            res.status(500).json({ message: err });
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
        ds.getRepository(DocumentEntity).delete({ id: req.body.id }).then((result) => {
            res.status(200).json(result);
        }).catch((err) => {
            res.status(500).json({ message: err });
        });
    }
];


/**
 * [user認証] 議事録追加
 */
export const addDiscussion = [
    param('taskId').trim().notEmpty(),
    body('topic').trim().notEmpty(),
    body('participants').trim().notEmpty(),
    validationErrorHandler,
    (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        ds.getRepository(TaskEntity).findOne({ where: { id: req.body.taskId } }).then((task) => {
            if (task) {
                const discussion = new DiscussionEntity();
                discussion.topic = req.body.topic;
                discussion.participants = req.body.participants;
                ds.getRepository(DiscussionEntity).save(discussion).then((discussion) => {
                    task.discussions.push(discussion);
                    ds.getRepository(TaskEntity).save(task).then((task) => {
                        res.status(201).json(discussion);
                    }).catch((err) => {
                        res.status(500).json({ message: err });
                    });
                });
            } else {
                res.status(404).json({ message: 'task not found' });
            }
        }).catch((err) => {
            res.status(500).json({ message: err });
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
        ds.getRepository(TaskEntity).findOne({ where: { id: req.body.taskId }, relations: ['discussions'] }).then((task) => {
            if (task) {
                res.status(200).json(task.discussions);
            } else {
                res.status(404).json({ message: 'task not found' });
            }
        }).catch((err) => {
            res.status(500).json({ message: err });
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
        ds.getRepository(DiscussionEntity).find({ where: { id: req.body.id }, relations: ['statements'] }).then((discussions) => {
            res.status(200).json(discussions);
        }).catch((err) => {
            res.status(500).json({ message: err });
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
        ds.getRepository(DiscussionEntity).findOne({ where: { id: req.body.id } }).then((discussion) => {
            if (discussion) {
                if (req.body.topic) {
                    discussion.topic = req.body.topic;
                } else {/* do nothing */ }
                if (req.body.participants && req.body.participants.length > 0) {
                    discussion.participants = req.body.participants;
                } else {/* do nothing */ }
                ds.getRepository(DiscussionEntity).save(discussion).then((discussion) => {
                    res.status(200).json(discussion);
                }).catch((err) => {
                    res.status(500).json({ message: err });
                });
            } else {
                res.status(404).json({ message: 'discussion not found' });
            }
        }).catch((err) => {
            res.status(500).json({ message: err });
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
        ds.getRepository(DiscussionEntity).delete({ id: req.body.id }).then((result) => {
            res.status(200).json(result);
        }).catch((err) => {
            res.status(500).json({ message: err });
        });
    }
];


/**
 * [user認証] 発言追加
 */
export const addStatement = [
    param('discussionId').trim().notEmpty(),
    body('sequence').trim().notEmpty(),
    body('speaker').trim().notEmpty(),
    body('content').trim().notEmpty(),
    validationErrorHandler,
    (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        ds.getRepository(DiscussionEntity).findOne({ where: { id: req.body.discussionId } }).then((discussion) => {
            if (discussion) {
                const statement = new StatementEntity();
                statement.discussion = discussion;
                statement.sequence = req.body.sequence;
                statement.speaker = req.body.speaker;
                statement.content = req.body.content;
                ds.getRepository(StatementEntity).save(statement).then((statement) => {
                    discussion.statements.push(statement);
                    ds.getRepository(DiscussionEntity).save(discussion).then((discussion) => {
                        res.status(201).json(statement);
                    }).catch((err) => {
                        res.status(500).json({ message: err });
                    });
                });
            } else {
                res.status(404).json({ message: 'discussion not found' });
            }
        }).catch((err) => {
            res.status(500).json({ message: err });
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
        ds.getRepository(DiscussionEntity).findOne({ where: { id: req.body.discussionId }, relations: ['statements'] }).then((discussion) => {
            if (discussion) {
                res.status(200).json(discussion.statements);
            } else {
                res.status(404).json({ message: 'discussion not found' });
            }
        }).catch((err) => {
            res.status(500).json({ message: err });
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
        ds.getRepository(StatementEntity).find({ where: { id: req.body.id } }).then((statements) => {
            res.status(200).json(statements);
        }).catch((err) => {
            res.status(500).json({ message: err });
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
        ds.getRepository(StatementEntity).findOne({ where: { id: req.body.id } }).then((statement) => {
            if (statement) {
                if (req.body.sequence) {
                    statement.sequence = req.body.sequence;
                } else {/* do nothing */ }
                if (req.body.speaker) {
                    statement.speaker = req.body.speaker;
                } else {/* do nothing */ }
                if (req.body.content) {
                    statement.content = req.body.content;
                } else {/* do nothing */ }
                ds.getRepository(StatementEntity).save(statement).then((statement) => {
                    res.status(200).json(statement);
                }).catch((err) => {
                    res.status(500).json({ message: err });
                });
            } else {
                res.status(404).json({ message: 'statement not found' });
            }
        }).catch((err) => {
            res.status(500).json({ message: err });
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
        ds.getRepository(StatementEntity).delete({ id: req.body.id }).then((result) => {
            res.status(200).json(result);
        }).catch((err) => {
            res.status(500).json({ message: err });
        });
    }
];

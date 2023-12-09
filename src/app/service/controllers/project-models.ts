import { NextFunction, Request, Response } from 'express';

import { ProjectEntity, DevelopmentStageEntity, DiscussionEntity, DocumentEntity, StatementEntity, TaskEntity, } from '../entity/project-models.entity.js';
import { ds } from '../db.js';
import { body, param } from 'express-validator';
import { validationErrorHandler } from '../middleware/validation.js';
import { UserRequest } from '../models/info.js';
import { EntityNotFoundError, Not } from 'typeorm';
import { ProjectStatus } from '../models/values.js';
import { Utils } from '../../common/utils.js';
import { Subject } from 'rxjs';

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
 * [user認証] プロジェクト取得
 */
export const getProjectDeep = [
    param('id').trim().notEmpty(),
    validationErrorHandler,
    (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        ds.getRepository(ProjectEntity).findOneOrFail({
            where: { id: Number(req.params.id) }, relations: ['stages', 'stages.tasks', 'stages.tasks.documents', 'stages.tasks.discussions']
        }).then((project) => {
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
        ds.getRepository(ProjectEntity).findOneOrFail({ where: { id: Number(req.params.projectId) }, relations: ['stages'] }).then((project) => {
            project.stages = project.stages || [];
            return ds.transaction(tx => {
                req.body.stages = req.body.stages || [];
                if (sequencial) {
                    // 逐次処理
                    return (req.body.stages as DevelopmentStageEntity[]).reduce((promise: Promise<DevelopmentStageEntity[]>, _stage: DevelopmentStageEntity) => {
                        return promise.then((before) => {
                            const stage = new DevelopmentStageEntity();
                            stage.project = project;
                            stage.type = _stage.type;
                            stage.name = _stage.name;
                            stage.status = _stage.status;
                            stage.tasks = [];
                            return tx.save(DevelopmentStageEntity, stage).then((savedStage) => {
                                before.push(savedStage);
                                project.stages.push(savedStage);
                                return savedStage;
                            });
                        }) as Promise<DevelopmentStageEntity[]>;
                    }, Promise.resolve([])).then((stages: DevelopmentStageEntity[]) => {
                        return tx.save(ProjectEntity, project).then((_project) => {
                            project.stages = []; // 循環参照を切るためにあえてprojectのstagesを空にする
                            return stages;
                        });
                    });
                } else {
                    // 並列処理
                    return Promise.all(req.body.stages.map((_stage: DevelopmentStageEntity) => {
                        const stage = new DevelopmentStageEntity();
                        stage.project = project;
                        stage.type = _stage.type;
                        stage.name = _stage.name;
                        stage.status = _stage.status;
                        stage.tasks = [];
                        return tx.save(DevelopmentStageEntity, stage);
                    })).then((savedStages: DevelopmentStageEntity[]) => {
                        console.log(`0savedStages=${JSON.stringify(savedStages)}`);
                        project.stages = project.stages || [];
                        project.stages.push(...savedStages);
                        console.log(`1savedStages=${JSON.stringify(project.stages)}`);
                        return tx.save(ProjectEntity, project).then((_project) => {
                            project.stages = []; // 循環参照を切るためにあえてprojectのstagesを空にする
                            return savedStages;
                        });
                    });
                }
            });
        }).then((stages: DevelopmentStageEntity[]) => {
            // console.log(stages);
            res.status(201).json(stages);
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
        ds.getRepository(DevelopmentStageEntity).findOneOrFail({ where: { id: Number(req.params.id) }, relations: ['tasks'] }).then((stage) => {
            if (req.body.type) {
                stage.type = req.body.type;
            } else {/* do nothing */ }
            if (req.body.name) {
                stage.name = req.body.name;
            } else {/* do nothing */ }
            if (req.body.status) {
                stage.status = req.body.status;
            } else {/* do nothing */ }
            // 更新トランザクション
            return ds.transaction(tx => {
                return tx.save(DevelopmentStageEntity, stage).then((stage) => {
                    stage.tasks = stage.tasks || [];
                    res.status(200).json(stage);
                });
            })
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
        return ds.getRepository(DevelopmentStageEntity).findOneOrFail({ where: { id: Number(req.params.stageId) }, relations: ['tasks'] }).then((stage) => {
            req.body.tasks = req.body.tasks || [];
            return ds.transaction(tx => {
                if (sequencial) {
                    // 逐次処理
                    return (req.body.tasks as TaskEntity[]).reduce((promise: Promise<TaskEntity[]>, _task: TaskEntity) => {
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
                    return Promise.all(req.body.tasks.map((_task: TaskEntity) => {
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
        ds.getRepository(TaskEntity).findOneOrFail({
            where: { id: Number(req.params.id) }, relations: ['documents', 'discussions']
        }).then((task) => {
            if (req.body.name) {
                task.name = req.body.name;
            } else {/* do nothing */ }
            if (req.body.status) {
                task.status = req.body.status;
            } else {/* do nothing */ }
            ;
            return ds.transaction(tx => {
                return tx.save(TaskEntity, task);
            })
        }).then((task) => {
            task.documents = task.documents || [];
            task.discussions = task.discussions || [];
            res.status(200).json(task);
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



// なんでかはわからないが並列処理かけまくるとエラーが発生するのでqueueを自前で用意した。
// 多分QueryRunnerのリソース開放が間に合ってないとかだと思うので、リソース上げ下げも全部手で書けば直ると思われるけど一旦これで対応する。
// TODO なかなかありえない実装だが、とりあえず動くのでこのままにしておく。当然、ゆくゆくはこのキューの仕組みは排除する。
export const qSubject = new Subject<{ uuid: string, lock: EntityName[] }>();

// exec queue
// const queue = new PQueue({ concurrency: 1 });
type EntityName = 'project' | 'stage' | 'task' | 'document' | 'discussion' | 'statement';
const queueMap: { [key: string]: { req: Request, res: Response, next: NextFunction } } = {};
const queue: Record<EntityName, string[]> = { project: [], stage: [], task: [], document: [], discussion: [], statement: [], };

export function enqueueGenerator(lock: EntityName[]) {
    return (req: Request, res: Response, next: NextFunction) => {
        // enqueue
        const uuid = Utils.generateUUID();
        queueMap[uuid] = { req, res, next };
        for (const entityName of lock) { queue[entityName].push(uuid); }

        // body.myQueue に自分のuuidとlockをセット
        req.body.myQueue = { uuid, lock };

        // 待ち行列の先頭が自分なら処理を実行
        if (lock.find((entityName) => queue[entityName].length > 1)) {
            // 並ぶ
            console.log();
            console.log(`################## 並ぶ ${uuid}`);
            console.log();
        } else {
            // 並ばない
            console.log();
            console.log(`################## 不待 ${uuid}`);
            console.log();
            next();
        }
    };
}
qSubject.asObservable().subscribe((obj: { uuid: string, lock: EntityName[] }) => {
    console.log();
    console.log(`################## 検知 ${JSON.stringify(obj)}`);
    console.log();
    // dequeue
    for (const entityName of obj.lock) queue[entityName].shift();
    delete queueMap[obj.uuid];

    // 次の先頭の人を動かす
    const uuidCount: { [key: string]: number } = {};

    // queueの先頭のuuidをカウント
    Object.values(queue).forEach((uuids) => {
        if (uuids[0] in uuidCount) {
            uuidCount[uuids[0] ?? ''] += 1;
        } else {
            uuidCount[uuids[0] ?? ''] = 1;
        }
    });

    // 実行
    Object.keys(uuidCount).filter(uuid => uuid).forEach(uuid => {
        console.log();
        console.log(`################## カウント ${uuid} ${uuidCount[uuid]} / ${queueMap[uuid].req.body.myQueue.lock.length}`);
        console.log(JSON.stringify(queueMap[uuid].req.body.myQueue));
        console.log();
        if (queueMap[uuid].req.body.myQueue.lock.length === uuidCount[uuid]) {
            // ロック要求数 === ロック取得数であれば実行
            console.log();
            console.log(`################## 実行 ${uuid}`);
            console.log(JSON.stringify(queue));
            console.log();
            queueMap[uuid].next();
        } else {
            // それ以外は待つ
        }
    });
});

/**
 * [user認証] ドキュメント追加
 */
export const addDocuments = [
    enqueueGenerator(['task', 'document']),
    param('taskId').trim().notEmpty(),
    body('documents.*.type').trim().notEmpty(),
    body('documents.*.subType').trim().notEmpty(),
    body('documents.*.title').trim().notEmpty(),
    // body('documents.*.content').trim().notEmpty(),
    body('documents.*.status').trim().notEmpty(),
    validationErrorHandler,
    (_req: Request, res: Response) => {
        const req = _req as UserRequest;
        return ds.getRepository(TaskEntity).findOneOrFail({ where: { id: Number(req.params.taskId) }, relations: ['stage.project', 'documents', 'discussions'] }).then((task: TaskEntity) => {
            req.body.documents = req.body.documents || [];
            return ds.transaction(tx => {
                if (sequencial) {
                    // 逐次処理
                    return (req.body.documents as DocumentEntity[]).reduce((promise: Promise<DocumentEntity[]>, _document: DocumentEntity) => {
                        return promise.then((before: DocumentEntity[]) => {
                            const document = new DocumentEntity();
                            document.type = _document.type;
                            document.subType = _document.subType;
                            document.title = _document.title;
                            document.content = _document.content;
                            document.status = _document.status;
                            return tx.save(DocumentEntity, document).then((savedDocument) => {
                                before.push(savedDocument);
                                task.documents = task.documents || [];
                                task.documents.push(savedDocument);
                                return before;
                            });
                        });
                    }, Promise.resolve([] as DocumentEntity[])).then((documents: DocumentEntity[]) => {
                        return tx.save(TaskEntity, task).then((_task) => {
                            task.documents = []; // 循環参照を切るためにあえてtaskのdocumentsを空にする
                            return documents as DocumentEntity[];
                        });
                    });
                } else {
                    // 並列処理
                    return Promise.all(req.body.documents.map((_document: DocumentEntity) => {
                        const document = new DocumentEntity();
                        document.type = _document.type;
                        document.subType = _document.subType;
                        document.title = _document.title;
                        document.content = _document.content;
                        document.status = _document.status;
                        console.log(`save document ${document.title}`);
                        return tx.save(DocumentEntity, document);
                    })).then((documents) => {
                        // idが振られたdocumentをtaskに追加して保存
                        task.documents = task.documents || [];
                        task.documents.push(...documents);
                        return tx.save(TaskEntity, task).then((_task) => {
                            return documents; // 更新分だけを返却する
                        });
                    });
                }
            });
        }).then((documents: DocumentEntity[]) => {
            console.log(`All save document ${documents.map(document => document.title)}`); // TODO: ここでエラーが発生する
            res.status(201).json(documents);
        }).catch((error) => {
            console.error(error);
            res.status(error instanceof EntityNotFoundError ? 404 : 500).json({ message: `Error adding document to task ${req.params.taskId}` });
        }).finally(() => {
            // 次の人を動かす
            qSubject.next(req.body.myQueue);
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
        ds.getRepository(DocumentEntity).findOneOrFail({ where: { id: Number(req.params.id) } }).then((document) => {
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
            ;
            return ds.transaction(tx => {
                return tx.save(DocumentEntity, document);
            })
        }).then((document: DocumentEntity) => {
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
        ds.getRepository(TaskEntity).findOneOrFail({ where: { id: Number(req.params.taskId) }, relations: ['discussions'] }).then((task) => {
            req.body.discussions = req.body.discussions || [];
            return ds.transaction(tx => {
                if (sequencial) {
                    // 逐次処理
                    return (req.body.discussions as DiscussionEntity[]).reduce((promise: Promise<DiscussionEntity[]>, _discussion: DiscussionEntity) => {
                        return promise.then((before) => {
                            const discussion = new DiscussionEntity();
                            discussion.topic = _discussion.topic;
                            discussion.participants = _discussion.participants;
                            discussion.type = _discussion.type || '' as any;
                            discussion.subType = _discussion.subType || '' as any;
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
                    return Promise.all(req.body.discussions.map((_discussion: DiscussionEntity) => {
                        const discussion = new DiscussionEntity();
                        discussion.topic = _discussion.topic;
                        discussion.participants = _discussion.participants;
                        discussion.type = _discussion.type || '' as any;
                        discussion.subType = _discussion.subType || '' as any;
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
            })
        }).then((discussions: DiscussionEntity[]) => {
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
        ds.getRepository(DiscussionEntity).findOneOrFail({ where: { id: Number(req.params.id) }, relations: ['statements'] }).then((discussion) => {
            if (req.body.topic) {
                discussion.topic = req.body.topic;
            } else {/* do nothing */ }
            if (req.body.participants && req.body.participants.length > 0) {
                discussion.participants = req.body.participants;
            } else {/* do nothing */ }
            return ds.transaction(tx => {
                return tx.save(DiscussionEntity, discussion);
            })
        }).then((discussion: DiscussionEntity) => {
            discussion.statements = discussion.statements || [];
            res.status(200).json(discussion);
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
        ds.getRepository(DiscussionEntity).findOneOrFail({ where: { id: Number(req.params.discussionId) }, relations: ['statements'] }).then((discussion) => {
            req.body.statements = req.body.statements || [];
            return ds.transaction(tx => {
                return Promise.all(req.body.statements.map((_statement: StatementEntity) => {
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
                        discussion.statements = []; // 循環参照を切るためにあえてdiscussionのstatementsを空にして返却する
                        return savedStatements;
                    });
                });
            });
        }).then((statements: StatementEntity[]) => {
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
        ds.getRepository(StatementEntity).findOneOrFail({ where: { id: Number(req.params.id) } }).then((statement) => {
            if (req.body.sequence) {
                statement.sequence = req.body.sequence;
            } else {/* do nothing */ }
            if (req.body.speaker) {
                statement.speaker = req.body.speaker;
            } else {/* do nothing */ }
            if (req.body.content) {
                statement.content = req.body.content;
            } else {/* do nothing */ }
            return ds.transaction(tx => {
                return tx.save(StatementEntity, statement);
            })
        }).then((statement: StatementEntity) => {
            res.status(200).json(statement);
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

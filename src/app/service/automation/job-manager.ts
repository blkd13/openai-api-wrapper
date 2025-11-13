import { EntityManager } from 'typeorm';
import { ds } from '../db.js';
import {
    AutomationJobEntity,
    AutomationTaskEntity,
    AutomationTaskStatus,
    AutomationTaskType,
} from '../entity/automation.entity.js';
import {
    ContentPartEntity,
    MessageEntity,
    MessageGroupEntity,
    ThreadEntity,
    ThreadGroupEntity,
} from '../entity/project-models.entity.js';
import {
    ContentPartType,
    MessageGroupType,
    ThreadGroupStatus,
    ThreadGroupType,
    ThreadGroupVisibility,
    ThreadStatus,
} from '../models/values.js';
import { threadCloneCore } from '../controllers/project-models.js';

type UserExecutionContext = {
    userId: string;
    orgKey: string;
    ip: string;
};

type TaskTemplateDefinition = {
    name: string;
    description?: string;
    prompt: string;
    model?: {
        provider: string;
        modelId: string;
    };
};

/**
 * タスクテンプレートを作成
 * ThreadGroup (type=AutomationTaskTemplate) と AutomationTask (taskType=Template) を作成
 */
export async function createTaskTemplate(
    job: AutomationJobEntity,
    taskDef: TaskTemplateDefinition,
    seq: number,
    userContext: UserExecutionContext,
    transactionalEntityManager?: EntityManager,
): Promise<{ task: AutomationTaskEntity; threadGroup: ThreadGroupEntity }> {
    const manager = transactionalEntityManager || ds.manager;

    // 1. ThreadGroup (type=AutomationTaskTemplate) を作成
    const threadGroup = new ThreadGroupEntity();
    threadGroup.projectId = job.projectId;
    threadGroup.type = ThreadGroupType.AutomationTaskTemplate;
    threadGroup.visibility = ThreadGroupVisibility.Team;
    threadGroup.title = taskDef.name;
    threadGroup.description = taskDef.description || '';
    threadGroup.status = ThreadGroupStatus.Normal;
    threadGroup.orgKey = userContext.orgKey;
    threadGroup.createdBy = userContext.userId;
    threadGroup.updatedBy = userContext.userId;
    threadGroup.createdIp = userContext.ip;
    threadGroup.updatedIp = userContext.ip;

    const savedThreadGroup = await manager.save(ThreadGroupEntity, threadGroup);

    // 2. AutomationTask (taskType=Template) を作成
    const task = new AutomationTaskEntity();
    task.jobId = job.id;
    task.projectId = job.projectId;
    task.threadGroupId = savedThreadGroup.id;
    task.taskType = AutomationTaskType.Template;
    task.status = AutomationTaskStatus.Pending;
    task.orgKey = userContext.orgKey;
    task.createdBy = userContext.userId;
    task.updatedBy = userContext.userId;
    task.createdIp = userContext.ip;
    task.updatedIp = userContext.ip;

    const savedTask = await manager.save(AutomationTaskEntity, task);

    // 3. Thread を作成し、inDtoにモデル情報を設定
    const thread = new ThreadEntity();
    thread.threadGroupId = savedThreadGroup.id;
    thread.status = ThreadStatus.Normal;
    thread.inDto = {
        args: {
            model: taskDef.model?.modelId || job.model?.modelId || 'gpt-4o',
            // 他の必要なパラメータは実行時に設定
        },
    };
    thread.orgKey = userContext.orgKey;
    thread.createdBy = userContext.userId;
    thread.updatedBy = userContext.userId;
    thread.createdIp = userContext.ip;
    thread.updatedIp = userContext.ip;

    const savedThread = await manager.save(ThreadEntity, thread);

    // 4. 初期MessageGroup/Message/ContentPartを作成（promptを保存）
    const messageGroup = new MessageGroupEntity();
    messageGroup.threadId = savedThread.id;
    messageGroup.type = MessageGroupType.Single;
    messageGroup.role = 'user';
    messageGroup.source = 'user';
    messageGroup.orgKey = userContext.orgKey;
    messageGroup.createdBy = userContext.userId;
    messageGroup.updatedBy = userContext.userId;
    messageGroup.createdIp = userContext.ip;
    messageGroup.updatedIp = userContext.ip;

    const savedMessageGroup = await manager.save(MessageGroupEntity, messageGroup);

    const message = new MessageEntity();
    message.messageGroupId = savedMessageGroup.id;
    message.label = 'Initial prompt';
    message.subSeq = 0;
    message.orgKey = userContext.orgKey;
    message.createdBy = userContext.userId;
    message.updatedBy = userContext.userId;
    message.createdIp = userContext.ip;
    message.updatedIp = userContext.ip;

    const savedMessage = await manager.save(MessageEntity, message);

    const contentPart = new ContentPartEntity();
    contentPart.messageId = savedMessage.id;
    contentPart.type = ContentPartType.TEXT;
    contentPart.text = taskDef.prompt;
    contentPart.subSeq = 0;
    contentPart.orgKey = userContext.orgKey;
    contentPart.createdBy = userContext.userId;
    contentPart.updatedBy = userContext.userId;
    contentPart.createdIp = userContext.ip;
    contentPart.updatedIp = userContext.ip;

    await manager.save(ContentPartEntity, contentPart);

    return { task: savedTask, threadGroup: savedThreadGroup };
}

/**
 * 実行インスタンスを生成
 * テンプレートThreadGroupを複製して ThreadGroup (type=AutomationExecution) を作成
 * AutomationTask (taskType=Execution) を作成
 */
export async function cloneTaskForExecution(
    templateTask: AutomationTaskEntity,
    templateThreadGroup: ThreadGroupEntity,
    runId: string,
    userContext: UserExecutionContext,
    transactionalEntityManager: EntityManager,
): Promise<{ task: AutomationTaskEntity; threadGroup: ThreadGroupEntity }> {
    const manager = transactionalEntityManager;

    // 1. ThreadGroup (type=AutomationExecution) を作成（テンプレートを複製）
    const executionThreadGroup = new ThreadGroupEntity();
    executionThreadGroup.projectId = templateThreadGroup.projectId;
    executionThreadGroup.type = ThreadGroupType.AutomationExecution;
    executionThreadGroup.visibility = templateThreadGroup.visibility;
    executionThreadGroup.title = `[Run:${runId}] ${templateThreadGroup.title}`;
    executionThreadGroup.description = templateThreadGroup.description;
    executionThreadGroup.status = ThreadGroupStatus.Normal;
    executionThreadGroup.orgKey = userContext.orgKey;
    executionThreadGroup.createdBy = userContext.userId;
    executionThreadGroup.updatedBy = userContext.userId;
    executionThreadGroup.createdIp = userContext.ip;
    executionThreadGroup.updatedIp = userContext.ip;

    const savedExecutionThreadGroup = await manager.save(ThreadGroupEntity, executionThreadGroup);

    // 2. Thread, MessageGroup, Message, ContentPartを複製
    // threadCloneCoreを使用して既存のロジックを活用
    const threadList = await manager.find(ThreadEntity, {
        where: { orgKey: userContext.orgKey, threadGroupId: templateThreadGroup.id },
    });

    // threadCloneCoreを呼び出すためのリクエストオブジェクトを構築
    const mockReq = {
        info: {
            user: {
                orgKey: userContext.orgKey,
                id: userContext.userId,
            },
            ip: userContext.ip,
        },
    } as any;

    for (const thread of threadList) {
        await threadCloneCore(mockReq, manager, thread.id, savedExecutionThreadGroup.id);
    }

    // 3. AutomationTask (taskType=Execution) を作成
    const executionTask = new AutomationTaskEntity();
    executionTask.jobId = templateTask.jobId;
    executionTask.projectId = templateTask.projectId;
    executionTask.threadGroupId = savedExecutionThreadGroup.id;
    executionTask.taskType = AutomationTaskType.Execution;
    executionTask.templateTaskId = templateTask.id;
    executionTask.runId = runId;
    executionTask.status = AutomationTaskStatus.Pending;
    executionTask.orgKey = userContext.orgKey;
    executionTask.createdBy = userContext.userId;
    executionTask.updatedBy = userContext.userId;
    executionTask.createdIp = userContext.ip;
    executionTask.updatedIp = userContext.ip;

    const savedExecutionTask = await manager.save(AutomationTaskEntity, executionTask);

    return { task: savedExecutionTask, threadGroup: savedExecutionThreadGroup };
}

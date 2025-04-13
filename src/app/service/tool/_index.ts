import { MyToolType, OpenAIApiWrapper } from '../../common/openai-api-wrapper.js';
import { MessageArgsSet } from '../controllers/chat-by-project-model.js';
import { ContentPartEntity, MessageEntity, MessageGroupEntity } from '../entity/project-models.entity.js';
import { UserRequest } from '../models/info.js';
import { boxFunctionDefinitions } from './box.js';
import { commonFunctionDefinitions } from './common.js';
import { confluenceFunctionDefinitions } from './confluence.js';
import { giteaFunctionDefinitions } from './gitea.js';
import { gitlabFunctionDefinitions } from './gitlab.js';
import { jiraFunctionDefinitions } from './jira.js';
import { mattermostFunctionDefinitions } from './mattermost.js';

// 1. 関数マッピングの作成
export async function functionDefinitions(
    obj: { inDto: MessageArgsSet; messageSet: { messageGroup: MessageGroupEntity; message: MessageEntity; contentParts: ContentPartEntity[]; }; },
    req: UserRequest, aiApi: OpenAIApiWrapper, connectionId: string, streamId: string, message: MessageEntity, label: string,
): Promise<MyToolType[]> {
    const functionDefinitions = [
        ...await mattermostFunctionDefinitions('sample', obj, req, aiApi, connectionId, streamId, message, label),
        ...await boxFunctionDefinitions('sample', obj, req, aiApi, connectionId, streamId, message, label),
        ...await confluenceFunctionDefinitions('sample', obj, req, aiApi, connectionId, streamId, message, label),
        ...await jiraFunctionDefinitions('sample', obj, req, aiApi, connectionId, streamId, message, label),
        ...await giteaFunctionDefinitions('sample', obj, req, aiApi, connectionId, streamId, message, label),
        ...await gitlabFunctionDefinitions('sample', obj, req, aiApi, connectionId, streamId, message, label),
        ...commonFunctionDefinitions(obj, req, aiApi, connectionId, streamId, message, label),
    ].map(_func => {
        const func = _func as MyToolType;
        // nameの補充（二重定義になると修正時漏れが怖いので、nameは一か所で定義してここで補充する）
        func.info.name = func.definition.function.name;
        func.definition.function.description = `${func.info.group}\n${func.definition.function.description}`;
        return func;
    }).filter((func, index, self) => func.info.isActive && index === self.findIndex(t => t.definition.function.name === func.definition.function.name)) as MyToolType[];
    return functionDefinitions;
}

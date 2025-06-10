import { MyToolType, OpenAIApiWrapper } from '../../common/openai-api-wrapper.js';
import { MessageArgsSet } from '../controllers/chat-by-project-model.js';
import { ds } from '../db.js';
import { ApiProviderEntity } from '../entity/auth.entity.js';
import { ContentPartEntity, MessageEntity, MessageGroupEntity } from '../entity/project-models.entity.js';
import { UserRequest } from '../models/info.js';
import { boxFunctionDefinitions } from './box.js';
import { commonFunctionDefinitions } from './common.js';
import { confluenceFunctionDefinitions } from './confluence.js';
import { giteaFunctionDefinitions } from './gitea.js';
import { gitlabFunctionDefinitions } from './gitlab.js';
import { jiraFunctionDefinitions } from './jira.js';
import { mattermostFunctionDefinitions } from './mattermost.js';
import { mcpFunctionDefinitions } from './mcp.js';

// 1. 関数マッピングの作成
export async function functionDefinitions(
    obj: { inDto: MessageArgsSet; messageSet: { messageGroup: MessageGroupEntity; message: MessageEntity; contentParts: ContentPartEntity[]; }; },
    req: UserRequest, aiApi: OpenAIApiWrapper, connectionId: string, streamId: string, message: MessageEntity, label: string,
): Promise<MyToolType[]> {

    // APIプロバイダーを基に関数定義を取得
    // まずは、APIプロバイダーを取得
    const activeApiProviders = await ds.getRepository(ApiProviderEntity).find({
        select: { type: true, name: true, },
        where: {
            orgKey: req.info.user.orgKey,
            isDeleted: false,
        },
        order: { sortSeq: 'ASC' },
    });    // プロバイダーtypeごとの関数定義をマッピング
    const map = {
        mattermost: mattermostFunctionDefinitions,
        box: boxFunctionDefinitions,
        confluence: confluenceFunctionDefinitions,
        jira: jiraFunctionDefinitions,
        gitea: giteaFunctionDefinitions,
        gitlab: gitlabFunctionDefinitions,
        mcp: mcpFunctionDefinitions,
    } as Record<string, (name: string, obj: any, req: UserRequest, aiApi: OpenAIApiWrapper, connectionId: string, streamId: string, message: MessageEntity, label: string) => Promise<MyToolType[]>>;

    // 各プロバイダーの関数定義を取得
    const functionDefinitions = (await Promise.all(activeApiProviders.map(async provider =>
        map[provider.type] ? await map[provider.type](provider.name, obj, req, aiApi, connectionId, streamId, message, label) : null
    ))).filter(Boolean).flat() as MyToolType[];

    // 共通関数定義を追加
    functionDefinitions.push(...commonFunctionDefinitions(obj, req, aiApi, connectionId, streamId, message, label));

    // 各関数定義に対して、nameの補充とdescriptionの更新を行い、重複を排除
    // 重複排除のため、isActiveがtrueのもののみを残し、nameで一意にする
    const updatedFunctionDefinitions = functionDefinitions.map(_func => {
        const func = _func as MyToolType;
        // nameの補充（二重定義になると修正時漏れが怖いので、nameは一か所で定義してここで補充する）
        func.info.name = func.definition.function.name;
        func.definition.function.description = `${func.info.group}\n${func.definition.function.description}`;
        return func;
    }).filter((func, index, self) => func.info.isActive && index === self.findIndex(t => t.definition.function.name === func.definition.function.name)) as MyToolType[];

    return updatedFunctionDefinitions;
}

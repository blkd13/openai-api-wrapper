import { Request } from 'express';

import { OAuthAccountEntity } from '../entity/auth.entity.js';
import { InviteTokenPayload, UserTokenPayloadWithRole } from '../middleware/authenticate.js';

export interface UserRequest extends Request {
    /**
     * 誤って重要情報をOverrideしないようにオリジナルのデータはinfoオブジェクト配下に格納する
     */
    info: { ip: string, user: UserTokenPayloadWithRole };
}

export interface OAuthUserRequest extends Request {
    /**
     * 誤って重要情報をOverrideしないようにオリジナルのデータはinfoオブジェクト配下に格納する
     */
    info: { ip: string, user: UserTokenPayloadWithRole, oAuth: OAuthAccountEntity };
}

export interface InviteRequest extends Request {
    /**
     * 誤って重要情報をOverrideしないようにオリジナルのデータはinfoオブジェクト配下に格納する
     */
    info: { ip: string, invite: InviteTokenPayload };
}

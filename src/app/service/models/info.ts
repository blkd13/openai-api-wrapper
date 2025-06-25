import { Request } from 'express';

import { OAuthAccountEntity } from '../entity/auth.entity.js';
import { InviteTokenPayload, UserTokenPayload, UserTokenPayloadWithRole } from '../middleware/authenticate.js';

export interface UserRequest extends Request {
    /**
     * 誤って重要情報をOverrideしないようにオリジナルのデータはinfoオブジェクト配下に格納する
     */
    info: { user: UserTokenPayloadWithRole, ip: string, cookie: Record<string, string> };
}

export interface OAuthUserRequest extends Request {
    /**
     * 誤って重要情報をOverrideしないようにオリジナルのデータはinfoオブジェクト配下に格納する
     */
    info: { user: UserTokenPayloadWithRole, ip: string, cookie: Record<string, string>, oAuth: OAuthAccountEntity };
}

export interface InviteRequest extends Request {
    /**
     * 誤って重要情報をOverrideしないようにオリジナルのデータはinfoオブジェクト配下に格納する
     */
    info: { invite: InviteTokenPayload, ip: string };
}

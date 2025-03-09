import { Request } from 'express';

import { InviteEntity, OAuthAccountEntity, UserEntity } from '../entity/auth.entity.js';

export interface UserRequest extends Request {
    /**
     * 誤って重要情報をOverrideしないようにオリジナルのデータはinfoオブジェクト配下に格納する
     */
    info: { user: UserEntity, ip: string, cookie: Record<string, string> };
}

export interface OAuthUserRequest extends Request {
    /**
     * 誤って重要情報をOverrideしないようにオリジナルのデータはinfoオブジェクト配下に格納する
     */
    info: { user: UserEntity, ip: string, cookie: Record<string, string>, oAuth: OAuthAccountEntity };
}

export interface InviteRequest extends Request {
    /**
     * 誤って重要情報をOverrideしないようにオリジナルのデータはinfoオブジェクト配下に格納する
     */
    info: { invite: InviteEntity, ip: string };
}

import { Request } from 'express';

import { InviteEntity, UserEntity } from './auth.js';

export interface UserRequest extends Request {
    /**
     * 誤って重要情報をOverrideしないようにオリジナルのデータはinfoオブジェクト配下に格納する
     */
    info: { user: UserEntity };
}

export interface InviteRequest extends Request {
    /**
     * 誤って重要情報をOverrideしないようにオリジナルのデータはinfoオブジェクト配下に格納する
     */
    info: { invite: InviteEntity };
}

import { validationResult } from 'express-validator';
import { NextFunction, Request, Response } from 'express';

/**
 * バリデーションエラーのハンドラー
 * @param req 
 * @param res 
 * @returns 
 */
export const validationErrorHandler = (req: Request, res: Response, next: NextFunction) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
    }
    next();
}

import { Request, Response } from 'express';
import { ds } from '../db.js';
import { BrowserDailyLogEntity, DailyLogPayload } from './browser-log.entity.js';

export const saveBrowserLog = async (req: Request, res: Response) => {
    try {
        const payload = req.body as DailyLogPayload;
        const orgKey = req.params.orgKey; // 今後利用予定

        if (!payload.uniqueId || !payload.date || !Array.isArray(payload.entries)) {
            res.status(400).json({ error: 'Invalid payload format' });
            return;
        }

        // X-Forwarded-For header might be comma separated list of IPs
        // or req.ip might be populated by express trust proxy setting
        let ip = req.ip;
        if (!ip && req.headers['x-forwarded-for']) {
            const forwarded = req.headers['x-forwarded-for'];
            ip = Array.isArray(forwarded) ? forwarded[0] : forwarded.split(',')[0].trim();
        }
        if (!ip) {
            ip = req.socket.remoteAddress;
        }

        const repo = ds.getRepository(BrowserDailyLogEntity);
        const log = repo.create({
            orgKey,
            uniqueId: payload.uniqueId,
            date: payload.date,
            entries: payload.entries,
            createdIp: typeof ip === 'string' ? ip : undefined,
            updatedIp: typeof ip === 'string' ? ip : undefined,
            createdBy: payload.uniqueId,
            updatedBy: payload.uniqueId,
        });

        await repo.save(log);

        res.json({ success: true });
    } catch (error) {
        console.error('Error saving browser log:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
};

import { Env } from './types';
import { add, isAfter } from 'date-fns';

export class StorageService {
    private db: D1Database;
    private static readonly DEFAULT_POST_HISTORY_LIMIT = 20;

    constructor(env: Env) {
        this.db = env.DB;
    }

    async updateLastRun(accountId: number): Promise<void> {
        await this.db.prepare(
            'UPDATE accounts SET last_run_at = ? WHERE id = ?'
        ).bind(Math.floor(Date.now() / 1000), accountId).run();
    }

    shouldRun(lastRun: number, frequency: string): boolean {
        const now = new Date();
        const normalizedLastRun = this.normalizeLastRunTimestamp(lastRun);
        const lastRunDate = new Date(normalizedLastRun * 1000);
        
        let nextRunDate: Date;

        switch (frequency) {
            case 'every_2_hours':
                nextRunDate = add(lastRunDate, { hours: 2 });
                break;
            case 'daily':
                nextRunDate = add(lastRunDate, { days: 1 });
                break;
            case 'hourly':
                nextRunDate = add(lastRunDate, { hours: 1 });
                break;
            case 'twice_a_day':
                nextRunDate = add(lastRunDate, { hours: 12 });
                break;
            default:
                nextRunDate = add(lastRunDate, { hours: 1 });
                break;
        }

        return isAfter(now, nextRunDate);
    }

    private normalizeLastRunTimestamp(lastRun: number): number {
        if (!Number.isFinite(lastRun) || lastRun <= 0) {
            return 0;
        }

        // Older rows stored milliseconds, while current writes use seconds.
        if (lastRun > 10_000_000_000) {
            return Math.floor(lastRun / 1000);
        }

        return lastRun;
    }

    async getPostHistory(
        accountId: number,
        limit: number = StorageService.DEFAULT_POST_HISTORY_LIMIT
    ): Promise<string[]> {
        const { results } = await this.db.prepare(
            'SELECT content FROM post_history WHERE account_id = ? ORDER BY created_at DESC LIMIT ?'
        ).bind(accountId, limit).all();
        return results.map((r: any) => r.content);
    }

    async addPostToHistory(accountId: number, content: string): Promise<void> {
        await this.db.prepare(
            'INSERT INTO post_history (account_id, content) VALUES (?, ?)'
        ).bind(accountId, content).run();
    }
}

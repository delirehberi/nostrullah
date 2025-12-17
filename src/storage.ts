import { Env } from './types';

export class StorageService {
    private db: D1Database;

    constructor(env: Env) {
        this.db = env.DB;
    }

    async updateLastRun(accountId: number): Promise<void> {
        await this.db.prepare(
            'UPDATE accounts SET last_run_at = ? WHERE id = ?'
        ).bind(Date.now(), accountId).run();
    }

    shouldRun(lastRun: number, frequency: string): boolean {
        const now = Date.now();
        const diff = now - lastRun;

        // Simple frequency parsing
        if (frequency === 'every_2_hours') {
            return diff > 2 * 60 * 60 * 1000;
        }
        if (frequency === 'daily') {
            return diff > 24 * 60 * 60 * 1000;
        }
        if (frequency === 'hourly') {
            return diff > 60 * 60 * 1000;
        }
        if (frequency === 'twice_a_day') {
            return diff > 12 * 60 * 60 * 1000;
        }

        // Default to 1 hour if unknown
        return diff > 60 * 60 * 1000;
    }

    async getPostHistory(accountId: number): Promise<string[]> {
        const { results } = await this.db.prepare(
            'SELECT content FROM post_history WHERE account_id = ? ORDER BY created_at DESC LIMIT 20'
        ).bind(accountId).all();
        return results.map((r: any) => r.content);
    }

    async addPostToHistory(accountId: number, content: string): Promise<void> {
        await this.db.prepare(
            'INSERT INTO post_history (account_id, content) VALUES (?, ?)'
        ).bind(accountId, content).run();
    }
}

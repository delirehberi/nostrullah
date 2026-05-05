import { Env } from './types';
import { add, isAfter } from 'date-fns';
import { AccountConfigPatch } from './control-actions';

export interface ProcessedControlEventRecord {
    eventId: string;
    accountId: number;
    authorPubkey: string;
    rawContent: string;
    parsedActionsJson?: string;
    status: string;
    resultMessage: string;
    eventCreatedAt: number;
}

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

    async updateControlLastCheckedAt(accountId: number, timestamp: number): Promise<void> {
        await this.db.prepare(
            'UPDATE accounts SET control_last_checked_at = ? WHERE id = ?'
        ).bind(timestamp, accountId).run();
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

    async addPostToHistory(accountId: number, content: string, eventId?: string): Promise<void> {
        await this.db.prepare(
            'INSERT INTO post_history (account_id, content, event_id) VALUES (?, ?, ?)'
        ).bind(accountId, content, eventId || null).run();
    }

    async findAccountIdByPostEventId(eventId: string): Promise<number | null> {
        const result = await this.db.prepare(
            'SELECT account_id FROM post_history WHERE event_id = ? LIMIT 1'
        ).bind(eventId).first<{ account_id: number }>();

        return result?.account_id ?? null;
    }

    async hasProcessedControlEvent(eventId: string): Promise<boolean> {
        const result = await this.db.prepare(
            'SELECT event_id FROM processed_control_events WHERE event_id = ? LIMIT 1'
        ).bind(eventId).first<{ event_id: string }>();

        return Boolean(result?.event_id);
    }

    async recordProcessedControlEvent(record: ProcessedControlEventRecord): Promise<void> {
        await this.db.prepare(`
            INSERT INTO processed_control_events (
                event_id,
                account_id,
                author_pubkey,
                raw_content,
                parsed_actions_json,
                status,
                result_message,
                event_created_at,
                processed_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(
            record.eventId,
            record.accountId,
            record.authorPubkey,
            record.rawContent,
            record.parsedActionsJson || null,
            record.status,
            record.resultMessage,
            record.eventCreatedAt,
            Math.floor(Date.now() / 1000)
        ).run();
    }

    async updateAccountConfiguration(accountId: number, patch: AccountConfigPatch): Promise<void> {
        const assignments: string[] = [];
        const values: Array<string | number | boolean | null> = [];

        if (Object.prototype.hasOwnProperty.call(patch, 'name')) {
            assignments.push('name = ?');
            values.push(patch.name || null);
        }

        if (patch.relays) {
            assignments.push('relays = ?');
            values.push(JSON.stringify(patch.relays));
        }

        if (patch.categories) {
            assignments.push('categories = ?');
            values.push(JSON.stringify(patch.categories));
        }

        if (patch.frequency) {
            assignments.push('frequency = ?');
            values.push(patch.frequency);
        }

        if (Object.prototype.hasOwnProperty.call(patch, 'data_resources')) {
            assignments.push('data_resources = ?');
            values.push(JSON.stringify(patch.data_resources || []));
        }

        if (Object.prototype.hasOwnProperty.call(patch, 'prompt_template')) {
            assignments.push('prompt_template = ?');
            values.push(patch.prompt_template || null);
        }

        if (Object.prototype.hasOwnProperty.call(patch, 'personality')) {
            assignments.push('personality = ?');
            values.push(patch.personality || null);
        }

        if (Object.prototype.hasOwnProperty.call(patch, 'is_active')) {
            assignments.push('is_active = ?');
            values.push(patch.is_active ? 1 : 0);
        }

        if (assignments.length === 0) {
            return;
        }

        values.push(accountId);

        await this.db.prepare(
            `UPDATE accounts SET ${assignments.join(', ')} WHERE id = ?`
        ).bind(...values).run();
    }
}

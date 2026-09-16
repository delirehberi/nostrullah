import { Env } from './types';
import { AccountConfigPatch } from './control-actions';
import { SchedulerService } from './scheduler';

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
        await this.db
            .prepare('UPDATE accounts SET last_run_at = ? WHERE id = ?')
            .bind(Math.floor(Date.now() / 1000), accountId)
            .run();
    }

    async updateControlLastCheckedAt(accountId: number, timestamp: number): Promise<void> {
        await this.db
            .prepare('UPDATE accounts SET control_last_checked_at = ? WHERE id = ?')
            .bind(timestamp, accountId)
            .run();
    }

    shouldRun(lastRun: number, frequency: string, now: Date = new Date()): boolean {
        return SchedulerService.isDue(lastRun, frequency, now);
    }

    getNextRunTimestamp(lastRun: number, frequency: string, now: Date = new Date()): number {
        return SchedulerService.getNextRunTimestamp(lastRun, frequency, now);
    }

    normalizeLastRunTimestamp(lastRun: number): number {
        return SchedulerService.normalizeLastRunTimestamp(lastRun);
    }

    async getPostHistory(
        accountId: number,
        limit: number = StorageService.DEFAULT_POST_HISTORY_LIMIT
    ): Promise<string[]> {
        const { results } = await this.db
            .prepare(
                'SELECT content FROM post_history WHERE account_id = ? ORDER BY created_at DESC LIMIT ?'
            )
            .bind(accountId, limit)
            .all();
        return results.map((r: any) => r.content);
    }

    async addPostToHistory(accountId: number, content: string, eventId?: string): Promise<void> {
        await this.db
            .prepare('INSERT INTO post_history (account_id, content, event_id) VALUES (?, ?, ?)')
            .bind(accountId, content, eventId || null)
            .run();

        // Prune to keep only the most recent 200 posts per account.
        await this.db
            .prepare(
                `
            DELETE FROM post_history
            WHERE account_id = ?
              AND id NOT IN (
                SELECT id FROM post_history
                WHERE account_id = ?
                ORDER BY created_at DESC
                LIMIT 200
            )
        `
            )
            .bind(accountId, accountId)
            .run();
    }

    async findAccountIdByPostEventId(eventId: string): Promise<number | null> {
        const result = await this.db
            .prepare('SELECT account_id FROM post_history WHERE event_id = ? LIMIT 1')
            .bind(eventId)
            .first<{ account_id: number }>();

        return result?.account_id ?? null;
    }

    async hasProcessedControlEvent(eventId: string): Promise<boolean> {
        const result = await this.db
            .prepare('SELECT event_id FROM processed_control_events WHERE event_id = ? LIMIT 1')
            .bind(eventId)
            .first<{ event_id: string }>();

        return Boolean(result?.event_id);
    }

    async recordProcessedControlEvent(record: ProcessedControlEventRecord): Promise<void> {
        await this.db
            .prepare(
                `
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
        `
            )
            .bind(
                record.eventId,
                record.accountId,
                record.authorPubkey,
                record.rawContent,
                record.parsedActionsJson || null,
                record.status,
                record.resultMessage,
                record.eventCreatedAt,
                Math.floor(Date.now() / 1000)
            )
            .run();
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

        await this.db
            .prepare(`UPDATE accounts SET ${assignments.join(', ')} WHERE id = ?`)
            .bind(...values)
            .run();
    }
}

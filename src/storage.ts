import { Env } from './types';
import { AccountConfigPatch } from './control-actions';
import { ScheduleSettings, SchedulerService } from './scheduler';

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
    private static readonly SHARED_ITEM_RETENTION_SECONDS = 90 * 24 * 60 * 60;

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

    shouldRun(
        lastRun: number,
        schedule: string | ScheduleSettings,
        now: Date = new Date()
    ): boolean {
        return SchedulerService.isDue(lastRun, schedule, now);
    }

    getNextRunTimestamp(
        lastRun: number,
        schedule: string | ScheduleSettings,
        now: Date = new Date()
    ): number {
        return SchedulerService.getNextRunTimestamp(lastRun, schedule, now);
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

    async addPostToHistory(
        accountId: number,
        content: string,
        eventId?: string,
        format?: string
    ): Promise<void> {
        try {
            await this.db
                .prepare(
                    'INSERT INTO post_history (account_id, content, event_id, format) VALUES (?, ?, ?, ?)'
                )
                .bind(accountId, content, eventId || null, format || null)
                .run();
        } catch (error) {
            // The format column comes from migration 0007; keep recording history without it.
            console.error('Failed to store post format, saving history without it:', error);
            await this.db
                .prepare(
                    'INSERT INTO post_history (account_id, content, event_id) VALUES (?, ?, ?)'
                )
                .bind(accountId, content, eventId || null)
                .run();
        }

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

    /**
     * Returns the normalized item URLs the account shared within the retention window.
     * Failures (e.g. migration not yet applied) yield an empty set so posting continues.
     */
    async getSharedUrls(accountId: number, now: Date = new Date()): Promise<Set<string>> {
        try {
            const { results } = await this.db
                .prepare('SELECT url FROM shared_items WHERE account_id = ? AND created_at >= ?')
                .bind(accountId, this.getSharedItemsCutoff(now))
                .all();
            return new Set(results.map((r: any) => r.url));
        } catch (error) {
            console.error(`Failed to load shared items for account ${accountId}:`, error);
            return new Set();
        }
    }

    /**
     * Records a resource item as shared and prunes entries older than the retention window.
     */
    async recordSharedItem(
        accountId: number,
        url: string,
        title?: string,
        now: Date = new Date()
    ): Promise<void> {
        try {
            await this.db
                .prepare(
                    'INSERT OR IGNORE INTO shared_items (account_id, url, title, created_at) VALUES (?, ?, ?, ?)'
                )
                .bind(accountId, url, title || null, Math.floor(now.getTime() / 1000))
                .run();

            await this.db
                .prepare('DELETE FROM shared_items WHERE account_id = ? AND created_at < ?')
                .bind(accountId, this.getSharedItemsCutoff(now))
                .run();
        } catch (error) {
            console.error(`Failed to record shared item for account ${accountId}:`, error);
        }
    }

    private getSharedItemsCutoff(now: Date): number {
        return Math.floor(now.getTime() / 1000) - StorageService.SHARED_ITEM_RETENTION_SECONDS;
    }

    /**
     * Returns the format of the account's most recent post, if recorded.
     */
    async getLastPostFormat(accountId: number): Promise<string | undefined> {
        try {
            const result = await this.db
                .prepare(
                    'SELECT format FROM post_history WHERE account_id = ? ORDER BY created_at DESC, id DESC LIMIT 1'
                )
                .bind(accountId)
                .first<{ format: string | null }>();
            return result?.format || undefined;
        } catch (error) {
            console.error(`Failed to load last post format for account ${accountId}:`, error);
            return undefined;
        }
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

        if (patch.timezone) {
            assignments.push('timezone = ?');
            values.push(patch.timezone);
        }

        if (Object.prototype.hasOwnProperty.call(patch, 'active_hours')) {
            assignments.push('active_hours = ?');
            values.push(patch.active_hours || null);
        }

        if (patch.jitter_minutes !== undefined) {
            assignments.push('jitter_minutes = ?');
            values.push(patch.jitter_minutes);
        }

        if (Object.prototype.hasOwnProperty.call(patch, 'post_formats')) {
            assignments.push('post_formats = ?');
            values.push(patch.post_formats ? JSON.stringify(patch.post_formats) : null);
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

import { Env } from './types';
import { AccountConfigPatch } from './control-actions';
import {
    EngagementCounts,
    EngagementPost,
    EngagementStats,
    EngagementStore,
    FormatPerformance,
} from './engagement';
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

export class StorageService implements EngagementStore {
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

    /**
     * Throws when the column is missing (migration 0009 not applied), which stops the
     * engagement collection instead of re-querying relays on every cron tick.
     */
    async updateEngagementCheckedAt(accountId: number, timestamp: number): Promise<void> {
        await this.db
            .prepare('UPDATE accounts SET engagement_checked_at = ? WHERE id = ?')
            .bind(timestamp, accountId)
            .run();
    }

    /**
     * Published posts (with an event id) created since `sinceTimestamp`, newest first.
     */
    async getPostsForEngagement(
        accountId: number,
        sinceTimestamp: number,
        limit: number
    ): Promise<EngagementPost[]> {
        const { results } = await this.db
            .prepare(
                `SELECT event_id, CAST(strftime('%s', created_at) AS INTEGER) AS created_ts
                FROM post_history
                WHERE account_id = ? AND event_id IS NOT NULL AND created_at >= datetime(?, 'unixepoch')
                ORDER BY created_at DESC LIMIT ?`
            )
            .bind(accountId, sinceTimestamp, limit)
            .all();
        return results.map((r: any) => ({ eventId: r.event_id, createdAt: Number(r.created_ts) }));
    }

    async saveEngagement(
        accountId: number,
        eventId: string,
        counts: EngagementCounts,
        score: number,
        timestamp: number
    ): Promise<void> {
        await this.db
            .prepare(
                `UPDATE post_history
                SET reactions = ?, reposts = ?, replies = ?, zaps = ?, zap_sats = ?,
                    engagement_score = ?, engagement_updated_at = ?
                WHERE account_id = ? AND event_id = ?`
            )
            .bind(
                counts.reactions,
                counts.reposts,
                counts.replies,
                counts.zaps,
                counts.zapSats,
                score,
                timestamp,
                accountId,
                eventId
            )
            .run();
    }

    /**
     * Contents of the best-scoring posts (score > 0) created since `sinceTimestamp`.
     */
    async getTopPosts(accountId: number, sinceTimestamp: number, limit: number): Promise<string[]> {
        try {
            const { results } = await this.db
                .prepare(
                    `SELECT content FROM post_history
                    WHERE account_id = ? AND engagement_score > 0 AND created_at >= datetime(?, 'unixepoch')
                    ORDER BY engagement_score DESC, created_at DESC LIMIT ?`
                )
                .bind(accountId, sinceTimestamp, limit)
                .all();
            return results.map((r: any) => r.content);
        } catch (error) {
            console.error(`Failed to load top posts for account ${accountId}:`, error);
            return [];
        }
    }

    /**
     * Format and score of measured posts created since `sinceTimestamp`.
     */
    async getFormatPerformance(
        accountId: number,
        sinceTimestamp: number
    ): Promise<FormatPerformance[]> {
        try {
            const { results } = await this.db
                .prepare(
                    `SELECT format, engagement_score FROM post_history
                    WHERE account_id = ? AND format IS NOT NULL AND engagement_updated_at IS NOT NULL
                      AND created_at >= datetime(?, 'unixepoch')`
                )
                .bind(accountId, sinceTimestamp)
                .all();
            return results.map((r: any) => ({
                format: r.format,
                score: Number(r.engagement_score) || 0,
            }));
        } catch (error) {
            console.error(`Failed to load format performance for account ${accountId}:`, error);
            return [];
        }
    }

    /**
     * Aggregated engagement for posts created since `sinceTimestamp`, plus the top post.
     */
    async getEngagementStats(
        accountId: number,
        sinceTimestamp: number
    ): Promise<EngagementStats | undefined> {
        try {
            const totals = await this.db
                .prepare(
                    `SELECT COUNT(*) AS posts, SUM(reactions) AS reactions, SUM(reposts) AS reposts,
                        SUM(replies) AS replies, SUM(zaps) AS zaps, SUM(zap_sats) AS zap_sats,
                        (SELECT engagement_checked_at FROM accounts WHERE id = ?) AS checked_at
                    FROM post_history
                    WHERE account_id = ? AND created_at >= datetime(?, 'unixepoch')`
                )
                .bind(accountId, accountId, sinceTimestamp)
                .first<any>();
            const top = await this.db
                .prepare(
                    `SELECT content, engagement_score FROM post_history
                    WHERE account_id = ? AND engagement_score > 0 AND created_at >= datetime(?, 'unixepoch')
                    ORDER BY engagement_score DESC LIMIT 1`
                )
                .bind(accountId, sinceTimestamp)
                .first<any>();

            return {
                posts: Number(totals?.posts) || 0,
                reactions: Number(totals?.reactions) || 0,
                reposts: Number(totals?.reposts) || 0,
                replies: Number(totals?.replies) || 0,
                zaps: Number(totals?.zaps) || 0,
                zapSats: Number(totals?.zap_sats) || 0,
                checkedAt: Number(totals?.checked_at) || undefined,
                topPost: top
                    ? { content: top.content, score: Number(top.engagement_score) }
                    : undefined,
            };
        } catch (error) {
            console.error(`Failed to load engagement stats for account ${accountId}:`, error);
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

        if (Object.prototype.hasOwnProperty.call(patch, 'max_post_length')) {
            assignments.push('max_post_length = ?');
            values.push(patch.max_post_length ?? null);
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

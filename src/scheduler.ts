import { CronExpressionParser } from 'cron-parser';

export const PRESET_FREQUENCIES: Record<string, string> = {
    hourly: '0 * * * *',
    every_2_hours: '0 */2 * * *',
    twice_a_day: '0 0,12 * * *',
    daily: '0 0 * * *',
};

// 30 seconds buffer to absorb trigger seconds clock skew
const JITTER_TOLERANCE_MS = 30 * 1000;

export class SchedulerService {
    /**
     * Normalizes a frequency alias or cron string into a canonical 5-field cron expression.
     */
    static toCronExpression(frequency: string): string {
        const trimmed = (frequency || '').trim();
        if (!trimmed) {
            return PRESET_FREQUENCIES.hourly;
        }
        if (PRESET_FREQUENCIES[trimmed]) {
            return PRESET_FREQUENCIES[trimmed];
        }

        try {
            CronExpressionParser.parse(trimmed, { tz: 'UTC' });
            return trimmed;
        } catch {
            console.warn(
                `Invalid frequency or cron expression: "${frequency}". Falling back to hourly ("0 * * * *").`
            );
            return PRESET_FREQUENCIES.hourly;
        }
    }

    /**
     * Checks whether a frequency string is a recognized preset or a valid cron expression.
     */
    static isValidFrequency(frequency: string): boolean {
        if (!frequency || typeof frequency !== 'string') {
            return false;
        }
        const trimmed = frequency.trim();
        if (!trimmed) {
            return false;
        }
        if (PRESET_FREQUENCIES[trimmed]) {
            return true;
        }
        try {
            CronExpressionParser.parse(trimmed, { tz: 'UTC' });
            return true;
        } catch {
            return false;
        }
    }

    /**
     * Normalizes last_run_at timestamp to unix epoch seconds.
     */
    static normalizeLastRunTimestamp(lastRun: number | null | undefined): number {
        if (!lastRun || !Number.isFinite(lastRun) || lastRun <= 0) {
            return 0;
        }
        // Older rows stored milliseconds, while current writes use seconds.
        if (lastRun > 10_000_000_000) {
            return Math.floor(lastRun / 1000);
        }
        return Math.floor(lastRun);
    }

    /**
     * Determines whether an account is due to run at the given execution time.
     * Evaluates strictly per-account using deterministic cron slot matching.
     */
    static isDue(
        lastRun: number | null | undefined,
        frequency: string,
        now: Date = new Date()
    ): boolean {
        const normalizedLastRun = this.normalizeLastRunTimestamp(lastRun);
        if (normalizedLastRun === 0) {
            return true;
        }

        const cronExpr = this.toCronExpression(frequency);
        const lastRunMs = normalizedLastRun * 1000;

        try {
            // Add jitter tolerance to handle triggers that fire slightly before/after the exact minute
            const referenceDate = new Date(now.getTime() + JITTER_TOLERANCE_MS);
            const interval = CronExpressionParser.parse(cronExpr, {
                currentDate: referenceDate,
                tz: 'UTC',
            });

            const prevSlot = interval.prev().toDate();
            return lastRunMs < prevSlot.getTime();
        } catch (error) {
            console.error(`Error calculating schedule due state for ${frequency}:`, error);
            // Fallback safe check: 1 hour has elapsed
            return now.getTime() - lastRunMs >= 60 * 60 * 1000;
        }
    }

    /**
     * Computes the timestamp (in milliseconds) of the next scheduled execution.
     */
    static getNextRunTimestamp(
        lastRun: number | null | undefined,
        frequency: string,
        now: Date = new Date()
    ): number {
        const cronExpr = this.toCronExpression(frequency);

        try {
            if (this.isDue(lastRun, frequency, now)) {
                return now.getTime();
            }

            const interval = CronExpressionParser.parse(cronExpr, {
                currentDate: now,
                tz: 'UTC',
            });
            return interval.next().toDate().getTime();
        } catch (error) {
            console.error(`Error calculating next run timestamp for ${frequency}:`, error);
            return now.getTime() + 60 * 60 * 1000;
        }
    }

    /**
     * Gets the previous scheduled slot timestamp for a frequency.
     */
    static getPreviousSlotTimestamp(frequency: string, now: Date = new Date()): number {
        const cronExpr = this.toCronExpression(frequency);
        const referenceDate = new Date(now.getTime() + JITTER_TOLERANCE_MS);
        const interval = CronExpressionParser.parse(cronExpr, {
            currentDate: referenceDate,
            tz: 'UTC',
        });
        return interval.prev().toDate().getTime();
    }
}

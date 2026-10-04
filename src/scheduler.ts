import { CronExpressionParser } from 'cron-parser';

import { NostrAccount } from './types';

/** Preset frequencies, evaluated in the account's timezone. */
export const PRESET_FREQUENCIES: Record<string, string> = {
    hourly: '0 * * * *',
    every_2_hours: '0 */2 * * *',
    twice_a_day: '0 9,18 * * *',
    daily: '0 9 * * *',
};

export const DEFAULT_TIMEZONE = 'Europe/Istanbul';
export const DEFAULT_ACTIVE_HOURS = '07:00-23:00';
export const DEFAULT_JITTER_HOURS = 1;
export const MAX_JITTER_HOURS = 6;

// 30 seconds buffer to absorb trigger seconds clock skew
const CLOCK_SKEW_TOLERANCE_MS = 30 * 1000;
const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const MINUTES_PER_DAY = 24 * 60;
const ACTIVE_HOURS_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)-([01]\d|2[0-3]):([0-5]\d)$/;

/**
 * Per-account schedule settings. A plain frequency string is treated as
 * `{ frequency, timezone: 'UTC' }` with no active hours and no random delay.
 */
export interface ScheduleSettings {
    frequency: string;
    timezone?: string;
    /** `HH:MM-HH:MM` in the account's timezone; may cross midnight. Unset = all day. */
    activeHours?: string;
    /**
     * Maximum random delay in whole hours added after each scheduled slot. Whole
     * hours because the worker's cron runs hourly.
     */
    jitterHours?: number;
    /** Stable per-account value (e.g. account id) used to derive the jitter. */
    seed?: number | string;
}

interface ActiveWindow {
    start: number;
    end: number;
}

interface ResolvedSchedule {
    cronExpr: string;
    timezone: string;
    window?: ActiveWindow;
    jitterHours: number;
    seed: string;
}

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
     * Checks whether a value is an IANA timezone name supported by the runtime.
     */
    static isValidTimezone(timezone: string): boolean {
        if (!timezone || typeof timezone !== 'string') {
            return false;
        }
        try {
            new Intl.DateTimeFormat('en-US', { timeZone: timezone });
            return true;
        } catch {
            return false;
        }
    }

    /**
     * Checks whether a value is an `HH:MM-HH:MM` active-hours window.
     */
    static isValidActiveHours(activeHours: string): boolean {
        return parseActiveHours(activeHours) !== undefined;
    }

    /**
     * Builds schedule settings from an account row.
     */
    static fromAccount(account: NostrAccount): ScheduleSettings {
        return {
            frequency: account.frequency,
            timezone: account.timezone,
            activeHours: account.active_hours,
            jitterHours: account.jitter_hours,
            seed: account.id,
        };
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
     *
     * The account is due when the first cron slot after its last run has passed, its
     * deterministic random delay has elapsed, and the current time is inside its
     * active hours. A slot outside the active hours is deferred to the next window
     * opening, so slots missed overnight produce one post when the window opens.
     * Using the first pending slot (not the latest) means later slots' delays can
     * never keep postponing a post.
     */
    static isDue(
        lastRun: number | null | undefined,
        schedule: string | ScheduleSettings,
        now: Date = new Date()
    ): boolean {
        const resolved = resolveSchedule(schedule);
        const normalizedLastRun = this.normalizeLastRunTimestamp(lastRun);

        if (!isWithinWindow(now, resolved)) {
            return false;
        }
        if (normalizedLastRun === 0) {
            return true;
        }

        const lastRunMs = normalizedLastRun * 1000;

        try {
            const pendingSlot = getFirstSlotAfter(resolved, lastRunMs);
            const reference = now.getTime() + CLOCK_SKEW_TOLERANCE_MS;
            return pendingSlot <= reference && reference >= getDueTime(pendingSlot, resolved);
        } catch (error) {
            console.error(`Error calculating schedule due state for ${resolved.cronExpr}:`, error);
            // Fallback safe check: 1 hour has elapsed
            return now.getTime() - lastRunMs >= 60 * 60 * 1000;
        }
    }

    /**
     * Computes the timestamp (in milliseconds) at which the account will next be due.
     */
    static getNextRunTimestamp(
        lastRun: number | null | undefined,
        schedule: string | ScheduleSettings,
        now: Date = new Date()
    ): number {
        const resolved = resolveSchedule(schedule);

        try {
            if (this.isDue(lastRun, schedule, now)) {
                return now.getTime();
            }

            const lastRunMs = this.normalizeLastRunTimestamp(lastRun) * 1000;
            if (lastRunMs === 0) {
                // Never ran: due as soon as the active window opens.
                return getNextWindowStart(now.getTime(), resolved);
            }

            const pendingSlot = getFirstSlotAfter(resolved, lastRunMs);
            const dueTime = Math.max(getDueTime(pendingSlot, resolved), now.getTime());
            return isWithinWindow(new Date(dueTime), resolved)
                ? dueTime
                : getNextWindowStart(dueTime, resolved);
        } catch (error) {
            console.error(`Error calculating next run timestamp for ${resolved.cronExpr}:`, error);
            return now.getTime() + 60 * 60 * 1000;
        }
    }
}

function resolveSchedule(schedule: string | ScheduleSettings): ResolvedSchedule {
    const settings: ScheduleSettings =
        typeof schedule === 'string' ? { frequency: schedule, timezone: 'UTC' } : schedule;

    const timezone =
        settings.timezone && SchedulerService.isValidTimezone(settings.timezone)
            ? settings.timezone
            : 'UTC';
    if (settings.timezone && timezone !== settings.timezone) {
        console.warn(`Invalid timezone "${settings.timezone}". Falling back to UTC.`);
    }

    const jitterHours = Math.min(
        Math.max(Math.floor(settings.jitterHours || 0), 0),
        MAX_JITTER_HOURS
    );

    return {
        cronExpr: SchedulerService.toCronExpression(settings.frequency),
        timezone,
        window: settings.activeHours ? parseActiveHours(settings.activeHours) : undefined,
        jitterHours,
        seed: String(settings.seed ?? ''),
    };
}

function parseActiveHours(value: string): ActiveWindow | undefined {
    const match = typeof value === 'string' ? value.trim().match(ACTIVE_HOURS_PATTERN) : null;
    if (!match) {
        return undefined;
    }
    return {
        start: Number(match[1]) * 60 + Number(match[2]),
        end: Number(match[3]) * 60 + Number(match[4]),
    };
}

/**
 * First cron slot strictly after `afterMs`: the slot the account still owes a post for.
 */
function getFirstSlotAfter(resolved: ResolvedSchedule, afterMs: number): number {
    const interval = CronExpressionParser.parse(resolved.cronExpr, {
        currentDate: new Date(afterMs),
        tz: resolved.timezone,
    });
    return interval.next().toDate().getTime();
}

/**
 * Time at which a slot becomes due: the slot itself, or the next window opening if
 * the slot is outside the active hours, plus the slot's jitter delay.
 */
function getDueTime(slot: number, resolved: ResolvedSchedule): number {
    const base = isWithinWindow(new Date(slot), resolved)
        ? slot
        : getNextWindowStart(slot, resolved);
    return base + getJitterOffset(slot, resolved);
}

function getJitterOffset(slot: number, resolved: ResolvedSchedule): number {
    if (resolved.jitterHours === 0) {
        return 0;
    }
    // FNV-1a hash of seed + slot: stable across cron ticks, different per slot/account.
    let hash = 0x811c9dc5;
    for (const char of `${resolved.seed}:${slot}`) {
        hash ^= char.charCodeAt(0);
        hash = Math.imul(hash, 0x01000193);
    }
    return ((hash >>> 0) % (resolved.jitterHours + 1)) * HOUR_MS;
}

function getLocalMinutes(date: Date, timezone: string): number {
    const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: timezone,
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
    }).formatToParts(date);
    const hour = Number(parts.find((p) => p.type === 'hour')?.value);
    const minute = Number(parts.find((p) => p.type === 'minute')?.value);
    return hour * 60 + minute;
}

function isWithinWindow(date: Date, resolved: ResolvedSchedule): boolean {
    const window = resolved.window;
    if (!window || window.start === window.end) {
        return true;
    }

    const minutes = getLocalMinutes(date, resolved.timezone);
    return window.start < window.end
        ? minutes >= window.start && minutes < window.end
        : minutes >= window.start || minutes < window.end;
}

/**
 * Next time (ms) at or after `from` when the active window opens.
 */
function getNextWindowStart(from: number, resolved: ResolvedSchedule): number {
    if (!resolved.window) {
        return from;
    }
    const flooredFrom = Math.floor(from / MINUTE_MS) * MINUTE_MS;
    const minutes = getLocalMinutes(new Date(flooredFrom), resolved.timezone);
    const delta = (resolved.window.start - minutes + MINUTES_PER_DAY) % MINUTES_PER_DAY;
    return flooredFrom + delta * MINUTE_MS;
}

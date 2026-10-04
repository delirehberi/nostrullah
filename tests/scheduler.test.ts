import { describe, expect, it } from 'vitest';
import { SchedulerService, PRESET_FREQUENCIES, ScheduleSettings } from '../src/scheduler';

describe('SchedulerService.toCronExpression', () => {
    it('maps standard presets correctly', () => {
        expect(SchedulerService.toCronExpression('hourly')).toBe(PRESET_FREQUENCIES.hourly);
        expect(SchedulerService.toCronExpression('every_2_hours')).toBe(
            PRESET_FREQUENCIES.every_2_hours
        );
        expect(SchedulerService.toCronExpression('twice_a_day')).toBe(
            PRESET_FREQUENCIES.twice_a_day
        );
        expect(SchedulerService.toCronExpression('daily')).toBe(PRESET_FREQUENCIES.daily);
    });

    it('preserves valid custom cron expressions', () => {
        expect(SchedulerService.toCronExpression('0 9,21 * * *')).toBe('0 9,21 * * *');
        expect(SchedulerService.toCronExpression('0 */4 * * *')).toBe('0 */4 * * *');
        expect(SchedulerService.toCronExpression('30 8 * * 1-5')).toBe('30 8 * * 1-5');
    });

    it('falls back to hourly for invalid expressions', () => {
        expect(SchedulerService.toCronExpression('invalid_expression')).toBe(
            PRESET_FREQUENCIES.hourly
        );
        expect(SchedulerService.toCronExpression('')).toBe(PRESET_FREQUENCIES.hourly);
    });
});

describe('SchedulerService.isValidFrequency', () => {
    it('returns true for presets and valid cron expressions', () => {
        expect(SchedulerService.isValidFrequency('hourly')).toBe(true);
        expect(SchedulerService.isValidFrequency('every_2_hours')).toBe(true);
        expect(SchedulerService.isValidFrequency('twice_a_day')).toBe(true);
        expect(SchedulerService.isValidFrequency('daily')).toBe(true);
        expect(SchedulerService.isValidFrequency('0 9,21 * * *')).toBe(true);
        expect(SchedulerService.isValidFrequency('0 */3 * * *')).toBe(true);
    });

    it('returns false for invalid frequencies', () => {
        expect(SchedulerService.isValidFrequency('invalid')).toBe(false);
        expect(SchedulerService.isValidFrequency('')).toBe(false);
        expect(SchedulerService.isValidFrequency(null as any)).toBe(false);
        expect(SchedulerService.isValidFrequency(undefined as any)).toBe(false);
    });
});

describe('SchedulerService.normalizeLastRunTimestamp', () => {
    it('normalizes 0, negative, and non-finite values to 0', () => {
        expect(SchedulerService.normalizeLastRunTimestamp(0)).toBe(0);
        expect(SchedulerService.normalizeLastRunTimestamp(-100)).toBe(0);
        expect(SchedulerService.normalizeLastRunTimestamp(null)).toBe(0);
        expect(SchedulerService.normalizeLastRunTimestamp(undefined)).toBe(0);
        expect(SchedulerService.normalizeLastRunTimestamp(NaN)).toBe(0);
    });

    it('normalizes legacy millisecond timestamps to seconds', () => {
        const ms = 1715000000000;
        expect(SchedulerService.normalizeLastRunTimestamp(ms)).toBe(1715000000);
    });

    it('preserves seconds timestamps', () => {
        const seconds = 1715000000;
        expect(SchedulerService.normalizeLastRunTimestamp(seconds)).toBe(1715000000);
    });
});

describe('SchedulerService.isDue (Deterministic Slot Matching & Zero Drift)', () => {
    it('marks accounts with last_run = 0 as due immediately', () => {
        const now = new Date('2026-09-16T14:00:00Z');
        expect(SchedulerService.isDue(0, 'hourly', now)).toBe(true);
        expect(SchedulerService.isDue(0, 'every_2_hours', now)).toBe(true);
        expect(SchedulerService.isDue(0, 'twice_a_day', now)).toBe(true);
        expect(SchedulerService.isDue(0, '0 9,21 * * *', now)).toBe(true);
    });

    it('correctly handles hourly preset without drift', () => {
        // Last run was at 10:00:15 (15 seconds after 10:00)
        const lastRun = Math.floor(new Date('2026-09-16T10:00:15Z').getTime() / 1000);

        // At 10:30:00 -> not due yet
        expect(SchedulerService.isDue(lastRun, 'hourly', new Date('2026-09-16T10:30:00Z'))).toBe(
            false
        );

        // At 11:00:00 -> exactly due (even though only 59m 45s passed since 10:00:15)
        expect(SchedulerService.isDue(lastRun, 'hourly', new Date('2026-09-16T11:00:00Z'))).toBe(
            true
        );

        // At 11:00:05 (cron trigger with 5s delay) -> due
        expect(SchedulerService.isDue(lastRun, 'hourly', new Date('2026-09-16T11:00:05Z'))).toBe(
            true
        );
    });

    it('correctly handles every_2_hours preset without 1-hour drift', () => {
        // Ran at 12:00:20
        const lastRun = Math.floor(new Date('2026-09-16T12:00:20Z').getTime() / 1000);

        // At 13:00:00 -> not due
        expect(
            SchedulerService.isDue(lastRun, 'every_2_hours', new Date('2026-09-16T13:00:00Z'))
        ).toBe(false);

        // At 14:00:00 -> DUE! (previously failed because 14:00:00 < 12:00:20 + 2h)
        expect(
            SchedulerService.isDue(lastRun, 'every_2_hours', new Date('2026-09-16T14:00:00Z'))
        ).toBe(true);

        // After running at 14:00:10:
        const updatedLastRun = Math.floor(new Date('2026-09-16T14:00:10Z').getTime() / 1000);

        // At 15:00:00 -> not due
        expect(
            SchedulerService.isDue(
                updatedLastRun,
                'every_2_hours',
                new Date('2026-09-16T15:00:00Z')
            )
        ).toBe(false);

        // At 16:00:00 -> due
        expect(
            SchedulerService.isDue(
                updatedLastRun,
                'every_2_hours',
                new Date('2026-09-16T16:00:00Z')
            )
        ).toBe(true);
    });

    it('correctly handles twice_a_day preset (09:00 & 18:00)', () => {
        const lastRun = Math.floor(new Date('2026-09-16T09:00:05Z').getTime() / 1000);

        // Between the two slots -> not due
        expect(
            SchedulerService.isDue(lastRun, 'twice_a_day', new Date('2026-09-16T12:00:00Z'))
        ).toBe(false);
        expect(
            SchedulerService.isDue(lastRun, 'twice_a_day', new Date('2026-09-16T17:00:00Z'))
        ).toBe(false);

        // At 18:00:00 -> due
        expect(
            SchedulerService.isDue(lastRun, 'twice_a_day', new Date('2026-09-16T18:00:00Z'))
        ).toBe(true);
    });

    it('correctly handles custom cron expressions independently per account', () => {
        const accountA_frequency = '0 9,21 * * *';
        const accountB_frequency = '0 8,14,20 * * *';

        const lastRunA = Math.floor(new Date('2026-09-16T09:00:05Z').getTime() / 1000);
        const lastRunB = Math.floor(new Date('2026-09-16T08:00:05Z').getTime() / 1000);

        // At 14:00:00:
        // Account A (9 & 21) is NOT due
        // Account B (8, 14, 20) IS due
        const now = new Date('2026-09-16T14:00:00Z');
        expect(SchedulerService.isDue(lastRunA, accountA_frequency, now)).toBe(false);
        expect(SchedulerService.isDue(lastRunB, accountB_frequency, now)).toBe(true);
    });
});

describe('SchedulerService.getNextRunTimestamp', () => {
    it('returns current time when account is due', () => {
        const now = new Date('2026-09-16T14:00:00Z');
        const lastRun = Math.floor(new Date('2026-09-16T12:00:00Z').getTime() / 1000);

        const nextRun = SchedulerService.getNextRunTimestamp(lastRun, 'every_2_hours', now);
        expect(nextRun).toBe(now.getTime());
    });

    it('returns next cron slot when account has already run for current slot', () => {
        const now = new Date('2026-09-16T14:00:05Z');
        const lastRun = Math.floor(now.getTime() / 1000);

        const nextRun = SchedulerService.getNextRunTimestamp(lastRun, 'every_2_hours', now);
        expect(nextRun).toBe(new Date('2026-09-16T16:00:00Z').getTime());
    });
});

describe('SchedulerService account schedule settings', () => {
    const seconds = (iso: string): number => Math.floor(new Date(iso).getTime() / 1000);
    const istanbul = (overrides: Partial<ScheduleSettings> = {}): ScheduleSettings => ({
        frequency: 'daily',
        timezone: 'Europe/Istanbul',
        seed: 1,
        ...overrides,
    });

    it('evaluates presets in the account timezone', () => {
        // daily = 09:00 Istanbul = 06:00 UTC
        const lastRun = seconds('2026-09-15T06:00:10Z');
        expect(SchedulerService.isDue(lastRun, istanbul(), new Date('2026-09-16T05:59:00Z'))).toBe(
            false
        );
        expect(SchedulerService.isDue(lastRun, istanbul(), new Date('2026-09-16T06:00:00Z'))).toBe(
            true
        );
    });

    it('does not post outside active hours, including for brand-new accounts', () => {
        const schedule = istanbul({ frequency: 'hourly', activeHours: '07:00-23:00' });
        // 02:00 Istanbul
        expect(SchedulerService.isDue(0, schedule, new Date('2026-09-15T23:00:00Z'))).toBe(false);
        expect(
            SchedulerService.isDue(
                seconds('2026-09-15T19:00:10Z'),
                schedule,
                new Date('2026-09-15T23:00:00Z')
            )
        ).toBe(false);
    });

    it('posts a slot missed overnight once when the window opens', () => {
        // 03:00 Istanbul slot, window opens 07:00 Istanbul (04:00 UTC)
        const schedule = istanbul({ frequency: '0 3 * * *', activeHours: '07:00-23:00' });
        const lastRun = seconds('2026-09-15T04:00:30Z');

        expect(SchedulerService.isDue(lastRun, schedule, new Date('2026-09-16T03:56:00Z'))).toBe(
            false
        );
        expect(SchedulerService.isDue(lastRun, schedule, new Date('2026-09-16T04:00:00Z'))).toBe(
            true
        );

        const ranAtOpening = seconds('2026-09-16T04:00:20Z');
        expect(
            SchedulerService.isDue(ranAtOpening, schedule, new Date('2026-09-16T12:00:00Z'))
        ).toBe(false);
    });

    it('supports windows that cross midnight', () => {
        const schedule = istanbul({ frequency: 'hourly', activeHours: '22:00-02:00' });
        const lastRun = seconds('2026-09-15T00:00:10Z');
        // 01:00 Istanbul -> inside, 12:00 Istanbul -> outside
        expect(SchedulerService.isDue(lastRun, schedule, new Date('2026-09-15T22:00:00Z'))).toBe(
            true
        );
        expect(SchedulerService.isDue(lastRun, schedule, new Date('2026-09-15T09:00:00Z'))).toBe(
            false
        );
    });

    it('delays each slot by a stable jitter within the configured bound', () => {
        const lastRun = seconds('2026-09-15T06:30:00Z');
        const slot = new Date('2026-09-16T06:00:00Z').getTime();

        for (let seed = 1; seed <= 25; seed++) {
            const schedule = istanbul({ jitterMinutes: 15, seed });
            const dueAt = SchedulerService.getNextRunTimestamp(
                lastRun,
                schedule,
                new Date('2026-09-16T05:00:00Z')
            );

            expect(dueAt).toBeGreaterThanOrEqual(slot);
            expect(dueAt).toBeLessThanOrEqual(slot + 15 * 60 * 1000);
            // Stable across cron ticks
            expect(
                SchedulerService.getNextRunTimestamp(
                    lastRun,
                    schedule,
                    new Date('2026-09-16T05:30:00Z')
                )
            ).toBe(dueAt);
            expect(SchedulerService.isDue(lastRun, schedule, new Date(dueAt - 60_000))).toBe(false);
            expect(SchedulerService.isDue(lastRun, schedule, new Date(dueAt))).toBe(true);
        }
    });

    it('reports the next window opening as the next run when outside active hours', () => {
        const schedule = istanbul({ frequency: 'hourly', activeHours: '07:00-23:00' });
        const lastRun = seconds('2026-09-15T19:00:10Z');
        // 02:00 Istanbul -> next run 07:00 Istanbul (04:00 UTC)
        expect(
            SchedulerService.getNextRunTimestamp(
                lastRun,
                schedule,
                new Date('2026-09-15T23:00:00Z')
            )
        ).toBe(new Date('2026-09-16T04:00:00Z').getTime());
    });

    it('falls back to UTC for an invalid timezone', () => {
        const lastRun = seconds('2026-09-15T09:00:10Z');
        const schedule: ScheduleSettings = { frequency: 'daily', timezone: 'Mars/Base' };
        expect(SchedulerService.isDue(lastRun, schedule, new Date('2026-09-16T09:00:00Z'))).toBe(
            true
        );
        expect(SchedulerService.isDue(lastRun, schedule, new Date('2026-09-16T06:00:00Z'))).toBe(
            false
        );
    });
});

describe('SchedulerService validators', () => {
    it('validates timezones', () => {
        expect(SchedulerService.isValidTimezone('Europe/Istanbul')).toBe(true);
        expect(SchedulerService.isValidTimezone('UTC')).toBe(true);
        expect(SchedulerService.isValidTimezone('Mars/Base')).toBe(false);
        expect(SchedulerService.isValidTimezone('')).toBe(false);
    });

    it('validates active hours', () => {
        expect(SchedulerService.isValidActiveHours('07:00-23:00')).toBe(true);
        expect(SchedulerService.isValidActiveHours('22:30-02:00')).toBe(true);
        expect(SchedulerService.isValidActiveHours('7-23')).toBe(false);
        expect(SchedulerService.isValidActiveHours('24:00-02:00')).toBe(false);
    });
});

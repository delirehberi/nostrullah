import { describe, expect, it } from 'vitest';

import { getAccounts } from '../src/config';

function envWithRows(rows: any[]) {
    return {
        DB: {
            prepare: () => ({
                all: async () => ({ results: rows }),
            }),
        },
    } as any;
}

const baseRow = {
    id: 1,
    private_key: 'k',
    relays: '[]',
    categories: '[]',
    is_active: 1,
};

describe('getAccounts schedule settings', () => {
    it('uses the stored values after the migration', async () => {
        const [account] = await getAccounts(
            envWithRows([
                {
                    ...baseRow,
                    frequency: 'daily',
                    timezone: 'Europe/Berlin',
                    active_hours: null,
                    jitter_hours: 0,
                },
            ])
        );

        expect(account).toMatchObject({
            timezone: 'Europe/Berlin',
            active_hours: undefined,
            jitter_hours: 0,
        });
    });

    it('mirrors the migration rule when the columns are missing', async () => {
        const [preset, custom] = await getAccounts(
            envWithRows([
                { ...baseRow, id: 1, frequency: 'twice_a_day' },
                { ...baseRow, id: 2, frequency: '0 6,15 * * *' },
            ])
        );

        expect(preset).toMatchObject({
            timezone: 'Europe/Istanbul',
            active_hours: '07:00-23:00',
            jitter_hours: 1,
        });
        // Custom cron expressions were written against UTC: keep them unchanged
        expect(custom).toMatchObject({
            timezone: 'UTC',
            active_hours: undefined,
            jitter_hours: 0,
        });
    });
});

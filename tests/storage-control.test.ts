import { describe, expect, it } from 'vitest';
import { StorageService } from '../src/storage';

function createDbMock(firstResult?: any) {
    const statements: Array<{ sql: string; values: any[] }> = [];

    const db = {
        prepare(sql: string) {
            const statement = {
                sql,
                values: [] as any[],
            };
            statements.push(statement);

            return {
                bind(...values: any[]) {
                    statement.values = values;
                    return {
                        run: async () => ({ success: true }),
                        all: async () => ({ results: [] }),
                        first: async () => firstResult,
                    };
                },
                first: async () => firstResult,
            };
        },
    };

    return {
        db,
        statements,
    };
}

describe('StorageService control-plane helpers', () => {
    it('serializes account config updates into D1 columns', async () => {
        const { db, statements } = createDbMock();
        const storage = new StorageService({ DB: db } as any);

        await storage.updateAccountConfiguration(7, {
            name: 'Updated Bot',
            relays: ['wss://relay.one', 'wss://relay.two'],
            categories: ['tech', 'ai'],
            frequency: 'hourly',
            data_resources: [
                {
                    type: 'rss',
                    url: 'https://example.com/feed.xml',
                },
            ],
            prompt_template: 'New prompt',
            personality: 'humorous',
            is_active: false,
        });

        expect(statements[0].sql).toContain('UPDATE accounts SET');
        expect(statements[0].values).toEqual([
            'Updated Bot',
            '["wss://relay.one","wss://relay.two"]',
            '["tech","ai"]',
            'hourly',
            '[{"type":"rss","url":"https://example.com/feed.xml"}]',
            'New prompt',
            'humorous',
            0,
            7,
        ]);
    });

    it('stores published post event ids in history', async () => {
        const { db, statements } = createDbMock();
        const storage = new StorageService({ DB: db } as any);

        await storage.addPostToHistory(3, 'hello nostr', 'event-123');

        expect(statements[0].sql).toContain('INSERT INTO post_history');
        expect(statements[0].values).toEqual([3, 'hello nostr', 'event-123']);
    });

    it('records processed control events with audit metadata', async () => {
        const { db, statements } = createDbMock();
        const storage = new StorageService({ DB: db } as any);

        await storage.recordProcessedControlEvent({
            eventId: 'event-1',
            accountId: 9,
            authorPubkey: 'a'.repeat(64),
            rawContent: 'set prompt to calmer tone',
            parsedActionsJson: '[{"type":"set_prompt"}]',
            status: 'applied',
            resultMessage: 'Applied 1 change.',
            eventCreatedAt: 12345,
        });

        expect(statements[0].sql).toContain('INSERT INTO processed_control_events');
        expect(statements[0].values[0]).toBe('event-1');
        expect(statements[0].values[1]).toBe(9);
        expect(statements[0].values[5]).toBe('applied');
        expect(typeof statements[0].values[8]).toBe('number');
    });

    it('updates the control cursor and can resolve account ids from post event ids', async () => {
        const { db, statements } = createDbMock({ account_id: 12 });
        const storage = new StorageService({ DB: db } as any);

        await storage.updateControlLastCheckedAt(12, 999);
        const accountId = await storage.findAccountIdByPostEventId('event-5');

        expect(statements[0].values).toEqual([999, 12]);
        expect(accountId).toBe(12);
    });
});

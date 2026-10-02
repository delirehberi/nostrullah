import { describe, expect, it } from 'vitest';
import { StorageService } from '../src/storage';

const NOW = new Date('2026-10-02T12:00:00Z');
const NOW_SECONDS = Math.floor(NOW.getTime() / 1000);
const RETENTION_SECONDS = 90 * 24 * 60 * 60;

function createDbMock(options: { rows?: any[]; fail?: boolean } = {}) {
    const statements: Array<{ sql: string; values: any[] }> = [];

    const db = {
        prepare(sql: string) {
            const statement = { sql, values: [] as any[] };
            statements.push(statement);

            return {
                bind(...values: any[]) {
                    statement.values = values;
                    return {
                        run: async () => {
                            if (options.fail) throw new Error('no such table: shared_items');
                            return { success: true };
                        },
                        all: async () => {
                            if (options.fail) throw new Error('no such table: shared_items');
                            return { results: options.rows || [] };
                        },
                    };
                },
            };
        },
    };

    return { db, statements };
}

describe('StorageService shared items', () => {
    it('loads shared urls within the retention window', async () => {
        const { db, statements } = createDbMock({
            rows: [{ url: 'https://example.com/a/' }, { url: 'https://example.com/b/' }],
        });
        const storage = new StorageService({ DB: db } as any);

        const urls = await storage.getSharedUrls(3, NOW);

        expect(urls).toEqual(new Set(['https://example.com/a/', 'https://example.com/b/']));
        expect(statements[0].sql).toContain('FROM shared_items');
        expect(statements[0].values).toEqual([3, NOW_SECONDS - RETENTION_SECONDS]);
    });

    it('records a shared item and prunes expired ones', async () => {
        const { db, statements } = createDbMock();
        const storage = new StorageService({ DB: db } as any);

        await storage.recordSharedItem(3, 'https://example.com/a/', 'Article A', NOW);

        expect(statements[0].sql).toContain('INSERT OR IGNORE INTO shared_items');
        expect(statements[0].values).toEqual([
            3,
            'https://example.com/a/',
            'Article A',
            NOW_SECONDS,
        ]);
        expect(statements[1].sql).toContain('DELETE FROM shared_items');
        expect(statements[1].values).toEqual([3, NOW_SECONDS - RETENTION_SECONDS]);
    });

    it('does not throw when the shared_items table is unavailable', async () => {
        const { db } = createDbMock({ fail: true });
        const storage = new StorageService({ DB: db } as any);

        await expect(storage.getSharedUrls(3, NOW)).resolves.toEqual(new Set());
        await expect(
            storage.recordSharedItem(3, 'https://example.com/a/', undefined, NOW)
        ).resolves.toBeUndefined();
    });
});

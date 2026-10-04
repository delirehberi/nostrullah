import { beforeEach, describe, expect, it, vi } from 'vitest';

// A scheduled post must still publish and record history when migration 0005
// (shared_items, scheduling, formats, length, engagement) has not been applied.

const getAccounts = vi.fn();
const generateValidatedPost = vi.fn();
const fetchResources = vi.fn();
const publishEvent = vi.fn();
const queryEvents = vi.fn();

vi.mock('../src/config', () => ({ getAccounts }));

vi.mock('../src/control', () => ({
    ControlProcessor: class {
        async processAccounts(): Promise<void> {}
    },
}));

vi.mock('../src/post-generation', () => ({ generateValidatedPost }));

vi.mock('../src/resources', async () => {
    const actual = await vi.importActual<typeof import('../src/resources')>('../src/resources');
    return {
        ...actual,
        ResourceService: class {
            fetchResources = fetchResources;
        },
    };
});

vi.mock('../src/nostr', async () => {
    const actual = await vi.importActual<typeof import('../src/nostr')>('../src/nostr');
    return {
        ...actual,
        NostrService: {
            getPublicKeyFromPrivate: actual.NostrService.getPublicKeyFromPrivate,
            queryEvents,
            publishEvent,
            discoverRelays: vi.fn().mockResolvedValue([]),
        },
    };
});

const NEW_SCHEMA =
    /shared_items|format|engagement|max_post_length|jitter_hours|timezone|active_hours|post_formats|reactions/;

/** D1 stand-in with the pre-0005 schema: any statement touching new tables/columns fails. */
function createLegacyDb() {
    const executed: string[] = [];
    const failed: string[] = [];

    const db = {
        prepare(sql: string) {
            const execute = async <T>(result: T): Promise<T> => {
                if (NEW_SCHEMA.test(sql)) {
                    failed.push(sql);
                    throw new Error('D1_ERROR: no such column');
                }
                executed.push(sql);
                return result;
            };
            const statement = {
                run: () => execute({ success: true }),
                all: () => execute({ results: [] }),
                first: () => execute(null),
            };
            return { ...statement, bind: () => statement };
        },
    };

    return { db, executed, failed };
}

describe('scheduled run on a database without migration 0005', () => {
    beforeEach(() => {
        vi.resetModules();
        for (const mock of [
            getAccounts,
            generateValidatedPost,
            fetchResources,
            publishEvent,
            queryEvents,
        ]) {
            mock.mockReset();
        }
    });

    it('still publishes and records the post, skipping the new features', async () => {
        const account = {
            id: 1,
            name: 'Bot',
            privateKey: '1'.repeat(64),
            relays: ['wss://relay.example'],
            categories: ['bilim'],
            frequency: 'daily',
            data_resources: [{ type: 'rss', url: 'https://example.com/feed' }],
            prompt_template: undefined,
            personality: 'informative',
            is_active: true,
            control_enabled: false,
            control_admin_pubkeys: [],
            control_last_checked_at: 0,
            last_run_at: 0,
            // Defaults config.ts applies when the new columns are missing
            timezone: 'Europe/Istanbul',
            active_hours: undefined,
            jitter_hours: 0,
            engagement_checked_at: 0,
        };
        getAccounts.mockResolvedValue([account]);
        fetchResources.mockResolvedValue({
            context: 'Title: Haber',
            sourceUrl: 'https://example.com/haber',
            sourceTitle: 'Haber',
        });
        generateValidatedPost.mockResolvedValue({
            content: 'Yeni gönderi #bilim',
            attempts: [{ content: 'Yeni gönderi #bilim', invalidUrls: [] }],
        });
        publishEvent.mockResolvedValue({ eventId: 'evt-1', published: true, successCount: 1 });

        const { db, executed, failed } = createLegacyDb();
        const { runScheduled } = await import('../src/index');
        const pending: Promise<void>[] = [];
        await runScheduled(
            {} as any,
            { AI: { run: vi.fn() }, DB: db } as any,
            { waitUntil: (promise: Promise<void>) => pending.push(promise) } as any
        );
        await Promise.all(pending);

        // The post was generated and published
        expect(generateValidatedPost).toHaveBeenCalledTimes(1);
        expect(publishEvent).toHaveBeenCalledTimes(1);

        // History and last run were saved with the legacy statements
        expect(executed).toContain(
            'INSERT INTO post_history (account_id, content, event_id) VALUES (?, ?, ?)'
        );
        expect(executed.some((sql) => sql.includes('SET last_run_at'))).toBe(true);

        // New-schema statements were attempted and failed without breaking the run
        expect(failed.some((sql) => sql.includes('shared_items'))).toBe(true);
        expect(failed.some((sql) => sql.includes('format'))).toBe(true);

        // Engagement collection stopped before querying any relay
        expect(failed.some((sql) => sql.includes('engagement_checked_at'))).toBe(true);
        expect(queryEvents).not.toHaveBeenCalled();
    });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

const getAccounts = vi.fn();
const processAccounts = vi.fn();
const shouldRun = vi.fn();
const getPostHistory = vi.fn();
const updateLastRun = vi.fn();
const addPostToHistory = vi.fn();
const fetchResources = vi.fn();
const generateValidatedPost = vi.fn();
const publishEvent = vi.fn();

vi.mock('../src/config', () => ({
    getAccounts,
}));

vi.mock('../src/control', () => ({
    ControlProcessor: class {
        async processAccounts(accounts: unknown[]) {
            return processAccounts(accounts);
        }
    },
}));

vi.mock('../src/storage', () => ({
    StorageService: class {
        shouldRun = shouldRun;
        getPostHistory = getPostHistory;
        updateLastRun = updateLastRun;
        addPostToHistory = addPostToHistory;
    },
}));

vi.mock('../src/resources', () => ({
    ResourceService: class {
        fetchResources = fetchResources;
    },
}));

vi.mock('../src/post-generation', () => ({
    generateValidatedPost,
}));

vi.mock('../src/nostr', async () => {
    const actual = await vi.importActual<typeof import('../src/nostr')>('../src/nostr');
    return {
        ...actual,
        NostrService: {
            getPublicKeyFromPrivate: actual.NostrService.getPublicKeyFromPrivate,
            queryEvents: actual.NostrService.queryEvents,
            publishEvent,
        },
    };
});

describe('runScheduled control ordering', () => {
    beforeEach(() => {
        vi.resetModules();
        getAccounts.mockReset();
        processAccounts.mockReset();
        shouldRun.mockReset();
        getPostHistory.mockReset();
        updateLastRun.mockReset();
        addPostToHistory.mockReset();
        fetchResources.mockReset();
        generateValidatedPost.mockReset();
        publishEvent.mockReset();

        shouldRun.mockReturnValue(true);
        getPostHistory.mockResolvedValue([]);
        fetchResources.mockResolvedValue('updated rss context');
        publishEvent.mockResolvedValue({
            eventId: 'post-1',
            published: true,
            successCount: 1,
        });
    });

    it('processes inbound control before generation and can disable posting in the same run', async () => {
        const account = {
            id: 1,
            name: 'Bot',
            privateKey: '1'.repeat(64),
            relays: ['wss://relay.example'],
            categories: ['technology'],
            frequency: 'daily',
            data_resources: [],
            prompt_template: 'old prompt',
            personality: 'informative',
            is_active: true,
            control_enabled: true,
            control_admin_pubkeys: ['a'.repeat(64)],
            control_last_checked_at: 0,
            last_run_at: 0,
        };

        getAccounts
            .mockResolvedValueOnce([account])
            .mockResolvedValueOnce([]);
        processAccounts.mockImplementation(async (accounts: any[]) => {
            accounts[0].is_active = false;
        });

        const { runScheduled } = await import('../src/index');
        const pending: Promise<void>[] = [];
        const ctx = {
            waitUntil(promise: Promise<void>) {
                pending.push(promise);
            },
        };

        await runScheduled({} as any, {
            AI: { run: vi.fn() } as any,
            AI_MODEL: '@cf/openai/gpt-oss-120b',
            DB: {} as any,
            MAX_POST_LENGTH: '280',
        } as any, ctx as any);
        await Promise.all(pending);

        expect(processAccounts).toHaveBeenCalledTimes(1);
        expect(generateValidatedPost).not.toHaveBeenCalled();
        expect(publishEvent).not.toHaveBeenCalled();
    });

    it('uses updated prompt and resources from control changes in the same cron execution', async () => {
        const state = {
            id: 2,
            name: 'Bot',
            privateKey: '1'.repeat(64),
            relays: ['wss://relay.example'],
            categories: ['technology'],
            frequency: 'daily',
            data_resources: [] as any[],
            prompt_template: 'old prompt',
            personality: 'informative',
            is_active: true,
            control_enabled: true,
            control_admin_pubkeys: ['a'.repeat(64)],
            control_last_checked_at: 0,
            last_run_at: 0,
        };

        getAccounts.mockImplementation(async (_env: unknown, options?: { includeInactive?: boolean }) => {
            if (options?.includeInactive) {
                return [state];
            }

            return state.is_active ? [state] : [];
        });
        processAccounts.mockImplementation(async () => {
            state.prompt_template = 'updated prompt from control';
            state.data_resources = [
                {
                    type: 'rss',
                    url: 'https://example.com/feed.xml',
                },
            ];
        });
        generateValidatedPost.mockResolvedValue({
            content: 'fresh generated post',
            attempts: [{ content: 'fresh generated post', invalidUrls: [] }],
        });

        const { runScheduled } = await import('../src/index');
        const pending: Promise<void>[] = [];
        const ctx = {
            waitUntil(promise: Promise<void>) {
                pending.push(promise);
            },
        };

        await runScheduled({} as any, {
            AI: { run: vi.fn() } as any,
            AI_MODEL: '@cf/openai/gpt-oss-120b',
            DB: {} as any,
            MAX_POST_LENGTH: '280',
        } as any, ctx as any);
        await Promise.all(pending);

        expect(generateValidatedPost).toHaveBeenCalledWith(
            expect.objectContaining({
                promptTemplate: 'updated prompt from control',
                context: 'updated rss context',
            })
        );
        expect(updateLastRun).toHaveBeenCalledWith(2);
        expect(addPostToHistory).toHaveBeenCalledWith(2, 'fresh generated post', 'post-1');
    });
});

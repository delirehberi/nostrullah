import { beforeEach, describe, expect, it, vi } from 'vitest';

const getAccounts = vi.fn();
const processAccounts = vi.fn();
const shouldRun = vi.fn();
const getPostHistory = vi.fn();
const updateLastRun = vi.fn();
const addPostToHistory = vi.fn();
const fetchResources = vi.fn();
const getSharedUrls = vi.fn();
const recordSharedItem = vi.fn();
const getLastPostFormat = vi.fn();
const getTopPosts = vi.fn();
const getFormatPerformance = vi.fn();
const updateEngagementCheckedAt = vi.fn();
const getPostsForEngagement = vi.fn();
const saveEngagement = vi.fn();
const generateValidatedPost = vi.fn();
const publishEvent = vi.fn();
const saveRunLog = vi.fn();
const pruneDebugData = vi.fn();

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
        getSharedUrls = getSharedUrls;
        recordSharedItem = recordSharedItem;
        getLastPostFormat = getLastPostFormat;
        getTopPosts = getTopPosts;
        getFormatPerformance = getFormatPerformance;
        updateEngagementCheckedAt = updateEngagementCheckedAt;
        getPostsForEngagement = getPostsForEngagement;
        saveEngagement = saveEngagement;
        saveRunLog = saveRunLog;
        pruneDebugData = pruneDebugData;
        getNextRunTimestamp = () => Date.now() + 60 * 60 * 1000;
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
            discoverRelays: vi.fn().mockResolvedValue([]),
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
        getSharedUrls.mockReset();
        recordSharedItem.mockReset();
        getLastPostFormat.mockReset();
        for (const mock of [
            getTopPosts,
            getFormatPerformance,
            updateEngagementCheckedAt,
            getPostsForEngagement,
            saveEngagement,
            saveRunLog,
            pruneDebugData,
        ]) {
            mock.mockReset();
        }
        getTopPosts.mockResolvedValue([]);
        getFormatPerformance.mockResolvedValue([]);
        getPostsForEngagement.mockResolvedValue([]);
        generateValidatedPost.mockReset();
        publishEvent.mockReset();

        shouldRun.mockReturnValue(true);
        getPostHistory.mockResolvedValue([]);
        getSharedUrls.mockResolvedValue(new Set(['https://example.com/old/']));
        fetchResources.mockResolvedValue({
            context: 'updated rss context',
            sourceUrl: 'https://example.com/new/',
            sourceTitle: 'New Article',
        });
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

        getAccounts.mockResolvedValueOnce([account]).mockResolvedValueOnce([]);
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

        await runScheduled(
            {} as any,
            {
                AI: { run: vi.fn() } as any,
                AI_MODEL: '@cf/openai/gpt-oss-120b',
                DB: {} as any,
                MAX_POST_LENGTH: '280',
            } as any,
            ctx as any
        );
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

        getAccounts.mockImplementation(
            async (_env: unknown, options?: { includeInactive?: boolean }) => {
                if (options?.includeInactive) {
                    return [state];
                }

                return state.is_active ? [state] : [];
            }
        );
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
            content: 'fresh generated post #Bilim #YapayZeka',
            attempts: [{ content: 'fresh generated post #Bilim #YapayZeka', invalidUrls: [] }],
        });

        const { runScheduled } = await import('../src/index');
        const pending: Promise<void>[] = [];
        const ctx = {
            waitUntil(promise: Promise<void>) {
                pending.push(promise);
            },
        };

        await runScheduled(
            {} as any,
            {
                AI: { run: vi.fn() } as any,
                AI_MODEL: '@cf/openai/gpt-oss-120b',
                DB: {} as any,
                MAX_POST_LENGTH: '280',
            } as any,
            ctx as any
        );
        await Promise.all(pending);

        expect(generateValidatedPost).toHaveBeenCalledWith(
            expect.objectContaining({
                promptTemplate: 'updated prompt from control',
                context: 'updated rss context',
            })
        );
        expect(updateLastRun).toHaveBeenCalledWith(2);
        expect(publishEvent).toHaveBeenCalledWith(
            expect.anything(),
            'fresh generated post #Bilim #YapayZeka',
            {
                extraTags: [
                    ['t', 'bilim'],
                    ['t', 'yapayzeka'],
                ],
            }
        );
        expect(addPostToHistory).toHaveBeenCalledWith(
            2,
            'fresh generated post #Bilim #YapayZeka',
            'post-1',
            undefined
        );
        // Custom template without $$FORMAT$$: no format rotation
        expect(generateValidatedPost).toHaveBeenCalledWith(
            expect.objectContaining({ formatInstruction: undefined })
        );
        expect(getLastPostFormat).not.toHaveBeenCalled();
        expect(fetchResources).toHaveBeenCalledWith(state.data_resources, {
            excludeUrls: new Set(['https://example.com/old/']),
        });
        expect(recordSharedItem).toHaveBeenCalledWith(2, 'https://example.com/new/', 'New Article');
    });

    it('rotates post formats for accounts without a custom template and records the format', async () => {
        const account = {
            id: 3,
            name: 'Bot',
            privateKey: '1'.repeat(64),
            relays: ['wss://relay.example'],
            categories: ['technology'],
            frequency: 'daily',
            data_resources: [],
            prompt_template: undefined,
            personality: 'informative',
            post_formats: { question: 1, tip: 1 },
            is_active: true,
            control_enabled: false,
            control_admin_pubkeys: [],
            control_last_checked_at: 0,
            last_run_at: 0,
        };

        getAccounts.mockResolvedValue([account]);
        processAccounts.mockResolvedValue(undefined);
        getLastPostFormat.mockResolvedValue('question');
        generateValidatedPost.mockResolvedValue({
            content: 'İpucu: yedek alın.',
            attempts: [{ content: 'İpucu: yedek alın.', invalidUrls: [] }],
        });

        const { runScheduled } = await import('../src/index');
        const pending: Promise<void>[] = [];
        await runScheduled(
            {} as any,
            { AI: { run: vi.fn() } as any, DB: {} as any } as any,
            { waitUntil: (promise: Promise<void>) => pending.push(promise) } as any
        );
        await Promise.all(pending);

        expect(getLastPostFormat).toHaveBeenCalledWith(3);
        expect(generateValidatedPost).toHaveBeenCalledWith(
            expect.objectContaining({
                formatInstruction: expect.stringContaining('practical, actionable tip'),
            })
        );
        expect(addPostToHistory).toHaveBeenCalledWith(3, 'İpucu: yedek alın.', 'post-1', 'tip');
        expect(saveRunLog).toHaveBeenCalledWith(
            expect.objectContaining({
                accountId: 3,
                outcome: 'published',
                postFormat: 'tip',
                eventId: 'post-1',
                summary: 'Published tip without resource context',
            })
        );
        const trace = saveRunLog.mock.calls[0][0];
        expect(trace.details.format).toMatchObject({
            enabled: true,
            weightSource: 'custom',
            lastFormat: 'question',
            selected: 'tip',
        });
        expect(pruneDebugData).toHaveBeenCalledTimes(1);
        // Engagement collection was attempted for the account (throttle timestamp set)
        expect(updateEngagementCheckedAt).toHaveBeenCalledWith(3, expect.any(Number));
    });

    it('passes top-performing posts to generation and to the similarity check', async () => {
        const account = {
            id: 4,
            name: 'Bot',
            privateKey: '1'.repeat(64),
            relays: ['wss://relay.example'],
            categories: ['technology'],
            frequency: 'daily',
            data_resources: [],
            prompt_template: undefined,
            personality: 'informative',
            is_active: true,
            control_enabled: false,
            control_admin_pubkeys: [],
            control_last_checked_at: 0,
            last_run_at: 0,
            engagement_checked_at: Math.floor(Date.now() / 1000),
        };

        getAccounts.mockResolvedValue([account]);
        processAccounts.mockResolvedValue(undefined);
        getPostHistory.mockResolvedValue(['older post']);
        getTopPosts.mockResolvedValue(['viral post']);
        getFormatPerformance.mockResolvedValue([
            { format: 'tip', score: 10 },
            { format: 'tip', score: 10 },
            { format: 'tip', score: 10 },
            { format: 'question', score: 1 },
        ]);
        generateValidatedPost.mockResolvedValue({
            content: 'yeni gönderi',
            attempts: [{ content: 'yeni gönderi', invalidUrls: [] }],
        });

        const { runScheduled } = await import('../src/index');
        const pending: Promise<void>[] = [];
        await runScheduled(
            {} as any,
            { AI: { run: vi.fn() } as any, DB: {} as any } as any,
            { waitUntil: (promise: Promise<void>) => pending.push(promise) } as any
        );
        await Promise.all(pending);

        expect(getTopPosts).toHaveBeenCalledWith(4, expect.any(Number), 3);
        expect(generateValidatedPost).toHaveBeenCalledWith(
            expect.objectContaining({
                topPosts: ['viral post'],
                similarityHistory: ['older post', 'viral post'],
            })
        );
        expect(getFormatPerformance).toHaveBeenCalledWith(4, expect.any(Number));
        // Checked recently: no new engagement collection
        expect(updateEngagementCheckedAt).not.toHaveBeenCalled();
    });

    it('logs skipped runs with the next slot', async () => {
        const account = {
            id: 5,
            name: 'Bot',
            privateKey: '1'.repeat(64),
            relays: ['wss://relay.example'],
            categories: ['technology'],
            frequency: 'daily',
            data_resources: [],
            is_active: true,
            last_run_at: 0,
        };
        getAccounts.mockResolvedValue([account]);
        processAccounts.mockResolvedValue(undefined);
        shouldRun.mockReturnValue(false);

        const { runScheduled } = await import('../src/index');
        const pending: Promise<void>[] = [];
        await runScheduled(
            {} as any,
            { AI: { run: vi.fn() } as any, DB: {} as any } as any,
            { waitUntil: (promise: Promise<void>) => pending.push(promise) } as any
        );
        await Promise.all(pending);

        expect(generateValidatedPost).not.toHaveBeenCalled();
        expect(saveRunLog).toHaveBeenCalledTimes(1);
        const trace = saveRunLog.mock.calls[0][0];
        expect(trace.outcome).toBe('skipped');
        expect(trace.details.schedule).toMatchObject({ due: false, frequency: 'daily' });
        expect(trace.details.schedule.nextRunAt).toEqual(expect.any(Number));
    });

    it('logs the stage and message when a run fails', async () => {
        const account = {
            id: 6,
            name: 'Bot',
            privateKey: '1'.repeat(64),
            relays: ['wss://relay.example'],
            categories: ['technology'],
            frequency: 'daily',
            data_resources: [{ type: 'rss', url: 'https://example.com/feed.xml' }],
            prompt_template: 'custom',
            is_active: true,
            last_run_at: 0,
        };
        getAccounts.mockResolvedValue([account]);
        processAccounts.mockResolvedValue(undefined);
        fetchResources.mockResolvedValue({
            context: 'ctx',
            sourceUrl: 'https://example.com/new/',
            attempts: [
                { resource: 'rss(https://example.com/feed.xml)', status: 'used', durationMs: 5 },
            ],
        });
        generateValidatedPost.mockRejectedValue(new Error('All 3 generation attempts rejected'));

        const { runScheduled } = await import('../src/index');
        const pending: Promise<void>[] = [];
        await runScheduled(
            {} as any,
            { AI: { run: vi.fn() } as any, DB: {} as any } as any,
            { waitUntil: (promise: Promise<void>) => pending.push(promise) } as any
        );
        await Promise.all(pending);

        expect(publishEvent).not.toHaveBeenCalled();
        const trace = saveRunLog.mock.calls[0][0];
        expect(trace.outcome).toBe('error');
        expect(trace.details.error).toEqual({
            stage: 'generation',
            message: 'All 3 generation attempts rejected',
        });
        expect(trace.details.resources).toMatchObject({
            configured: 1,
            alreadyShared: 1,
            sourceUrl: 'https://example.com/new/',
        });
        expect(trace.details.format).toEqual({ enabled: false });
    });
});

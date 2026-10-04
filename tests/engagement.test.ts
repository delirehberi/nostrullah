import { Event } from 'nostr-tools';
import { describe, expect, it, vi } from 'vitest';

import { ContentGenerator } from '../src/ai';
import {
    EngagementService,
    adjustFormatWeights,
    computeEngagementScore,
    countEngagement,
    formatEngagementStats,
    formatTopPostsForPrompt,
    parseZapAmountSats,
    shouldCheckEngagement,
} from '../src/engagement';
import { NostrService } from '../src/nostr';
import { DEFAULT_POST_FORMAT_WEIGHTS } from '../src/post-formats';

const OWN_PRIVATE_KEY = '1'.repeat(64);
const OWN_PUBKEY = NostrService.getPublicKeyFromPrivate(OWN_PRIVATE_KEY);
const POST_A = 'a'.repeat(64);
const POST_B = 'b'.repeat(64);
// Lease written before collecting: makes the next check due 50 minutes later.
const RETRY_LEASE = 1_790_000_000 - 6 * 3600 + 50 * 60;

let nextId = 0;
function event(kind: number, tags: string[][], content = '', pubkey = 'f'.repeat(64)): Event {
    nextId++;
    return {
        id: nextId.toString(16).padStart(64, '0'),
        kind,
        tags,
        content,
        pubkey,
        created_at: 1_790_000_000,
        sig: '',
    } as Event;
}

function zapReceipt(target: string, millisats: number): Event {
    const zapRequest = { kind: 9734, tags: [['amount', String(millisats)]] };
    return event(9735, [
        ['e', target],
        ['description', JSON.stringify(zapRequest)],
    ]);
}

describe('countEngagement', () => {
    it('counts reactions, reposts, replies and zaps per post', () => {
        const counts = countEngagement(
            [
                event(7, [['e', POST_A]], '+'),
                event(7, [['e', POST_A]], '🔥'),
                event(6, [['e', POST_A]]),
                event(1, [['e', POST_B, '', 'root']], 'Katılıyorum'),
                zapReceipt(POST_B, 21_000),
            ],
            [POST_A, POST_B],
            OWN_PUBKEY
        );

        expect(counts.get(POST_A)).toEqual({
            reactions: 2,
            reposts: 1,
            replies: 0,
            zaps: 0,
            zapSats: 0,
        });
        expect(counts.get(POST_B)).toEqual({
            reactions: 0,
            reposts: 0,
            replies: 1,
            zaps: 1,
            zapSats: 21,
        });
    });

    it('ignores downvotes, own events, duplicates and unrelated events', () => {
        const duplicate = event(7, [['e', POST_A]], '+');
        const counts = countEngagement(
            [
                event(7, [['e', POST_A]], '-'),
                event(1, [['e', POST_A]], 'control reply', OWN_PUBKEY),
                duplicate,
                duplicate,
                event(7, [['e', 'c'.repeat(64)]], '+'),
            ],
            [POST_A],
            OWN_PUBKEY
        );

        expect(counts.get(POST_A)?.reactions).toBe(1);
        expect(counts.get(POST_A)?.replies).toBe(0);
    });

    it('attributes a reaction to the last referenced post', () => {
        const counts = countEngagement(
            [
                event(
                    7,
                    [
                        ['e', POST_A],
                        ['e', POST_B],
                    ],
                    '+'
                ),
            ],
            [POST_A, POST_B],
            OWN_PUBKEY
        );

        expect(counts.get(POST_A)?.reactions).toBe(0);
        expect(counts.get(POST_B)?.reactions).toBe(1);
    });
});

describe('parseZapAmountSats', () => {
    it('reads millisats from the zap request and handles bad input', () => {
        expect(parseZapAmountSats(zapReceipt(POST_A, 1_000_500))).toBe(1000);
        expect(parseZapAmountSats(event(9735, [['description', 'not json']]))).toBe(0);
        expect(parseZapAmountSats(event(9735, []))).toBe(0);
    });
});

describe('scoring and throttling', () => {
    it('weights reactions 1, reposts 2, replies 3, zaps 3', () => {
        expect(
            computeEngagementScore({ reactions: 4, reposts: 2, replies: 1, zaps: 1, zapSats: 500 })
        ).toBe(4 + 4 + 3 + 3);
    });

    it('checks at most every 6 hours', () => {
        const now = 1_790_000_000;
        expect(shouldCheckEngagement(undefined, now)).toBe(true);
        expect(shouldCheckEngagement(0, now)).toBe(true);
        expect(shouldCheckEngagement(now - 5 * 3600, now)).toBe(false);
        expect(shouldCheckEngagement(now - 6 * 3600, now)).toBe(true);
    });
});

describe('adjustFormatWeights', () => {
    it('scales formats with enough samples by relative performance, clamped to 0.5-2x', () => {
        const performance = [
            ...Array(3).fill({ format: 'tip', score: 12 }),
            ...Array(3).fill({ format: 'question', score: 1 }),
            { format: 'hot_take', score: 50 },
        ];

        const weights = adjustFormatWeights(performance);

        // Average of all 7 = 89/7 ≈ 12.7: tip ≈ 0.94x, question clamped to 0.5x
        expect(weights.tip).toBeCloseTo(DEFAULT_POST_FORMAT_WEIGHTS.tip * (12 / (89 / 7)), 2);
        expect(weights.question).toBe(DEFAULT_POST_FORMAT_WEIGHTS.question * 0.5);
        // Too few samples: unchanged
        expect(weights.hot_take).toBe(DEFAULT_POST_FORMAT_WEIGHTS.hot_take);
        expect(weights.news_commentary).toBe(DEFAULT_POST_FORMAT_WEIGHTS.news_commentary);
    });

    it('caps a strong format at 2x and keeps defaults without data', () => {
        const performance = [
            ...Array(3).fill({ format: 'short_list', score: 30 }),
            ...Array(6).fill({ format: 'tip', score: 1 }),
        ];
        expect(adjustFormatWeights(performance).short_list).toBe(
            DEFAULT_POST_FORMAT_WEIGHTS.short_list * 2
        );
        expect(adjustFormatWeights([])).toEqual(DEFAULT_POST_FORMAT_WEIGHTS);
        expect(adjustFormatWeights(Array(3).fill({ format: 'tip', score: 0 }))).toEqual(
            DEFAULT_POST_FORMAT_WEIGHTS
        );
    });
});

describe('EngagementService.refreshAccount', () => {
    function createStore(posts = [{ eventId: POST_A, createdAt: 1_789_900_000 }]) {
        return {
            updateEngagementCheckedAt: vi.fn().mockResolvedValue(undefined),
            getPostsForEngagement: vi.fn().mockResolvedValue(posts),
            saveEngagement: vi.fn().mockResolvedValue(undefined),
        };
    }
    const account = {
        id: 9,
        privateKey: OWN_PRIVATE_KEY,
        relays: ['wss://relay.example'],
        categories: [],
        frequency: 'daily',
    };
    const now = new Date(1_790_000_000 * 1000);

    it('queries relays once and stores counts and score per post', async () => {
        const store = createStore();
        const queryEvents = vi
            .fn()
            .mockResolvedValue([event(7, [['e', POST_A]], '+'), event(6, [['e', POST_A]])]);

        await new EngagementService(store, queryEvents).refreshAccount(account, now);

        // First a short retry lease (next check in 50 min), then the full interval
        expect(store.updateEngagementCheckedAt.mock.calls).toEqual([
            [9, RETRY_LEASE],
            [9, 1_790_000_000],
        ]);
        expect(store.getPostsForEngagement).toHaveBeenCalledWith(9, 1_790_000_000 - 7 * 86400, 50);
        expect(queryEvents).toHaveBeenCalledTimes(1);
        expect(queryEvents.mock.calls[0][0]).toEqual(
            expect.arrayContaining(['wss://relay.example', 'wss://relay.damus.io'])
        );
        expect(queryEvents.mock.calls[0][1]).toEqual({
            kinds: [1, 6, 7, 9735],
            '#e': [POST_A],
            since: 1_789_900_000,
            limit: 1000,
        });
        expect(store.saveEngagement).toHaveBeenCalledWith(
            9,
            POST_A,
            { reactions: 1, reposts: 1, replies: 0, zaps: 0, zapSats: 0 },
            3,
            1_790_000_000
        );
    });

    it('skips accounts checked within the last 6 hours', async () => {
        const store = createStore();
        const queryEvents = vi.fn();

        await new EngagementService(store, queryEvents).refreshAccount(
            { ...account, engagement_checked_at: 1_790_000_000 - 3600 },
            now
        );

        expect(store.updateEngagementCheckedAt).not.toHaveBeenCalled();
        expect(queryEvents).not.toHaveBeenCalled();
    });

    it('stops before querying relays when the check time cannot be stored', async () => {
        const store = createStore();
        store.updateEngagementCheckedAt.mockRejectedValue(new Error('no such column'));
        const queryEvents = vi.fn();

        await expect(
            new EngagementService(store, queryEvents).refreshAccount(account, now)
        ).rejects.toThrow('no such column');
        expect(queryEvents).not.toHaveBeenCalled();
    });

    it('does not query relays when there are no recent posts', async () => {
        const store = createStore([]);
        const queryEvents = vi.fn();

        await new EngagementService(store, queryEvents).refreshAccount(account, now);

        expect(store.updateEngagementCheckedAt).toHaveBeenLastCalledWith(9, 1_790_000_000);
        expect(queryEvents).not.toHaveBeenCalled();
    });

    it('retries on the next hourly run when the relay query fails', async () => {
        const store = createStore();
        const queryEvents = vi.fn().mockRejectedValue(new Error('relay timeout'));
        const service = new EngagementService(store, queryEvents);

        await expect(service.refreshAccount(account, now)).rejects.toThrow('relay timeout');

        // Only the short lease was written; nothing saved
        expect(store.updateEngagementCheckedAt.mock.calls).toEqual([[9, RETRY_LEASE]]);
        expect(store.saveEngagement).not.toHaveBeenCalled();

        // 45 minutes later: still within the lease; 60 minutes later (next run): retried
        const leased = { ...account, engagement_checked_at: RETRY_LEASE };
        await service.refreshAccount(leased, new Date((1_790_000_000 + 45 * 60) * 1000));
        expect(queryEvents).toHaveBeenCalledTimes(1);
        await expect(
            service.refreshAccount(leased, new Date((1_790_000_000 + 60 * 60) * 1000))
        ).rejects.toThrow('relay timeout');
        expect(queryEvents).toHaveBeenCalledTimes(2);
    });

    it('retries on the next run when saving the counts fails', async () => {
        const store = createStore();
        store.saveEngagement.mockRejectedValue(new Error('D1 unavailable'));
        const queryEvents = vi.fn().mockResolvedValue([event(7, [['e', POST_A]], '+')]);

        await expect(
            new EngagementService(store, queryEvents).refreshAccount(account, now)
        ).rejects.toThrow('D1 unavailable');
        expect(store.updateEngagementCheckedAt.mock.calls).toEqual([[9, RETRY_LEASE]]);
    });
});

describe('top posts in the prompt', () => {
    function createGenerator() {
        const run = vi.fn().mockResolvedValue({ response: 'post' });
        const generator = new ContentGenerator({ AI: { run } } as any);
        const userPrompt = (): string => run.mock.calls[0][1].messages[1].content;
        return { generator, userPrompt };
    }

    it('appends the top posts block when there is no placeholder', async () => {
        const { generator, userPrompt } = createGenerator();
        await generator.generatePost(['bilim'], [], '', undefined, undefined, {
            topPosts: ['En çok beğenilen gönderi'],
        });

        expect(userPrompt()).toContain('got the most engagement');
        expect(userPrompt()).toContain('1. En çok beğenilen gönderi');
    });

    it('fills the $$TOP_POSTS$$ placeholder and removes it when empty', async () => {
        const filled = createGenerator();
        await filled.generator.generatePost(['bilim'], [], '', 'Yaz.\n$$TOP_POSTS$$', undefined, {
            topPosts: ['popüler'],
        });
        expect(filled.userPrompt()).toContain('1. popüler');
        expect(filled.userPrompt()).not.toContain('$$TOP_POSTS$$');

        const empty = createGenerator();
        await empty.generator.generatePost(['bilim'], [], '', 'Yaz.\n$$TOP_POSTS$$');
        expect(empty.userPrompt()).not.toContain('$$TOP_POSTS$$');
        expect(empty.userPrompt()).not.toContain('most engagement');
    });

    it('truncates long posts in the block', () => {
        expect(formatTopPostsForPrompt(['x'.repeat(400)])).toContain(`${'x'.repeat(300)}…`);
        expect(formatTopPostsForPrompt([])).toBe('');
    });
});

describe('formatEngagementStats', () => {
    it('renders totals and the top post', () => {
        const text = formatEngagementStats({
            posts: 12,
            reactions: 30,
            reposts: 4,
            replies: 6,
            zaps: 2,
            zapSats: 2100,
            checkedAt: 1_790_000_000,
            topPost: { content: 'Harika bir gönderi', score: 14 },
        });

        expect(text).toContain('Engagement stats (last 7 days):');
        expect(text).toContain('Zaps: 2 (2100 sats)');
        expect(text).toContain('Top post (score 14): "Harika bir gönderi"');
    });

    it('says when stats were not collected yet', () => {
        expect(formatEngagementStats(undefined)).toContain('not collected yet');
    });
});

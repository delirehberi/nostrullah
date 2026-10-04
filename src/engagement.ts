import { Event } from 'nostr-tools';

import { NostrQueryFilter, NostrService } from './nostr';
import { DEFAULT_POST_FORMAT_WEIGHTS } from './post-formats';
import { NostrAccount, POST_FORMAT_VALUES, PostFormat, PostFormatWeights } from './types';

export const ENGAGEMENT_CHECK_INTERVAL_SECONDS = 6 * 60 * 60;
/** After a failed collection, retry on the next hourly cron run (not after 6 hours). */
export const ENGAGEMENT_RETRY_AFTER_SECONDS = 50 * 60;
export const ENGAGEMENT_LOOKBACK_SECONDS = 7 * 24 * 60 * 60;
export const ENGAGEMENT_MAX_POSTS = 50;
export const TOP_POSTS_LOOKBACK_SECONDS = 30 * 24 * 60 * 60;
export const TOP_POSTS_LIMIT = 3;
export const FORMAT_MIN_SAMPLES = 3;
export const TOP_POSTS_PLACEHOLDER = '$$TOP_POSTS$$';

const ENGAGEMENT_QUERY_LIMIT = 1000;
const FORMAT_FACTOR_MIN = 0.5;
const FORMAT_FACTOR_MAX = 2;
const TOP_POST_PROMPT_CHARS = 300;
const ENGAGEMENT_BOOTSTRAP_RELAYS = [
    'wss://relay.damus.io',
    'wss://nos.lol',
    'wss://relay.primal.net',
];

const KIND_REPLY = 1;
const KIND_REPOST = 6;
const KIND_REACTION = 7;
const KIND_ZAP_RECEIPT = 9735;

export interface EngagementCounts {
    reactions: number;
    reposts: number;
    replies: number;
    zaps: number;
    zapSats: number;
}

export interface EngagementPost {
    eventId: string;
    /** Unix seconds. */
    createdAt: number;
}

export interface FormatPerformance {
    format: string;
    score: number;
}

export interface EngagementStats {
    posts: number;
    reactions: number;
    reposts: number;
    replies: number;
    zaps: number;
    zapSats: number;
    topPost?: { content: string; score: number };
    /** Unix seconds of the last engagement check, if any. */
    checkedAt?: number;
}

/** Storage operations the engagement collector needs. */
export interface EngagementStore {
    updateEngagementCheckedAt(accountId: number, timestamp: number): Promise<void>;
    getPostsForEngagement(
        accountId: number,
        sinceTimestamp: number,
        limit: number
    ): Promise<EngagementPost[]>;
    saveEngagement(
        accountId: number,
        eventId: string,
        counts: EngagementCounts,
        score: number,
        timestamp: number
    ): Promise<void>;
}

export function emptyEngagementCounts(): EngagementCounts {
    return { reactions: 0, reposts: 0, replies: 0, zaps: 0, zapSats: 0 };
}

/**
 * Engagement score: reactions + 2×reposts + 3×replies + 3×zaps.
 */
export function computeEngagementScore(counts: EngagementCounts): number {
    return counts.reactions + 2 * counts.reposts + 3 * counts.replies + 3 * counts.zaps;
}

export function shouldCheckEngagement(lastCheckedAt: number | undefined, now: number): boolean {
    return !lastCheckedAt || now - lastCheckedAt >= ENGAGEMENT_CHECK_INTERVAL_SECONDS;
}

/**
 * Reads the zapped amount in sats from a zap receipt's embedded zap request
 * (`description` tag, `amount` tag in millisats). Returns 0 when unavailable.
 */
export function parseZapAmountSats(event: Event): number {
    const description = event.tags.find((tag) => tag[0] === 'description')?.[1];
    if (!description) {
        return 0;
    }

    try {
        const zapRequest = JSON.parse(description);
        const amountTag = (zapRequest?.tags || []).find(
            (tag: unknown) => Array.isArray(tag) && tag[0] === 'amount'
        );
        const millisats = Number(amountTag?.[1]);
        return Number.isFinite(millisats) && millisats > 0 ? Math.floor(millisats / 1000) : 0;
    } catch {
        return 0;
    }
}

/**
 * Counts reactions, reposts, replies and zaps per post. Events by the bot itself
 * and downvote reactions (`-`, NIP-25) are ignored. Reactions, reposts and zaps
 * count for the post they target (the last matching `e` tag); a reply counts for
 * every one of our posts it references.
 */
export function countEngagement(
    events: Event[],
    postIds: string[],
    ownPubkey: string
): Map<string, EngagementCounts> {
    const ids = new Set(postIds);
    const counts = new Map(postIds.map((id) => [id, emptyEngagementCounts()]));
    const seen = new Set<string>();

    for (const event of events) {
        if (seen.has(event.id) || event.pubkey === ownPubkey) {
            continue;
        }
        seen.add(event.id);

        const referenced = event.tags
            .filter((tag) => tag[0] === 'e' && ids.has(tag[1]))
            .map((tag) => tag[1]);
        if (referenced.length === 0) {
            continue;
        }
        const target = counts.get(referenced[referenced.length - 1]) as EngagementCounts;

        switch (event.kind) {
            case KIND_REACTION:
                if (event.content.trim() !== '-') {
                    target.reactions++;
                }
                break;
            case KIND_REPOST:
                target.reposts++;
                break;
            case KIND_ZAP_RECEIPT:
                target.zaps++;
                target.zapSats += parseZapAmountSats(event);
                break;
            case KIND_REPLY:
                for (const id of new Set(referenced)) {
                    (counts.get(id) as EngagementCounts).replies++;
                }
                break;
        }
    }

    return counts;
}

/**
 * Scales default format weights by how each format performed relative to the
 * account's average score. Formats with fewer than `FORMAT_MIN_SAMPLES` measured
 * posts keep their default weight; factors are clamped to 0.5–2×.
 */
export function adjustFormatWeights(
    performance: FormatPerformance[],
    baseWeights: Record<PostFormat, number> = DEFAULT_POST_FORMAT_WEIGHTS
): PostFormatWeights {
    const adjusted: PostFormatWeights = { ...baseWeights };
    if (performance.length === 0) {
        return adjusted;
    }

    const overallAverage =
        performance.reduce((sum, row) => sum + row.score, 0) / performance.length;
    if (overallAverage <= 0) {
        return adjusted;
    }

    for (const format of POST_FORMAT_VALUES) {
        const scores = performance.filter((row) => row.format === format).map((row) => row.score);
        if (scores.length < FORMAT_MIN_SAMPLES) {
            continue;
        }

        const average = scores.reduce((sum, score) => sum + score, 0) / scores.length;
        const factor = Math.min(
            Math.max(average / overallAverage, FORMAT_FACTOR_MIN),
            FORMAT_FACTOR_MAX
        );
        adjusted[format] = Math.round(baseWeights[format] * factor * 100) / 100;
    }

    return adjusted;
}

/**
 * Prompt block listing the account's best-performing recent posts.
 */
export function formatTopPostsForPrompt(topPosts: string[]): string {
    if (topPosts.length === 0) {
        return '';
    }

    const lines = topPosts.map((post, index) => {
        const trimmed =
            post.length > TOP_POST_PROMPT_CHARS ? `${post.slice(0, TOP_POST_PROMPT_CHARS)}…` : post;
        return `${index + 1}. ${trimmed}`;
    });

    return [
        'These recent posts of yours got the most engagement from your audience. ' +
            'Learn from their topic, tone and format, but do NOT copy or repeat them:',
        ...lines,
    ].join('\n');
}

/**
 * Human-readable engagement summary for the `show stats` control command.
 */
export function formatEngagementStats(stats?: EngagementStats): string {
    if (!stats || !stats.checkedAt) {
        return 'Engagement stats (last 7 days): not collected yet. They are refreshed every 6 hours.';
    }

    const lines = [
        `Posts: ${stats.posts}`,
        `Reactions: ${stats.reactions}`,
        `Reposts: ${stats.reposts}`,
        `Replies: ${stats.replies}`,
        `Zaps: ${stats.zaps} (${stats.zapSats} sats)`,
        `Last checked: ${new Date(stats.checkedAt * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC`,
    ];
    if (stats.topPost) {
        const preview = stats.topPost.content.slice(0, 80);
        lines.push(
            `Top post (score ${stats.topPost.score}): "${preview}${stats.topPost.content.length > 80 ? '…' : ''}"`
        );
    }

    return `Engagement stats (last 7 days):\n${lines.join('\n')}`;
}

/**
 * Collects reactions, reposts, replies and zaps for an account's recent posts and
 * stores per-post counts and scores. Runs at most every 6 hours per account.
 */
export class EngagementService {
    constructor(
        private storage: EngagementStore,
        private queryEvents: (
            relays: string[],
            filter: NostrQueryFilter
        ) => Promise<Event[]> = NostrService.queryEvents.bind(NostrService)
    ) {}

    async refreshAccount(account: NostrAccount, now: Date = new Date()): Promise<void> {
        const nowSeconds = Math.floor(now.getTime() / 1000);
        if (!account.id || !shouldCheckEngagement(account.engagement_checked_at, nowSeconds)) {
            return;
        }

        // Claim a short retry slot first: if anything below fails, the account is
        // retried on the next cron run instead of after the full 6-hour interval.
        // This write also fails fast (before any relay query) when the column is missing.
        await this.storage.updateEngagementCheckedAt(
            account.id,
            nowSeconds - ENGAGEMENT_CHECK_INTERVAL_SECONDS + ENGAGEMENT_RETRY_AFTER_SECONDS
        );

        const posts = await this.storage.getPostsForEngagement(
            account.id,
            nowSeconds - ENGAGEMENT_LOOKBACK_SECONDS,
            ENGAGEMENT_MAX_POSTS
        );
        if (posts.length === 0) {
            await this.storage.updateEngagementCheckedAt(account.id, nowSeconds);
            return;
        }

        const pubkey = NostrService.getPublicKeyFromPrivate(account.privateKey);
        const postIds = posts.map((post) => post.eventId);
        const events = await this.queryEvents(
            [...new Set([...account.relays, ...ENGAGEMENT_BOOTSTRAP_RELAYS])],
            {
                kinds: [KIND_REPLY, KIND_REPOST, KIND_REACTION, KIND_ZAP_RECEIPT],
                '#e': postIds,
                since: Math.min(...posts.map((post) => post.createdAt)),
                limit: ENGAGEMENT_QUERY_LIMIT,
            }
        );

        const counts = countEngagement(events, postIds, pubkey);
        for (const [eventId, postCounts] of counts) {
            await this.storage.saveEngagement(
                account.id,
                eventId,
                postCounts,
                computeEngagementScore(postCounts),
                nowSeconds
            );
        }

        // Only a fully successful collection starts the 6-hour interval.
        await this.storage.updateEngagementCheckedAt(account.id, nowSeconds);

        console.log(
            `Collected engagement for ${posts.length} posts of account ${account.id} ` +
                `(${events.length} events)`
        );
    }
}

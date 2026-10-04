import {
    NostrAccount,
    PostFormat,
    PostFormatWeights,
    ResourceAttempt,
    ResourceContext,
} from './types';
import type { GeneratedPostResult } from './post-generation';
import type { RelayPublishResult } from './nostr';

export type RunOutcome = 'skipped' | 'published' | 'queued' | 'failed' | 'error';

export type RunStage =
    'schedule' | 'history' | 'resources' | 'format' | 'generation' | 'publish' | 'record';

/** Longest text kept from the resource context (the full context can be 5000 chars). */
const CONTEXT_PREVIEW_LENGTH = 600;

export interface RunTraceDetails {
    schedule?: {
        frequency: string;
        timezone?: string;
        activeHours?: string;
        jitterHours?: number;
        lastRunAt: number;
        due: boolean;
        /** Unix ms of the next due slot, recorded for skipped runs. */
        nextRunAt?: number;
    };
    history?: {
        recentPosts: number;
        topPosts: string[];
    };
    resources?: {
        configured: number;
        alreadyShared: number;
        attempts: ResourceAttempt[];
        sourceUrl?: string;
        sourceTitle?: string;
        contextPreview?: string;
    };
    format?: {
        enabled: boolean;
        weightSource?: 'custom' | 'engagement';
        weights?: PostFormatWeights;
        lastFormat?: string;
        /** Link-based formats (news commentary) need a resource item with a link. */
        hasLinkContext?: boolean;
        selected?: PostFormat;
    };
    generation?: {
        maxLength?: number;
        attempts: Array<{
            content: string;
            length: number;
            tooLong: boolean;
            invalidUrls: string[];
            similarity?: { score: number; reason: string; previousPost: string };
            promptLeak?: string;
        }>;
        /** Index of the published draft in `attempts`. */
        selectedAttempt?: number;
        /** Every draft was rejected and the best safe one was used. */
        fallback: boolean;
    };
    publish?: {
        configuredRelays: string[];
        discoveredRelays: string[];
        hashtags: string[];
        eventId?: string;
        relays: RelayPublishResult[];
        queuedForRetry: boolean;
    };
    retry?: {
        at: number;
        published: boolean;
        relays: RelayPublishResult[];
    };
    error?: {
        stage: RunStage;
        message: string;
    };
}

export interface RunTraceRecord {
    id: string;
    accountId?: number;
    accountName?: string;
    startedAt: number;
    durationMs: number;
    outcome: RunOutcome;
    summary: string;
    postFormat?: PostFormat;
    eventId?: string;
    details: RunTraceDetails;
}

/**
 * Collects what happened during one scheduled account run (and why), so it can be
 * stored in `run_log` and inspected on the debug page.
 */
export class RunTrace {
    readonly id: string;
    readonly details: RunTraceDetails = {};
    stage: RunStage = 'schedule';
    private readonly startedAtMs: number;
    private outcome: RunOutcome = 'error';
    private summary = '';

    constructor(
        private readonly account: NostrAccount,
        now: number = Date.now(),
        id: string = crypto.randomUUID()
    ) {
        this.id = id;
        this.startedAtMs = now;
    }

    recordSchedule(due: boolean, nextRunAt?: number): void {
        this.details.schedule = {
            frequency: this.account.frequency,
            timezone: this.account.timezone,
            activeHours: this.account.active_hours,
            jitterHours: this.account.jitter_hours,
            lastRunAt: this.account.last_run_at || 0,
            due,
            nextRunAt,
        };
        if (!due) {
            const next = nextRunAt ? new Date(nextRunAt).toISOString() : 'unknown';
            this.finish('skipped', `Not due yet (next slot ${next})`);
        }
    }

    recordResources(configured: number, alreadyShared: number, source: ResourceContext): void {
        this.details.resources = {
            configured,
            alreadyShared,
            attempts: source.attempts || [],
            sourceUrl: source.sourceUrl,
            sourceTitle: source.sourceTitle,
            contextPreview: source.context
                ? source.context.slice(0, CONTEXT_PREVIEW_LENGTH)
                : undefined,
        };
    }

    recordGeneration(result: GeneratedPostResult, maxLength?: number): void {
        this.details.generation = {
            maxLength,
            attempts: result.attempts.map((attempt) => ({
                content: attempt.content,
                length: attempt.length,
                tooLong: attempt.tooLong,
                invalidUrls: attempt.invalidUrls,
                similarity: attempt.similarityMatch
                    ? {
                          score: attempt.similarityMatch.score,
                          reason: attempt.similarityMatch.reason,
                          previousPost: attempt.similarityMatch.previousPost,
                      }
                    : undefined,
                promptLeak: attempt.promptLeakage?.isLeaked
                    ? attempt.promptLeakage.reason || 'prompt leak detected'
                    : undefined,
            })),
            selectedAttempt: result.selectedAttempt,
            fallback: Boolean(result.fallback),
        };
    }

    finish(outcome: RunOutcome, summary: string): void {
        this.outcome = outcome;
        this.summary = summary;
    }

    fail(error: unknown): void {
        const message = error instanceof Error ? error.message : String(error);
        this.details.error = { stage: this.stage, message };
        this.finish('error', `Error during ${this.stage}: ${message}`);
    }

    toRecord(now: number = Date.now()): RunTraceRecord {
        return {
            id: this.id,
            accountId: this.account.id,
            accountName: this.account.name,
            startedAt: Math.floor(this.startedAtMs / 1000),
            durationMs: Math.max(0, now - this.startedAtMs),
            outcome: this.outcome,
            summary: this.summary,
            postFormat: this.details.format?.selected,
            eventId: this.details.publish?.eventId,
            details: this.details,
        };
    }
}

/**
 * Most common rejection reasons across the generation attempts of the given runs,
 * e.g. `{ similarity: 4, too_long: 1 }`. A published draft counts as no rejection.
 */
export function countRejectionReasons(traces: RunTraceDetails[]): Record<string, number> {
    const counts: Record<string, number> = {};
    const bump = (key: string): void => {
        counts[key] = (counts[key] || 0) + 1;
    };

    for (const trace of traces) {
        const generation = trace.generation;
        if (!generation) continue;

        generation.attempts.forEach((attempt, index) => {
            if (index === generation.selectedAttempt && !generation.fallback) return;
            if (attempt.similarity) bump('similarity');
            if (attempt.tooLong) bump('too_long');
            if (attempt.promptLeak) bump('prompt_leak');
            if (attempt.invalidUrls.length > 0) bump('invalid_urls');
        });
    }

    return counts;
}

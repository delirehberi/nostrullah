import { describe, expect, it } from 'vitest';

import { RunTrace, countRejectionReasons } from '../src/run-trace';

const account = {
    id: 7,
    name: 'Bilim Bot',
    privateKey: '1'.repeat(64),
    relays: ['wss://relay.example'],
    categories: ['science'],
    frequency: 'daily',
    timezone: 'Europe/Istanbul',
    active_hours: '07:00-23:00',
    jitter_hours: 1,
    last_run_at: 1_790_000_000,
};

const START = 1_790_003_600_000;

describe('RunTrace', () => {
    it('records a skipped run with its next slot', () => {
        const trace = new RunTrace(account, START, 'run-1');
        trace.recordSchedule(false, START + 3_600_000);

        const record = trace.toRecord(START + 25);
        expect(record).toMatchObject({
            id: 'run-1',
            accountId: 7,
            accountName: 'Bilim Bot',
            startedAt: START / 1000,
            durationMs: 25,
            outcome: 'skipped',
        });
        expect(record.summary).toContain('Not due yet');
        expect(record.details.schedule).toMatchObject({
            frequency: 'daily',
            timezone: 'Europe/Istanbul',
            due: false,
            nextRunAt: START + 3_600_000,
            lastRunAt: 1_790_000_000,
        });
    });

    it('records resources, generation attempts and the error stage', () => {
        const trace = new RunTrace(account, START, 'run-2');
        trace.recordSchedule(true);
        trace.recordResources(2, 5, {
            context: 'x'.repeat(1000),
            sourceUrl: 'https://example.com/a/',
            sourceTitle: 'A',
            attempts: [
                { resource: 'rss(https://example.com/feed)', status: 'used', durationMs: 12 },
            ],
        });
        trace.recordGeneration(
            {
                content: 'final',
                selectedAttempt: 1,
                fallback: false,
                attempts: [
                    {
                        content: 'first',
                        invalidUrls: [],
                        length: 900,
                        tooLong: true,
                        similarityMatch: { previousPost: 'old', reason: 'same topic', score: 0.9 },
                        promptLeakage: { isLeaked: false },
                    },
                    { content: 'final', invalidUrls: [], length: 100, tooLong: false },
                ],
            },
            500
        );
        trace.stage = 'publish';
        trace.fail(new Error('relay exploded'));

        const record = trace.toRecord(START + 10);
        expect(record.outcome).toBe('error');
        expect(record.summary).toBe('Error during publish: relay exploded');
        expect(record.details.error).toEqual({ stage: 'publish', message: 'relay exploded' });
        expect(record.details.resources?.contextPreview).toHaveLength(600);
        expect(record.details.resources?.alreadyShared).toBe(5);
        expect(record.details.generation).toEqual({
            maxLength: 500,
            selectedAttempt: 1,
            fallback: false,
            attempts: [
                {
                    content: 'first',
                    length: 900,
                    tooLong: true,
                    invalidUrls: [],
                    similarity: { score: 0.9, reason: 'same topic', previousPost: 'old' },
                    promptLeak: undefined,
                },
                {
                    content: 'final',
                    length: 100,
                    tooLong: false,
                    invalidUrls: [],
                    similarity: undefined,
                    promptLeak: undefined,
                },
            ],
        });
    });

    it('counts rejection reasons, ignoring the published draft', () => {
        const draft = (overrides: object) => ({
            content: 'x',
            length: 1,
            tooLong: false,
            invalidUrls: [] as string[],
            ...overrides,
        });
        const counts = countRejectionReasons([
            {
                generation: {
                    fallback: false,
                    selectedAttempt: 2,
                    attempts: [
                        draft({ similarity: { score: 1, reason: 'r', previousPost: 'p' } }),
                        draft({ tooLong: true, invalidUrls: ['https://bad.example'] }),
                        draft({}),
                    ],
                },
            },
            {
                // Fallback: the published draft was rejected too.
                generation: {
                    fallback: true,
                    selectedAttempt: 0,
                    attempts: [draft({ tooLong: true }), draft({ promptLeak: 'leak' })],
                },
            },
            {},
        ]);
        expect(counts).toEqual({ similarity: 1, too_long: 2, invalid_urls: 1, prompt_leak: 1 });
    });
});

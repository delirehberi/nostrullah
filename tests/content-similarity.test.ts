import { describe, expect, it, vi } from 'vitest';
import { ContentSimilarityService } from '../src/content-similarity';

describe('ContentSimilarityService', () => {
    it('rejects exact normalized matches without calling the LLM', async () => {
        const run = vi.fn();
        const service = new ContentSimilarityService({
            AI: { run } as any,
            AI_MODEL: '@cf/openai/gpt-oss-120b',
        } as any);

        const result = await service.checkSimilarity(
            'Bitcoin ETF approval is driving the market higher!',
            ['bitcoin etf approval is driving the market higher']
        );

        expect(result.isTooSimilar).toBe(true);
        expect(result.match?.reason).toContain('matches a previous post exactly');
        expect(run).not.toHaveBeenCalled();
    });

    it('uses the LLM to reject near-duplicate posts with the same angle', async () => {
        const run = vi.fn().mockResolvedValue({
            output: [
                {
                    content: [
                        {
                            type: 'output_text',
                            text: JSON.stringify({
                                too_similar: true,
                                matched_index: 1,
                                reason: 'Both posts make the same point about ETF-driven price momentum.',
                            }),
                        },
                    ],
                },
            ],
        });

        const service = new ContentSimilarityService({
            AI: { run } as any,
            AI_MODEL: '@cf/openai/gpt-oss-120b',
        } as any);

        const result = await service.checkSimilarity(
            'ETF demand is driving Bitcoin higher again while momentum stays strong.',
            ['ETF demand is driving Bitcoin higher again and momentum stays strong.']
        );

        expect(result.isTooSimilar).toBe(true);
        expect(result.match?.reason).toContain('same point about ETF-driven price momentum');
        expect(run).toHaveBeenCalledTimes(1);
        expect(run).toHaveBeenCalledWith(
            '@cf/openai/gpt-oss-120b',
            expect.objectContaining({
                input: expect.stringContaining('Previous posts to compare'),
            })
        );
    });

    it('handles plain { response } model output without throwing (BUG-05)', async () => {
        // The model may return { response: "..." } instead of { output: [...] }.
        // The old private extractOutputText only handled the output format, causing
        // the catch block to return isTooSimilar:false — silently bypassing the check.
        const run = vi.fn().mockResolvedValue({
            response: JSON.stringify({
                too_similar: true,
                matched_index: 1,
                reason: 'Same claim reworded.',
            }),
        });

        const service = new ContentSimilarityService({
            AI: { run } as any,
            AI_MODEL: '@cf/openai/gpt-oss-120b',
        } as any);

        const result = await service.checkSimilarity(
            'ETF approval is pushing crypto values upward.',
            ['ETF approval is pushing crypto values higher.']
        );

        expect(result.isTooSimilar).toBe(true);
        expect(result.match?.reason).toContain('Same claim reworded.');
        expect(run).toHaveBeenCalledTimes(1);
    });

    it('maps matched_index: 2 to the second candidate, not via null fallback (BUG-06)', async () => {
        const firstCandidate =
            'Bitcoin price momentum remains strong as ETF demand accelerates in major markets.';
        const secondCandidate =
            'Bitcoin price momentum remains strong as ETF demand accelerates across spot markets.';
        const run = vi.fn().mockResolvedValue({
            output: [
                {
                    content: [
                        {
                            type: 'output_text',
                            text: JSON.stringify({
                                too_similar: true,
                                matched_index: 2, // 1-based → maps to index 1
                                reason: 'Repeats the same ETF momentum claim.',
                            }),
                        },
                    ],
                },
            ],
        });

        const service = new ContentSimilarityService({
            AI: { run } as any,
            AI_MODEL: '@cf/openai/gpt-oss-120b',
        } as any);

        const result = await service.checkSimilarity(
            'Bitcoin price momentum remains strong as ETF demand accelerates in global markets.',
            [firstCandidate, secondCandidate]
        );

        expect(result.isTooSimilar).toBe(true);
        // matched_index: 2 (1-based) → candidate at index 1 → secondCandidate
        expect(result.match?.previousPost).toBe(secondCandidate);
        expect(result.match?.reason).toContain('Repeats the same ETF momentum claim.');
    });
});

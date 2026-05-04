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
});

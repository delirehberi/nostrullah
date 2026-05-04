import { describe, expect, it, vi } from 'vitest';
import { generateValidatedPost } from '../src/post-generation';
import { extractUrls, validatePostUrls } from '../src/url-validator';

describe('generateValidatedPost', () => {
    it('retries when the generated content contains invalid URLs', async () => {
        const generator = {
            generatePost: vi
                .fn()
                .mockResolvedValueOnce('Look at https://bad.example/test for details')
                .mockResolvedValueOnce('Look at https://good.example/test for details'),
        };

        const validateUrls = vi
            .fn()
            .mockResolvedValueOnce({
                valid: false,
                invalidUrls: ['https://bad.example/test'],
            })
            .mockResolvedValueOnce({
                valid: true,
                invalidUrls: [],
            });

        const result = await generateValidatedPost({
            generator,
            categories: ['technology'],
            previousPosts: ['older post'],
            validateUrls,
        });

        expect(result.content).toBe('Look at https://good.example/test for details');
        expect(result.attempts).toHaveLength(2);
        expect(generator.generatePost).toHaveBeenCalledTimes(2);
        expect(generator.generatePost).toHaveBeenNthCalledWith(
            2,
            ['technology'],
            ['older post', 'Look at https://bad.example/test for details'],
            '',
            undefined,
            undefined,
            expect.stringContaining('https://bad.example/test')
        );
    });

    it('fails after exhausting the retry budget', async () => {
        const generator = {
            generatePost: vi.fn().mockResolvedValue('https://bad.example/again'),
        };

        await expect(
            generateValidatedPost({
                generator,
                categories: ['technology'],
                maxAttempts: 2,
                validateUrls: vi.fn().mockResolvedValue({
                    valid: false,
                    invalidUrls: ['https://bad.example/again'],
                }),
            })
        ).rejects.toThrow('Failed to generate a unique post with valid URLs after 2 attempts');
    });

    it('retries when the generated content is too similar to post history', async () => {
        const generator = {
            generatePost: vi
                .fn()
                .mockResolvedValueOnce('Bitcoin yine 100 bin dolar seviyesine yaklasti.')
                .mockResolvedValueOnce('Bitcoin fiyatinda hizli hareket var, ancak odak bu kez ETF hacimleri.'),
        };

        const similarityChecker = {
            checkSimilarity: vi
                .fn()
                .mockResolvedValueOnce({
                    isTooSimilar: true,
                    match: {
                        previousPost: 'Bitcoin tekrar 100 bin dolar sinirina geldi.',
                        reason: 'Same market update and takeaway as a recent post.',
                        score: 0.91,
                    },
                })
                .mockResolvedValueOnce({
                    isTooSimilar: false,
                }),
        };

        const validateUrls = vi.fn().mockResolvedValue({
            valid: true,
            invalidUrls: [],
        });

        const result = await generateValidatedPost({
            generator,
            categories: ['technology'],
            previousPosts: ['older post'],
            similarityHistory: ['Bitcoin tekrar 100 bin dolar sinirina geldi.'],
            similarityChecker,
            validateUrls,
        });

        expect(result.content).toBe('Bitcoin fiyatinda hizli hareket var, ancak odak bu kez ETF hacimleri.');
        expect(result.attempts).toHaveLength(2);
        expect(result.attempts[0].similarityMatch?.reason).toContain('Same market update');
        expect(generator.generatePost).toHaveBeenCalledTimes(2);
        expect(generator.generatePost).toHaveBeenNthCalledWith(
            2,
            ['technology'],
            ['older post', 'Bitcoin yine 100 bin dolar seviyesine yaklasti.'],
            '',
            undefined,
            undefined,
            expect.stringContaining('Same market update and takeaway as a recent post.')
        );
        expect(similarityChecker.checkSimilarity).toHaveBeenNthCalledWith(
            1,
            'Bitcoin yine 100 bin dolar seviyesine yaklasti.',
            ['Bitcoin tekrar 100 bin dolar sinirina geldi.']
        );
        expect(similarityChecker.checkSimilarity).toHaveBeenNthCalledWith(
            2,
            'Bitcoin fiyatinda hizli hareket var, ancak odak bu kez ETF hacimleri.',
            [
                'Bitcoin tekrar 100 bin dolar sinirina geldi.',
                'Bitcoin yine 100 bin dolar seviyesine yaklasti.',
            ]
        );
    });
});

describe('extractUrls', () => {
    it('trims trailing punctuation from extracted URLs', () => {
        expect(extractUrls('Read https://example.com/path, then reply.')).toEqual([
            'https://example.com/path',
        ]);
    });
});

describe('validatePostUrls', () => {
    it('treats posts without URLs as valid without fetching', async () => {
        const fetchSpy = vi.spyOn(globalThis, 'fetch');

        const result = await validatePostUrls('No links here.');

        expect(result).toEqual({
            valid: true,
            invalidUrls: [],
        });
        expect(fetchSpy).not.toHaveBeenCalled();

        fetchSpy.mockRestore();
    });
});

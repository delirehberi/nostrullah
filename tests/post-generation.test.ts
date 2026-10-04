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
            expect.objectContaining({
                additionalGuidance: expect.stringContaining('https://bad.example/test'),
            })
        );
    });

    it('throws instead of publishing when every attempt has invalid URLs', async () => {
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
        ).rejects.toThrow('skipping publish');
        expect(generator.generatePost).toHaveBeenCalledTimes(2);
    });

    it('retries when the generated content is too similar to post history', async () => {
        const generator = {
            generatePost: vi
                .fn()
                .mockResolvedValueOnce('Bitcoin yine 100 bin dolar seviyesine yaklasti.')
                .mockResolvedValueOnce(
                    'Bitcoin fiyatinda hizli hareket var, ancak odak bu kez ETF hacimleri.'
                ),
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

        expect(result.content).toBe(
            'Bitcoin fiyatinda hizli hareket var, ancak odak bu kez ETF hacimleri.'
        );
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
            expect.objectContaining({
                additionalGuidance: expect.stringContaining(
                    'Same market update and takeaway as a recent post.'
                ),
            })
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

    it('treats a timed-out URL fetch as reachable (BUG-07)', async () => {
        // Both HEAD and GET timeout (return null) — the URL should be considered reachable
        // rather than causing the post to be discarded.
        vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network timeout'));

        const result = await validatePostUrls(
            'Check https://slow-cdn.example.com/article for details.'
        );

        expect(result.valid).toBe(true);
        expect(result.invalidUrls).toHaveLength(0);

        vi.restoreAllMocks();
    });
});

describe('generateValidatedPost — exhaustion fallback (BUG-01)', () => {
    it('returns the best available attempt instead of throwing when all retries fail', async () => {
        const generator = {
            generatePost: vi
                .fn()
                .mockResolvedValueOnce('First attempt with https://bad1.example.com/link')
                .mockResolvedValueOnce('Second attempt with https://bad2.example.com/link')
                .mockResolvedValueOnce('Third attempt, no links, slightly similar'),
        };

        const validateUrls = vi
            .fn()
            .mockResolvedValueOnce({ valid: false, invalidUrls: ['https://bad1.example.com/link'] })
            .mockResolvedValueOnce({ valid: false, invalidUrls: ['https://bad2.example.com/link'] })
            .mockResolvedValueOnce({ valid: true, invalidUrls: [] });

        const similarityChecker = {
            checkSimilarity: vi.fn().mockResolvedValue({
                isTooSimilar: true,
                match: {
                    previousPost: 'Older post, no links, somewhat similar',
                    reason: 'Same topic and angle.',
                    score: 0.75,
                },
            }),
        };

        const result = await generateValidatedPost({
            generator,
            categories: ['technology'],
            validateUrls,
            similarityChecker,
            maxAttempts: 3,
        });

        // Should not throw — should return the attempt with no invalid URLs
        // (attempt 3) even though similarity failed.
        expect(result.content).toBe('Third attempt, no links, slightly similar');
        expect(result.attempts).toHaveLength(3);
    });

    it('never publishes a leaked draft, even when every attempt leaked', async () => {
        const generator = { generatePost: vi.fn().mockResolvedValue('leaked prompt text') };

        await expect(
            generateValidatedPost({
                generator,
                categories: ['technology'],
                maxAttempts: 3,
                validateUrls: vi.fn().mockResolvedValue({ valid: true, invalidUrls: [] }),
                checkPromptLeakage: () => ({ isLeaked: true, reason: 'echoed template' }),
            })
        ).rejects.toThrow('skipping publish');
    });

    it('does not publish when attempts are only leaked or have invalid URLs', async () => {
        const generator = {
            generatePost: vi
                .fn()
                .mockResolvedValueOnce('leaked draft')
                .mockResolvedValueOnce('draft with https://bad.example/x')
                .mockResolvedValueOnce('leaked draft with https://bad.example/y'),
        };
        const validateUrls = vi
            .fn()
            .mockResolvedValueOnce({ valid: true, invalidUrls: [] })
            .mockResolvedValueOnce({ valid: false, invalidUrls: ['https://bad.example/x'] })
            .mockResolvedValueOnce({ valid: false, invalidUrls: ['https://bad.example/y'] });

        await expect(
            generateValidatedPost({
                generator,
                categories: ['technology'],
                maxAttempts: 3,
                validateUrls,
                checkPromptLeakage: (content: string) => ({
                    isLeaked: content.startsWith('leaked'),
                    reason: 'echoed template',
                }),
            })
        ).rejects.toThrow('skipping publish');
    });

    it('publishes the least similar draft when attempts are rejected only for similarity', async () => {
        const generator = {
            generatePost: vi
                .fn()
                .mockResolvedValueOnce('draft A')
                .mockResolvedValueOnce('draft B')
                .mockResolvedValueOnce('draft C'),
        };
        const scores: Record<string, number> = { 'draft A': 0.9, 'draft B': 0.6, 'draft C': 0.8 };
        const similarityChecker = {
            checkSimilarity: vi.fn(async (content: string) => ({
                isTooSimilar: true,
                match: { previousPost: 'old', reason: 'similar', score: scores[content] },
            })),
        };

        const result = await generateValidatedPost({
            generator,
            categories: ['technology'],
            maxAttempts: 3,
            validateUrls: vi.fn().mockResolvedValue({ valid: true, invalidUrls: [] }),
            similarityChecker,
            checkPromptLeakage: () => ({ isLeaked: false }),
        });

        expect(result.content).toBe('draft B');
    });
});

describe('detectPromptLeakage & generateValidatedPost prompt protection', () => {
    const samplePromptTemplate =
        'Lütfen ulaştığınız son haberleri analiz edin ve benzersiz bir açıya ya da derinlemesine bilgiye yer verin. ' +
        'Lütfen aşağıdaki son haberlerden birini seçin ve aşağıdaki açıklamaları gerçekleştirin: ' +
        '- Bir haberin üzerine yorum yapın\n- Bir kısa gerçeklik paylaşın\n- Bir kısaca fikir ya da deneyim paylaşın\n' +
        'Haberi özgün bir şekilde yorumlayıp anlatabilirsiniz.';

    it('retries when the draft echoes the prompt template instructions', async () => {
        const leakedContent =
            'Lütfen ulaştığınız son haberleri analiz edin ve benzersiz bir açıya ya da derinlemesine bilgiye yer verin. ' +
            'Sanat dünyasında yeni gelişmeler var.';
        const cleanContent =
            'Turner Ödülü bu yıl çağdaş sanatın sınırlarını zorlayan yenilikçi projelere odaklanıyor. #ModernSanat';

        const generator = {
            generatePost: vi
                .fn()
                .mockResolvedValueOnce(leakedContent)
                .mockResolvedValueOnce(cleanContent),
        };

        const validateUrls = vi.fn().mockResolvedValue({ valid: true, invalidUrls: [] });

        const result = await generateValidatedPost({
            generator,
            categories: ['art'],
            promptTemplate: samplePromptTemplate,
            validateUrls,
        });

        expect(result.content).toBe(cleanContent);
        expect(result.attempts).toHaveLength(2);
        expect(result.attempts[0].promptLeakage?.isLeaked).toBe(true);
        expect(result.attempts[1].promptLeakage?.isLeaked).toBe(false);
        expect(generator.generatePost).toHaveBeenNthCalledWith(
            2,
            ['art'],
            [leakedContent],
            '',
            samplePromptTemplate,
            undefined,
            expect.objectContaining({
                additionalGuidance: expect.stringContaining(
                    'CRITICAL: Your previous draft repeated or leaked the prompt template'
                ),
            })
        );
    });

    it('detects common meta-instruction preambles', async () => {
        const preamblePost = "Here's a post about technology: AI is transforming healthcare.";
        const cleanPost = 'AI is transforming healthcare through faster diagnostics.';

        const generator = {
            generatePost: vi
                .fn()
                .mockResolvedValueOnce(preamblePost)
                .mockResolvedValueOnce(cleanPost),
        };

        const validateUrls = vi.fn().mockResolvedValue({ valid: true, invalidUrls: [] });

        const result = await generateValidatedPost({
            generator,
            categories: ['technology'],
            validateUrls,
        });

        expect(result.content).toBe(cleanPost);
        expect(result.attempts).toHaveLength(2);
        expect(result.attempts[0].promptLeakage?.isLeaked).toBe(true);
    });
});

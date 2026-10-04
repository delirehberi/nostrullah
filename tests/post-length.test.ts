import { describe, expect, it, vi } from 'vitest';

import { ContentGenerator } from '../src/ai';
import { generateValidatedPost } from '../src/post-generation';
import { countPostLength, resolveMaxPostLength } from '../src/post-length';

const validUrls = vi.fn().mockResolvedValue({ valid: true, invalidUrls: [] });
const notLeaked = (): { isLeaked: boolean } => ({ isLeaked: false });

describe('countPostLength', () => {
    it('does not count links', () => {
        expect(countPostLength('Okuyun: https://example.com/a/very/long/article-path?x=1')).toBe(
            'Okuyun:'.length
        );
    });

    it('counts Turkish letters and emoji as one character each', () => {
        expect(countPostLength('Güneş 🌞')).toBe(7);
        expect(countPostLength('👩‍💻 İş')).toBe(4);
    });

    it('collapses whitespace left by removed links', () => {
        expect(countPostLength('a https://x.example b')).toBe(3);
    });
});

describe('resolveMaxPostLength', () => {
    it('prefers the account value, then the env var, then 500', () => {
        expect(resolveMaxPostLength(300, '800')).toBe(300);
        expect(resolveMaxPostLength(undefined, '800')).toBe(800);
        expect(resolveMaxPostLength(null, undefined)).toBe(500);
    });

    it('ignores out-of-range or invalid values', () => {
        expect(resolveMaxPostLength(50, '5000')).toBe(500);
        expect(resolveMaxPostLength(undefined, 'abc')).toBe(500);
    });
});

describe('ContentGenerator max length', () => {
    function createGenerator(env: Record<string, string> = {}) {
        const run = vi.fn().mockResolvedValue({ response: 'post' });
        const generator = new ContentGenerator({ AI: { run }, ...env } as any);
        const messages = (): Array<{ content: string }> => run.mock.calls[0][1].messages;
        return { generator, messages };
    }

    it('fills the personality prompt limit from the option', async () => {
        const { generator, messages } = createGenerator({ MAX_POST_LENGTH: '280' });
        await generator.generatePost(['bilim'], [], '', undefined, 'sarcastic', {
            maxLength: 700,
        });

        expect(messages()[0].content).toContain('under 700 characters (links are not counted)');
        expect(messages()[0].content).not.toContain('$$MAX_LENGTH$$');
    });

    it('falls back to MAX_POST_LENGTH and replaces the placeholder in custom templates', async () => {
        const { generator, messages } = createGenerator({ MAX_POST_LENGTH: '350' });
        await generator.generatePost(['bilim'], [], '', 'En fazla $$MAX_LENGTH$$ karakter yaz.');

        expect(messages()[0].content).toContain('under 350 characters');
        expect(messages()[1].content).toContain('En fazla 350 karakter yaz.');
    });
});

describe('generateValidatedPost length enforcement', () => {
    it('retries an over-length draft with shortening guidance', async () => {
        const generator = {
            generatePost: vi
                .fn()
                .mockResolvedValueOnce('x'.repeat(150))
                .mockResolvedValueOnce('kısa ve öz'),
        };

        const result = await generateValidatedPost({
            generator,
            categories: ['bilim'],
            maxLength: 100,
            validateUrls: validUrls,
            checkPromptLeakage: notLeaked,
        });

        expect(result.content).toBe('kısa ve öz');
        expect(result.attempts[0]).toMatchObject({ length: 150, tooLong: true });
        expect(generator.generatePost).toHaveBeenNthCalledWith(
            2,
            ['bilim'],
            ['x'.repeat(150)],
            '',
            undefined,
            undefined,
            expect.objectContaining({
                maxLength: 100,
                additionalGuidance: expect.stringContaining(
                    'Your previous draft was 150 characters'
                ),
            })
        );
    });

    it('publishes the shortest safe draft when every attempt is too long', async () => {
        const generator = {
            generatePost: vi
                .fn()
                .mockResolvedValueOnce('a'.repeat(180))
                .mockResolvedValueOnce('b'.repeat(120))
                .mockResolvedValueOnce('c'.repeat(150)),
        };

        const result = await generateValidatedPost({
            generator,
            categories: ['bilim'],
            maxLength: 100,
            validateUrls: validUrls,
            checkPromptLeakage: notLeaked,
        });

        expect(result.content).toBe('b'.repeat(120));
    });

    it('prefers a draft within the limit over a shorter-but-too-long one', async () => {
        const generator = {
            generatePost: vi
                .fn()
                .mockResolvedValueOnce('too similar but fits')
                .mockResolvedValueOnce('y'.repeat(120)),
        };
        const similarityChecker = {
            checkSimilarity: vi.fn(async (content: string) =>
                content === 'too similar but fits'
                    ? {
                          isTooSimilar: true,
                          match: { previousPost: 'old', reason: 'same', score: 0.9 },
                      }
                    : { isTooSimilar: false }
            ),
        };

        const result = await generateValidatedPost({
            generator,
            categories: ['bilim'],
            maxLength: 100,
            maxAttempts: 2,
            validateUrls: validUrls,
            similarityChecker,
            checkPromptLeakage: notLeaked,
        });

        expect(result.content).toBe('too similar but fits');
    });

    it('still never publishes leaked drafts, even when they fit', async () => {
        const generator = { generatePost: vi.fn().mockResolvedValue('leak') };

        await expect(
            generateValidatedPost({
                generator,
                categories: ['bilim'],
                maxLength: 100,
                maxAttempts: 2,
                validateUrls: validUrls,
                checkPromptLeakage: () => ({ isLeaked: true, reason: 'echo' }),
            })
        ).rejects.toThrow('skipping publish');
    });

    it('does not check length when no limit is given', async () => {
        const generator = { generatePost: vi.fn().mockResolvedValue('z'.repeat(5000)) };

        const result = await generateValidatedPost({
            generator,
            categories: ['bilim'],
            validateUrls: validUrls,
            checkPromptLeakage: notLeaked,
        });

        expect(result.attempts).toHaveLength(1);
    });
});

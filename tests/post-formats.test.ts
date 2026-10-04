import { describe, expect, it, vi } from 'vitest';

import { ContentGenerator } from '../src/ai';
import {
    DEFAULT_POST_FORMAT_WEIGHTS,
    POST_FORMAT_INSTRUCTIONS,
    formatPostFormats,
    isFormatRotationEnabled,
    selectPostFormat,
} from '../src/post-formats';

describe('selectPostFormat', () => {
    it('never picks news_commentary without link context', () => {
        for (let i = 0; i < 50; i++) {
            expect(selectPostFormat(undefined, { hasLinkContext: false })).not.toBe(
                'news_commentary'
            );
        }
    });

    it('can pick news_commentary with link context', () => {
        expect(selectPostFormat(undefined, { hasLinkContext: true, random: () => 0 })).toBe(
            'news_commentary'
        );
    });

    it('avoids repeating the previous format when another is eligible', () => {
        for (let i = 0; i < 50; i++) {
            expect(
                selectPostFormat(
                    { question: 5, tip: 1 },
                    { hasLinkContext: false, lastFormat: 'question' }
                )
            ).toBe('tip');
        }
    });

    it('repeats the only enabled format', () => {
        expect(selectPostFormat({ tip: 1 }, { hasLinkContext: false, lastFormat: 'tip' })).toBe(
            'tip'
        );
    });

    it('follows the weights', () => {
        const weights = { question: 3, tip: 1 };
        expect(selectPostFormat(weights, { hasLinkContext: false, random: () => 0.7 })).toBe(
            'question'
        );
        expect(selectPostFormat(weights, { hasLinkContext: false, random: () => 0.8 })).toBe('tip');
    });

    it('returns undefined when rotation is off or nothing is eligible', () => {
        expect(selectPostFormat({}, { hasLinkContext: true })).toBeUndefined();
        expect(selectPostFormat({ news_commentary: 1 }, { hasLinkContext: false })).toBeUndefined();
    });
});

describe('isFormatRotationEnabled', () => {
    it('applies to accounts without a template or with the $$FORMAT$$ placeholder', () => {
        expect(isFormatRotationEnabled(undefined)).toBe(true);
        expect(isFormatRotationEnabled('')).toBe(true);
        expect(isFormatRotationEnabled('Yaz. $$FORMAT$$')).toBe(true);
        expect(isFormatRotationEnabled('Bir haberi yorumla.')).toBe(false);
    });
});

describe('formatPostFormats', () => {
    it('describes defaults, custom weights, off and custom templates', () => {
        expect(formatPostFormats(undefined)).toContain('(default)');
        expect(formatPostFormats({ tip: 2 })).toBe('tip 2');
        expect(formatPostFormats({})).toBe('off');
        expect(formatPostFormats(undefined, 'Custom prompt')).toContain('add $$FORMAT$$');
    });

    it('uses the agreed default weights', () => {
        expect(DEFAULT_POST_FORMAT_WEIGHTS).toEqual({
            news_commentary: 3,
            question: 2,
            tip: 2,
            hot_take: 1,
            short_list: 1,
        });
    });
});

describe('ContentGenerator format instructions', () => {
    function createGenerator() {
        const run = vi.fn().mockResolvedValue({ response: 'post' });
        const generator = new ContentGenerator({ AI: { run } } as any);
        const userPrompt = (): string => run.mock.calls[0][1].messages[1].content;
        return { generator, userPrompt };
    }

    it('appends the format instruction when the template has no placeholder', async () => {
        const { generator, userPrompt } = createGenerator();
        await generator.generatePost(['bilim'], [], '', undefined, undefined, {
            formatInstruction: POST_FORMAT_INSTRUCTIONS.tip,
        });

        expect(userPrompt()).toContain(
            `Post format for this post: ${POST_FORMAT_INSTRUCTIONS.tip}`
        );
    });

    it('replaces the $$FORMAT$$ placeholder', async () => {
        const { generator, userPrompt } = createGenerator();
        await generator.generatePost(
            ['bilim'],
            [],
            '',
            'Bilim hakkında yaz.\n$$FORMAT$$\nTürkçe yaz.',
            undefined,
            { formatInstruction: POST_FORMAT_INSTRUCTIONS.question }
        );

        expect(userPrompt()).toContain(`Post format: ${POST_FORMAT_INSTRUCTIONS.question}`);
        expect(userPrompt()).not.toContain('$$FORMAT$$');
        expect(userPrompt()).not.toContain('Post format for this post');
    });

    it('removes the placeholder when no format is chosen', async () => {
        const { generator, userPrompt } = createGenerator();
        await generator.generatePost(['bilim'], [], '', 'Yaz. $$FORMAT$$');

        expect(userPrompt()).not.toContain('$$FORMAT$$');
        expect(userPrompt()).not.toContain('Post format');
    });
});

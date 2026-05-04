import { describe, expect, it, vi } from 'vitest';
import { ContentGenerator } from '../src/ai';
import { StorageService } from '../src/storage';

describe('StorageService.shouldRun', () => {
    it('accepts legacy millisecond last_run_at values', () => {
        const storage = new StorageService({ DB: {} as D1Database } as any);
        const nowMs = Date.now();
        const lastRunMs = nowMs - 3 * 60 * 60 * 1000;

        expect(storage.shouldRun(lastRunMs, 'every_2_hours')).toBe(true);
    });

    it('still accepts current second-based last_run_at values', () => {
        const storage = new StorageService({ DB: {} as D1Database } as any);
        const nowSeconds = Math.floor(Date.now() / 1000);
        const lastRunSeconds = nowSeconds - 3 * 60 * 60;

        expect(storage.shouldRun(lastRunSeconds, 'every_2_hours')).toBe(true);
    });
});

describe('ContentGenerator.generatePost', () => {
    it('falls back to informative instructions for unknown personalities', async () => {
        const run = vi.fn().mockResolvedValue({
            output: [
                {
                    content: [
                        {
                            type: 'output_text',
                            text: 'test post',
                        },
                    ],
                },
            ],
        });

        const generator = new ContentGenerator({
            AI: { run } as any,
            AI_MODEL: '@cf/openai/gpt-oss-120b',
            MAX_POST_LENGTH: '280',
        } as any);

        const content = await generator.generatePost(
            ['technology'],
            [],
            '',
            undefined,
            'chaotic' as any
        );

        expect(content).toBe('test post');
        expect(run).toHaveBeenCalledTimes(1);
        expect(run).toHaveBeenCalledWith(
            '@cf/openai/gpt-oss-120b',
            expect.objectContaining({
                instructions: expect.stringContaining('informative assistant'),
            })
        );
    });
});

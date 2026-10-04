import { Ai } from '@cloudflare/workers-types';
import { DEFAULT_AI_MODEL, Env, Personality } from './types';
import { withRetry } from './utils';
import { personalityTemplates } from '../prompts';
import { FORMAT_PLACEHOLDER } from './post-formats';
import { MAX_LENGTH_PLACEHOLDER, resolveMaxPostLength } from './post-length';
import { TOP_POSTS_PLACEHOLDER, formatTopPostsForPrompt } from './engagement';

export function extractOutputText(response: any): string {
    let text: string;
    // Standard Cloudflare AI text generation response
    if (response && typeof response.response === 'string') {
        text = response.response;
    } else if (response?.output) {
        const result = response.output.filter(
            (c: any) =>
                Array.isArray(c.content) && c.content.some((a: any) => a.type === 'output_text')
        );

        if (result.length === 0) {
            throw new Error('No valid output found');
        }

        const textContent = result[0].content.find((a: any) => a.type === 'output_text');
        if (!textContent?.text) {
            throw new Error('output_text item has no text field');
        }

        text = textContent.text;
    } else {
        throw new Error(`Unexpected AI response format: ${JSON.stringify(response)}`);
    }

    text = text.trim();
    // Strip code block fences if accidentally returned
    if (text.startsWith('```') && text.endsWith('```')) {
        text = text
            .replace(/^```[a-z]*\s*/i, '')
            .replace(/```$/, '')
            .trim();
    }

    return text;
}

export interface GeneratePostOptions {
    /** Retry guidance from previously rejected drafts. */
    additionalGuidance?: string;
    /** Post format instruction (see `src/post-formats.ts`). */
    formatInstruction?: string;
    /** Character limit (links excluded); defaults to MAX_POST_LENGTH or 500. */
    maxLength?: number;
    /** Best-performing recent posts, shown as examples of what resonated. */
    topPosts?: string[];
}

export class ContentGenerator {
    private ai: Ai;
    private model: string;
    private maxLength: number;

    constructor(env: Env) {
        this.ai = env.AI;
        this.model = env.AI_MODEL || DEFAULT_AI_MODEL;
        this.maxLength = resolveMaxPostLength(undefined, env.MAX_POST_LENGTH);
    }

    async generatePost(
        categories: string[],
        previousPosts: string[] = [],
        context: string = '',
        promptTemplate?: string,
        personality?: Personality,
        options: GeneratePostOptions = {}
    ): Promise<any> {
        const { additionalGuidance, formatInstruction } = options;
        const maxLength = String(options.maxLength ?? this.maxLength);
        // Fall back cleanly if the DB contains an unknown personality value.
        const normalizedPersonality: Personality =
            personality && Object.prototype.hasOwnProperty.call(personalityTemplates, personality)
                ? personality
                : 'informative';
        const instructions = personalityTemplates[normalizedPersonality].replaceAll(
            MAX_LENGTH_PLACEHOLDER,
            maxLength
        );

        // 2. Construct the user/input prompt
        let inputPrompt = '';
        if (promptTemplate) {
            inputPrompt = promptTemplate;
        } else {
            const categoryString = categories.join(', ');
            inputPrompt = `Generate a short, engaging social media post about ${categoryString}.`;
        }

        // 3. Replace placeholders in the input prompt
        if (inputPrompt.includes('$$RESOURCES$$')) {
            inputPrompt = inputPrompt.replace('$$RESOURCES$$', context);
        } else if (context) {
            inputPrompt += `\n\nContext/News:\n${context}`;
        }

        // The placeholder is always removed; the instruction goes there when present,
        // otherwise it is appended.
        if (inputPrompt.includes(FORMAT_PLACEHOLDER)) {
            inputPrompt = inputPrompt.replace(
                FORMAT_PLACEHOLDER,
                formatInstruction ? `Post format: ${formatInstruction}` : ''
            );
        } else if (formatInstruction) {
            inputPrompt += `\n\nPost format for this post: ${formatInstruction}`;
        }

        const topPostsBlock = formatTopPostsForPrompt(options.topPosts || []);
        if (inputPrompt.includes(TOP_POSTS_PLACEHOLDER)) {
            inputPrompt = inputPrompt.replace(TOP_POSTS_PLACEHOLDER, topPostsBlock);
        } else if (topPostsBlock) {
            inputPrompt += `\n\n${topPostsBlock}`;
        }

        if (inputPrompt.includes('$$CATEGORIES$$')) {
            const categoriesString = categories.join(', ');
            inputPrompt = inputPrompt.replace('$$CATEGORIES$$', categoriesString);
        }

        if (inputPrompt.includes('$$POST_HISTORY$$')) {
            const historyStr = previousPosts.map((p, i) => `${i + 1}. ${p}`).join('\n');
            inputPrompt = inputPrompt.replace('$$POST_HISTORY$$', `\n\n${historyStr}`);
        } else if (previousPosts.length > 0) {
            inputPrompt += `\n\nHere are the last ${previousPosts.length} posts I created. Do NOT generate content similar to these:\n`;
            previousPosts.forEach((post, index) => {
                inputPrompt += `${index + 1}. ${post}\n`;
            });
        }

        if (additionalGuidance) {
            inputPrompt += `\n\nAdditional requirements:\n${additionalGuidance}`;
        }

        inputPrompt = inputPrompt.replaceAll(MAX_LENGTH_PLACEHOLDER, maxLength);

        const systemPrompt = [
            instructions,
            '',
            'CRITICAL ENFORCEMENT:',
            '- Output ONLY the raw post content to publish.',
            '- NEVER echo, repeat, summarize, quote, or paraphrase the prompt instructions, templates, or task requirements.',
            '- Do NOT include introductory phrases, quotation marks around the post, or meta explanations.',
        ].join('\n');

        // 4. Run the AI model
        try {
            const response: any = await withRetry(() =>
                this.ai.run(this.model as any, {
                    messages: [
                        { role: 'system', content: systemPrompt },
                        { role: 'user', content: inputPrompt },
                    ],
                })
            );

            return extractOutputText(response);
        } catch (error) {
            console.error('AI generation failed:', error);
            throw error;
        }
    }
}

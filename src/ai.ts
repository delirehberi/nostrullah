import { Ai } from '@cloudflare/workers-types';
import { Env, Personality } from './types';
import { withRetry } from './utils';
import { personalityTemplates } from '../prompts';

export function extractOutputText(response: any): string {
    if (!response?.output) {
        throw new Error(`Unexpected AI response format: ${JSON.stringify(response)}`);
    }

    const result = response.output.filter((c: any) =>
        Array.isArray(c.content) && c.content.some((a: any) => a.type === 'output_text')
    );

    if (result.length === 0) {
        throw new Error('No valid output found');
    }

    const textContent = result[0].content.find((a: any) => a.type === 'output_text');
    if (!textContent?.text) {
        throw new Error('output_text item has no text field');
    }

    return textContent.text;
}

export class ContentGenerator {
    private ai: Ai;
    private model: string;
    private maxLength: number;

    constructor(env: Env) {
        this.ai = env.AI;
        this.model = env.AI_MODEL || '@cf/openai/gpt-oss-120b';
        this.maxLength = parseInt(env.MAX_POST_LENGTH || '280');
    }

    async generatePost(
        categories: string[],
        previousPosts: string[] = [],
        context: string = '',
        promptTemplate?: string,
        personality?: Personality,
        additionalGuidance?: string
    ): Promise<any> {
        // Fall back cleanly if the DB contains an unknown personality value.
        const normalizedPersonality: Personality =
            personality && Object.prototype.hasOwnProperty.call(personalityTemplates, personality)
                ? personality
                : 'informative';
        const instructions = personalityTemplates[normalizedPersonality];

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

        // 4. Run the AI model
        try {
            const response: any = await withRetry(() =>
                this.ai.run(this.model as any, {
                    instructions: instructions,
                    input: inputPrompt,
                })
            );

            return extractOutputText(response);
        } catch (error) {
            console.error('AI generation failed:', error);
            throw error;
        }
    }
}

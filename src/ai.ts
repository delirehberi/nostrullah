import { Ai } from '@cloudflare/workers-types';
import { Env } from './types';
import { withRetry } from './utils';

export class ContentGenerator {
    private ai: Ai;
    private model: string;
    private maxLength: number;

    constructor(env: Env) {
        this.ai = env.AI;
        this.model = env.AI_MODEL || '@cf/openai/gpt-oss-120b';
        this.maxLength = parseInt(env.MAX_POST_LENGTH || '280');
    }

    async generatePost(categories: string[]): Promise<string> {
        const categoryString = categories.join(', ');
        const prompt = `Generate a short, engaging social media post about ${categoryString} in turkish language. 
    The post should be under ${this.maxLength} characters. 
    Use hashtags. 
    Do not include any introductory text like "Here is a post". 
    Just output the post content directly.
    Post should be informative or educational. 
    Post should be engaging and interesting.
    Post should be in turkish language.
    `;

        try {
            const response: any = await withRetry(() => this.ai.run(this.model as any, {
                messages: [
                    { role: 'system', content: 'You are a helpful social media assistant.' },
                    { role: 'user', content: prompt }
                ]
            }));

            let content = response.response || '';
            if (content.length > this.maxLength) {
                content = content.substring(0, this.maxLength - 3) + '...';
            }
            return content.trim();
        } catch (error) {
            console.error('AI generation failed:', error);
            throw error;
        }
    }
}

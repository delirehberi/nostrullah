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

    async generatePost(categories: string[], previousPosts: string[] = []): Promise<any> {
        const categoryString = categories.join(', ');
        let prompt = `Generate a short, engaging social media post about ${categoryString} in turkish language. 
    The post should be under ${this.maxLength} characters. 
    Use hashtags. 
    Do not include any introductory text like "Here is a post". 
    Just output the post content directly.
    Post should be informative or educational. 
    Post should be engaging and interesting.
    Post should be in turkish language.
    `;

        if (previousPosts.length > 0) {
            prompt += `\n\nHere are the last ${previousPosts.length} posts I created. Do NOT generate content similar to these:\n`;
            previousPosts.forEach((post, index) => {
                prompt += `${index + 1}. ${post}\n`;
            });
        }
        let filter_function = function (content: any) {
            return content.filter((c: any) => {
                return c.type == 'output_text'
            });
        }
        try {
            const response: any = await withRetry(() => this.ai.run(this.model as any, {
                instructions: 'You are a helpful social media content generator and your main output language is turkish.',
                input: prompt
            }));
            //response.output[].type=='output_text'.content.text
            //is string 
            const result = response.output.filter((c: any) => {
                return c.content.filter((a: any) => {
                    return a.type == 'output_text'
                }).length > 0;
            });
            if (result.length === 0) {
                throw new Error('No valid output found');
            }
            return result[0].content[0].text;

        } catch (error) {
            console.error('AI generation failed:', error);
            throw error;
        }
    }
}

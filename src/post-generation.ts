import { Personality } from './types';
import { PostSimilarityChecker, SimilarityMatch } from './content-similarity';
import { validatePostUrls } from './url-validator';

const DEFAULT_MAX_GENERATION_ATTEMPTS = 3;

export interface PostGenerator {
    generatePost(
        categories: string[],
        previousPosts?: string[],
        context?: string,
        promptTemplate?: string,
        personality?: Personality,
        additionalGuidance?: string
    ): Promise<string>;
}

export interface GeneratedPostAttempt {
    content: string;
    invalidUrls: string[];
    similarityMatch?: SimilarityMatch;
}

export interface GeneratedPostResult {
    attempts: GeneratedPostAttempt[];
    content: string;
}

export interface GenerateValidatedPostOptions {
    generator: PostGenerator;
    categories: string[];
    previousPosts?: string[];
    context?: string;
    promptTemplate?: string;
    personality?: Personality;
    maxAttempts?: number;
    validateUrls?: (content: string) => Promise<{ valid: boolean; invalidUrls: string[] }>;
    similarityHistory?: string[];
    similarityChecker?: PostSimilarityChecker;
}

export async function generateValidatedPost(options: GenerateValidatedPostOptions): Promise<GeneratedPostResult> {
    const attempts: GeneratedPostAttempt[] = [];
    const rejectedPosts: string[] = [];
    const maxAttempts = options.maxAttempts || DEFAULT_MAX_GENERATION_ATTEMPTS;
    const validateUrls = options.validateUrls || validatePostUrls;

    for (let attemptNumber = 1; attemptNumber <= maxAttempts; attemptNumber++) {
        const guidance = buildRetryGuidance(attempts);
        const content = await options.generator.generatePost(
            options.categories,
            [...(options.previousPosts || []), ...rejectedPosts],
            options.context || '',
            options.promptTemplate,
            options.personality,
            guidance
        );
        const validation = await validateUrls(content);
        const similarityResult = options.similarityChecker
            ? await options.similarityChecker.checkSimilarity(
                content,
                [...(options.similarityHistory || []), ...rejectedPosts]
            )
            : { isTooSimilar: false };

        attempts.push({
            content,
            invalidUrls: validation.invalidUrls,
            similarityMatch: similarityResult.match,
        });

        if (validation.valid && !similarityResult.isTooSimilar) {
            return {
                attempts,
                content,
            };
        }

        rejectedPosts.push(content);

        if (!validation.valid) {
            console.warn(
                `Generated post rejected due to invalid URLs on attempt ${attemptNumber}: ${validation.invalidUrls.join(', ')}`
            );
        }

        if (similarityResult.isTooSimilar) {
            console.warn(
                `Generated post rejected for similarity on attempt ${attemptNumber}: ${similarityResult.match?.reason || 'unknown reason'}`
            );
        }
    }

    throw new Error(`Failed to generate a unique post with valid URLs after ${maxAttempts} attempts`);
}

function buildRetryGuidance(attempts: GeneratedPostAttempt[]): string | undefined {
    const failedAttempts = attempts.filter((attempt) => attempt.invalidUrls.length > 0);
    const similarAttempts = attempts.filter((attempt) => attempt.similarityMatch);

    if (failedAttempts.length === 0 && similarAttempts.length === 0) {
        return undefined;
    }

    const guidance: string[] = [];

    if (failedAttempts.length > 0) {
        const invalidUrls = failedAttempts.flatMap((attempt) => attempt.invalidUrls);

        guidance.push(
            'Your previous draft included invalid or unreachable URLs.',
            'Generate a new post and do not reuse these URLs:',
            ...invalidUrls.map((url) => `- ${url}`),
            'Only include a URL if it is explicitly supported by the provided context.'
        );
    }

    if (similarAttempts.length > 0) {
        guidance.push(
            'Your previous draft was too similar to an already published post.',
            'Generate a materially different angle, wording, and takeaway than these historical matches:'
        );

        for (const attempt of similarAttempts) {
            if (!attempt.similarityMatch) {
                continue;
            }

            guidance.push(`- ${attempt.similarityMatch.reason}`);
            guidance.push(`- Historical post: ${attempt.similarityMatch.previousPost}`);
        }
    }

    return guidance.join('\n');
}

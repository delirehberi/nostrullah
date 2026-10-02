import { Personality } from './types';
import { PostSimilarityChecker, SimilarityMatch } from './content-similarity';
import { validatePostUrls } from './url-validator';
import { detectPromptLeakage, PromptLeakageCheckResult } from './prompt-leakage';

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
    promptLeakage?: PromptLeakageCheckResult;
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
    checkPromptLeakage?: (content: string, promptTemplate?: string) => PromptLeakageCheckResult;
}

export async function generateValidatedPost(
    options: GenerateValidatedPostOptions
): Promise<GeneratedPostResult> {
    const attempts: GeneratedPostAttempt[] = [];
    const rejectedPosts: string[] = [];
    const maxAttempts = options.maxAttempts || DEFAULT_MAX_GENERATION_ATTEMPTS;
    const validateUrls = options.validateUrls || validatePostUrls;
    const checkLeakage = options.checkPromptLeakage || detectPromptLeakage;

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
            ? await options.similarityChecker.checkSimilarity(content, [
                  ...(options.similarityHistory || []),
                  ...rejectedPosts,
              ])
            : { isTooSimilar: false };
        const leakageResult = checkLeakage(content, options.promptTemplate);

        attempts.push({
            content,
            invalidUrls: validation.invalidUrls,
            similarityMatch: similarityResult.match,
            promptLeakage: leakageResult,
        });

        if (validation.valid && !similarityResult.isTooSimilar && !leakageResult.isLeaked) {
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

        if (leakageResult.isLeaked) {
            console.warn(
                `Generated post rejected for prompt leakage on attempt ${attemptNumber}: ${leakageResult.reason || 'prompt leak detected'}`
            );
        }
    }

    // All attempts failed validation. Rather than throwing (which silently drops the post),
    // publish the best available candidate: prefer non-leaked, then no invalid URLs, then lowest similarity score.
    const bestAttempt =
        attempts
            .filter((a) => !a.promptLeakage?.isLeaked && a.invalidUrls.length === 0)
            .sort((a, b) => (a.similarityMatch?.score ?? 0) - (b.similarityMatch?.score ?? 0))[0] ??
        attempts
            .filter((a) => !a.promptLeakage?.isLeaked)
            .sort((a, b) => (a.similarityMatch?.score ?? 0) - (b.similarityMatch?.score ?? 0))[0] ??
        attempts
            .filter((a) => a.invalidUrls.length === 0)
            .sort((a, b) => (a.similarityMatch?.score ?? 0) - (b.similarityMatch?.score ?? 0))[0] ??
        attempts[attempts.length - 1];

    console.warn(
        `All ${maxAttempts} generation attempts were rejected. ` +
            `Publishing best available candidate ` +
            `(isLeaked=${bestAttempt.promptLeakage?.isLeaked ?? false}, ` +
            `invalidUrls=${bestAttempt.invalidUrls.length}, ` +
            `similarityScore=${bestAttempt.similarityMatch?.score ?? 'n/a'}).`
    );

    return {
        attempts,
        content: bestAttempt.content,
    };
}

function buildRetryGuidance(attempts: GeneratedPostAttempt[]): string | undefined {
    const failedUrls = attempts.filter((attempt) => attempt.invalidUrls.length > 0);
    const similarAttempts = attempts.filter((attempt) => attempt.similarityMatch);
    const leakedAttempts = attempts.filter((attempt) => attempt.promptLeakage?.isLeaked);

    if (failedUrls.length === 0 && similarAttempts.length === 0 && leakedAttempts.length === 0) {
        return undefined;
    }

    const guidance: string[] = [];

    if (leakedAttempts.length > 0) {
        guidance.push(
            'CRITICAL: Your previous draft repeated or leaked the prompt template instructions or meta-commentary.',
            'Output ONLY the final, ready-to-publish social media post.',
            'NEVER quote, echo, or repeat the instructions or task descriptions.'
        );
    }

    if (failedUrls.length > 0) {
        const invalidUrls = failedUrls.flatMap((attempt) => attempt.invalidUrls);

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

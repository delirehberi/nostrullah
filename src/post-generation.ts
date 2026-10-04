import { Personality } from './types';
import { PostSimilarityChecker, SimilarityMatch } from './content-similarity';
import { validatePostUrls } from './url-validator';
import { detectPromptLeakage, PromptLeakageCheckResult } from './prompt-leakage';
import { countPostLength } from './post-length';
import type { GeneratePostOptions } from './ai';

const DEFAULT_MAX_GENERATION_ATTEMPTS = 3;

export interface PostGenerator {
    generatePost(
        categories: string[],
        previousPosts?: string[],
        context?: string,
        promptTemplate?: string,
        personality?: Personality,
        options?: GeneratePostOptions
    ): Promise<string>;
}

export interface GeneratedPostAttempt {
    content: string;
    invalidUrls: string[];
    similarityMatch?: SimilarityMatch;
    promptLeakage?: PromptLeakageCheckResult;
    /** Character count excluding links. */
    length: number;
    /** Over `maxLength`; a soft failure that can still be published as a fallback. */
    tooLong: boolean;
}

export interface GeneratedPostResult {
    attempts: GeneratedPostAttempt[];
    content: string;
    /** Index in `attempts` of the draft returned as `content`. */
    selectedAttempt?: number;
    /** Every draft was rejected; `content` is the best safe fallback. */
    fallback?: boolean;
}

export interface GenerateValidatedPostOptions {
    generator: PostGenerator;
    categories: string[];
    previousPosts?: string[];
    context?: string;
    promptTemplate?: string;
    personality?: Personality;
    /** Post format instruction, kept the same across retries. */
    formatInstruction?: string;
    /** Character limit (links excluded). Unset = no length check. */
    maxLength?: number;
    /** Best-performing recent posts passed to the prompt. */
    topPosts?: string[];
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
        const guidance = buildRetryGuidance(attempts, options.maxLength);
        const content = await options.generator.generatePost(
            options.categories,
            [...(options.previousPosts || []), ...rejectedPosts],
            options.context || '',
            options.promptTemplate,
            options.personality,
            {
                additionalGuidance: guidance,
                formatInstruction: options.formatInstruction,
                maxLength: options.maxLength,
                topPosts: options.topPosts,
            }
        );
        const validation = await validateUrls(content);
        const similarityResult = options.similarityChecker
            ? await options.similarityChecker.checkSimilarity(content, [
                  ...(options.similarityHistory || []),
                  ...rejectedPosts,
              ])
            : { isTooSimilar: false };
        const leakageResult = checkLeakage(content, options.promptTemplate);
        const length = countPostLength(content);
        const tooLong = options.maxLength !== undefined && length > options.maxLength;

        attempts.push({
            content,
            invalidUrls: validation.invalidUrls,
            similarityMatch: similarityResult.match,
            promptLeakage: leakageResult,
            length,
            tooLong,
        });

        if (
            validation.valid &&
            !similarityResult.isTooSimilar &&
            !leakageResult.isLeaked &&
            !tooLong
        ) {
            return {
                attempts,
                content,
                selectedAttempt: attempts.length - 1,
                fallback: false,
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

        if (tooLong) {
            console.warn(
                `Generated post rejected for length on attempt ${attemptNumber}: ${length} > ${options.maxLength} characters`
            );
        }

        if (leakageResult.isLeaked) {
            console.warn(
                `Generated post rejected for prompt leakage on attempt ${attemptNumber}: ${leakageResult.reason || 'prompt leak detected'}`
            );
        }
    }

    // All attempts were rejected. A draft rejected only for similarity or length is still
    // safe to publish: prefer drafts within the length limit (least similar first), then
    // the shortest over-length draft. Drafts that leaked the prompt or contain invalid
    // URLs are never published: skip this run instead (it is retried on the next cron
    // tick because last_run_at is not updated).
    const bestAttempt = attempts
        .filter((a) => !a.promptLeakage?.isLeaked && a.invalidUrls.length === 0)
        .sort(compareFallbackCandidates)[0];

    if (!bestAttempt) {
        throw new Error(
            `All ${maxAttempts} generation attempts were rejected for prompt leakage or invalid URLs; ` +
                'skipping publish'
        );
    }

    console.warn(
        `All ${maxAttempts} generation attempts were rejected. ` +
            `Publishing the best safe candidate ` +
            `(similarityScore=${bestAttempt.similarityMatch?.score ?? 'n/a'}, ` +
            `length=${bestAttempt.length}${bestAttempt.tooLong ? ' over limit' : ''}).`
    );

    return {
        attempts,
        content: bestAttempt.content,
        selectedAttempt: attempts.indexOf(bestAttempt),
        fallback: true,
    };
}

function compareFallbackCandidates(a: GeneratedPostAttempt, b: GeneratedPostAttempt): number {
    if (a.tooLong !== b.tooLong) {
        return a.tooLong ? 1 : -1;
    }
    if (a.tooLong) {
        return a.length - b.length;
    }
    return (a.similarityMatch?.score ?? 0) - (b.similarityMatch?.score ?? 0);
}

function buildRetryGuidance(
    attempts: GeneratedPostAttempt[],
    maxLength?: number
): string | undefined {
    const failedUrls = attempts.filter((attempt) => attempt.invalidUrls.length > 0);
    const similarAttempts = attempts.filter((attempt) => attempt.similarityMatch);
    const leakedAttempts = attempts.filter((attempt) => attempt.promptLeakage?.isLeaked);
    const longAttempts = attempts.filter((attempt) => attempt.tooLong);

    if (
        failedUrls.length === 0 &&
        similarAttempts.length === 0 &&
        leakedAttempts.length === 0 &&
        longAttempts.length === 0
    ) {
        return undefined;
    }

    const guidance: string[] = [];

    if (longAttempts.length > 0) {
        const lastLength = longAttempts[longAttempts.length - 1].length;
        guidance.push(
            `Your previous draft was ${lastLength} characters (links excluded), which is too long.`,
            `Rewrite it to be under ${maxLength} characters (links excluded) while keeping the key point.`
        );
    }

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

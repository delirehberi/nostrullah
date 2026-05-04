import { Ai } from '@cloudflare/workers-types';
import { Env } from './types';
import { withRetry } from './utils';

const DIRECT_REJECTION_THRESHOLD = 0.96;
const LLM_REVIEW_THRESHOLD = 0.55;
const MAX_LLM_CANDIDATES = 3;
const MIN_TOKENS_FOR_COMPARISON = 2;
const MIN_CONTAINMENT_LENGTH = 40;
const COMMON_TOKENS = new Set([
    'and',
    'are',
    'bir',
    'bu',
    'but',
    'for',
    'gibi',
    'how',
    'için',
    'icin',
    'ile',
    'ilgili',
    'in',
    'into',
    'the',
    'that',
    'this',
    'very',
    've',
    'with',
]);

export interface SimilarityMatch {
    previousPost: string;
    reason: string;
    score: number;
}

export interface SimilarityCheckResult {
    isTooSimilar: boolean;
    match?: SimilarityMatch;
}

interface SimilarityCandidate {
    previousPost: string;
    score: number;
    exactMatch: boolean;
    containmentMatch: boolean;
    sharedTerms: string[];
}

interface SimilarityReviewResponse {
    too_similar: boolean;
    matched_index: number | null;
    reason: string;
}

export interface PostSimilarityChecker {
    checkSimilarity(content: string, previousPosts: string[]): Promise<SimilarityCheckResult>;
}

export class ContentSimilarityService implements PostSimilarityChecker {
    private ai: Ai;
    private model: string;

    constructor(env: Env) {
        this.ai = env.AI;
        this.model = env.AI_MODEL || '@cf/openai/gpt-oss-120b';
    }

    async checkSimilarity(content: string, previousPosts: string[]): Promise<SimilarityCheckResult> {
        const normalizedContent = normalizeText(content);
        if (!normalizedContent) {
            return {
                isTooSimilar: false,
            };
        }

        const candidates = previousPosts
            .map((previousPost) => buildCandidate(content, previousPost))
            .filter((candidate) => candidate.score >= LLM_REVIEW_THRESHOLD)
            .sort((left, right) => right.score - left.score);

        const directMatch = candidates.find((candidate) =>
            candidate.exactMatch
            || (candidate.containmentMatch && normalizedContent.length >= MIN_CONTAINMENT_LENGTH)
            || candidate.score >= DIRECT_REJECTION_THRESHOLD
        );

        if (directMatch) {
            return {
                isTooSimilar: true,
                match: {
                    previousPost: directMatch.previousPost,
                    reason: buildDirectReason(directMatch),
                    score: directMatch.score,
                },
            };
        }

        const llmCandidates = candidates.slice(0, MAX_LLM_CANDIDATES);
        if (llmCandidates.length === 0) {
            return {
                isTooSimilar: false,
            };
        }

        try {
            const review = await this.reviewWithLlm(content, llmCandidates);
            if (!review.too_similar) {
                return {
                    isTooSimilar: false,
                };
            }

            const matchedIndex = review.matched_index && review.matched_index > 0
                ? review.matched_index - 1
                : 0;
            const candidate = llmCandidates[matchedIndex] || llmCandidates[0];
            return {
                isTooSimilar: true,
                match: {
                    previousPost: candidate.previousPost,
                    reason: review.reason || 'LLM similarity review flagged this as too close to a past post.',
                    score: candidate.score,
                },
            };
        } catch (error) {
            console.warn('LLM similarity review failed, falling back to heuristic result:', error);

            const fallbackCandidate = llmCandidates[0];
            if (fallbackCandidate.score >= 0.8) {
                return {
                    isTooSimilar: true,
                    match: {
                        previousPost: fallbackCandidate.previousPost,
                        reason: 'High-overlap heuristic flagged this as too close to a past post.',
                        score: fallbackCandidate.score,
                    },
                };
            }

            return {
                isTooSimilar: false,
            };
        }
    }

    private async reviewWithLlm(
        content: string,
        candidates: SimilarityCandidate[]
    ): Promise<SimilarityReviewResponse> {
        const response: any = await withRetry(() =>
            this.ai.run(this.model as any, {
                instructions: [
                    'You review short social posts for duplicate content.',
                    'Mark posts as too similar when they repeat the same claim, same news item, same quote, or same takeaway, even if rewritten.',
                    'Allow posts about the same general topic only when the angle or substance is clearly different.',
                    'Return JSON only with keys: too_similar, matched_index, reason.',
                ].join(' '),
                input: [
                    `New post:\n${content}`,
                    '',
                    'Previous posts to compare:',
                    ...candidates.map((candidate, index) => [
                        `${index + 1}. ${candidate.previousPost}`,
                        `Heuristic score: ${candidate.score.toFixed(2)}`,
                        candidate.sharedTerms.length > 0
                            ? `Shared terms: ${candidate.sharedTerms.join(', ')}`
                            : 'Shared terms: none',
                    ].join('\n')),
                    '',
                    'Respond as JSON only. Use matched_index=null if none are too similar.',
                ].join('\n'),
            })
        );

        const text = extractOutputText(response);
        const parsed = parseSimilarityResponse(text);

        return {
            too_similar: Boolean(parsed.too_similar),
            matched_index: typeof parsed.matched_index === 'number' ? parsed.matched_index : null,
            reason: typeof parsed.reason === 'string' ? parsed.reason : '',
        };
    }
}

function buildCandidate(content: string, previousPost: string): SimilarityCandidate {
    const normalizedContent = normalizeText(content);
    const normalizedPreviousPost = normalizeText(previousPost);

    if (!normalizedPreviousPost) {
        return {
            previousPost,
            score: 0,
            exactMatch: false,
            containmentMatch: false,
            sharedTerms: [],
        };
    }

    const contentTokens = tokenize(normalizedContent);
    const previousTokens = tokenize(normalizedPreviousPost);
    const exactMatch = normalizedContent === normalizedPreviousPost;
    const containmentMatch =
        normalizedContent.includes(normalizedPreviousPost)
        || normalizedPreviousPost.includes(normalizedContent);

    const tokenScore = jaccardSimilarity(contentTokens, previousTokens);
    const phraseScore = jaccardSimilarity(
        buildPhrases(contentTokens),
        buildPhrases(previousTokens)
    );
    const score = exactMatch
        ? 1
        : Math.max(
            containmentMatch ? 0.97 : 0,
            tokenScore * 0.65 + phraseScore * 0.35
        );

    return {
        previousPost,
        score,
        exactMatch,
        containmentMatch,
        sharedTerms: getSharedTerms(contentTokens, previousTokens).slice(0, 6),
    };
}

function buildDirectReason(candidate: SimilarityCandidate): string {
    if (candidate.exactMatch) {
        return 'Normalized content matches a previous post exactly.';
    }

    if (candidate.containmentMatch) {
        return 'Most of the post text is contained in a previous post.';
    }

    return 'High-overlap heuristic flagged this as too close to a previous post.';
}

function normalizeText(text: string): string {
    return text
        .toLocaleLowerCase()
        .replace(/https?:\/\/\S+/g, ' ')
        .replace(/[^\p{L}\p{N}\s]/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function tokenize(text: string): string[] {
    return text
        .split(' ')
        .map((token) => token.trim())
        .filter((token) => token.length > MIN_TOKENS_FOR_COMPARISON && !COMMON_TOKENS.has(token));
}

function buildPhrases(tokens: string[]): string[] {
    if (tokens.length < 2) {
        return tokens;
    }

    const phrases: string[] = [];
    for (let index = 0; index < tokens.length - 1; index++) {
        phrases.push(`${tokens[index]} ${tokens[index + 1]}`);
    }

    return phrases;
}

function getSharedTerms(left: string[], right: string[]): string[] {
    const rightSet = new Set(right);
    return Array.from(new Set(left.filter((token) => rightSet.has(token))));
}

function jaccardSimilarity(left: string[], right: string[]): number {
    const leftSet = new Set(left);
    const rightSet = new Set(right);

    if (leftSet.size === 0 || rightSet.size === 0) {
        return 0;
    }

    let intersection = 0;
    for (const token of leftSet) {
        if (rightSet.has(token)) {
            intersection++;
        }
    }

    const union = new Set([...leftSet, ...rightSet]).size;
    return union === 0 ? 0 : intersection / union;
}

function extractOutputText(response: any): string {
    if (!response?.output) {
        throw new Error(`Unexpected AI response format: ${JSON.stringify(response)}`);
    }

    const result = response.output.find((candidate: any) =>
        Array.isArray(candidate.content) && candidate.content.some((item: any) => item.type === 'output_text')
    );

    const textContent = result?.content?.find((item: any) => item.type === 'output_text');
    if (!textContent?.text) {
        throw new Error('Similarity review response did not include output_text.');
    }

    return textContent.text;
}

function parseSimilarityResponse(text: string): SimilarityReviewResponse {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) {
        throw new Error(`Similarity review did not return JSON: ${text}`);
    }

    return JSON.parse(match[0]) as SimilarityReviewResponse;
}

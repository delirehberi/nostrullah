import { POST_FORMAT_VALUES, PostFormat, PostFormatWeights } from './types';

export const FORMAT_PLACEHOLDER = '$$FORMAT$$';

export const DEFAULT_POST_FORMAT_WEIGHTS: Record<PostFormat, number> = {
    news_commentary: 3,
    question: 2,
    tip: 2,
    hot_take: 1,
    short_list: 1,
};

/** Format instructions given to the model (the post itself stays in Turkish). */
export const POST_FORMAT_INSTRUCTIONS: Record<PostFormat, string> = {
    news_commentary:
        'React to the single news story in the provided context with your own take or insight. ' +
        'Do not just summarize it. Include the story link exactly as given.',
    question:
        'Make one interesting point, then end the post with an open question that invites ' +
        'readers to reply with their own view or experience.',
    tip:
        'Share one practical, actionable tip or a surprising "did you know?" fact. ' +
        'Keep it concrete and immediately useful.',
    hot_take:
        'Share one bold, debatable opinion on the topic, stated confidently and briefly, ' +
        'while staying respectful.',
    short_list:
        'Write a very short intro line followed by exactly 3 brief items, one per line, ' +
        'each starting with "•".',
};

/** Formats that only make sense with a resource item that has a link. */
const LINK_CONTEXT_FORMATS: ReadonlySet<PostFormat> = new Set(['news_commentary']);

export interface SelectPostFormatOptions {
    /** Whether the prompt context is a resource item with a link (e.g. an RSS story). */
    hasLinkContext: boolean;
    /** Format of the account's previous post, avoided when another one is eligible. */
    lastFormat?: string;
    random?: () => number;
}

/**
 * Format rotation applies to accounts without a custom prompt template, or whose
 * template opts in with the `$$FORMAT$$` placeholder.
 */
export function isFormatRotationEnabled(promptTemplate?: string): boolean {
    return !promptTemplate || promptTemplate.includes(FORMAT_PLACEHOLDER);
}

/**
 * Resolves an account's weights: unset means the defaults; an empty object means
 * rotation is switched off.
 */
export function resolvePostFormatWeights(weights?: PostFormatWeights): PostFormatWeights {
    return weights ?? DEFAULT_POST_FORMAT_WEIGHTS;
}

/**
 * Picks a post format by weight among the eligible ones, avoiding the previous
 * post's format when possible. Returns undefined when no format is enabled.
 */
export function selectPostFormat(
    weights: PostFormatWeights | undefined,
    options: SelectPostFormatOptions
): PostFormat | undefined {
    const random = options.random || Math.random;
    const eligible = POST_FORMAT_VALUES.filter(
        (format) =>
            (resolvePostFormatWeights(weights)[format] || 0) > 0 &&
            (options.hasLinkContext || !LINK_CONTEXT_FORMATS.has(format))
    );
    if (eligible.length === 0) {
        return undefined;
    }

    const candidates =
        eligible.length > 1 ? eligible.filter((format) => format !== options.lastFormat) : eligible;
    const resolved = resolvePostFormatWeights(weights);
    const totalWeight = candidates.reduce((sum, format) => sum + (resolved[format] || 0), 0);
    let roll = random() * totalWeight;

    for (const format of candidates) {
        roll -= resolved[format] || 0;
        if (roll < 0) {
            return format;
        }
    }

    return candidates[candidates.length - 1];
}

/**
 * Human-readable summary of an account's format rotation for `show details`.
 */
export function formatPostFormats(weights?: PostFormatWeights, promptTemplate?: string): string {
    if (!isFormatRotationEnabled(promptTemplate)) {
        return `off (custom prompt template; add ${FORMAT_PLACEHOLDER} to enable)`;
    }

    const resolved = resolvePostFormatWeights(weights);
    const enabled = POST_FORMAT_VALUES.filter((format) => (resolved[format] || 0) > 0);
    if (enabled.length === 0) {
        return 'off';
    }

    const list = enabled.map((format) => `${format} ${resolved[format]}`).join(', ');
    return weights ? list : `${list} (default)`;
}

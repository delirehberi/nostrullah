export const DEFAULT_MAX_POST_LENGTH = 500;
export const MIN_MAX_POST_LENGTH = 100;
export const MAX_MAX_POST_LENGTH = 2000;
export const MAX_LENGTH_PLACEHOLDER = '$$MAX_LENGTH$$';

const URL_PATTERN = /https?:\/\/\S+/giu;

/**
 * Counts the visible characters of a post, excluding links (clients render them as
 * previews). Counts grapheme clusters, so Turkish letters and emoji count as one.
 */
export function countPostLength(content: string): number {
    const text = content.replace(URL_PATTERN, '').replace(/\s+/g, ' ').trim();
    if (typeof Intl !== 'undefined' && 'Segmenter' in Intl) {
        return [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)].length;
    }
    return [...text].length;
}

export function isValidMaxPostLength(value: number): boolean {
    return Number.isInteger(value) && value >= MIN_MAX_POST_LENGTH && value <= MAX_MAX_POST_LENGTH;
}

/**
 * Resolves the effective limit: the account's value, then the MAX_POST_LENGTH env
 * var, then the default. Out-of-range values are ignored.
 */
export function resolveMaxPostLength(accountValue?: number | null, envValue?: string): number {
    if (accountValue !== undefined && accountValue !== null && isValidMaxPostLength(accountValue)) {
        return accountValue;
    }

    const fromEnv = envValue ? Number(envValue) : NaN;
    if (isValidMaxPostLength(fromEnv)) {
        return fromEnv;
    }

    return DEFAULT_MAX_POST_LENGTH;
}

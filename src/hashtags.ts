const MAX_HASHTAGS = 5;
const URL_PATTERN = /https?:\/\/\S+/giu;
// A hashtag starts at the beginning of the text or after a non-word character, so
// `abc#def` is ignored. Letters in any script, digits and `_` belong to the tag.
const HASHTAG_PATTERN = /(?<![\p{L}\p{N}_])#([\p{L}\p{M}\p{N}_]+)/gu;

/**
 * Extracts the hashtags from post content: lowercased (NIP-24), deduplicated,
 * in order of appearance and capped at `MAX_HASHTAGS`. Hashtags inside URLs
 * (fragments) and purely numeric tags are ignored.
 */
export function extractHashtags(content: string): string[] {
    const withoutUrls = content.replace(URL_PATTERN, ' ');
    const tags: string[] = [];

    for (const match of withoutUrls.matchAll(HASHTAG_PATTERN)) {
        const tag = normalizeHashtag(match[1]);
        if (/^\d+$/.test(tag) || tags.includes(tag)) {
            continue;
        }

        tags.push(tag);
        if (tags.length === MAX_HASHTAGS) {
            break;
        }
    }

    return tags;
}

/**
 * Builds NIP-12 `t` tags for the hashtags in post content.
 */
export function buildHashtagTags(content: string): string[][] {
    return extractHashtags(content).map((tag) => ['t', tag]);
}

function normalizeHashtag(tag: string): string {
    // Map Turkish dotted capital İ to plain `i`; the default lowercase would add a
    // combining dot. Locale-aware Turkish lowercasing is avoided because it would
    // turn English tags like `#AI` into `aı`.
    return tag.replace(/İ/g, 'i').toLowerCase().normalize('NFC');
}

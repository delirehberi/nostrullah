const URL_REGEX = /https?:\/\/[^\s<>"'`]+/g;

export interface UrlValidationResult {
    valid: boolean;
    invalidUrls: string[];
}

export function extractUrls(content: string): string[] {
    const matches = content.match(URL_REGEX) || [];
    const uniqueUrls = new Set<string>();

    for (const match of matches) {
        const normalizedUrl = trimTrailingPunctuation(match);

        try {
            const parsedUrl = new URL(normalizedUrl);
            uniqueUrls.add(parsedUrl.toString());
        } catch {
            continue;
        }
    }

    return Array.from(uniqueUrls);
}

export async function validatePostUrls(content: string): Promise<UrlValidationResult> {
    const urls = extractUrls(content);
    if (urls.length === 0) {
        return {
            valid: true,
            invalidUrls: [],
        };
    }

    const invalidUrls: string[] = [];

    for (const url of urls) {
        const reachable = await isReachableUrl(url);
        if (!reachable) {
            invalidUrls.push(url);
        }
    }

    return {
        valid: invalidUrls.length === 0,
        invalidUrls,
    };
}

async function isReachableUrl(url: string): Promise<boolean> {
    const headResponse = await fetchWithTimeout(url, 'HEAD');
    if (headResponse && isSuccessStatus(headResponse.status)) {
        return true;
    }

    if (headResponse && !shouldRetryWithGet(headResponse.status)) {
        return false;
    }

    const getResponse = await fetchWithTimeout(url, 'GET');
    if (!getResponse) {
        return false;
    }

    if (isSuccessStatus(getResponse.status)) {
        return true;
    }

    return isProbablyReachable(getResponse.status);
}

async function fetchWithTimeout(url: string, method: 'HEAD' | 'GET'): Promise<Response | null> {
    try {
        const timeoutPromise = new Promise<never>((_, reject) => {
            setTimeout(() => reject(new Error(`Timed out while validating URL: ${url}`)), 5000);
        });

        return await Promise.race([
            fetch(url, {
                method,
                redirect: 'follow',
            }),
            timeoutPromise,
        ]);
    } catch (error) {
        console.warn(`URL validation failed for ${url} with ${method}:`, error);
        return null;
    }
}

function isSuccessStatus(status: number): boolean {
    return status >= 200 && status < 400;
}

function shouldRetryWithGet(status: number): boolean {
    return [401, 403, 405, 429].includes(status);
}

function isProbablyReachable(status: number): boolean {
    return [401, 403, 429].includes(status);
}

function trimTrailingPunctuation(url: string): string {
    let normalizedUrl = url;

    while (/[.,!?;:]$/.test(normalizedUrl)) {
        normalizedUrl = normalizedUrl.slice(0, -1);
    }

    if (normalizedUrl.endsWith(')') && !normalizedUrl.includes('(')) {
        normalizedUrl = normalizedUrl.slice(0, -1);
    }

    return normalizedUrl;
}

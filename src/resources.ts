import { XMLParser } from 'fast-xml-parser';
import { FetchResourcesOptions, Resource, ResourceContext } from './types';

const RSS_CANDIDATE_LIMIT = 10;
// Upper bound on resources tried per run, to stay within Worker time limits.
const MAX_RESOURCE_ATTEMPTS = 3;
const FETCH_TIMEOUT_MS = 10_000;

/**
 * Normalizes an item URL for shared-item comparisons: trims it and drops the
 * fragment, so `https://a.com/x#top` and `https://a.com/x` count as the same item.
 */
export function normalizeSharedUrl(url: string): string {
    const trimmed = url.trim();
    try {
        const parsed = new URL(trimmed);
        parsed.hash = '';
        return parsed.toString();
    } catch {
        return trimmed;
    }
}

export class ResourceService {
    private parser: XMLParser;

    constructor() {
        this.parser = new XMLParser({
            ignoreAttributes: false,
            attributeNamePrefix: '@_',
        });
    }

    /**
     * Builds prompt context from the account's resources. Resources are tried in
     * weighted-random order (at most `MAX_RESOURCE_ATTEMPTS`) until one returns
     * usable context; a resource that fails or has nothing new (e.g. every RSS item
     * is in `options.excludeUrls`) falls through to the next. Returns an empty
     * context when none succeed.
     */
    async fetchResources(
        resources: Resource[],
        options: FetchResourcesOptions = {}
    ): Promise<ResourceContext> {
        if (!resources || resources.length === 0) {
            return { context: '' };
        }

        const excludeUrls = options.excludeUrls || new Set<string>();
        const candidates = this.orderByWeight(resources).slice(0, MAX_RESOURCE_ATTEMPTS);

        for (const resource of candidates) {
            const label = this.describeResource(resource);
            try {
                const result = await this.fetchResource(resource, excludeUrls);
                if (result.context.trim()) {
                    console.log(`Using resource ${label}`);
                    return result;
                }
                console.log(`Resource ${label} returned nothing new, trying next`);
            } catch (error) {
                console.error(`Failed to fetch resource ${label}:`, error);
            }
        }

        console.warn(
            `All ${candidates.length} attempted resources failed or had nothing new; ` +
                'generating without resource context'
        );
        return { context: '' };
    }

    private async fetchResource(
        resource: Resource,
        excludeUrls: Set<string>
    ): Promise<ResourceContext> {
        switch (resource.type) {
            case 'rss':
                return this.fetchAndParseRSS(resource.url, excludeUrls);
            case 'scraping':
                return { context: await this.fetchAndParseScraping(resource.url) };
            case 'quote':
                return { context: await this.fetchQuote(resource.categories) };
        }
    }

    private describeResource(resource: Resource): string {
        return resource.type === 'quote'
            ? `quote(${resource.categories.join(',')})`
            : `${resource.type}(${resource.url})`;
    }

    /**
     * Returns the resources in weighted-random order: repeatedly draws one by weight
     * from those not yet drawn.
     */
    private orderByWeight(resources: Resource[]): Resource[] {
        const remaining = [...resources];
        const ordered: Resource[] = [];

        while (remaining.length > 0) {
            const selected = this.selectResource(remaining);
            ordered.push(selected);
            remaining.splice(remaining.indexOf(selected), 1);
        }

        return ordered;
    }

    private selectResource(resources: Resource[]): Resource {
        const totalWeight = resources.reduce((sum, r) => sum + (r.weight || 1), 0);
        let random = Math.random() * totalWeight;

        for (const resource of resources) {
            const weight = resource.weight || 1;
            if (random <= weight) {
                return resource;
            }
            random -= weight;
        }

        return resources[0]; // Fallback
    }

    private async fetchQuote(categories: string[]): Promise<string> {
        const url = new URL('https://api.quotable.io/quotes/random');
        if (categories.length > 0) {
            url.searchParams.set('tags', categories[Math.floor(Math.random() * categories.length)]);
        }
        const response = await fetch(url.toString(), {
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        const data: any = await response.json();
        const quote = Array.isArray(data) ? data[0] : data;
        if (quote?.content) {
            return `"${quote.content}" - ${quote.author}`;
        }
        return '';
    }

    private async fetchAndParseScraping(url: string): Promise<string> {
        const response = await fetch(url, {
            headers: {
                'User-Agent': 'NostrBot/1.0 (Scraper)',
                Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            },
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        let accumulatedText = '';

        class BlockHandler {
            element(_element: any) {
                if (accumulatedText.length > 0 && !accumulatedText.endsWith('\n')) {
                    accumulatedText += '\n';
                }
            }

            text(textInfo: any) {
                accumulatedText += textInfo.text;
            }
        }

        const rewriter = new HTMLRewriter().on(
            'p, h1, h2, h3, h4, h5, h6, li, article, section',
            new BlockHandler()
        );

        await rewriter.transform(response).text();

        return accumulatedText
            .replace(/\n{3,}/g, '\n\n')
            .trim()
            .slice(0, 5000);
    }

    private async fetchAndParseRSS(
        url: string,
        excludeUrls: Set<string>
    ): Promise<ResourceContext> {
        const response = await fetch(url, {
            headers: {
                'User-Agent': 'NostrBot/1.0',
            },
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        const xmlData = await response.text();
        const jsonObj = this.parser.parse(xmlData);

        // Handle common RSS structures (rss/channel/item or feed/entry)
        let items: any[] = [];
        if (jsonObj.rss?.channel?.item) {
            items = Array.isArray(jsonObj.rss.channel.item)
                ? jsonObj.rss.channel.item
                : [jsonObj.rss.channel.item];
        } else if (jsonObj.feed?.entry) {
            items = Array.isArray(jsonObj.feed.entry) ? jsonObj.feed.entry : [jsonObj.feed.entry];
        }

        // Pick one random not-yet-shared item from the top 10 so each run uses a new article.
        const candidateItems = items
            .slice(0, RSS_CANDIDATE_LIMIT)
            .map((item) => ({ item, link: this.extractItemLink(item) }))
            .filter(({ link }) => !link || !excludeUrls.has(normalizeSharedUrl(link)));
        if (candidateItems.length === 0) {
            if (items.length > 0) {
                console.log(`No unshared items left in feed ${url}`);
            }
            return { context: '' };
        }

        const { item, link } = candidateItems[Math.floor(Math.random() * candidateItems.length)];
        const title = this.extractTextValue(item.title) || 'Untitled';
        const desc = this.extractTextValue(
            item.description || item.summary || item['content:encoded'] || ''
        );
        const cleanDesc = desc.replace(/<[^>]*>?/gm, '');

        let output = `Title: ${title}\n`;
        if (cleanDesc) output += `Summary: ${cleanDesc.slice(0, 300)}...\n`;
        if (link) output += `Link: ${link}\n`;

        return {
            context: output,
            sourceUrl: link ? normalizeSharedUrl(link) : undefined,
            sourceTitle: title,
        };
    }

    private extractItemLink(item: any): string | undefined {
        const candidates = [item.link, item.guid, item.id];

        for (const candidate of candidates) {
            const normalized = this.normalizeLinkCandidate(candidate);
            if (normalized) {
                return normalized;
            }
        }

        return undefined;
    }

    private normalizeLinkCandidate(candidate: any): string | undefined {
        if (!candidate) {
            return undefined;
        }

        if (typeof candidate === 'string') {
            return this.isHttpUrl(candidate) ? candidate : undefined;
        }

        if (Array.isArray(candidate)) {
            for (const entry of candidate) {
                const normalized = this.normalizeLinkCandidate(entry);
                if (normalized) {
                    return normalized;
                }
            }
            return undefined;
        }

        if (typeof candidate === 'object') {
            const href = typeof candidate['@_href'] === 'string' ? candidate['@_href'] : undefined;
            if (href && this.isHttpUrl(href)) {
                return href;
            }

            const textValue = this.extractTextValue(candidate);
            if (textValue && this.isHttpUrl(textValue)) {
                return textValue;
            }
        }

        return undefined;
    }

    private extractTextValue(value: any): string {
        if (!value) {
            return '';
        }

        if (typeof value === 'string') {
            return value.trim();
        }

        if (Array.isArray(value)) {
            for (const entry of value) {
                const extracted = this.extractTextValue(entry);
                if (extracted) {
                    return extracted;
                }
            }
            return '';
        }

        if (typeof value === 'object') {
            const textKeys = ['#text', '__cdata', '@_title'];
            for (const key of textKeys) {
                if (typeof value[key] === 'string') {
                    return value[key].trim();
                }
            }
        }

        return '';
    }

    private isHttpUrl(value: string): boolean {
        try {
            const parsed = new URL(value);
            return parsed.protocol === 'http:' || parsed.protocol === 'https:';
        } catch {
            return false;
        }
    }
}

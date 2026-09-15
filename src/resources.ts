import { XMLParser } from 'fast-xml-parser';
import { Resource } from './types';

export class ResourceService {
    private parser: XMLParser;

    constructor() {
        this.parser = new XMLParser({
            ignoreAttributes: false,
            attributeNamePrefix: '@_',
        });
    }

    async fetchResources(resources: Resource[]): Promise<string> {
        if (!resources || resources.length === 0) {
            return '';
        }

        // 1. Weighted Selection
        const selectedResource = this.selectResource(resources);
        if (!selectedResource) {
            return '';
        }

        console.log(`Selected resource type: ${selectedResource.type}`);

        // 2. Fetch and Parse
        try {
            if (selectedResource.type === 'rss') {
                return await this.fetchAndParseRSS(selectedResource.url);
            }
            if (selectedResource.type === 'scraping') {
                return await this.fetchAndParseScraping(selectedResource.url);
            }
            if (selectedResource.type === 'quote') {
                return await this.fetchQuote(selectedResource.categories);
            }
        } catch (error) {
            console.error(`Failed to fetch resource:`, error);
        }

        return '';
    }

    private selectResource(resources: Resource[]): Resource | null {
        if (resources.length === 0) return null;

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
        const category = categories[Math.floor(Math.random() * categories.length)];
        const response = await fetch(`https://api.quotable.io/quotes/random?tags=${category}`);
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

    private async fetchAndParseRSS(url: string): Promise<string> {
        const response = await fetch(url, {
            headers: {
                'User-Agent': 'NostrBot/1.0',
            },
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

        // Pick one random item from the top 10 so each run uses a different article.
        const candidateItems = items.slice(0, 10);
        if (candidateItems.length === 0) {
            return '';
        }

        const item = candidateItems[Math.floor(Math.random() * candidateItems.length)];
        const title = this.extractTextValue(item.title) || 'Untitled';
        const link = this.extractItemLink(item);
        const desc = this.extractTextValue(
            item.description || item.summary || item['content:encoded'] || ''
        );
        const cleanDesc = desc.replace(/<[^>]*>?/gm, '');

        let output = `Title: ${title}\n`;
        if (cleanDesc) output += `Summary: ${cleanDesc.slice(0, 300)}...\n`;
        if (link) output += `Link: ${link}\n`;

        return output;
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

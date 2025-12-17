import { XMLParser } from 'fast-xml-parser';
import { Resource } from './types';

export class ResourceService {
    private parser: XMLParser;

    constructor() {
        this.parser = new XMLParser({
            ignoreAttributes: false,
            attributeNamePrefix: "@_"
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

        console.log(`Selected resource: ${selectedResource.url} (type: ${selectedResource.type})`);

        // 2. Fetch and Parse
        try {
            if (selectedResource.type === 'rss') {
                return await this.fetchAndParseRSS(selectedResource.url);
            }
            // Add scraping logic here in future
        } catch (error) {
            console.error(`Failed to fetch resource ${selectedResource.url}:`, error);
        }

        return '';
    }

    private selectResource(resources: Resource[]): Resource | null {
        // Filter valid resources
        const validResources = resources.filter(r => r.url);
        if (validResources.length === 0) return null;

        // Calculate total weight
        const totalWeight = validResources.reduce((sum, r) => sum + (r.weight || 1), 0);
        let random = Math.random() * totalWeight;

        for (const resource of validResources) {
            const weight = resource.weight || 1;
            if (random < weight) {
                return resource;
            }
            random -= weight;
        }

        return validResources[0]; // Fallback
    }

    private async fetchAndParseRSS(url: string): Promise<string> {
        const response = await fetch(url, {
            headers: {
                'User-Agent': 'NostrBot/1.0'
            }
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
            items = Array.isArray(jsonObj.feed.entry)
                ? jsonObj.feed.entry
                : [jsonObj.feed.entry];
        }

        // Extract top 3 items
        const topItems = items.slice(0, 3);

        let output = `Source: ${url}\n\n`;

        topItems.forEach((item: any) => {
            const title = item.title;
            const link = item.link;
            const desc = item.description || item.summary || '';
            // Strip HTML from description if simple string
            const cleanDesc = typeof desc === 'string' ? desc.replace(/<[^>]*>?/gm, "") : '';

            output += `Title: ${title}\n`;
            if (cleanDesc) output += `Summary: ${cleanDesc.slice(0, 150)}...\n`;
            if (link) output += `Link: ${link}\n`;
            output += '---\n';
        });

        return output;
    }
}

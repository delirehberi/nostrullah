import { afterEach, describe, expect, it, vi } from 'vitest';
import { ResourceService } from '../src/resources';

describe('ResourceService.fetchResources', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('uses article links from RSS items instead of the feed url', async () => {
        const service = new ResourceService();
        const feedUrl = 'https://sanatatak.com/feed/';
        const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <item>
      <title>Gokyuzunun Renkleri</title>
      <link>https://sanatatak.com/gokyuzunun-renkleri/</link>
      <description><![CDATA[Karadeniz'in sisli sabahlarindan bir secki.]]></description>
    </item>
  </channel>
</rss>`;

        vi.spyOn(globalThis, 'fetch').mockResolvedValue(
            new Response(xml, {
                status: 200,
                headers: {
                    'content-type': 'application/rss+xml',
                },
            })
        );

        const context = await service.fetchResources([
            {
                type: 'rss',
                url: feedUrl,
            },
        ]);

        expect(context).toContain('Title: Gokyuzunun Renkleri');
        expect(context).toContain('Link: https://sanatatak.com/gokyuzunun-renkleri/');
        expect(context).not.toContain(`Source: ${feedUrl}`);
        expect(context).not.toContain(`Link: ${feedUrl}`);
    });

    it('extracts article links from Atom href attributes', async () => {
        const service = new ResourceService();
        const xml = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <title>Sehir Isiklari</title>
    <link href="https://example.com/sehir-isiklari/" rel="alternate" />
    <summary>Neon renklerin izinde.</summary>
  </entry>
</feed>`;

        vi.spyOn(globalThis, 'fetch').mockResolvedValue(
            new Response(xml, {
                status: 200,
                headers: {
                    'content-type': 'application/atom+xml',
                },
            })
        );

        const context = await service.fetchResources([
            {
                type: 'rss',
                url: 'https://example.com/feed.xml',
            },
        ]);

        expect(context).toContain('Title: Sehir Isiklari');
        expect(context).toContain('Link: https://example.com/sehir-isiklari/');
        expect(context).not.toContain('Link: https://example.com/feed.xml');
    });
});

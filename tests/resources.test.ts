import { afterEach, describe, expect, it, vi } from 'vitest';
import { normalizeSharedUrl, ResourceService } from '../src/resources';

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

        const { context } = await service.fetchResources([
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

        const { context } = await service.fetchResources([
            {
                type: 'rss',
                url: 'https://example.com/feed.xml',
            },
        ]);

        expect(context).toContain('Title: Sehir Isiklari');
        expect(context).toContain('Link: https://example.com/sehir-isiklari/');
        expect(context).not.toContain('Link: https://example.com/feed.xml');
    });

    it('picks a single item from the RSS feed, not all top items (BUG-04)', async () => {
        const service = new ResourceService();
        const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <item>
      <title>Article One</title>
      <link>https://example.com/one/</link>
      <description>First article.</description>
    </item>
    <item>
      <title>Article Two</title>
      <link>https://example.com/two/</link>
      <description>Second article.</description>
    </item>
    <item>
      <title>Article Three</title>
      <link>https://example.com/three/</link>
      <description>Third article.</description>
    </item>
  </channel>
</rss>`;

        vi.spyOn(globalThis, 'fetch').mockResolvedValue(
            new Response(xml, { status: 200, headers: { 'content-type': 'application/rss+xml' } })
        );

        const { context } = await service.fetchResources([
            { type: 'rss', url: 'https://example.com/feed/' },
        ]);

        // Exactly one 'Title:' line — not three
        const titleMatches = (context.match(/^Title:/gm) || []).length;
        expect(titleMatches).toBe(1);

        // No separator lines from the old multi-item format
        expect(context).not.toContain('---');

        vi.restoreAllMocks();
    });

    it('does not bias weighted selection toward the first resource (BUG-03)', async () => {
        const service = new ResourceService();
        const resources = [
            { type: 'quote' as const, categories: ['science'], weight: 1 },
            { type: 'quote' as const, categories: ['history'], weight: 1 },
            { type: 'quote' as const, categories: ['philosophy'], weight: 1 },
        ];

        const categoriesSelected: string[] = [];
        vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any) => {
            const url: string = typeof input === 'string' ? input : input.toString();
            const category = new URL(url).searchParams.get('tags') ?? '';
            categoriesSelected.push(category);
            return new Response(JSON.stringify([{ content: 'Test quote', author: 'Author' }]), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            });
        });

        // Run 60 selections; with uniform weights each category should appear ~20 times.
        // A bias toward the first resource would cause 'science' to appear nearly every time.
        for (let i = 0; i < 60; i++) {
            await service.fetchResources(resources);
        }

        const scienceCount = categoriesSelected.filter((c) => c === 'science').length;
        // Should not dominate — with fair distribution expect < 40 out of 60
        expect(scienceCount).toBeLessThan(40);

        vi.restoreAllMocks();
    });

    it('extracts the quote from an array response (BUG-10)', async () => {
        const service = new ResourceService();

        vi.spyOn(globalThis, 'fetch').mockResolvedValue(
            new Response(
                JSON.stringify([
                    { content: 'To be or not to be.', author: 'Shakespeare', _id: 'abc' },
                ]),
                { status: 200, headers: { 'content-type': 'application/json' } }
            )
        );

        const { context } = await service.fetchResources([
            { type: 'quote', categories: ['literature'] },
        ]);

        expect(context).toContain('To be or not to be.');
        expect(context).toContain('Shakespeare');

        vi.restoreAllMocks();
    });

    describe('shared item tracking', () => {
        const feedXml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <item>
      <title>Article One</title>
      <link>https://example.com/one/</link>
      <description>First article.</description>
    </item>
    <item>
      <title>Article Two</title>
      <link>https://example.com/two/#comments</link>
      <description>Second article.</description>
    </item>
    <item>
      <title>Article Three</title>
      <link>https://example.com/three/</link>
      <description>Third article.</description>
    </item>
  </channel>
</rss>`;

        function mockFeed(): void {
            vi.spyOn(globalThis, 'fetch').mockImplementation(
                async () =>
                    new Response(feedXml, {
                        status: 200,
                        headers: { 'content-type': 'application/rss+xml' },
                    })
            );
        }

        it('returns the normalized source url and title of the chosen item', async () => {
            mockFeed();
            const service = new ResourceService();

            const result = await service.fetchResources([
                { type: 'rss', url: 'https://example.com/feed/' },
            ]);

            expect(result.sourceUrl).toMatch(/^https:\/\/example\.com\/(one|two|three)\/$/);
            expect(result.sourceTitle).toMatch(/^Article (One|Two|Three)$/);
            expect(result.context).toContain(`Title: ${result.sourceTitle}`);
        });

        it('never offers an item that was already shared', async () => {
            mockFeed();
            const service = new ResourceService();
            const excludeUrls = new Set([
                'https://example.com/one/',
                normalizeSharedUrl('https://example.com/two/#comments'),
            ]);

            for (let i = 0; i < 20; i++) {
                const result = await service.fetchResources(
                    [{ type: 'rss', url: 'https://example.com/feed/' }],
                    { excludeUrls }
                );
                expect(result.sourceUrl).toBe('https://example.com/three/');
                expect(result.context).toContain('Title: Article Three');
            }
        });

        it('returns empty context when every feed item was already shared', async () => {
            mockFeed();
            const service = new ResourceService();

            const result = await service.fetchResources(
                [{ type: 'rss', url: 'https://example.com/feed/' }],
                {
                    excludeUrls: new Set([
                        'https://example.com/one/',
                        'https://example.com/two/',
                        'https://example.com/three/',
                    ]),
                }
            );

            expect(result).toEqual({ context: '' });
        });
    });
});

describe('normalizeSharedUrl', () => {
    it('trims whitespace and drops the fragment', () => {
        expect(normalizeSharedUrl('  https://example.com/a?x=1#top ')).toBe(
            'https://example.com/a?x=1'
        );
    });

    it('returns non-url input trimmed', () => {
        expect(normalizeSharedUrl(' not a url ')).toBe('not a url');
    });
});

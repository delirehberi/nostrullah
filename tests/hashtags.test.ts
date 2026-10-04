import { describe, expect, it } from 'vitest';
import { buildHashtagTags, extractHashtags } from '../src/hashtags';

describe('extractHashtags', () => {
    it('extracts lowercased hashtags in order of appearance', () => {
        expect(extractHashtags('Yeni keşif! #Bilim #Uzay')).toEqual(['bilim', 'uzay']);
    });

    it('keeps Turkish characters', () => {
        expect(extractHashtags('#YapayZekâ #Çevre #Öğrenme #Şehir #Güneş')).toEqual([
            'yapayzekâ',
            'çevre',
            'öğrenme',
            'şehir',
            'güneş',
        ]);
    });

    it('maps dotted capital İ to a plain i and keeps English tags intact', () => {
        expect(extractHashtags('#İstanbul #AI #ılık')).toEqual(['istanbul', 'ai', 'ılık']);
    });

    it('normalizes decomposed characters so equal tags are deduplicated', () => {
        const decomposed = '#Zekâ';
        expect(extractHashtags(`${decomposed} #Zekâ`)).toEqual(['zekâ']);
    });

    it('deduplicates case-insensitively', () => {
        expect(extractHashtags('#Bilim bilgi #bilim #BILIM')).toEqual(['bilim']);
    });

    it('stops tags at punctuation', () => {
        expect(extractHashtags('Harika (#bilim), değil mi? #uzay.')).toEqual(['bilim', 'uzay']);
    });

    it('ignores URL fragments and mid-word hashes', () => {
        expect(
            extractHashtags('Oku: https://example.com/haber#yorumlar ve abc#def #gerçek')
        ).toEqual(['gerçek']);
    });

    it('ignores purely numeric tags but keeps alphanumeric ones', () => {
        expect(extractHashtags('#1 numara #2026 #web3')).toEqual(['web3']);
    });

    it('returns at most five tags', () => {
        expect(extractHashtags('#a1 #b2 #c3 #d4 #e5 #f6 #g7')).toEqual([
            'a1',
            'b2',
            'c3',
            'd4',
            'e5',
        ]);
    });

    it('returns an empty list when there are no hashtags', () => {
        expect(extractHashtags('Hashtag yok, sadece # işareti.')).toEqual([]);
    });
});

describe('buildHashtagTags', () => {
    it('builds NIP-12 t tags', () => {
        expect(buildHashtagTags('Merhaba #Nostr #Türkiye')).toEqual([
            ['t', 'nostr'],
            ['t', 'türkiye'],
        ]);
    });
});

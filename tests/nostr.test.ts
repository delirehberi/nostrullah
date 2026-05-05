import { describe, expect, it, vi } from 'vitest';
import { Relay } from 'nostr-tools';
import { NostrService } from '../src/nostr';
import { NostrAccount } from '../src/types';

describe('NostrService.publishEvent', () => {
    it('publishes reply tags and returns the signed event id', async () => {
        const publish = vi.fn().mockResolvedValue(undefined);
        const close = vi.fn();
        const connectSpy = vi.spyOn(Relay, 'connect').mockResolvedValue({
            publish,
            close,
        } as any);

        const account: NostrAccount = {
            id: 1,
            privateKey: '1'.repeat(64),
            relays: ['wss://relay.example'],
            categories: ['technology'],
            frequency: 'daily',
        };

        const result = await NostrService.publishEvent(account, 'hello', {
            replyToEventId: 'event-123',
            replyToPubkey: 'a'.repeat(64),
            mentionPubkeys: ['b'.repeat(64)],
        });

        expect(connectSpy).toHaveBeenCalledWith('wss://relay.example');
        expect(publish).toHaveBeenCalledWith(
            expect.objectContaining({
                content: 'hello',
                tags: [
                    ['e', 'event-123', '', 'reply'],
                    ['p', 'b'.repeat(64)],
                    ['p', 'a'.repeat(64)],
                ],
            })
        );
        expect(result.published).toBe(true);
        expect(result.successCount).toBe(1);
        expect(result.eventId).toMatch(/^[a-f0-9]{64}$/);

        connectSpy.mockRestore();
    });
});

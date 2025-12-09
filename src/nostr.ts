import { finalizeEvent, getPublicKey, nip19, Relay } from 'nostr-tools';
import { hexToBytes } from '@noble/hashes/utils';
import { NostrAccount } from './types';

export class NostrService {
    static getPublicKeyFromPrivate(privateKey: string): string {
        if (privateKey.startsWith('nsec')) {
            const { data } = nip19.decode(privateKey);
            return getPublicKey(data as Uint8Array);
        }
        return getPublicKey(hexToBytes(privateKey));
    }

    static async publishEvent(account: NostrAccount, content: string): Promise<boolean> {
        let privateKeyBytes: Uint8Array;
        if (account.privateKey.startsWith('nsec')) {
            const { data } = nip19.decode(account.privateKey);
            privateKeyBytes = data as Uint8Array;
        } else {
            privateKeyBytes = hexToBytes(account.privateKey);
        }

        const eventTemplate = {
            kind: 1,
            created_at: Math.floor(Date.now() / 1000),
            tags: [],
            content: content,
        };

        const signedEvent = finalizeEvent(eventTemplate, privateKeyBytes);

        let successCount = 0;
        const publishPromises = account.relays.map(async (relayUrl) => {
            try {
                const relay = await Relay.connect(relayUrl);
                await relay.publish(signedEvent);
                relay.close();
                successCount++;
            } catch (e) {
                console.error(`Failed to publish to ${relayUrl}:`, e);
            }
        });

        await Promise.allSettled(publishPromises);
        return successCount > 0;
    }
}

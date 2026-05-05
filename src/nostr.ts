import { Event, EventTemplate, finalizeEvent, getPublicKey, nip19, Relay, SimplePool } from 'nostr-tools';
import { hexToBytes } from '@noble/hashes/utils';
import { NostrAccount } from './types';

export interface PublishEventOptions {
    replyToEventId?: string;
    replyToPubkey?: string;
    mentionPubkeys?: string[];
    extraTags?: string[][];
}

export interface PublishEventResult {
    eventId: string;
    published: boolean;
    successCount: number;
}

export interface NostrQueryFilter {
    kinds?: number[];
    authors?: string[];
    '#p'?: string[];
    since?: number;
    limit?: number;
}

export class NostrService {
    static getPublicKeyFromPrivate(privateKey: string): string {
        if (privateKey.startsWith('nsec')) {
            const { data } = nip19.decode(privateKey);
            return getPublicKey(data as Uint8Array);
        }
        return getPublicKey(hexToBytes(privateKey));
    }

    static async publishEvent(
        account: NostrAccount,
        content: string,
        options: PublishEventOptions = {}
    ): Promise<PublishEventResult> {
        let privateKeyBytes: Uint8Array;
        if (account.privateKey.startsWith('nsec')) {
            const { data } = nip19.decode(account.privateKey);
            privateKeyBytes = data as Uint8Array;
        } else {
            privateKeyBytes = hexToBytes(account.privateKey);
        }

        const eventTemplate: EventTemplate = {
            kind: 1,
            created_at: Math.floor(Date.now() / 1000),
            tags: buildEventTags(options),
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
        return {
            eventId: signedEvent.id,
            published: successCount > 0,
            successCount,
        };
    }

    static async queryEvents(relays: string[], filter: NostrQueryFilter): Promise<Event[]> {
        const normalizedRelays = [...new Set(relays)];
        if (normalizedRelays.length === 0) {
            return [];
        }

        const pool = new SimplePool();

        try {
            const events = await pool.querySync(normalizedRelays, filter as any, {
                maxWait: 5000,
            });

            return events.sort((left, right) => {
                if (left.created_at !== right.created_at) {
                    return left.created_at - right.created_at;
                }

                return left.id.localeCompare(right.id);
            });
        } finally {
            pool.close(normalizedRelays);
        }
    }
}

function buildEventTags(options: PublishEventOptions): string[][] {
    const tags: string[][] = [];
    const mentionedPubkeys = new Set(options.mentionPubkeys || []);

    if (options.replyToPubkey) {
        mentionedPubkeys.add(options.replyToPubkey);
    }

    if (options.replyToEventId) {
        tags.push(['e', options.replyToEventId, '', 'reply']);
    }

    for (const pubkey of mentionedPubkeys) {
        tags.push(['p', pubkey]);
    }

    if (options.extraTags) {
        tags.push(...options.extraTags);
    }

    return tags;
}

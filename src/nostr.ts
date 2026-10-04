import {
    Event,
    EventTemplate,
    finalizeEvent,
    getPublicKey,
    nip19,
    Relay,
    SimplePool,
} from 'nostr-tools';
import { hexToBytes } from '@noble/hashes/utils';
import { NostrAccount } from './types';

export interface PublishEventOptions {
    replyToEventId?: string;
    replyToPubkey?: string;
    mentionPubkeys?: string[];
    extraTags?: string[][];
}

export interface RelayPublishResult {
    relay: string;
    ok: boolean;
    error?: string;
}

export interface PublishEventResult {
    eventId: string;
    published: boolean;
    successCount: number;
    /** Outcome per relay, in the order of `account.relays`. */
    relays?: RelayPublishResult[];
}

export interface NostrQueryFilter {
    kinds?: number[];
    authors?: string[];
    '#p'?: string[];
    '#e'?: string[];
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

        const publishPromises = account.relays.map(
            async (relayUrl): Promise<RelayPublishResult> => {
                try {
                    const relay = await Relay.connect(relayUrl);
                    await relay.publish(signedEvent);
                    relay.close();
                    return { relay: relayUrl, ok: true };
                } catch (e) {
                    console.error(`Failed to publish to ${relayUrl}:`, e);
                    return {
                        relay: relayUrl,
                        ok: false,
                        error: e instanceof Error ? e.message : String(e),
                    };
                }
            }
        );

        const relays = await Promise.all(publishPromises);
        const successCount = relays.filter((result) => result.ok).length;
        return {
            eventId: signedEvent.id,
            published: successCount > 0,
            successCount,
            relays,
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

    static async discoverRelays(pubkey: string, bootstrapRelays: string[]): Promise<string[]> {
        try {
            const filter: NostrQueryFilter = {
                kinds: [10002],
                authors: [pubkey],
                limit: 1,
            };
            const events = await this.queryEvents(bootstrapRelays, filter);
            if (events.length > 0) {
                const relayListEvent = events[0];
                const writeRelays = relayListEvent.tags
                    .filter((tag) => tag[0] === 'r' && (!tag[2] || tag[2] === 'write'))
                    .map((tag) => tag[1]);
                if (writeRelays.length > 0) {
                    return writeRelays;
                }
            }
        } catch (e) {
            console.error(`Failed to discover relays for ${pubkey}:`, e);
        }
        return [];
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

import { Event, nip19, verifyEvent } from 'nostr-tools';

import { StorageService } from './storage';

/** The only Nostr identity allowed to log in to the debug page. */
export const DEBUG_ADMIN_NPUB = 'npub1gmeu0wenescpjpymwmwgnkaedc6vy3aamf5tdtvxxf5z0yll3gdqatwl3v';
export const DEBUG_ADMIN_PUBKEY = nip19.decode(DEBUG_ADMIN_NPUB).data as string;

/** NIP-98 HTTP auth event kind. */
export const NIP98_KIND = 27235;
export const LOGIN_MAX_AGE_SECONDS = 60;
export const SESSION_TTL_SECONDS = 12 * 60 * 60;
export const SESSION_COOKIE = 'nostrullah_debug';

export type LoginCheck = { ok: true; event: Event } | { ok: false; reason: string };

/**
 * Checks a NIP-98 login event: kind 27235, signed by `DEBUG_ADMIN_PUBKEY`, created
 * within `LOGIN_MAX_AGE_SECONDS` of `now`, with `u` and `method` tags matching the
 * login request. Replay protection is done separately by the caller.
 */
export function verifyLoginEvent(
    event: unknown,
    expected: { url: string; method: string; now: number },
    allowedPubkey: string = DEBUG_ADMIN_PUBKEY
): LoginCheck {
    if (!isEventShape(event)) {
        return { ok: false, reason: 'malformed event' };
    }
    if (event.kind !== NIP98_KIND) {
        return { ok: false, reason: 'wrong event kind' };
    }
    if (event.pubkey !== allowedPubkey) {
        return { ok: false, reason: 'pubkey not allowed' };
    }
    if (Math.abs(expected.now - event.created_at) > LOGIN_MAX_AGE_SECONDS) {
        return { ok: false, reason: 'event expired' };
    }

    const urlTag = event.tags.find((tag) => tag[0] === 'u')?.[1];
    if (!urlTag || !sameEndpoint(urlTag, expected.url)) {
        return { ok: false, reason: 'url mismatch' };
    }
    const methodTag = event.tags.find((tag) => tag[0] === 'method')?.[1];
    if (!methodTag || methodTag.toUpperCase() !== expected.method.toUpperCase()) {
        return { ok: false, reason: 'method mismatch' };
    }

    // Verify a plain copy: nostr-tools caches a successful check on the object itself.
    // Also checks that the id is the hash of the event.
    const plain: Event = {
        id: event.id,
        pubkey: event.pubkey,
        created_at: event.created_at,
        kind: event.kind,
        tags: event.tags,
        content: event.content,
        sig: event.sig,
    };
    if (!verifyEvent(plain)) {
        return { ok: false, reason: 'invalid signature' };
    }

    return { ok: true, event: plain };
}

/**
 * Verifies a login event, claims its id (single use) and creates a session.
 * Returns the raw session token for the cookie.
 */
export async function createLoginSession(
    storage: StorageService,
    event: unknown,
    requestUrl: string,
    now: number,
    allowedPubkey: string = DEBUG_ADMIN_PUBKEY
): Promise<{ ok: true; token: string } | { ok: false; reason: string }> {
    const check = verifyLoginEvent(event, { url: requestUrl, method: 'POST', now }, allowedPubkey);
    if (!check.ok) {
        return check;
    }
    if (!(await storage.claimDebugLoginEvent(check.event.id, now))) {
        return { ok: false, reason: 'event already used' };
    }

    const token = randomToken();
    await storage.createDebugSession(
        await hashToken(token),
        check.event.pubkey,
        now,
        now + SESSION_TTL_SECONDS
    );
    return { ok: true, token };
}

/** True when the request carries a live session of the admin pubkey. */
export async function hasValidSession(
    request: Request,
    storage: StorageService,
    now: number,
    allowedPubkey: string = DEBUG_ADMIN_PUBKEY
): Promise<boolean> {
    const token = readCookie(request, SESSION_COOKIE);
    if (!token) {
        return false;
    }
    try {
        const pubkey = await storage.getDebugSessionPubkey(await hashToken(token), now);
        return pubkey === allowedPubkey;
    } catch (error) {
        console.error('Failed to load debug session:', error);
        return false;
    }
}

export async function destroySession(request: Request, storage: StorageService): Promise<void> {
    const token = readCookie(request, SESSION_COOKIE);
    if (token) {
        await storage.deleteDebugSession(await hashToken(token));
    }
}

export function buildSessionCookie(token: string, maxAgeSeconds: number): string {
    return (
        `${SESSION_COOKIE}=${token}; Path=/debug; HttpOnly; Secure; SameSite=Strict; ` +
        `Max-Age=${maxAgeSeconds}`
    );
}

export function readCookie(request: Request, name: string): string | undefined {
    const header = request.headers.get('cookie');
    if (!header) {
        return undefined;
    }
    for (const part of header.split(';')) {
        const [key, ...rest] = part.trim().split('=');
        if (key === name) {
            return rest.join('=') || undefined;
        }
    }
    return undefined;
}

export async function hashToken(token: string): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
    return toHex(new Uint8Array(digest));
}

function randomToken(): string {
    return toHex(crypto.getRandomValues(new Uint8Array(32)));
}

function toHex(bytes: Uint8Array): string {
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Same origin and path; the query string and fragment are ignored. */
function sameEndpoint(left: string, right: string): boolean {
    try {
        const a = new URL(left);
        const b = new URL(right);
        return a.origin === b.origin && a.pathname === b.pathname;
    } catch {
        return false;
    }
}

function isEventShape(value: unknown): value is Event {
    if (!value || typeof value !== 'object') {
        return false;
    }
    const event = value as Record<string, unknown>;
    return (
        typeof event.id === 'string' &&
        typeof event.pubkey === 'string' &&
        typeof event.sig === 'string' &&
        typeof event.content === 'string' &&
        typeof event.kind === 'number' &&
        typeof event.created_at === 'number' &&
        Array.isArray(event.tags) &&
        event.tags.every(
            (tag) => Array.isArray(tag) && tag.every((item) => typeof item === 'string')
        )
    );
}

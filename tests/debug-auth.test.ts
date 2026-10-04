import { describe, expect, it } from 'vitest';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools';

import {
    DEBUG_ADMIN_PUBKEY,
    NIP98_KIND,
    SESSION_COOKIE,
    buildSessionCookie,
    createLoginSession,
    hasValidSession,
    hashToken,
    readCookie,
    verifyLoginEvent,
} from '../src/debug-auth';

const LOGIN_URL = 'https://bot.example.workers.dev/debug/login';
const NOW = 1_790_000_000;

const adminKey = generateSecretKey();
const adminPubkey = getPublicKey(adminKey);

function signLogin(
    overrides: { kind?: number; createdAt?: number; url?: string; method?: string } = {},
    key: Uint8Array = adminKey
) {
    return finalizeEvent(
        {
            kind: overrides.kind ?? NIP98_KIND,
            created_at: overrides.createdAt ?? NOW,
            tags: [
                ['u', overrides.url ?? LOGIN_URL],
                ['method', overrides.method ?? 'POST'],
            ],
            content: '',
        },
        key
    );
}

const expected = { url: LOGIN_URL, method: 'POST', now: NOW };

/** Storage stand-in holding sessions and used login events in memory. */
function createStorage() {
    const sessions = new Map<string, { pubkey: string; expiresAt: number }>();
    const usedEvents = new Set<string>();
    return {
        sessions,
        storage: {
            async claimDebugLoginEvent(eventId: string): Promise<boolean> {
                if (usedEvents.has(eventId)) return false;
                usedEvents.add(eventId);
                return true;
            },
            async createDebugSession(
                tokenHash: string,
                pubkey: string,
                _createdAt: number,
                expiresAt: number
            ): Promise<void> {
                sessions.set(tokenHash, { pubkey, expiresAt });
            },
            async getDebugSessionPubkey(
                tokenHash: string,
                now: number
            ): Promise<string | undefined> {
                const session = sessions.get(tokenHash);
                return session && session.expiresAt > now ? session.pubkey : undefined;
            },
        } as any,
    };
}

function requestWithCookie(token?: string): Request {
    return new Request('https://bot.example.workers.dev/debug', {
        headers: token ? { cookie: `other=1; ${SESSION_COOKIE}=${token}` } : {},
    });
}

describe('debug auth', () => {
    it('only allows the configured npub by default', () => {
        expect(DEBUG_ADMIN_PUBKEY).toBe(
            '46f3c7bb33cc3019049b76dc89dbb96e34c247bdda68b6ad8632682793ff8a1a'
        );

        // A correctly signed event from any other key is refused.
        const result = verifyLoginEvent(signLogin(), expected);
        expect(result).toEqual({ ok: false, reason: 'pubkey not allowed' });
    });

    it('accepts a fresh, correctly signed NIP-98 event from the allowed key', () => {
        const result = verifyLoginEvent(signLogin(), expected, adminPubkey);
        expect(result.ok).toBe(true);
    });

    it.each([
        ['wrong event kind', { kind: 1 }],
        ['event expired', { createdAt: NOW - 61 }],
        ['event expired', { createdAt: NOW + 61 }],
        ['url mismatch', { url: 'https://evil.example/debug/login' }],
        ['url mismatch', { url: 'https://bot.example.workers.dev/other' }],
        ['method mismatch', { method: 'GET' }],
    ])('rejects: %s', (reason, overrides) => {
        const result = verifyLoginEvent(signLogin(overrides), expected, adminPubkey);
        expect(result).toEqual({ ok: false, reason });
    });

    it('rejects a tampered event or a bad signature', () => {
        const tampered = { ...signLogin(), content: 'changed' };
        expect(verifyLoginEvent(tampered, expected, adminPubkey)).toEqual({
            ok: false,
            reason: 'invalid signature',
        });

        const event = signLogin();
        const badSig = { ...event, sig: event.sig.replace(/^./, event.sig[0] === 'a' ? 'b' : 'a') };
        expect(verifyLoginEvent(badSig, expected, adminPubkey)).toEqual({
            ok: false,
            reason: 'invalid signature',
        });
    });

    it('rejects malformed input', () => {
        expect(verifyLoginEvent(null, expected, adminPubkey).ok).toBe(false);
        expect(verifyLoginEvent({ kind: NIP98_KIND }, expected, adminPubkey).ok).toBe(false);
    });

    it('creates a session once per login event and refuses replays', async () => {
        const { storage, sessions } = createStorage();
        const event = signLogin();

        const first = await createLoginSession(storage, event, LOGIN_URL, NOW, adminPubkey);
        expect(first.ok).toBe(true);
        expect(sessions.size).toBe(1);
        // Only the hash of the token is stored.
        if (first.ok) {
            expect(sessions.has(first.token)).toBe(false);
            expect(sessions.has(await hashToken(first.token))).toBe(true);
        }

        const replay = await createLoginSession(storage, event, LOGIN_URL, NOW, adminPubkey);
        expect(replay).toEqual({ ok: false, reason: 'event already used' });
    });

    it('validates sessions by cookie, expiry and pubkey', async () => {
        const { storage } = createStorage();
        const login = await createLoginSession(storage, signLogin(), LOGIN_URL, NOW, adminPubkey);
        if (!login.ok) throw new Error('login failed');

        expect(
            await hasValidSession(requestWithCookie(login.token), storage, NOW, adminPubkey)
        ).toBe(true);
        // The session belongs to adminPubkey, not to the real admin key.
        expect(await hasValidSession(requestWithCookie(login.token), storage, NOW)).toBe(false);
        expect(await hasValidSession(requestWithCookie(), storage, NOW, adminPubkey)).toBe(false);
        expect(await hasValidSession(requestWithCookie('nope'), storage, NOW, adminPubkey)).toBe(
            false
        );
        expect(
            await hasValidSession(
                requestWithCookie(login.token),
                storage,
                NOW + 13 * 60 * 60,
                adminPubkey
            )
        ).toBe(false);
    });

    it('builds a hardened session cookie and reads cookies', () => {
        const cookie = buildSessionCookie('abc', 3600);
        expect(cookie).toContain(`${SESSION_COOKIE}=abc`);
        expect(cookie).toContain('HttpOnly');
        expect(cookie).toContain('Secure');
        expect(cookie).toContain('SameSite=Strict');
        expect(cookie).toContain('Path=/debug');
        expect(readCookie(requestWithCookie('tok=en'), SESSION_COOKIE)).toBe('tok=en');
    });
});

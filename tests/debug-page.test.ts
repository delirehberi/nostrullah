import { beforeEach, describe, expect, it, vi } from 'vitest';
import { finalizeEvent, generateSecretKey } from 'nostr-tools';

const { getAccounts } = vi.hoisted(() => ({ getAccounts: vi.fn() }));
vi.mock('../src/config', () => ({ getAccounts }));

import { handleDebugRequest, isDebugPath, renderRun } from '../src/debug-page';
import { DEBUG_ADMIN_PUBKEY, NIP98_KIND, SESSION_COOKIE } from '../src/debug-auth';

const ORIGIN = 'https://bot.example.workers.dev';

const RUN_ROW = {
    id: 'run-abc',
    account_id: 1,
    account_name: 'Bilim Bot',
    started_at: 1_790_000_000,
    duration_ms: 4200,
    outcome: 'published',
    summary: 'Published tip from rss(https://example.com/feed)',
    post_format: 'tip',
    event_id: 'a'.repeat(64),
    details: JSON.stringify({
        schedule: {
            frequency: 'daily',
            timezone: 'Europe/Istanbul',
            lastRunAt: 0,
            due: true,
        },
        resources: {
            configured: 1,
            alreadyShared: 3,
            attempts: [
                { resource: 'rss(https://example.com/feed)', status: 'used', durationMs: 120 },
            ],
            sourceUrl: 'https://example.com/a/',
            sourceTitle: 'Article <A>',
        },
        generation: {
            maxLength: 500,
            selectedAttempt: 1,
            fallback: false,
            attempts: [
                {
                    content: 'too similar draft',
                    length: 17,
                    tooLong: false,
                    invalidUrls: [],
                    similarity: { score: 0.91, reason: 'same story', previousPost: 'old post' },
                },
                {
                    content: '<script>alert(1)</script> final post',
                    length: 30,
                    tooLong: false,
                    invalidUrls: [],
                },
            ],
        },
        publish: {
            configuredRelays: ['wss://relay.example'],
            discoveredRelays: [],
            hashtags: ['bilim'],
            eventId: 'a'.repeat(64),
            relays: [
                { relay: 'wss://relay.example', ok: true },
                { relay: 'wss://down.example', ok: false, error: 'timeout' },
            ],
            queuedForRetry: false,
        },
    }),
};

function createDb(options: { sessionPubkey?: string } = {}) {
    const statements: Array<{ sql: string; values: unknown[] }> = [];
    const db = {
        prepare(sql: string) {
            const statement = { sql, values: [] as unknown[] };
            statements.push(statement);
            const api = {
                bind(...values: unknown[]) {
                    statement.values = values;
                    return api;
                },
                async first() {
                    if (sql.includes('FROM debug_sessions')) {
                        return options.sessionPubkey ? { pubkey: options.sessionPubkey } : null;
                    }
                    if (sql.includes('FROM run_log WHERE id')) {
                        return statement.values[0] === RUN_ROW.id ? RUN_ROW : null;
                    }
                    return null;
                },
                async all() {
                    if (sql.startsWith('SELECT * FROM run_log')) return { results: [RUN_ROW] };
                    if (sql.includes('COUNT(*)')) {
                        return {
                            results: [
                                {
                                    account_id: 1,
                                    account_name: 'Bilim Bot',
                                    outcome: 'published',
                                    count: 4,
                                },
                            ],
                        };
                    }
                    if (sql.includes('post_format, details')) {
                        return {
                            results: [
                                {
                                    account_id: 1,
                                    post_format: 'tip',
                                    details: RUN_ROW.details,
                                },
                            ],
                        };
                    }
                    return { results: [] };
                },
                async run() {
                    return { success: true, meta: { changes: 1 } };
                },
            };
            return api;
        },
    };
    return { env: { DB: db } as any, statements };
}

function request(path: string, init: RequestInit & { cookie?: boolean } = {}): Request {
    const headers = new Headers(init.headers);
    if (init.cookie) headers.set('cookie', `${SESSION_COOKIE}=token123`);
    return new Request(`${ORIGIN}${path}`, { ...init, headers });
}

describe('debug page', () => {
    beforeEach(() => {
        getAccounts.mockReset();
        getAccounts.mockResolvedValue([
            {
                id: 1,
                name: 'Bilim Bot',
                privateKey: 'nsec-must-not-leak',
                relays: [],
                categories: [],
                frequency: 'daily',
                timezone: 'Europe/Istanbul',
                active_hours: '07:00-23:00',
                jitter_hours: 1,
                is_active: true,
                last_run_at: 0,
            },
        ]);
    });

    it('matches only debug paths', () => {
        expect(isDebugPath('/debug')).toBe(true);
        expect(isDebugPath('/debug/run/x')).toBe(true);
        expect(isDebugPath('/debugger')).toBe(false);
        expect(isDebugPath('/')).toBe(false);
    });

    it('shows the Nostr login page without a session', async () => {
        const { env } = createDb();
        const response = await handleDebugRequest(request('/debug'), env);
        const html = await response.text();

        expect(response.status).toBe(401);
        expect(html).toContain('Login with Nostr');
        expect(html).toContain(DEBUG_ADMIN_PUBKEY);
        expect(html).not.toContain('Bilim Bot');

        const csp = response.headers.get('content-security-policy') || '';
        const nonce = csp.match(/'nonce-([^']+)'/)?.[1];
        expect(nonce).toBeTruthy();
        expect(html).toContain(`<script nonce="${nonce}">`);
        expect(response.headers.get('cache-control')).toBe('no-store');
    });

    it('requires a session for raw run JSON', async () => {
        const { env } = createDb();
        const response = await handleDebugRequest(request('/debug/run/run-abc'), env);
        expect(response.status).toBe(401);
    });

    it('rejects a session that belongs to another pubkey', async () => {
        const { env } = createDb({ sessionPubkey: 'b'.repeat(64) });
        const response = await handleDebugRequest(request('/debug', { cookie: true }), env);
        expect(response.status).toBe(401);
    });

    it('refuses a login signed by any other key', async () => {
        const { env, statements } = createDb();
        const event = finalizeEvent(
            {
                kind: NIP98_KIND,
                created_at: Math.floor(Date.now() / 1000),
                tags: [
                    ['u', `${ORIGIN}/debug/login`],
                    ['method', 'POST'],
                ],
                content: '',
            },
            generateSecretKey()
        );
        const response = await handleDebugRequest(
            request('/debug/login', {
                method: 'POST',
                headers: { 'content-type': 'application/json', origin: ORIGIN },
                body: JSON.stringify({ event }),
            }),
            env
        );

        expect(response.status).toBe(401);
        expect(await response.json()).toEqual({ error: 'pubkey not allowed' });
        expect(response.headers.get('set-cookie')).toBeNull();
        expect(statements.some((s) => s.sql.includes('INSERT INTO debug_sessions'))).toBe(false);
    });

    it('refuses cross-origin posts', async () => {
        const { env } = createDb();
        const response = await handleDebugRequest(
            request('/debug/login', {
                method: 'POST',
                headers: { origin: 'https://evil.example' },
                body: '{}',
            }),
            env
        );
        expect(response.status).toBe(403);
    });

    it('renders runs for the admin session without leaking secrets', async () => {
        const { env } = createDb({ sessionPubkey: DEBUG_ADMIN_PUBKEY });
        const response = await handleDebugRequest(request('/debug', { cookie: true }), env);
        const html = await response.text();

        expect(response.status).toBe(200);
        expect(html).toContain('Bilim Bot');
        expect(html).toContain('Published tip from rss(https://example.com/feed)');
        expect(html).toContain('too similar 0.91');
        expect(html).toContain('same story');
        expect(html).toContain('1/2 relays accepted the event.');
        expect(html).toContain('https://njump.me/note1');
        // Post text and titles are escaped.
        expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt; final post');
        expect(html).not.toContain('<script>alert(1)</script>');
        expect(html).toContain('Article &lt;A&gt;');
        expect(html).not.toContain('nsec-must-not-leak');
    });

    it('excludes skipped runs by default and applies filters', async () => {
        const { env, statements } = createDb({ sessionPubkey: DEBUG_ADMIN_PUBKEY });
        await handleDebugRequest(request('/debug', { cookie: true }), env);
        const defaultQuery = statements.find((s) => s.sql.startsWith('SELECT * FROM run_log'));
        expect(defaultQuery?.sql).toContain("outcome != 'skipped'");

        statements.length = 0;
        await handleDebugRequest(
            request('/debug?account=1&outcome=skipped&page=2', { cookie: true }),
            env
        );
        const filtered = statements.find((s) => s.sql.startsWith('SELECT * FROM run_log'));
        expect(filtered?.sql).toContain('account_id = ?');
        expect(filtered?.sql).toContain('outcome = ?');
        expect(filtered?.values).toEqual([1, 'skipped', 51, 100]);
    });

    it('returns raw run JSON for the admin session', async () => {
        const { env } = createDb({ sessionPubkey: DEBUG_ADMIN_PUBKEY });
        const response = await handleDebugRequest(
            request('/debug/run/run-abc', { cookie: true }),
            env
        );
        const body: any = await response.json();
        expect(response.status).toBe(200);
        expect(body.id).toBe('run-abc');
        expect(body.details.publish.relays).toHaveLength(2);

        const missing = await handleDebugRequest(
            request('/debug/run/unknown', { cookie: true }),
            env
        );
        expect(missing.status).toBe(404);
    });

    it('logs out by deleting the session and clearing the cookie', async () => {
        const { env, statements } = createDb({ sessionPubkey: DEBUG_ADMIN_PUBKEY });
        const response = await handleDebugRequest(
            request('/debug/logout', { method: 'POST', cookie: true }),
            env
        );
        expect(response.status).toBe(303);
        expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
        expect(statements.some((s) => s.sql.includes('DELETE FROM debug_sessions'))).toBe(true);
    });

    it('renders a skipped run with its schedule decision', () => {
        const html = renderRun({
            id: 'run-skip',
            accountId: 1,
            accountName: 'Bilim Bot',
            startedAt: 1_790_000_000,
            durationMs: 3,
            outcome: 'skipped',
            summary: 'Not due yet',
            details: {
                schedule: {
                    frequency: 'twice_a_day',
                    timezone: 'Europe/Istanbul',
                    activeHours: '07:00-23:00',
                    jitterHours: 1,
                    lastRunAt: 1_789_990_000,
                    due: false,
                    nextRunAt: 1_790_010_000_000,
                },
            },
        });
        expect(html).toContain('Not due, skipped');
        expect(html).toContain('twice_a_day');
        expect(html).toContain('Next slot');
    });
});

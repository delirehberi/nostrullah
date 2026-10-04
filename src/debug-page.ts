import { nip19 } from 'nostr-tools';

import { Env, NostrAccount } from './types';
import { getAccounts } from './config';
import { StorageService, RunOutcomeCount } from './storage';
import { SchedulerService } from './scheduler';
import { RunOutcome, RunTraceDetails, RunTraceRecord, countRejectionReasons } from './run-trace';
import {
    DEBUG_ADMIN_NPUB,
    DEBUG_ADMIN_PUBKEY,
    NIP98_KIND,
    SESSION_TTL_SECONDS,
    buildSessionCookie,
    createLoginSession,
    destroySession,
    hasValidSession,
} from './debug-auth';

const PAGE_SIZE = 50;
const SUMMARY_WINDOW_SECONDS = 7 * 24 * 60 * 60;
const RUN_OUTCOMES: RunOutcome[] = ['published', 'queued', 'failed', 'error', 'skipped'];

/** Account fields the page may show; never includes the private key. */
export interface AccountInfo {
    id: number;
    name: string;
    timezone: string;
    isActive: boolean;
    frequency: string;
    activeHours?: string;
    nextRunAt?: number;
}

export function isDebugPath(pathname: string): boolean {
    return pathname === '/debug' || pathname.startsWith('/debug/');
}

/**
 * Routes `/debug*` requests. Every route except login requires a session of
 * `DEBUG_ADMIN_NPUB` (see `src/debug-auth.ts`).
 */
export async function handleDebugRequest(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const storage = new StorageService(env);
    const now = Math.floor(Date.now() / 1000);
    const nonce = randomNonce();

    if (request.method === 'POST' && !isSameOrigin(request, url)) {
        return jsonResponse({ error: 'cross-origin request' }, 403);
    }

    if (url.pathname === '/debug/login' && request.method === 'POST') {
        return handleLogin(request, storage, now);
    }

    if (url.pathname === '/debug/logout' && request.method === 'POST') {
        await destroySession(request, storage);
        return new Response(null, {
            status: 303,
            headers: { location: '/debug', 'set-cookie': buildSessionCookie('', 0) },
        });
    }

    const loggedIn = await hasValidSession(request, storage, now);
    const runMatch = url.pathname.match(/^\/debug\/run\/([A-Za-z0-9-]+)$/);

    if (runMatch && request.method === 'GET') {
        if (!loggedIn) return jsonResponse({ error: 'login required' }, 401);
        const run = await storage.getRun(runMatch[1]);
        return run ? jsonResponse(run, 200) : jsonResponse({ error: 'not found' }, 404);
    }

    if (url.pathname === '/debug' && request.method === 'GET') {
        if (!loggedIn) return htmlResponse(renderLoginPage(nonce), nonce, 401);
        try {
            return htmlResponse(await renderDashboard(env, storage, url, now, nonce), nonce, 200);
        } catch (error) {
            console.error('Failed to render debug page:', error);
            const message = error instanceof Error ? error.message : String(error);
            return htmlResponse(
                renderShell(
                    'Error',
                    `<main class="wrap"><p class="notice error">Could not load run data: ${esc(message)}. ` +
                        'Is migration 0006 applied?</p></main>',
                    nonce
                ),
                nonce,
                500
            );
        }
    }

    return jsonResponse({ error: 'not found' }, 404);
}

async function handleLogin(
    request: Request,
    storage: StorageService,
    now: number
): Promise<Response> {
    let body: unknown;
    try {
        body = await request.json();
    } catch {
        return jsonResponse({ error: 'invalid JSON body' }, 400);
    }

    const event = (body as { event?: unknown } | null)?.event;
    try {
        const result = await createLoginSession(storage, event, request.url, now);
        if (!result.ok) {
            console.warn(`Debug login refused: ${result.reason}`);
            return jsonResponse({ error: result.reason }, 401);
        }
        return jsonResponse({ ok: true }, 200, {
            'set-cookie': buildSessionCookie(result.token, SESSION_TTL_SECONDS),
        });
    } catch (error) {
        console.error('Debug login failed:', error);
        return jsonResponse({ error: 'login failed' }, 500);
    }
}

async function renderDashboard(
    env: Env,
    storage: StorageService,
    url: URL,
    now: number,
    nonce: string
): Promise<string> {
    const accounts = (await getAccounts(env, { includeInactive: true }))
        .filter((account): account is NostrAccount & { id: number } => account.id !== undefined)
        .map(toAccountInfo);
    const accountsById = new Map(accounts.map((account) => [account.id, account]));

    const accountParam = Number.parseInt(url.searchParams.get('account') || '', 10);
    const accountId = Number.isFinite(accountParam) ? accountParam : undefined;
    const outcomeParam = url.searchParams.get('outcome') || '';
    const outcome = RUN_OUTCOMES.find((value) => value === outcomeParam);
    const page = Math.max(0, Number.parseInt(url.searchParams.get('page') || '0', 10) || 0);

    const since = now - SUMMARY_WINDOW_SECONDS;
    const [runs, outcomeCounts, generatedRuns] = await Promise.all([
        storage.listRuns({
            accountId,
            outcome,
            excludeSkipped: outcomeParam === '',
            limit: PAGE_SIZE + 1,
            offset: page * PAGE_SIZE,
        }),
        storage.getRunOutcomeCounts(since),
        storage.getGeneratedRunDetails(since),
    ]);

    const hasMore = runs.length > PAGE_SIZE;
    const visibleRuns = runs.slice(0, PAGE_SIZE);

    const body = `
<header class="topbar">
    <div class="wrap topbar-inner">
        <div class="brand"><span class="dot" aria-hidden="true"></span> Nostrullah debug</div>
        <form method="post" action="/debug/logout" class="logout">
            <span class="muted mono" title="${esc(DEBUG_ADMIN_NPUB)}">${esc(shortNpub(DEBUG_ADMIN_NPUB))}</span>
            <button type="submit" class="btn ghost">Log out</button>
        </form>
    </div>
</header>
<main class="wrap">
    ${renderSummary(accounts, outcomeCounts, generatedRuns, now)}
    ${renderFilters(accounts, accountId, outcomeParam)}
    <section aria-label="Runs">
        ${
            visibleRuns.length === 0
                ? '<p class="notice">No runs match these filters yet. Runs are logged on every hourly cron tick once migration 0006 is applied.</p>'
                : `<ol class="runs">${visibleRuns
                      .map((run) => renderRun(run, accountsById.get(run.accountId ?? -1)))
                      .join('')}</ol>`
        }
        ${renderPager(url, page, hasMore)}
    </section>
</main>`;

    return renderShell('Nostrullah debug', body, nonce);
}

function renderSummary(
    accounts: AccountInfo[],
    counts: RunOutcomeCount[],
    generatedRuns: Array<{
        accountId: number | null;
        postFormat?: string;
        details: RunTraceDetails;
    }>,
    now: number
): string {
    if (accounts.length === 0) {
        return '<p class="notice">No accounts configured.</p>';
    }

    const cards = accounts.map((account) => {
        const outcomeCounts = Object.fromEntries(
            RUN_OUTCOMES.map((outcome) => [
                outcome,
                counts
                    .filter((c) => c.accountId === account.id && c.outcome === outcome)
                    .reduce((sum, c) => sum + c.count, 0),
            ])
        ) as Record<RunOutcome, number>;
        const runs = generatedRuns.filter((run) => run.accountId === account.id);
        const formats: Record<string, number> = {};
        for (const run of runs) {
            if (run.postFormat) formats[run.postFormat] = (formats[run.postFormat] || 0) + 1;
        }
        const rejections = countRejectionReasons(runs.map((run) => run.details));

        const nextRun =
            account.nextRunAt !== undefined
                ? account.nextRunAt <= now * 1000
                    ? 'due now'
                    : `${formatTime(Math.floor(account.nextRunAt / 1000), account.timezone)} (${relative(Math.floor(account.nextRunAt / 1000), now)})`
                : 'unknown';

        return `
<article class="card account">
    <header class="card-head">
        <h2>${esc(account.name)}</h2>
        <span class="chip ${account.isActive ? 'ok' : 'muted-chip'}">${account.isActive ? 'active' : 'inactive'}</span>
    </header>
    <p class="muted small">${esc(account.frequency)} · ${esc(account.timezone)} · ${esc(account.activeHours || 'all day')}</p>
    <p class="small">Next slot: <strong>${esc(nextRun)}</strong></p>
    <div class="stats">
        ${RUN_OUTCOMES.map(
            (outcome) =>
                `<div class="stat"><span class="stat-num">${outcomeCounts[outcome]}</span><span class="stat-label"><span class="chip-dot ${outcomeClass(outcome)}"></span>${outcome}</span></div>`
        ).join('')}
    </div>
    ${renderCountList('Formats (7d)', formats)}
    ${renderCountList('Draft rejections (7d)', rejections)}
</article>`;
    });

    return `<section class="summary" aria-label="Accounts, last 7 days">${cards.join('')}</section>`;
}

function renderCountList(title: string, counts: Record<string, number>): string {
    const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    if (entries.length === 0) {
        return `<p class="small muted">${esc(title)}: none</p>`;
    }
    return `<p class="small"><span class="muted">${esc(title)}:</span> ${entries
        .map(([key, count]) => `<span class="tag">${esc(key)} <b>${count}</b></span>`)
        .join(' ')}</p>`;
}

function renderFilters(
    accounts: AccountInfo[],
    accountId: number | undefined,
    outcomeParam: string
): string {
    const outcomeOptions: Array<[string, string]> = [
        ['', 'All except skipped'],
        ['all', 'All, including skipped'],
        ...RUN_OUTCOMES.map((outcome): [string, string] => [outcome, outcome]),
    ];
    return `
<form class="filters" method="get" action="/debug">
    <label>Account
        <select name="account">
            <option value="">All accounts</option>
            ${accounts
                .map(
                    (account) =>
                        `<option value="${account.id}"${account.id === accountId ? ' selected' : ''}>${esc(account.name)}</option>`
                )
                .join('')}
        </select>
    </label>
    <label>Outcome
        <select name="outcome">
            ${outcomeOptions
                .map(
                    ([value, label]) =>
                        `<option value="${value}"${value === outcomeParam ? ' selected' : ''}>${esc(label)}</option>`
                )
                .join('')}
        </select>
    </label>
    <button type="submit" class="btn">Apply</button>
</form>`;
}

function renderPager(url: URL, page: number, hasMore: boolean): string {
    const link = (target: number, label: string): string => {
        const next = new URL(url.toString());
        next.searchParams.set('page', String(target));
        return `<a class="btn ghost" href="${esc(next.pathname + next.search)}">${label}</a>`;
    };
    const parts: string[] = [];
    if (page > 0) parts.push(link(page - 1, '← Newer'));
    if (hasMore) parts.push(link(page + 1, 'Older →'));
    return parts.length > 0 ? `<nav class="pager">${parts.join('')}</nav>` : '';
}

/** One run as a collapsible card: summary row plus each pipeline step. */
export function renderRun(run: RunTraceRecord, account?: AccountInfo): string {
    const timezone = run.details.schedule?.timezone || account?.timezone || 'UTC';
    const d = run.details;

    return `
<li>
<details class="run ${outcomeClass(run.outcome)}">
    <summary>
        <span class="run-time mono">${esc(formatTime(run.startedAt, timezone))}</span>
        <span class="chip ${outcomeClass(run.outcome)}">${esc(run.outcome)}</span>
        <span class="run-account">${esc(run.accountName || account?.name || `#${run.accountId ?? '?'}`)}</span>
        <span class="run-summary">${esc(run.summary)}</span>
        ${run.postFormat ? `<span class="tag">${esc(run.postFormat)}</span>` : ''}
        <span class="run-duration muted mono">${formatDuration(run.durationMs)}</span>
    </summary>
    <div class="steps">
        ${renderScheduleStep(d, timezone)}
        ${d.resources ? renderResourcesStep(d.resources) : ''}
        ${d.format ? renderFormatStep(d.format) : ''}
        ${d.history ? renderHistoryStep(d.history) : ''}
        ${d.generation ? renderGenerationStep(d.generation) : ''}
        ${d.publish ? renderPublishStep(d.publish, d.retry, timezone) : ''}
        ${d.error ? renderStep('Error', 'error', `<p>Failed during <b>${esc(d.error.stage)}</b>:</p><pre>${esc(d.error.message)}</pre>`) : ''}
        <p class="small"><a href="/debug/run/${esc(run.id)}">Raw JSON</a> <span class="muted mono">${esc(run.id)}</span></p>
    </div>
</details>
</li>`;
}

function renderStep(title: string, status: string, content: string): string {
    return `<section class="step"><h3><span class="chip-dot ${status}"></span>${esc(title)}</h3>${content}</section>`;
}

function renderScheduleStep(d: RunTraceDetails, timezone: string): string {
    const s = d.schedule;
    if (!s) return '';
    const rows: Array<[string, string]> = [
        ['Decision', s.due ? 'Due, processing' : 'Not due, skipped'],
        ['Frequency', s.frequency],
        ['Timezone', s.timezone || 'default'],
        ['Active hours', s.activeHours || 'all day'],
        ['Jitter', `${s.jitterHours ?? 0}h`],
        ['Last run', s.lastRunAt ? formatTime(s.lastRunAt, timezone) : 'never'],
    ];
    if (s.nextRunAt) {
        rows.push(['Next slot', formatTime(Math.floor(s.nextRunAt / 1000), timezone)]);
    }
    return renderStep('Schedule', s.due ? 'ok' : 'skipped', renderKeyValues(rows));
}

function renderResourcesStep(r: NonNullable<RunTraceDetails['resources']>): string {
    const attempts =
        r.attempts.length === 0
            ? '<p class="muted small">No resource was tried.</p>'
            : `<table><thead><tr><th>#</th><th>Resource</th><th>Result</th><th>Time</th></tr></thead><tbody>${r.attempts
                  .map(
                      (a, i) =>
                          `<tr><td>${i + 1}</td><td class="mono break">${esc(a.resource)}</td><td><span class="chip ${a.status === 'used' ? 'ok' : a.status === 'error' ? 'error' : 'skipped'}">${esc(a.status === 'empty' ? 'nothing new' : a.status)}</span>${a.error ? ` <span class="small">${esc(a.error)}</span>` : ''}</td><td class="mono">${formatDuration(a.durationMs)}</td></tr>`
                  )
                  .join('')}</tbody></table>`;
    const source = r.sourceUrl
        ? `<p>Source item: ${safeLink(r.sourceUrl, r.sourceTitle || r.sourceUrl)}</p>`
        : r.contextPreview
          ? '<p class="small muted">Context without a source link.</p>'
          : '<p class="small muted">Generated without resource context.</p>';
    const preview = r.contextPreview
        ? `<details class="inner"><summary>Context given to the AI</summary><pre>${esc(r.contextPreview)}</pre></details>`
        : '';
    const used = r.attempts.some((a) => a.status === 'used');
    return renderStep(
        'Resources',
        used ? 'ok' : 'skipped',
        `<p class="small muted">${r.configured} configured · ${r.alreadyShared} items already shared (skipped)</p>${attempts}${source}${preview}`
    );
}

function renderFormatStep(f: NonNullable<RunTraceDetails['format']>): string {
    if (!f.enabled) {
        return renderStep(
            'Format',
            'skipped',
            '<p class="small muted">Rotation off: custom prompt template without <code>$$FORMAT$$</code>, or no format weights.</p>'
        );
    }
    const weights = Object.entries(f.weights || {}).filter(([, weight]) => weight !== undefined);
    const max = Math.max(1, ...weights.map(([, weight]) => weight || 0));
    const bars = weights
        .map(
            ([format, weight]) =>
                `<div class="weight${format === f.selected ? ' selected' : ''}"><span class="mono">${esc(format)}</span><meter min="0" max="${max}" value="${weight}"></meter><span class="mono small">${formatNumber(weight || 0)}</span></div>`
        )
        .join('');
    const notes = [
        `Weights: ${f.weightSource === 'custom' ? 'account setting' : 'defaults adjusted by engagement'}`,
        `previous format: ${f.lastFormat || 'none'} (avoided)`,
        f.hasLinkContext ? 'link available' : 'no link, news_commentary not eligible',
    ];
    return renderStep(
        'Format',
        f.selected ? 'ok' : 'skipped',
        `<p>Selected: <b>${esc(f.selected || 'none eligible')}</b></p><div class="weights">${bars}</div><p class="small muted">${esc(notes.join(' · '))}</p>`
    );
}

function renderHistoryStep(h: NonNullable<RunTraceDetails['history']>): string {
    const top =
        h.topPosts.length > 0
            ? `<details class="inner"><summary>${h.topPosts.length} top posts given as examples</summary>${h.topPosts.map((post) => `<blockquote>${esc(post)}</blockquote>`).join('')}</details>`
            : '<p class="small muted">No top posts given as examples.</p>';
    return renderStep(
        'Context',
        'ok',
        `<p class="small muted">${h.recentPosts} recent posts used for the prompt and similarity check.</p>${top}`
    );
}

function renderGenerationStep(g: NonNullable<RunTraceDetails['generation']>): string {
    const drafts = g.attempts
        .map((attempt, index) => {
            const selected = index === g.selectedAttempt;
            const reasons: string[] = [];
            if (attempt.similarity) {
                reasons.push(
                    `<span class="chip warn">too similar ${formatNumber(attempt.similarity.score)}</span>`
                );
            }
            if (attempt.tooLong) reasons.push('<span class="chip warn">too long</span>');
            if (attempt.promptLeak) reasons.push('<span class="chip error">prompt leak</span>');
            if (attempt.invalidUrls.length > 0) {
                reasons.push('<span class="chip error">invalid URLs</span>');
            }
            if (selected) {
                reasons.unshift(
                    `<span class="chip ok">${g.fallback ? 'published (fallback)' : 'published'}</span>`
                );
            }
            const extra: string[] = [];
            if (attempt.similarity) {
                extra.push(
                    `<p class="small">${esc(attempt.similarity.reason)}</p><details class="inner"><summary>Matched earlier post</summary><blockquote>${esc(attempt.similarity.previousPost)}</blockquote></details>`
                );
            }
            if (attempt.promptLeak) extra.push(`<p class="small">${esc(attempt.promptLeak)}</p>`);
            if (attempt.invalidUrls.length > 0) {
                extra.push(
                    `<p class="small mono break">${attempt.invalidUrls.map(esc).join('<br>')}</p>`
                );
            }
            return `
<div class="draft${selected ? ' selected' : ''}">
    <div class="draft-head"><b>Draft ${index + 1}</b> <span class="muted small mono">${attempt.length}${g.maxLength ? `/${g.maxLength}` : ''} chars</span> ${reasons.join(' ')}</div>
    <blockquote>${esc(attempt.content)}</blockquote>
    ${extra.join('')}
</div>`;
        })
        .join('');
    const note = g.fallback
        ? '<p class="small notice">Every draft was rejected; the best safe one was published.</p>'
        : '';
    return renderStep('Drafts', g.fallback ? 'warn' : 'ok', `${note}${drafts}`);
}

function renderPublishStep(
    p: NonNullable<RunTraceDetails['publish']>,
    retry: RunTraceDetails['retry'],
    timezone: string
): string {
    const okCount = p.relays.filter((relay) => relay.ok).length;
    const relays = p.relays
        .map(
            (relay) =>
                `<li><span class="chip-dot ${relay.ok ? 'ok' : 'error'}"></span><span class="mono break">${esc(relay.relay)}</span>${p.discoveredRelays.includes(relay.relay) && !p.configuredRelays.includes(relay.relay) ? ' <span class="tag">NIP-65</span>' : ''}${relay.error ? ` <span class="small muted">${esc(relay.error)}</span>` : ''}</li>`
        )
        .join('');
    const event = p.eventId
        ? `<p>Event: ${safeLink(`https://njump.me/${nip19.noteEncode(p.eventId)}`, nip19.noteEncode(p.eventId))}</p>`
        : '';
    const hashtags =
        p.hashtags.length > 0
            ? `<p class="small">Hashtags: ${p.hashtags.map((tag) => `<span class="tag">#${esc(tag)}</span>`).join(' ')}</p>`
            : '';
    const retryInfo = retry
        ? `<p class="small">Retry at ${esc(formatTime(retry.at, timezone))}: <b>${retry.published ? 'published' : 'failed again'}</b> (${retry.relays.filter((r) => r.ok).length}/${retry.relays.length} relays)</p>`
        : p.queuedForRetry
          ? '<p class="small">Queued for retry.</p>'
          : '';
    return renderStep(
        'Publish',
        okCount > 0 ? 'ok' : 'error',
        `<p>${okCount}/${p.relays.length} relays accepted the event.</p>${event}${hashtags}<ul class="relays">${relays}</ul>${retryInfo}`
    );
}

function renderKeyValues(rows: Array<[string, string]>): string {
    return `<dl class="kv">${rows.map(([key, value]) => `<dt>${esc(key)}</dt><dd>${esc(value)}</dd>`).join('')}</dl>`;
}

export function renderLoginPage(nonce: string): string {
    const body = `
<main class="login">
    <div class="card login-card">
        <div class="brand"><span class="dot" aria-hidden="true"></span> Nostrullah debug</div>
        <p>Sign in with your Nostr browser extension (NIP-07). Only one key is allowed:</p>
        <p class="mono small break">${esc(DEBUG_ADMIN_NPUB)}</p>
        <button id="login" type="button" class="btn">Login with Nostr</button>
        <p id="login-message" class="small" role="status"></p>
    </div>
</main>
<script nonce="${nonce}">
(function () {
    var button = document.getElementById('login');
    var message = document.getElementById('login-message');
    var allowed = ${JSON.stringify(DEBUG_ADMIN_PUBKEY)};
    button.addEventListener('click', async function () {
        message.textContent = '';
        if (!window.nostr) {
            message.textContent = 'No Nostr extension found. Install Alby, nos2x or another NIP-07 signer.';
            return;
        }
        button.disabled = true;
        try {
            var pubkey = await window.nostr.getPublicKey();
            if (pubkey !== allowed) {
                message.textContent = 'This key is not allowed to log in.';
                return;
            }
            var loginUrl = location.origin + '/debug/login';
            var event = await window.nostr.signEvent({
                kind: ${NIP98_KIND},
                created_at: Math.floor(Date.now() / 1000),
                tags: [['u', loginUrl], ['method', 'POST']],
                content: ''
            });
            var response = await fetch('/debug/login', {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ event: event })
            });
            var data = await response.json().catch(function () { return {}; });
            if (response.ok) {
                location.reload();
                return;
            }
            message.textContent = 'Login refused: ' + (data.error || response.status);
        } catch (error) {
            message.textContent = 'Signing failed: ' + (error && error.message ? error.message : error);
        } finally {
            button.disabled = false;
        }
    });
})();
</script>`;
    return renderShell('Nostrullah debug login', body, nonce);
}

function renderShell(title: string, body: string, nonce: string): string {
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${esc(title)}</title>
<style nonce="${nonce}">${STYLES}</style>
</head>
<body>${body}</body>
</html>`;
}

const STYLES = `
:root {
    --bg: #f6f7f9; --surface: #ffffff; --surface-2: #f0f2f5; --border: #e2e5ea;
    --text: #1b1f24; --muted: #646d78; --accent: #7c3aed;
    --ok: #15803d; --ok-bg: #dcfce7; --warn: #b45309; --warn-bg: #fef3c7;
    --error: #b91c1c; --error-bg: #fee2e2; --skip: #64748b; --skip-bg: #e2e8f0;
    --queued: #1d4ed8; --queued-bg: #dbeafe;
    color-scheme: light;
}
@media (prefers-color-scheme: dark) {
    :root {
        --bg: #0f1115; --surface: #171a21; --surface-2: #1f232c; --border: #2a2f3a;
        --text: #e6e8ec; --muted: #9aa3ae; --accent: #a78bfa;
        --ok: #4ade80; --ok-bg: #14321f; --warn: #fbbf24; --warn-bg: #3a2c0c;
        --error: #f87171; --error-bg: #3b1515; --skip: #94a3b8; --skip-bg: #232a35;
        --queued: #93c5fd; --queued-bg: #172554;
        color-scheme: dark;
    }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text);
    font: 14px/1.5 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; }
a { color: var(--accent); overflow-wrap: anywhere; }
code, .mono, pre { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
pre { white-space: pre-wrap; word-break: break-word; background: var(--surface-2); padding: 8px 10px; border-radius: 6px; margin: 6px 0; }
.wrap { max-width: 1100px; margin: 0 auto; padding: 0 16px; }
.muted { color: var(--muted); } .small { font-size: 12.5px; } .break { word-break: break-all; }
.topbar { background: var(--surface); border-bottom: 1px solid var(--border); position: sticky; top: 0; z-index: 2; }
.topbar-inner { display: flex; align-items: center; justify-content: space-between; height: 52px; gap: 12px; }
.brand { white-space: nowrap; font-weight: 650; display: flex; align-items: center; gap: 8px; }
.dot { width: 10px; height: 10px; border-radius: 50%; background: var(--accent); display: inline-block; }
.logout { display: flex; align-items: center; gap: 10px; margin: 0; }
.btn { font: inherit; border: 1px solid var(--accent); background: var(--accent); color: #fff; border-radius: 6px; padding: 6px 14px; cursor: pointer; text-decoration: none; display: inline-block; }
.btn.ghost { background: transparent; color: var(--text); border-color: var(--border); }
.btn:disabled { opacity: .6; cursor: wait; }
.card { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 14px 16px; }
.summary { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 12px; margin: 18px 0; }
.card-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.card-head h2 { font-size: 15px; margin: 0; }
.account p { margin: 6px 0; }
.stats { display: grid; grid-template-columns: repeat(5, 1fr); gap: 4px; margin: 10px 0; }
.stat { background: var(--surface-2); border-radius: 6px; padding: 6px 4px; text-align: center; }
.stat-num { display: block; font-size: 17px; font-weight: 650; }
.stat-label { font-size: 11px; color: var(--muted); display: inline-flex; align-items: center; gap: 4px; }
.chip { display: inline-block; font-size: 11.5px; font-weight: 600; padding: 1px 8px; border-radius: 999px; background: var(--skip-bg); color: var(--skip); white-space: nowrap; }
.chip.ok, .chip.published { background: var(--ok-bg); color: var(--ok); }
.chip.warn { background: var(--warn-bg); color: var(--warn); }
.chip.error, .chip.failed { background: var(--error-bg); color: var(--error); }
.chip.queued { background: var(--queued-bg); color: var(--queued); }
.chip-dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; background: var(--skip); margin-right: 6px; flex: none; }
.chip-dot.ok, .chip-dot.published { background: var(--ok); } .chip-dot.warn { background: var(--warn); }
.chip-dot.error, .chip-dot.failed { background: var(--error); } .chip-dot.queued { background: var(--queued); }
.tag { display: inline-block; font-size: 11.5px; padding: 0 6px; border-radius: 4px; background: var(--surface-2); border: 1px solid var(--border); }
.filters { display: flex; flex-wrap: wrap; gap: 12px; align-items: flex-end; margin: 6px 0 14px; }
.filters label { display: flex; flex-direction: column; font-size: 12px; color: var(--muted); gap: 3px; }
select { font: inherit; padding: 5px 8px; border-radius: 6px; border: 1px solid var(--border); background: var(--surface); color: var(--text); }
.runs { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 8px; }
.run { background: var(--surface); border: 1px solid var(--border); border-left: 4px solid var(--skip); border-radius: 8px; }
.run.published { border-left-color: var(--ok); } .run.error, .run.failed { border-left-color: var(--error); } .run.queued { border-left-color: var(--queued); }
.run > summary { cursor: pointer; padding: 10px 12px; display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; list-style: none; }
.run > summary::-webkit-details-marker { display: none; }
.run > summary::before { content: '▸'; color: var(--muted); }
.run[open] > summary::before { content: '▾'; }
.run-account { font-weight: 600; }
.run-summary { flex: 1 1 260px; min-width: 0; }
.steps { border-top: 1px solid var(--border); padding: 4px 14px 12px; }
.step { padding: 10px 0; border-bottom: 1px dashed var(--border); }
.step h3 { font-size: 13px; margin: 0 0 6px; display: flex; align-items: center; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); }
.step p { margin: 6px 0; }
.kv { display: grid; grid-template-columns: max-content 1fr; gap: 2px 14px; margin: 0; font-size: 13px; }
.kv dt { color: var(--muted); } .kv dd { margin: 0; }
table { border-collapse: collapse; width: 100%; font-size: 13px; }
th, td { text-align: left; padding: 4px 8px 4px 0; border-bottom: 1px solid var(--border); vertical-align: top; }
th { color: var(--muted); font-weight: 500; }
blockquote { margin: 6px 0; padding: 8px 12px; background: var(--surface-2); border-left: 3px solid var(--border); border-radius: 4px; white-space: pre-wrap; word-break: break-word; }
.draft { padding: 8px 0; }
.draft.selected blockquote { border-left-color: var(--ok); }
.draft-head { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.weights { display: grid; gap: 3px; max-width: 460px; }
.weight { display: grid; grid-template-columns: 130px 1fr 48px; gap: 8px; align-items: center; font-size: 12.5px; }
.weight.selected span:first-child { font-weight: 700; color: var(--accent); }
meter { width: 100%; height: 10px; }
.relays { list-style: none; padding: 0; margin: 6px 0; font-size: 13px; }
.relays li { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; padding: 2px 0; }
details.inner > summary { cursor: pointer; color: var(--accent); font-size: 12.5px; }
.notice { background: var(--warn-bg); color: var(--text); padding: 10px 12px; border-radius: 8px; }
.notice.error { background: var(--error-bg); }
.pager { display: flex; gap: 8px; justify-content: center; margin: 16px 0 32px; }
.login { min-height: 100vh; display: grid; place-items: center; padding: 16px; }
.login-card { max-width: 420px; width: 100%; }
@media (max-width: 600px) {
    .stats { grid-template-columns: repeat(3, 1fr); }
    .run-duration, .logout .muted { display: none; }
}
`;

function toAccountInfo(account: NostrAccount & { id: number }): AccountInfo {
    let nextRunAt: number | undefined;
    try {
        nextRunAt = SchedulerService.getNextRunTimestamp(
            account.last_run_at || 0,
            SchedulerService.fromAccount(account)
        );
    } catch {
        nextRunAt = undefined;
    }
    return {
        id: account.id,
        name: account.name || `Account #${account.id}`,
        timezone: account.timezone || 'UTC',
        isActive: Boolean(account.is_active),
        frequency: account.frequency,
        activeHours: account.active_hours,
        nextRunAt,
    };
}

function outcomeClass(outcome: RunOutcome): string {
    return outcome;
}

export function esc(value: unknown): string {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/** Link only to http(s) URLs; anything else is shown as text. */
function safeLink(href: string, label: string): string {
    try {
        const url = new URL(href);
        if (url.protocol === 'http:' || url.protocol === 'https:') {
            return `<a href="${esc(url.toString())}" target="_blank" rel="noopener noreferrer">${esc(label)}</a>`;
        }
    } catch {
        // fall through
    }
    return esc(label);
}

function formatTime(unixSeconds: number, timezone: string): string {
    const date = new Date(unixSeconds * 1000);
    try {
        return new Intl.DateTimeFormat('en-CA', {
            timeZone: timezone,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            hour12: false,
        })
            .format(date)
            .replace(',', '');
    } catch {
        return date.toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
    }
}

function relative(target: number, now: number): string {
    const diff = target - now;
    const minutes = Math.round(Math.abs(diff) / 60);
    const text = minutes < 60 ? `${minutes}m` : `${Math.round(minutes / 6) / 10}h`;
    return diff >= 0 ? `in ${text}` : `${text} ago`;
}

function formatDuration(ms: number): string {
    return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function formatNumber(value: number): string {
    return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

function shortNpub(npub: string): string {
    return `${npub.slice(0, 12)}…${npub.slice(-6)}`;
}

function isSameOrigin(request: Request, url: URL): boolean {
    const origin = request.headers.get('origin');
    return !origin || origin === url.origin;
}

function randomNonce(): string {
    return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
}

function securityHeaders(nonce: string): Record<string, string> {
    return {
        'content-security-policy':
            `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; ` +
            "connect-src 'self'; img-src 'self' data:; form-action 'self'; base-uri 'none'; " +
            "frame-ancestors 'none'",
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
    };
}

function htmlResponse(html: string, nonce: string, status: number): Response {
    return new Response(html, {
        status,
        headers: { 'content-type': 'text/html;charset=UTF-8', ...securityHeaders(nonce) },
    });
}

function jsonResponse(
    data: unknown,
    status: number,
    extraHeaders: Record<string, string> = {}
): Response {
    return new Response(JSON.stringify(data, null, 2), {
        status,
        headers: {
            'content-type': 'application/json;charset=UTF-8',
            'cache-control': 'no-store',
            'x-content-type-options': 'nosniff',
            ...extraHeaders,
        },
    });
}

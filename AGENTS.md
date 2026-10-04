# AGENTS.md: A Guide for AI Agents

This document provides instructions for AI agents working in this repository.

## Core Workflow: Plan Before You Act

For any non-trivial request that involves changing files, you must follow this procedure:

1. **Understand:** Analyze the request and the existing codebase to understand the context and requirements. Use tools like `grep`, `sed`, and file reads to explore the code.
2. **Plan:** Propose a clear, step-by-step implementation plan. Describe what you are going to do and which files you will modify.
3. **Wait for Approval:** **Do not start implementing** until the user explicitly approves your plan. Wait for a confirmation like `yes`, `sounds good`, or `proceed`.

This process ensures that your work aligns with the user's expectations.

## Project Overview

This project is a headless Nostr bot running on Cloudflare Workers.

- The worker entrypoint is `src/index.ts`.
- Scheduled execution is driven by a Cloudflare cron trigger that runs hourly (`7 * * * *` in `wrangler.toml`; see `wrangler.toml.dist`).
- Account configuration is loaded from a D1 database, not from in-code arrays.
- Content is generated with Cloudflare AI in `src/ai.ts`.
- Posts are signed and published to Nostr relays in `src/nostr.ts`.
- Recent post history and account scheduling state are stored in D1 via `src/storage.ts`.
- Optional prompt context is fetched from external resources in `src/resources.ts`.

### Runtime Flow

1. The cron trigger invokes `scheduled()` in `src/index.ts`.
2. `getAccounts()` in `src/config.ts` loads all active accounts from the `accounts` table.
3. Each account is processed in `ctx.waitUntil(...)`. In a separate `waitUntil`, `EngagementService` (`src/engagement.ts`) collects reactions, reposts, replies and zaps for the account's posts of the last 7 days, at most every 6 hours (one relay query per account), and stores per-post counts and scores. A failed collection is retried on the next hourly run.
4. The worker checks whether the account should run now using `StorageService.shouldRun()` (`src/scheduler.ts`): the frequency is evaluated in the account's `timezone`, nothing is posted outside `active_hours` (slots missed overnight produce one post when the window opens), and each slot is delayed by a stable random 0..`jitter_hours` whole-hour offset. Due-ness is based on the first slot after `last_run_at`, so later slots' delays never postpone a pending post.
5. The worker loads recent post history from `post_history`.
6. The worker optionally fetches external resource context. Resources are tried in weighted-random order (up to 3) until one returns usable content; RSS items already listed in `shared_items` are skipped. If none succeed, the post is generated without resource context.
7. A post format is picked by weight (`src/post-formats.ts`), avoiding the previous post's format, for accounts without a custom `prompt_template` or whose template contains `$$FORMAT$$`; accounts on the default weights get them scaled (0.5-2x) by each format's measured engagement. The 3 best-scoring posts of the last 30 days are added to the prompt (same template rule, via `$$TOP_POSTS$$`). `ContentGenerator` builds the prompt and calls Cloudflare AI.
8. `NostrService` signs and publishes the generated post to all configured relays. Hashtags in the post (max 5) are added as NIP-12 `t` tags via `src/hashtags.ts`.
9. On success, `last_run_at`, `post_history` and (for RSS-based posts) `shared_items` are updated in D1.
10. Every account run, skips included, is recorded in `run_log` by a `RunTrace` (`src/run-trace.ts`): schedule decision, resources tried, format choice, each draft and why it was rejected, per-relay publish result, and the failing stage on errors. A queued publish retry updates its run. The debug page (`/debug`, `src/debug-page.ts`) shows these traces.

## Repository Map

### Source Files

- `src/index.ts`
    - Worker entrypoint.
    - Contains both `scheduled()` and a guarded `fetch()` preview endpoint.

- `src/config.ts`
    - Loads active accounts from D1 and parses JSON-backed fields.

- `src/ai.ts`
    - Builds prompts and calls the configured Cloudflare AI model.
    - Applies personality templates from `prompts/`.

- `src/nostr.ts`
    - Derives public keys, signs events, and publishes to relays.
    - Supports both `nsec` and hex private keys.

- `src/storage.ts`
    - Handles D1 reads/writes for `last_run_at`, `post_history` and `shared_items`.
    - Contains posting-frequency logic.

- `src/resources.ts`
    - Performs weighted resource selection with fallback to the next resource on failure or no new content.
    - Supports `rss`, `scraping`, and `quote` resources.

- `src/post-formats.ts`
    - Post format definitions (`news_commentary`, `question`, `tip`, `hot_take`, `short_list`), default weights and weighted selection.

- `src/engagement.ts`
    - Collects and scores engagement (reactions, reposts, replies, zaps), adjusts format weights and formats top posts / stats.

- `src/hashtags.ts`
    - Extracts hashtags from generated posts and builds `t` tags for publishing.

- `src/run-trace.ts`
    - `RunTrace` collects what happened in one account run (and why) for `run_log`.

- `src/debug-page.ts`
    - Server-rendered `/debug` page: per-account 7-day summary, filterable run timeline, raw run JSON at `/debug/run/:id`.

- `src/debug-auth.ts`
    - Nostr login for the debug page: NIP-98 (kind 27235) events signed via a NIP-07 extension, accepted only from `DEBUG_ADMIN_NPUB`; single-use events, 12h HttpOnly session cookies (only hashes stored).

- `src/types.ts`
    - Shared TypeScript types, including `Env`, `NostrAccount`, and `Resource`.

- `src/utils.ts`
    - Shared utilities such as `withRetry()`.

### Supporting Files

- `prompts/`
    - Personality instruction templates.
    - Current personalities are `informative`, `humorous`, `enthusiastic`, `sarcastic`, and `philosophical`.

- `migrations/`
    - D1 schema migrations.

- `scripts/generate-key.ts`
    - Generates new Nostr keys in hex and `nsec` format.

- `add_resource.sh`
    - Updates `data_resources` for an account in remote D1.

- `update_prompt.sh`
    - Opens an account prompt template in `vim` and writes it back to remote D1.

- `Makefile`
    - Shortcuts for deployment and account-specific prompt/resource management.

## Build, Lint, and Test Commands

### Build and Run

This is a Cloudflare Workers project. There is no dedicated build script in `package.json`.

- Local development: `npx wrangler dev`
- Deploy: `npx wrangler deploy`

### Lint

ESLint and Prettier are configured for this project.

- Check linting: `npm run lint`
- Format code: `npm run format`

### Test

`vitest` is installed and there is a comprehensive test suite in the `tests/` directory.

- Run all tests directly: `npm run test`
- Run a single test file: `npx vitest <path_to_test_file>`

## Data Model

The worker currently depends on these D1 tables:

### `accounts`

- `id`
- `name`
- `private_key`
- `relays` as JSON text
- `categories` as JSON text
- `frequency`
- `data_resources` as JSON text
- `prompt_template`
- `last_run_at`
- `is_active`
- `created_at`
- `personality`
- `timezone` (IANA name, default `Europe/Istanbul`)
- `active_hours` (`HH:MM-HH:MM` in `timezone`, default `07:00-23:00`; `NULL` = all day)
- `jitter_hours` (0-6 whole hours of random delay, default `1`)
- `post_formats` as JSON text (format → weight; `NULL` = defaults, `{}` = rotation off)
- `max_post_length` (100-2000 characters, links not counted; `NULL` = `MAX_POST_LENGTH` env var or 500)
- `engagement_checked_at` (unix seconds of the last engagement collection)

Frequency presets (in the account's timezone): `hourly`, `every_2_hours`, `twice_a_day` (09:00 and 18:00), `daily` (09:00); any 5-field cron expression is also accepted.

### `post_history`

- `id`
- `account_id`
- `content`
- `created_at`
- `event_id`
- `format` (post format used, if any)
- `reactions`, `reposts`, `replies`, `zaps`, `zap_sats`, `engagement_score` (reactions + 2×reposts + 3×replies + 3×zaps), `engagement_updated_at`

### `shared_items`

- `id`
- `account_id`
- `url` (normalized item link, unique per account)
- `title`
- `created_at` (unix seconds; rows older than 90 days are pruned)

### `run_log`

- `id` (UUID), `account_id`, `account_name`, `started_at` (unix seconds), `duration_ms`
- `outcome` (`published`, `queued`, `failed`, `error`, `skipped`), `summary`, `post_format`, `event_id`
- `details` (JSON `RunTraceDetails`, see `src/run-trace.ts`)
- Rows older than 30 days are pruned on each cron run.

### `debug_sessions` / `debug_login_events`

- Debug page sessions (`token_hash`, `pubkey`, `created_at`, `expires_at`) and used NIP-98 login event ids (pruned after a day).

If a change affects account shape or persistence, review:

- `src/types.ts`
- `src/config.ts`
- `src/storage.ts`
- `migrations/`
- helper scripts that query or update D1

## Code Style Guidelines

### Imports

- Group imports by source: built-in modules, external modules, then local modules.
- Use named imports where possible.
- Separate groups of imports with a blank line.

### Formatting

- Indentation: 4 spaces.
- Quotes: single quotes.
- Braces: opening braces on the same line.
- Use single blank lines between logical blocks.
- Add a blank line at the end of each file.

### Types

- TypeScript runs with `strict: true`.
- Use explicit types for function parameters and return values.
- Avoid `any` unless there is a strong reason and the surrounding code already uses it.
- Put shared types in `src/types.ts` when appropriate.

### Naming Conventions

- Classes and types: `PascalCase`
- Methods and variables: `camelCase`
- New files: `kebab-case`

### Error Handling

- Use `try...catch` for asynchronous operations that may fail.
- Log failures with `console.error`.
- Use `withRetry()` for retryable async work.
- Throw `Error` objects when creating new errors.

### Asynchronous Code

- Prefer `async/await`.
- Use `ctx.waitUntil` for scheduled background work in the worker.

### General Principles

- Keep functions focused and single-purpose.
- Follow the existing project structure and patterns.
- Add JSDoc comments to public methods and complex logic where they add real clarity.
- New logic changes should be accompanied by tests whenever practical.

## Project-Specific Change Guidance

### If You Change Prompt Generation

Review both:

- `src/ai.ts`
- `prompts/`

Prompt templates may contain these placeholders:

- `$$RESOURCES$$`
- `$$CATEGORIES$$`
- `$$POST_HISTORY$$`
- `$$FORMAT$$` (post format instruction; also opts a custom template into format rotation)
- `$$MAX_LENGTH$$` (the account's character limit; also used by the personality templates)
- `$$TOP_POSTS$$` (best-performing recent posts; also opts a custom template into this feedback)

Drafts longer than the limit (links not counted, see `src/post-length.ts`) are retried with shortening guidance; if every attempt is too long, the shortest safe draft is published.

Current prompt templates are designed to generate Turkish posts and should stay aligned with the product intent unless the user asks otherwise.

### If You Change Scheduling or Publishing

Review:

- `src/index.ts`
- `src/storage.ts`
- `src/nostr.ts`

Be careful not to break:

- per-account frequency checks
- successful publish detection
- history updates after successful posts

### If You Change Resource Handling

Review:

- `src/resources.ts`
- `src/types.ts`
- any account data shape assumptions in `src/config.ts`

`scraping` is currently treated the same as RSS/XML fetching. Do not assume there is a dedicated scraper implementation.

### If You Change Documentation or Scripts

Sanity-check docs and scripts against the actual code before reusing old wording. Some project documentation has drifted from the current implementation.

## Known Gotchas

- `README.md` is stale in a few important ways:
    - it still mentions KV-backed state, but the worker now uses D1
    - it documents `NOSTR_ACCOUNTS`, but account loading currently comes from D1
    - it references `npm run start`, but that script does not exist

- `wrangler.toml` currently contains account-like data in `[vars].NOSTR_ACCOUNTS`, but the active account-loading path does not use it.

- The preview endpoint in `src/index.ts` is intentionally gated by checking whether the request URL contains `1542`. `/debug*` routes are handled before that gate and use Nostr login instead.

- Only `DEBUG_ADMIN_NPUB` in `src/debug-auth.ts` can log in to the debug page; per-account `control_admin_pubkeys` do not grant access. Changing it requires a code change and deploy.

- When a new step is added to the posting pipeline, record it on the `RunTrace` in `processScheduledAccount` so the debug page stays complete.

- Admin control commands are read only from the relays in `CONTROL_RELAY_URLS` (`src/control.ts`): relay.ditto.pub, relay.primal.net, relay.nostr.org.tr, relay.emre.xyz and relay.damus.io. A command published to none of them is never seen.

## Safety Notes

- Treat `wrangler.toml`, `keys.json`, and anything containing `nsec` or private keys as sensitive.
- Do not print, copy, or expose secrets unless the user explicitly asks and understands the risk.
- Be careful when editing helper scripts that run `wrangler d1 execute --remote`; they affect remote state, not just local files.

## Working Rules for Future Agents

1. Start from `src/index.ts` if you need the end-to-end mental model.
2. Confirm whether the source of truth is D1, a helper script, or static config before making assumptions.
3. Prefer updating stale docs when you touch behavior that they describe.
4. If a change affects schema or account configuration, verify the full chain from migration to runtime parsing.
5. Keep the repo's approval-first workflow intact for non-trivial edits.

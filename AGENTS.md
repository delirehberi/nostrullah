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
- Scheduled execution is driven by a Cloudflare cron trigger.
- Account configuration is loaded from a D1 database, not from in-code arrays.
- Content is generated with Cloudflare AI in `src/ai.ts`.
- Posts are signed and published to Nostr relays in `src/nostr.ts`.
- Recent post history and account scheduling state are stored in D1 via `src/storage.ts`.
- Optional prompt context is fetched from external resources in `src/resources.ts`.

### Runtime Flow

1. The cron trigger invokes `scheduled()` in `src/index.ts`.
2. `getAccounts()` in `src/config.ts` loads all active accounts from the `accounts` table.
3. Each account is processed in `ctx.waitUntil(...)`.
4. The worker checks whether the account should run now using `StorageService.shouldRun()`.
5. The worker loads recent post history from `post_history`.
6. The worker optionally fetches one weighted external resource.
7. `ContentGenerator` builds the prompt and calls Cloudflare AI.
8. `NostrService` signs and publishes the generated post to all configured relays.
9. On success, `last_run_at` and `post_history` are updated in D1.

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
  - Handles D1 reads/writes for `last_run_at` and `post_history`.
  - Contains posting-frequency logic.

- `src/resources.ts`
  - Performs weighted resource selection.
  - Supports `rss`, `scraping`, and `quote` resources.

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

There is currently no linting setup in this repository.

### Test

`vitest` is installed, but `package.json` still contains a placeholder `test` script that exits with an error.

- Run all tests directly: `npx vitest`
- Run a single test file: `npx vitest <path_to_test_file>`

If you add tests, prefer also adding or updating the `test` script in `package.json`.

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

### `post_history`

- `id`
- `account_id`
- `content`
- `created_at`

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

- The preview endpoint in `src/index.ts` is intentionally gated by checking whether the request URL contains `1542`.

- There is no meaningful automated test suite yet, even though `vitest` is installed.

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

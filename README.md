# Headless Nostr Bot

A serverless, headless Nostr bot built on Cloudflare Workers. This bot automatically generates and publishes content to Nostr relays using Cloudflare Workers AI (Llama 3) based on a configurable schedule and categories.

## Features

- **Serverless Architecture**: Runs entirely on Cloudflare Workers with no external infrastructure.
- **AI-Powered Content**: Utilizes Cloudflare Workers AI (@cf/meta/llama-3-8b-instruct) to generate engaging posts.
- **Multi-Account Support**: Manage multiple Nostr accounts with distinct schedules and content categories.
- **Robust Publishing**: Includes relay failover, retry logic, and automatic event signing (NIP-19 compatible).
- **Duplicate Protection**: Screens generated posts against recent publishing history with exact-match, heuristic, and LLM-assisted similarity checks before posting.
- **D1-Backed Scheduling**: Stores account config, post history, and scheduling state in Cloudflare D1.
- **Reply-Driven Controls**: Allowlisted admin pubkeys can update D1-backed account config through Nostr replies and mentions.

## Prerequisites

- [Node.js](https://nodejs.org/) (v22 recommended)
- [Cloudflare Account](https://dash.cloudflare.com/) with Workers and Workers AI enabled.
- `npm` or `yarn`

## Installation

1.  **Clone the repository:**

    ```bash
    git clone <repository-url>
    cd nostr.bot
    ```

2.  **Install dependencies:**
    ```bash
    npm install
    ```

## Configuration

The bot uses Cloudflare D1 for account configuration and worker environment variables for runtime settings.

1.  **Cloudflare D1 Setup:**
    Create the D1 database, bind it in `wrangler.toml`, and apply the SQL files in `migrations/`.

2.  **Environment Variables:**
    The bot requires specific environment variables. You can set these in your Cloudflare Worker dashboard or via `wrangler secret put`.

    - `AI_MODEL` (Optional): The AI model to use (default: `@cf/openai/gpt-oss-120b`).
    - `MAX_POST_LENGTH` (Optional): Max character count for posts (default: 280).

3.  **Account Records:**
    Accounts are loaded from the D1 `accounts` table. JSON-backed fields such as `relays`, `categories`, `data_resources`, and `control_admin_pubkeys` are stored as text in D1.

## Utilities

### Generate New Keys

To generate a new Nostr private key (hex and nsec format):

```bash
npm run generate-key
```

### Helper Scripts

We provide several bash scripts to help manage your bot accounts and data.

#### Add Resource (`add_resource.sh`)

Add an RSS feed or other data source to a specific account. This data is fetched and provided as context to the AI.

```bash
./add_resource.sh <private_key> <type> <url> <weight>
```

- `type`: Currently supports `rss`.
- `weight`: Importance of this source (integer).

#### Update Prompt (`update_prompt.sh`)

Interactively edit the AI prompt template for an account using `vim`.

```bash
./update_prompt.sh <private_key>
```

This script fetches the current template, opens it in `vim`, and saves the updated version back to the database.

## Prompt Customization

You can use the following placeholders in your prompt templates to inject dynamic content:

- `$$RESOURCES$$`: Replaced with content fetched from your configured resources (e.g., RSS feeds).
- `$$POST_HISTORY$$`: Replaced with the account's recent post history to maintain style/context and reduce repeated post ideas.
- `$$CATEGORIES$$`: Replaced with the comma-separated list of account categories.

## Nostr Control Replies

Accounts can opt into a reply-driven control plane by setting:

- `control_enabled = 1`
- `control_admin_pubkeys = '["<admin-pubkey>"]'`

The bot **does not use traditional strict slash commands**. Instead, it uses an AI interpreter to read natural language replies or mentions from authorized administrators and convert them into configuration updates.

During each cron run, the worker polls relays for new admin-authored mentions and replies. The bot passes the message to its AI model to map your intent to one of the following supported configuration actions:

1. **Prompt Template**: Change the instructions for post generation (`set_prompt`).
2. **Account Details**: Update its display name (`set_name`).
3. **Categories**: Change which topics to post about (`set_categories`).
4. **Personality**: Change its tone. Supported values are: `informative`, `humorous`, `enthusiastic`, `sarcastic`, and `philosophical` (`set_personality`).
5. **Posting Frequency**: Change how often to post. Supported values are: `hourly`, `every_2_hours`, `twice_a_day`, and `daily` (`set_frequency`).
6. **Relays**: Add or change the Nostr relays it publishes to (`set_relays`).
7. **Active State**: Pause or resume posting (`set_active`).
8. **Resources**: Add, remove, or replace the external content it uses for posts (`add_resource`, `remove_resource`, `replace_resources`). Supports `rss` feeds, `scraping` URLs, and `quote` categories.

**How to use it:**
As long as your Nostr public key is in the account's `control_admin_pubkeys` allowlist, you can simply reply to one of the bot's posts or mention the bot and say something natural like:

> _"Change your posting frequency to twice a day and add https://example.com/rss as a new RSS resource."_

The bot will interpret the instruction, apply the changes to the database, and reply to your note confirming the applied actions.

## Running & Deployment

### Local Development

To run the worker locally (note: Cron triggers may need manual invocation or simulation):

```bash
npx wrangler dev
```

### Deployment

To deploy the worker to Cloudflare:

```bash
npx wrangler deploy
```

## Contribution

Contributions are welcome! Please feel free to submit a Pull Request.

1.  Fork the repository.
2.  Create your feature branch (`git checkout -b feature/AmazingFeature`).
3.  Commit your changes (`git commit -m 'Add some AmazingFeature'`).
4.  Push to the branch (`git push origin feature/AmazingFeature`).
5.  Open a Pull Request.

## License

Distributed under the MIT License. See `LICENSE` for more information.

```text
MIT License

Copyright (c) 2025

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

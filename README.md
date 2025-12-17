# Headless Nostr Bot

A serverless, headless Nostr bot built on Cloudflare Workers. This bot automatically generates and publishes content to Nostr relays using Cloudflare Workers AI (Llama 3) based on a configurable schedule and categories.

## Features

- **Serverless Architecture**: Runs entirely on Cloudflare Workers with no external infrastructure.
- **AI-Powered Content**: Utilizes Cloudflare Workers AI (@cf/meta/llama-3-8b-instruct) to generate engaging posts.
- **Multi-Account Support**: Manage multiple Nostr accounts with distinct schedules and content categories.
- **Robust Publishing**: Includes relay failover, retry logic, and automatic event signing (NIP-19 compatible).
- **Rate Limiting**: Enforces posting frequency limits using Cloudflare KV.

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

The bot is configured using environment variables and `wrangler.toml`.

1.  **Cloudflare KV Setup:**
    Create a KV namespace for the bot to store state (last run times).
    ```bash
    npx wrangler kv:namespace create BOT_STATE
    ```
    Copy `wrangler.toml.dist` to `wrangler.toml` and update `wrangler.toml` with the `id` from the output:
    ```toml
    [[kv_namespaces]]
    binding = "BOT_STATE"
    id = "YOUR_KV_NAMESPACE_ID"
    ```

2.  **Environment Variables:**
    The bot requires specific environment variables. You can set these in your Cloudflare Worker dashboard or via `wrangler secret put`.

    - `NOSTR_ACCOUNTS`: A JSON string defining the accounts.
      ```json
      [
        {
          "privateKey": "YOUR_PRIVATE_KEY",
          "relays": ["wss://relay.damus.io", "wss://nos.lol"],
          "categories": ["technology", "coding"],
          "frequency": "every_2_hours"
        }
      ]
      ```
    - `AI_MODEL` (Optional): The AI model to use (default: `@cf/openai/gpt-oss-120b`).
    - `MAX_POST_LENGTH` (Optional): Max character count for posts (default: 280).

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
*   `type`: Currently supports `rss`.
*   `weight`: Importance of this source (integer).

#### Update Prompt (`update_prompt.sh`)
Interactively edit the AI prompt template for an account using `vim`.

```bash
./update_prompt.sh <private_key>
```
This script fetches the current template, opens it in `vim`, and saves the updated version back to the database.

## Prompt Customization

You can use the following placeholders in your prompt templates to inject dynamic content:

-   `$$RESOURCES$$`: Replaced with content fetched from your configured resources (e.g., RSS feeds).
-   `$$POST_HISTORY$$`: Replaced with the account's recent post history to maintain style/context.
-   `$$CATEGORIES$$`: Replaced with the comma-separated list of account categories.

## Running & Deployment

### Local Development
To run the worker locally (note: Cron triggers may need manual invocation or simulation):
```bash
npm run start
# or
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

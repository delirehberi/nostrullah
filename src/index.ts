import { ScheduledEvent, ExecutionContext } from '@cloudflare/workers-types';
import { Env } from './types';
import { getAccounts } from './config';
import { ContentGenerator } from './ai';
import { NostrService } from './nostr';
import { StorageService } from './storage';
import { ResourceService } from './resources';

export default {
    async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
        console.log('Worker triggered by cron');

        const accounts = await getAccounts(env);
        if (accounts.length === 0) {
            console.log('No accounts configured');
            return;
        }

        const storage = new StorageService(env);
        const generator = new ContentGenerator(env);
        const resourceService = new ResourceService();

        for (const account of accounts) {
            ctx.waitUntil((async () => {
                try {
                    const pubKey = NostrService.getPublicKeyFromPrivate(account.privateKey);
                    // Use last_run_at directly from the account record
                    const lastRun = account.last_run_at || 0;

                    if (!storage.shouldRun(lastRun, account.frequency)) {
                        console.log(`Skipping account ${pubKey.slice(0, 8)}... - not time yet`);
                        return;
                    }

                    console.log(`Processing account ${pubKey.slice(0, 8)}...`);

                    if (!account.id) {
                        console.error(`Account ${pubKey.slice(0, 8)} has no ID!`);
                        return;
                    }

                    const history = await storage.getPostHistory(account.id);

                    // Fetch external resources (RSS, etc.)
                    let context = '';
                    if (account.data_resources && account.data_resources.length > 0) {
                        console.log(`Fetching resources for ${pubKey.slice(0, 8)}...`);
                        context = await resourceService.fetchResources(account.data_resources);
                    }

                    const content = await generator.generatePost(
                        account.categories,
                        history,
                        context,
                        account.prompt_template
                    );

                    console.log(`Generated content: ${content}`);

                    const published = await NostrService.publishEvent(account, content);

                    if (published) {
                        console.log(`Successfully published for ${pubKey.slice(0, 8)}...`);
                        await storage.updateLastRun(account.id);
                        await storage.addPostToHistory(account.id, content);
                    } else {
                        console.error(`Failed to publish for ${pubKey.slice(0, 8)}...`);
                    }
                } catch (error) {
                    console.error(`Error processing account:`, error);
                }
            })());
        }
    },

    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
        //disable endpoint if reqquest not have querystring of hellofromemre
        if (!request.url.includes('1542')) {
            return new Response('Forbidden', {
                status: 403,
            });
        }
        const accounts = await getAccounts(env);
        const storage = new StorageService(env);
        const generator = new ContentGenerator(env);
        const resourceService = new ResourceService();
        const results: any[] = [];

        for (const account of accounts) {
            try {
                if (!account.id) continue;
                const pubKey = NostrService.getPublicKeyFromPrivate(account.privateKey);
                const history = await storage.getPostHistory(account.id);

                let context = '';
                if (account.data_resources && account.data_resources.length > 0) {
                    context = await resourceService.fetchResources(account.data_resources);
                }

                const content = await generator.generatePost(
                    account.categories,
                    history,
                    context,
                    account.prompt_template
                );

                results.push({
                    pubKey: pubKey,
                    content: content,
                    categories: account.categories,
                    last_run: account.last_run_at,
                    context_used: !!context,
                    account_details: {
                        prompt: account.prompt_template,
                        resources: account.data_resources,

                    }
                });
            } catch (error: any) {
                results.push({
                    error: error.message
                });
            }
        }

        return new Response(JSON.stringify(results, null, 2), {
            headers: {
                'content-type': 'application/json;charset=UTF-8',
            },
        });
    },
};

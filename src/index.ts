import { ScheduledEvent, ExecutionContext } from '@cloudflare/workers-types';
import { Env } from './types';
import { parseAccounts } from './config';
import { ContentGenerator } from './ai';
import { NostrService } from './nostr';
import { StorageService } from './storage';

export default {
    async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
        console.log('Worker triggered by cron');

        const accounts = parseAccounts(env);
        if (accounts.length === 0) {
            console.log('No accounts configured');
            return;
        }

        const storage = new StorageService(env);
        const generator = new ContentGenerator(env);

        for (const account of accounts) {
            ctx.waitUntil((async () => {
                try {
                    const pubKey = NostrService.getPublicKeyFromPrivate(account.privateKey);
                    const lastRun = await storage.getLastRun(pubKey);

                    if (!storage.shouldRun(lastRun, account.frequency)) {
                        console.log(`Skipping account ${pubKey.slice(0, 8)}... - not time yet`);
                        return;
                    }

                    console.log(`Processing account ${pubKey.slice(0, 8)}...`);

                    const history = await storage.getPostHistory(pubKey);
                    const content = await generator.generatePost(account.categories, history);
                    console.log(`Generated content: ${content}`);

                    const published = await NostrService.publishEvent(account, content);

                    if (published) {
                        console.log(`Successfully published for ${pubKey.slice(0, 8)}...`);
                        await storage.updateLastRun(pubKey);
                        await storage.addPostToHistory(pubKey, content);
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
        const accounts = parseAccounts(env);
        const storage = new StorageService(env);
        const generator = new ContentGenerator(env);
        const results: any[] = [];

        for (const account of accounts) {
            try {
                const pubKey = NostrService.getPublicKeyFromPrivate(account.privateKey);
                const history = await storage.getPostHistory(pubKey);
                const content = await generator.generatePost(account.categories, history);
                results.push({
                    pubKey: pubKey,
                    content: content,
                    categories: account.categories
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

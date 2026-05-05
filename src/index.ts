import { ScheduledEvent, ExecutionContext } from '@cloudflare/workers-types';
import { Env } from './types';
import { getAccounts } from './config';
import { ContentGenerator } from './ai';
import { NostrService } from './nostr';
import { StorageService } from './storage';
import { generateValidatedPost } from './post-generation';
import { ResourceService } from './resources';
import { ContentSimilarityService } from './content-similarity';
import { ControlProcessor } from './control';

const PROMPT_HISTORY_LIMIT = 20;
const SIMILARITY_HISTORY_LIMIT = 30;

export async function runScheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    console.log('Worker triggered by cron');

    const allAccounts = await getAccounts(env, { includeInactive: true });
    const storage = new StorageService(env);
    const controlProcessor = new ControlProcessor(env, storage);

    await controlProcessor.processAccounts(allAccounts);

    const accounts = await getAccounts(env);
    if (accounts.length === 0) {
        console.log('No active accounts configured');
        return;
    }

    const generator = new ContentGenerator(env);
    const resourceService = new ResourceService();
    const similarityService = new ContentSimilarityService(env);

    for (const account of accounts) {
        ctx.waitUntil(processScheduledAccount({
            account,
            storage,
            generator,
            resourceService,
            similarityService,
        }));
    }
}

export default {
    async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
        await runScheduled(event, env, ctx);
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
        const similarityService = new ContentSimilarityService(env);
        const results: any[] = [];

        for (const account of accounts) {
            try {
                if (!account.id) continue;
                const pubKey = NostrService.getPublicKeyFromPrivate(account.privateKey);
                const history = await storage.getPostHistory(account.id, SIMILARITY_HISTORY_LIMIT);
                const promptHistory = history.slice(0, PROMPT_HISTORY_LIMIT);

                let context = '';
                if (account.data_resources && account.data_resources.length > 0) {
                    context = await resourceService.fetchResources(account.data_resources);
                }

                const generatedPost = await generateValidatedPost({
                    generator,
                    categories: account.categories,
                    previousPosts: promptHistory,
                    similarityHistory: history,
                    context,
                    promptTemplate: account.prompt_template,
                    personality: account.personality,
                    similarityChecker: similarityService,
                });
                const content = generatedPost.content;

                results.push({
                    pubKey: pubKey,
                    content: content,
                    attempts: generatedPost.attempts,
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

async function processScheduledAccount(options: {
    account: Awaited<ReturnType<typeof getAccounts>>[number];
    storage: StorageService;
    generator: ContentGenerator;
    resourceService: ResourceService;
    similarityService: ContentSimilarityService;
}): Promise<void> {
    const { account, storage, generator, resourceService, similarityService } = options;

    try {
        const pubKey = NostrService.getPublicKeyFromPrivate(account.privateKey);
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

        const history = await storage.getPostHistory(account.id, SIMILARITY_HISTORY_LIMIT);
        const promptHistory = history.slice(0, PROMPT_HISTORY_LIMIT);

        let context = '';
        if (account.data_resources && account.data_resources.length > 0) {
            console.log(`Fetching resources for ${pubKey.slice(0, 8)}...`);
            context = await resourceService.fetchResources(account.data_resources);
        }

        const generatedPost = await generateValidatedPost({
            generator,
            categories: account.categories,
            previousPosts: promptHistory,
            similarityHistory: history,
            context,
            promptTemplate: account.prompt_template,
            personality: account.personality,
            similarityChecker: similarityService,
        });
        const content = generatedPost.content;

        console.log(`Generated content: ${content}`);
        if (generatedPost.attempts.length > 1) {
            console.log(
                `Post generation required ${generatedPost.attempts.length} attempts for ${pubKey.slice(0, 8)}...`
            );
        }

        const publishResult = await NostrService.publishEvent(account, content);

        if (publishResult.published) {
            console.log(`Successfully published for ${pubKey.slice(0, 8)}...`);
            await storage.updateLastRun(account.id);
            await storage.addPostToHistory(account.id, content, publishResult.eventId);
        } else {
            console.error(`Failed to publish for ${pubKey.slice(0, 8)}...`);
        }
    } catch (error) {
        console.error('Error processing account:', error);
    }
}

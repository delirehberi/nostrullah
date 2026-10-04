import { ScheduledEvent, ExecutionContext, MessageBatch, Queue } from '@cloudflare/workers-types';
import { Env, NostrAccount, PostFormat, ResourceContext } from './types';
import { getAccounts } from './config';
import { ContentGenerator } from './ai';
import { NostrService } from './nostr';
import { StorageService } from './storage';
import { generateValidatedPost } from './post-generation';
import { ResourceService } from './resources';
import { ContentSimilarityService } from './content-similarity';
import { ControlProcessor } from './control';
import { buildHashtagTags } from './hashtags';
import { SchedulerService } from './scheduler';
import { RunTrace } from './run-trace';
import { extractHashtags } from './hashtags';
import { handleDebugRequest, isDebugPath } from './debug-page';
import { resolveMaxPostLength } from './post-length';
import {
    EngagementService,
    TOP_POSTS_LIMIT,
    TOP_POSTS_LOOKBACK_SECONDS,
    TOP_POSTS_PLACEHOLDER,
    adjustFormatWeights,
} from './engagement';
import {
    POST_FORMAT_INSTRUCTIONS,
    isFormatRotationEnabled,
    selectPostFormat,
} from './post-formats';

const PROMPT_HISTORY_LIMIT = 20;
const SIMILARITY_HISTORY_LIMIT = 30;

export async function runScheduled(
    event: ScheduledEvent,
    env: Env,
    ctx: ExecutionContext
): Promise<void> {
    console.log('Worker triggered by cron');

    const allAccounts = await getAccounts(env, { includeInactive: true });
    const storage = new StorageService(env);
    const controlProcessor = new ControlProcessor(env, storage);

    await controlProcessor.processAccounts(allAccounts);
    ctx.waitUntil(storage.pruneDebugData());

    // BUG-13: Derive active accounts from the already-fetched list rather than
    // issuing a second DB query.
    const accounts = allAccounts.filter((a) => a.is_active);
    if (accounts.length === 0) {
        console.log('No active accounts configured');
        return;
    }

    const generator = new ContentGenerator(env);
    const similarityService = new ContentSimilarityService(env);

    // BUG-02: ResourceService holds a stateful XMLParser instance. Instantiate
    // it per-account inside processScheduledAccount so concurrent accounts cannot
    // corrupt each other's parsing state.
    const engagementService = new EngagementService(storage);

    for (const account of accounts) {
        ctx.waitUntil(refreshEngagement(engagementService, account));
        ctx.waitUntil(
            processScheduledAccount({
                account,
                storage,
                generator,
                similarityService,
                env,
            })
        );
    }
}

export default {
    async queue(batch: MessageBatch<any>, env: Env, ctx: ExecutionContext): Promise<void> {
        for (const message of batch.messages) {
            const { account, content, targetRelays, sourceUrl, sourceTitle, format, runId } =
                message.body;
            const storage = new StorageService(env);
            try {
                const publishResult = await NostrService.publishEvent(
                    { ...account, relays: targetRelays },
                    content,
                    { extraTags: buildHashtagTags(content) }
                );
                if (runId) {
                    await storage.recordRunRetry(runId, {
                        at: Math.floor(Date.now() / 1000),
                        published: publishResult.published,
                        relays: publishResult.relays || [],
                    });
                }
                if (publishResult.published) {
                    console.log(
                        `Successfully published retried post for ${account.name || 'Unknown'}`
                    );
                    await recordSuccessfulPost(
                        storage,
                        account.id,
                        content,
                        publishResult.eventId,
                        { context: '', sourceUrl, sourceTitle },
                        format
                    );
                    message.ack();
                } else {
                    console.error(`Retry failed for ${account.name || 'Unknown'}`);
                    message.retry();
                }
            } catch (e) {
                console.error('Queue processing error:', e);
                message.retry();
            }
        }
    },

    async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
        await runScheduled(event, env, ctx);
    },

    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
        if (isDebugPath(new URL(request.url).pathname)) {
            return handleDebugRequest(request, env);
        }

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

                let resourceContext: ResourceContext = { context: '' };
                if (account.data_resources && account.data_resources.length > 0) {
                    resourceContext = await resourceService.fetchResources(account.data_resources, {
                        excludeUrls: await storage.getSharedUrls(account.id),
                    });
                }
                const context = resourceContext.context;
                const format = await choosePostFormat(storage, account, resourceContext);
                const topPosts = await loadTopPosts(storage, account);

                const generatedPost = await generateValidatedPost({
                    generator,
                    categories: account.categories,
                    previousPosts: promptHistory,
                    similarityHistory: [...history, ...topPosts],
                    context,
                    promptTemplate: account.prompt_template,
                    personality: account.personality,
                    formatInstruction: format ? POST_FORMAT_INSTRUCTIONS[format] : undefined,
                    maxLength: resolveMaxPostLength(account.max_post_length, env.MAX_POST_LENGTH),
                    topPosts,
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
                    source_url: resourceContext.sourceUrl,
                    format: format || null,
                    top_posts: topPosts,
                    account_details: {
                        prompt: account.prompt_template,
                        resources: account.data_resources,
                    },
                });
            } catch (error: any) {
                results.push({
                    error: error.message,
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
    similarityService: ContentSimilarityService;
    env: Env;
}): Promise<void> {
    const { account, storage, generator, similarityService, env } = options;

    // BUG-02: Instantiate per-account to avoid shared XMLParser state across
    // concurrent waitUntil tasks.
    const resourceService = new ResourceService();
    const trace = new RunTrace(account);

    try {
        const pubKey = NostrService.getPublicKeyFromPrivate(account.privateKey);
        const lastRun = account.last_run_at || 0;

        const schedule = SchedulerService.fromAccount(account);
        if (!storage.shouldRun(lastRun, schedule)) {
            const nextRunAtMs = storage.getNextRunTimestamp(lastRun, schedule);
            trace.recordSchedule(false, nextRunAtMs);
            console.log(
                `Skipping account ${pubKey.slice(0, 8)}... - not time yet ` +
                    `(frequency=${account.frequency}, timezone=${account.timezone}, ` +
                    `activeHours=${account.active_hours || 'all day'}, lastRun=${lastRun}, ` +
                    `nextRunAt=${new Date(nextRunAtMs).toISOString()})`
            );
            return;
        }
        trace.recordSchedule(true);

        console.log(`Processing account ${pubKey.slice(0, 8)}...`);

        if (!account.id) {
            console.error(`Account ${pubKey.slice(0, 8)} has no ID!`);
            trace.finish('error', 'Account has no id');
            return;
        }

        trace.stage = 'history';
        const history = await storage.getPostHistory(account.id, SIMILARITY_HISTORY_LIMIT);
        const promptHistory = history.slice(0, PROMPT_HISTORY_LIMIT);

        trace.stage = 'resources';
        let resourceContext: ResourceContext = { context: '' };
        if (account.data_resources && account.data_resources.length > 0) {
            console.log(`Fetching resources for ${pubKey.slice(0, 8)}...`);
            const sharedUrls = await storage.getSharedUrls(account.id);
            resourceContext = await resourceService.fetchResources(account.data_resources, {
                excludeUrls: sharedUrls,
            });
            trace.recordResources(account.data_resources.length, sharedUrls.size, resourceContext);
        }
        const context = resourceContext.context;

        trace.stage = 'format';
        const format = await choosePostFormat(storage, account, resourceContext, trace);
        const topPosts = await loadTopPosts(storage, account);
        trace.details.history = { recentPosts: history.length, topPosts };
        if (format) {
            console.log(`Using post format ${format} for ${pubKey.slice(0, 8)}...`);
        }

        trace.stage = 'generation';
        const maxLength = resolveMaxPostLength(account.max_post_length, env.MAX_POST_LENGTH);
        const generatedPost = await generateValidatedPost({
            generator,
            categories: account.categories,
            previousPosts: promptHistory,
            similarityHistory: [...history, ...topPosts],
            context,
            promptTemplate: account.prompt_template,
            personality: account.personality,
            formatInstruction: format ? POST_FORMAT_INSTRUCTIONS[format] : undefined,
            maxLength,
            topPosts,
            similarityChecker: similarityService,
        });
        trace.recordGeneration(generatedPost, maxLength);
        const content = generatedPost.content;

        console.log(`Generated content: ${content}`);
        if (generatedPost.attempts.length > 1) {
            console.log(
                `Post generation required ${generatedPost.attempts.length} attempts for ${pubKey.slice(0, 8)}...`
            );
        }

        trace.stage = 'publish';
        let targetRelays = account.relays;
        const discoveredRelays = await NostrService.discoverRelays(pubKey, [
            ...targetRelays,
            'wss://relay.damus.io',
            'wss://nos.lol',
            'wss://relay.primal.net',
        ]);

        if (discoveredRelays.length > 0) {
            const uniqueRelays = new Set([...targetRelays, ...discoveredRelays]);
            targetRelays = Array.from(uniqueRelays);
            console.log(
                `Discovered ${discoveredRelays.length} NIP-65 relays for ${pubKey.slice(0, 8)}... Publishing to ${targetRelays.length} total relays.`
            );
        }

        const publishResult = await NostrService.publishEvent(
            { ...account, relays: targetRelays },
            content,
            { extraTags: buildHashtagTags(content) }
        );
        trace.details.publish = {
            configuredRelays: account.relays,
            discoveredRelays,
            hashtags: extractHashtags(content),
            eventId: publishResult.eventId,
            relays: publishResult.relays || [],
            queuedForRetry: false,
        };

        if (publishResult.published) {
            console.log(`Successfully published for ${pubKey.slice(0, 8)}...`);
            trace.finish('published', describePublishedRun(format, resourceContext, generatedPost));
            trace.stage = 'record';
            await recordSuccessfulPost(
                storage,
                account.id,
                content,
                publishResult.eventId,
                resourceContext,
                format
            );
        } else {
            console.error(`Failed to publish for ${pubKey.slice(0, 8)}... Enqueuing for retry.`);
            trace.finish('failed', 'No relay accepted the post');
            if (env.FAILED_POSTS) {
                await env.FAILED_POSTS.send({
                    account,
                    content,
                    targetRelays,
                    sourceUrl: resourceContext.sourceUrl,
                    sourceTitle: resourceContext.sourceTitle,
                    format,
                    runId: trace.id,
                });
                trace.details.publish.queuedForRetry = true;
                trace.finish('queued', 'No relay accepted the post; queued for retry');
            }
        }
    } catch (error) {
        console.error('Error processing account:', error);
        trace.fail(error);
    } finally {
        await storage.saveRunLog(trace.toRecord());
    }
}

/**
 * One-line reason for a published run, e.g. "Published tip from rss(...) (2 drafts)".
 */
function describePublishedRun(
    format: PostFormat | undefined,
    resourceContext: ResourceContext,
    generatedPost: { attempts: unknown[]; fallback?: boolean }
): string {
    const used = resourceContext.attempts?.find((attempt) => attempt.status === 'used');
    const parts = [`Published ${format || 'post'}`];
    parts.push(used ? `from ${used.resource}` : 'without resource context');
    if (generatedPost.attempts.length > 1) {
        parts.push(`(${generatedPost.attempts.length} drafts)`);
    }
    if (generatedPost.fallback) {
        parts.push('using fallback draft');
    }
    return parts.join(' ');
}

/**
 * Best-performing recent posts for the prompt: used for accounts without a custom
 * prompt template, or whose template contains `$$TOP_POSTS$$`.
 */
async function loadTopPosts(storage: StorageService, account: NostrAccount): Promise<string[]> {
    if (
        !account.id ||
        (account.prompt_template && !account.prompt_template.includes(TOP_POSTS_PLACEHOLDER))
    ) {
        return [];
    }

    return storage.getTopPosts(
        account.id,
        Math.floor(Date.now() / 1000) - TOP_POSTS_LOOKBACK_SECONDS,
        TOP_POSTS_LIMIT
    );
}

async function refreshEngagement(
    engagementService: EngagementService,
    account: NostrAccount
): Promise<void> {
    try {
        await engagementService.refreshAccount(account);
    } catch (error) {
        console.error(`Failed to collect engagement for account ${account.id}:`, error);
    }
}

/**
 * Picks this post's format, or undefined when rotation does not apply to the account
 * (custom prompt template without `$$FORMAT$$`, or rotation switched off).
 */
async function choosePostFormat(
    storage: StorageService,
    account: NostrAccount,
    resourceContext: ResourceContext,
    trace?: RunTrace
): Promise<PostFormat | undefined> {
    if (!account.id || !isFormatRotationEnabled(account.prompt_template)) {
        if (trace) trace.details.format = { enabled: false };
        return undefined;
    }

    // Accounts on the default weights get them adjusted by measured engagement.
    const weights =
        account.post_formats ??
        adjustFormatWeights(
            await storage.getFormatPerformance(
                account.id,
                Math.floor(Date.now() / 1000) - TOP_POSTS_LOOKBACK_SECONDS
            )
        );
    const lastFormat = await storage.getLastPostFormat(account.id);
    const selected = selectPostFormat(weights, {
        hasLinkContext: Boolean(resourceContext.sourceUrl),
        lastFormat,
    });

    if (trace) {
        trace.details.format = {
            enabled: true,
            weightSource: account.post_formats ? 'custom' : 'engagement',
            weights,
            lastFormat,
            hasLinkContext: Boolean(resourceContext.sourceUrl),
            selected,
        };
    }
    return selected;
}

/**
 * Persists the outcome of a successful publish: run timestamp, post history and,
 * when the post was built from a resource item, that item as shared.
 */
async function recordSuccessfulPost(
    storage: StorageService,
    accountId: number,
    content: string,
    eventId: string,
    resourceContext: ResourceContext,
    format?: PostFormat
): Promise<void> {
    await storage.updateLastRun(accountId);
    await storage.addPostToHistory(accountId, content, eventId, format);
    if (resourceContext.sourceUrl) {
        await storage.recordSharedItem(
            accountId,
            resourceContext.sourceUrl,
            resourceContext.sourceTitle
        );
    }
}

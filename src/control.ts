import { Event } from 'nostr-tools';
import { Env, NostrAccount } from './types';
import { extractOutputText } from './ai';
import {
    AccountConfigPatch,
    AppliedControlActions,
    applyControlActions,
    buildControlSchemaPrompt,
    validateInterpreterResponse,
} from './control-actions';
import { NostrQueryFilter, NostrService, PublishEventResult } from './nostr';
import { ProcessedControlEventRecord, StorageService } from './storage';
import { withRetry } from './utils';

const CONTROL_QUERY_LIMIT = 50;
const CONTROL_LOOKBACK_SECONDS = 300;
const CONTROL_RELAY_URL = 'wss://relay.emre.xyz';

interface ManagedAccountContext {
    account: NostrAccount;
    accountId: number;
    pubkey: string;
}

interface DiscoveredControlEvent {
    event: Event;
    replyAccountId: number;
}

interface ControlResolution {
    replyAccount: ManagedAccountContext;
    targetAccount?: ManagedAccountContext;
    error?: string;
}

export interface ControlProcessorDependencies {
    queryEvents?: (relays: string[], filter: NostrQueryFilter) => Promise<Event[]>;
    publishEvent?: (
        account: NostrAccount,
        content: string,
        options?: {
            replyToEventId?: string;
            replyToPubkey?: string;
            mentionPubkeys?: string[];
        }
    ) => Promise<PublishEventResult>;
    interpreter?: ControlCommandInterpreter;
}

export class ControlCommandInterpreter {
    private env: Env;

    constructor(env: Env) {
        this.env = env;
    }

    async interpret(noteContent: string, account: NostrAccount): Promise<ReturnType<typeof validateInterpreterResponse>> {
        const response: any = await withRetry(() =>
            this.env.AI.run(this.env.AI_MODEL as any, {
                instructions: buildControlSchemaPrompt(),
                input: [
                    'Current account configuration:',
                    JSON.stringify({
                        name: account.name || null,
                        relays: account.relays,
                        categories: account.categories,
                        frequency: account.frequency,
                        data_resources: account.data_resources || [],
                        prompt_template: account.prompt_template || null,
                        personality: account.personality || null,
                        is_active: Boolean(account.is_active),
                    }, null, 2),
                    '',
                    'Admin note:',
                    noteContent,
                    '',
                    'Return JSON only.',
                ].join('\n'),
            })
        );

        return validateInterpreterResponse(extractOutputText(response));
    }
}

export class ControlProcessor {
    private storage: StorageService;
    private queryEvents: (relays: string[], filter: NostrQueryFilter) => Promise<Event[]>;
    private publishEvent: (
        account: NostrAccount,
        content: string,
        options?: {
            replyToEventId?: string;
            replyToPubkey?: string;
            mentionPubkeys?: string[];
        }
    ) => Promise<PublishEventResult>;
    private interpreter: ControlCommandInterpreter;

    constructor(env: Env, storage: StorageService, dependencies: ControlProcessorDependencies = {}) {
        this.storage = storage;
        this.queryEvents = dependencies.queryEvents || NostrService.queryEvents;
        this.publishEvent = dependencies.publishEvent || NostrService.publishEvent;
        this.interpreter = dependencies.interpreter || new ControlCommandInterpreter(env);
    }

    async processAccounts(accounts: NostrAccount[]): Promise<void> {
        const managedAccounts = accounts
            .filter((account): account is NostrAccount & { id: number } =>
                Boolean(account.id)
                && Boolean(account.control_enabled)
                && (account.control_admin_pubkeys || []).length > 0
            )
            .map((account) => ({
                account,
                accountId: account.id as number,
                pubkey: NostrService.getPublicKeyFromPrivate(account.privateKey),
            }));

        if (managedAccounts.length === 0) {
            return;
        }

        const accountsById = new Map<number, ManagedAccountContext>(
            managedAccounts.map((account) => [account.accountId, account])
        );
        const accountsByPubkey = new Map<string, ManagedAccountContext>(
            managedAccounts.map((account) => [account.pubkey, account])
        );
        const discoveredEvents = new Map<string, DiscoveredControlEvent>();

        for (const account of managedAccounts) {
            await this.collectControlEvents(account, discoveredEvents);
        }

        const orderedEvents = [...discoveredEvents.values()].sort((left, right) => {
            if (left.event.created_at !== right.event.created_at) {
                return left.event.created_at - right.event.created_at;
            }

            return left.event.id.localeCompare(right.event.id);
        });

        for (const discoveredEvent of orderedEvents) {
            const alreadyProcessed = await this.storage.hasProcessedControlEvent(discoveredEvent.event.id);
            if (alreadyProcessed) {
                continue;
            }

            await this.processEvent(discoveredEvent, accountsById, accountsByPubkey);
        }
    }

    private async collectControlEvents(
        account: ManagedAccountContext,
        discoveredEvents: Map<string, DiscoveredControlEvent>
    ): Promise<void> {
        const currentCursor = account.account.control_last_checked_at || 0;
        const filter: NostrQueryFilter = {
            kinds: [1],
            authors: account.account.control_admin_pubkeys,
            '#p': [account.pubkey],
            since: Math.max(currentCursor - CONTROL_LOOKBACK_SECONDS, 0),
            limit: CONTROL_QUERY_LIMIT,
        };

        try {
            const events = await this.queryEvents([CONTROL_RELAY_URL], filter);
            let maxSeenTimestamp = currentCursor;

            for (const event of events) {
                maxSeenTimestamp = Math.max(maxSeenTimestamp, event.created_at);
                if (!discoveredEvents.has(event.id)) {
                    discoveredEvents.set(event.id, {
                        event,
                        replyAccountId: account.accountId,
                    });
                }
            }

            if (maxSeenTimestamp > currentCursor) {
                await this.storage.updateControlLastCheckedAt(account.accountId, maxSeenTimestamp);
                account.account.control_last_checked_at = maxSeenTimestamp;
            }
        } catch (error) {
            console.error(`Failed to poll control events for account ${account.pubkey.slice(0, 8)}...`, error);
        }
    }

    private async processEvent(
        discoveredEvent: DiscoveredControlEvent,
        accountsById: Map<number, ManagedAccountContext>,
        accountsByPubkey: Map<string, ManagedAccountContext>
    ): Promise<void> {
        const resolution = await resolveTargetAccount(
            discoveredEvent.event,
            discoveredEvent.replyAccountId,
            accountsById,
            accountsByPubkey,
            this.storage
        );

        if (!resolution.targetAccount) {
            await this.rejectEvent({
                replyAccount: resolution.replyAccount,
                accountId: resolution.replyAccount.accountId,
                event: discoveredEvent.event,
                status: 'rejected',
                message: resolution.error || 'Could not determine which account this command should update.',
            });
            return;
        }

        const targetAccount = resolution.targetAccount;
        if (!(targetAccount.account.control_admin_pubkeys || []).includes(discoveredEvent.event.pubkey)) {
            await this.rejectEvent({
                replyAccount: resolution.replyAccount,
                accountId: targetAccount.accountId,
                event: discoveredEvent.event,
                status: 'rejected',
                message: 'Your pubkey is not allowlisted for this account.',
            });
            return;
        }

        let parsedActionsJson: string | undefined;

        try {
            const actions = await this.interpreter.interpret(discoveredEvent.event.content, targetAccount.account);
            parsedActionsJson = JSON.stringify(actions);

            const applied = applyControlActions(targetAccount.account, actions);
            const changeCount = Object.keys(applied.patch).length;

            if (changeCount > 0) {
                await this.storage.updateAccountConfiguration(targetAccount.accountId, applied.patch);
                targetAccount.account = {
                    ...targetAccount.account,
                    ...applied.updatedAccount,
                };
            }

            const acknowledgement = await this.publishAcknowledgement(
                resolution.replyAccount,
                discoveredEvent.event,
                targetAccount.account,
                applied,
                changeCount === 0
            );

            await this.storage.recordProcessedControlEvent(buildProcessedRecord({
                accountId: targetAccount.accountId,
                event: discoveredEvent.event,
                parsedActionsJson,
                status: changeCount === 0 ? 'ignored' : 'applied',
                resultMessage: acknowledgement,
            }));
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Unknown control processing error.';
            await this.rejectEvent({
                replyAccount: resolution.replyAccount,
                accountId: targetAccount.accountId,
                event: discoveredEvent.event,
                parsedActionsJson,
                status: 'error',
                message,
            });
        }
    }

    private async publishAcknowledgement(
        replyAccount: ManagedAccountContext,
        event: Event,
        targetAccount: NostrAccount,
        applied: AppliedControlActions,
        isNoop: boolean
    ): Promise<string> {
        const targetLabel = targetAccount.name || NostrService.getPublicKeyFromPrivate(targetAccount.privateKey).slice(0, 8);
        const content = isNoop
            ? `No changes were needed for ${targetLabel}. ${applied.summary.join('; ')}.`
            : `Applied ${applied.summary.length} change${applied.summary.length === 1 ? '' : 's'} to ${targetLabel}: ${applied.summary.join('; ')}.`;

        const publishResult = await this.publishEvent(replyAccount.account, content, {
            replyToEventId: event.id,
            replyToPubkey: event.pubkey,
            mentionPubkeys: [event.pubkey],
        });

        if (!publishResult.published) {
            return `${content} Acknowledgement publish failed on all relays.`;
        }

        return content;
    }

    private async rejectEvent(options: {
        replyAccount: ManagedAccountContext;
        accountId: number;
        event: Event;
        parsedActionsJson?: string;
        status: string;
        message: string;
    }): Promise<void> {
        const content = `I could not apply that request: ${options.message}`;

        try {
            await this.publishEvent(options.replyAccount.account, content, {
                replyToEventId: options.event.id,
                replyToPubkey: options.event.pubkey,
                mentionPubkeys: [options.event.pubkey],
            });
        } catch (error) {
            console.error('Failed to publish control rejection acknowledgement:', error);
        }

        await this.storage.recordProcessedControlEvent(buildProcessedRecord({
            accountId: options.accountId,
            event: options.event,
            parsedActionsJson: options.parsedActionsJson,
            status: options.status,
            resultMessage: options.message,
        }));
    }
}

export async function resolveTargetAccount(
    event: Event,
    replyAccountId: number,
    accountsById: Map<number, ManagedAccountContext>,
    accountsByPubkey: Map<string, ManagedAccountContext>,
    storage: StorageService
): Promise<ControlResolution> {
    const replyAccount = accountsById.get(replyAccountId);
    if (!replyAccount) {
        throw new Error(`Unknown reply account ${replyAccountId}`);
    }

    const replyTagEventIds = event.tags
        .filter((tag) => tag[0] === 'e' && tag[1])
        .map((tag) => tag[1]);
    const matchedReplyAccountIds = new Set<number>();

    for (const eventId of replyTagEventIds) {
        const matchedAccountId = await storage.findAccountIdByPostEventId(eventId);
        if (matchedAccountId) {
            matchedReplyAccountIds.add(matchedAccountId);
        }
    }

    if (matchedReplyAccountIds.size === 1) {
        const targetAccountId = [...matchedReplyAccountIds][0];
        const targetAccount = accountsById.get(targetAccountId);
        if (targetAccount) {
            return {
                replyAccount,
                targetAccount,
            };
        }
    }

    if (matchedReplyAccountIds.size > 1) {
        return {
            replyAccount,
            error: 'Your reply matched more than one managed account. Reply directly to a single bot post or mention only one bot pubkey.',
        };
    }

    const mentionedManagedAccounts = [...new Set(
        event.tags
            .filter((tag) => tag[0] === 'p' && tag[1])
            .map((tag) => tag[1])
            .map((pubkey) => accountsByPubkey.get(pubkey))
            .filter((account): account is ManagedAccountContext => Boolean(account))
    )];

    if (mentionedManagedAccounts.length === 1) {
        return {
            replyAccount,
            targetAccount: mentionedManagedAccounts[0],
        };
    }

    if (mentionedManagedAccounts.length > 1) {
        return {
            replyAccount,
            error: 'Your note mentions multiple managed bot accounts. Mention only one bot pubkey or reply directly to a single bot post.',
        };
    }

    return {
        replyAccount,
        error: 'Your note did not reply to a known bot post and did not mention exactly one managed bot pubkey.',
    };
}

function buildProcessedRecord(options: {
    accountId: number;
    event: Event;
    parsedActionsJson?: string;
    status: string;
    resultMessage: string;
}): ProcessedControlEventRecord {
    return {
        eventId: options.event.id,
        accountId: options.accountId,
        authorPubkey: options.event.pubkey,
        rawContent: options.event.content,
        parsedActionsJson: options.parsedActionsJson,
        status: options.status,
        resultMessage: options.resultMessage,
        eventCreatedAt: options.event.created_at,
    };
}

import { describe, expect, it, vi } from 'vitest';
import { ControlProcessor, resolveTargetAccount } from '../src/control';
import { NostrService } from '../src/nostr';
import { NostrAccount } from '../src/types';

const primaryPrivateKey = '1'.repeat(64);
const secondaryPrivateKey = '2'.repeat(64);
const adminPubkey = 'a'.repeat(64);
const strangerPubkey = 'b'.repeat(64);

function createAccount(overrides: Partial<NostrAccount> = {}): NostrAccount {
    return {
        id: 1,
        name: 'Control Bot',
        privateKey: primaryPrivateKey,
        relays: ['wss://relay.example'],
        categories: ['technology'],
        frequency: 'daily',
        data_resources: [],
        prompt_template: 'Original prompt',
        personality: 'informative',
        is_active: true,
        control_enabled: true,
        control_admin_pubkeys: [adminPubkey],
        control_last_checked_at: 0,
        ...overrides,
    };
}

function createControlEvent(overrides: Partial<{
    id: string;
    pubkey: string;
    content: string;
    created_at: number;
    tags: string[][];
}> = {}) {
    return {
        id: 'event-1',
        pubkey: adminPubkey,
        created_at: 100,
        kind: 1,
        tags: [],
        content: 'update the prompt',
        sig: 'sig',
        ...overrides,
    };
}

describe('resolveTargetAccount', () => {
    it('resolves by replying to a known bot post event id', async () => {
        const firstAccount = createAccount({
            id: 1,
            privateKey: primaryPrivateKey,
        });
        const secondAccount = createAccount({
            id: 2,
            name: 'Second Bot',
            privateKey: secondaryPrivateKey,
        });
        const contextsById = new Map([
            [1, { account: firstAccount, accountId: 1, pubkey: NostrService.getPublicKeyFromPrivate(primaryPrivateKey) }],
            [2, { account: secondAccount, accountId: 2, pubkey: NostrService.getPublicKeyFromPrivate(secondaryPrivateKey) }],
        ]);
        const contextsByPubkey = new Map([
            [NostrService.getPublicKeyFromPrivate(primaryPrivateKey), contextsById.get(1)!],
            [NostrService.getPublicKeyFromPrivate(secondaryPrivateKey), contextsById.get(2)!],
        ]);
        const storage = {
            findAccountIdByPostEventId: vi.fn().mockResolvedValue(2),
        } as any;

        const resolution = await resolveTargetAccount(
            createControlEvent({
                tags: [['e', 'post-event-1']],
            }) as any,
            1,
            contextsById as any,
            contextsByPubkey as any,
            storage
        );

        expect(resolution.targetAccount?.accountId).toBe(2);
    });

    it('resolves a single mentioned managed bot pubkey', async () => {
        const account = createAccount();
        const pubkey = NostrService.getPublicKeyFromPrivate(primaryPrivateKey);
        const context = { account, accountId: 1, pubkey };
        const storage = {
            findAccountIdByPostEventId: vi.fn().mockResolvedValue(null),
        } as any;

        const resolution = await resolveTargetAccount(
            createControlEvent({
                tags: [['p', pubkey]],
            }) as any,
            1,
            new Map([[1, context]]) as any,
            new Map([[pubkey, context]]) as any,
            storage
        );

        expect(resolution.targetAccount?.accountId).toBe(1);
    });

    it('rejects ambiguous mentions across multiple managed accounts', async () => {
        const firstPubkey = NostrService.getPublicKeyFromPrivate(primaryPrivateKey);
        const secondPubkey = NostrService.getPublicKeyFromPrivate(secondaryPrivateKey);
        const firstContext = {
            account: createAccount({ id: 1, privateKey: primaryPrivateKey }),
            accountId: 1,
            pubkey: firstPubkey,
        };
        const secondContext = {
            account: createAccount({ id: 2, privateKey: secondaryPrivateKey }),
            accountId: 2,
            pubkey: secondPubkey,
        };
        const storage = {
            findAccountIdByPostEventId: vi.fn().mockResolvedValue(null),
        } as any;

        const resolution = await resolveTargetAccount(
            createControlEvent({
                tags: [['p', firstPubkey], ['p', secondPubkey]],
            }) as any,
            1,
            new Map([[1, firstContext], [2, secondContext]]) as any,
            new Map([[firstPubkey, firstContext], [secondPubkey, secondContext]]) as any,
            storage
        );

        expect(resolution.targetAccount).toBeUndefined();
        expect(resolution.error).toContain('multiple managed bot accounts');
    });
});

describe('ControlProcessor', () => {
    it('applies an allowlisted admin command and records the event', async () => {
        const account = createAccount();
        const pubkey = NostrService.getPublicKeyFromPrivate(primaryPrivateKey);
        const storage = {
            hasProcessedControlEvent: vi.fn().mockResolvedValue(false),
            updateControlLastCheckedAt: vi.fn().mockResolvedValue(undefined),
            updateAccountConfiguration: vi.fn().mockResolvedValue(undefined),
            recordProcessedControlEvent: vi.fn().mockResolvedValue(undefined),
            findAccountIdByPostEventId: vi.fn().mockResolvedValue(null),
        } as any;
        const interpreter = {
            interpret: vi.fn().mockResolvedValue([
                {
                    type: 'set_prompt',
                    prompt_template: 'New prompt from admin',
                },
            ]),
        } as any;
        const publishEvent = vi.fn().mockResolvedValue({
            eventId: 'ack-1',
            published: true,
            successCount: 1,
        });
        const processor = new ControlProcessor({
            AI: { run: vi.fn() } as any,
            AI_MODEL: '@cf/openai/gpt-oss-120b',
            DB: {} as any,
            MAX_POST_LENGTH: '280',
        } as any, storage, {
            interpreter,
            publishEvent,
            queryEvents: vi.fn().mockResolvedValue([
                createControlEvent({
                    tags: [['p', pubkey]],
                }),
            ]),
        });

        await processor.processAccounts([account]);

        expect(interpreter.interpret).toHaveBeenCalledTimes(1);
        expect(storage.updateAccountConfiguration).toHaveBeenCalledWith(1, {
            prompt_template: 'New prompt from admin',
        });
        expect(publishEvent).toHaveBeenCalledWith(
            expect.objectContaining({ id: 1 }),
            expect.stringContaining('Applied 1 change'),
            expect.objectContaining({
                replyToEventId: 'event-1',
                replyToPubkey: adminPubkey,
            })
        );
        expect(storage.recordProcessedControlEvent).toHaveBeenCalledWith(
            expect.objectContaining({
                eventId: 'event-1',
                accountId: 1,
                status: 'applied',
            })
        );
    });

    it('rejects commands from non-allowlisted authors', async () => {
        const account = createAccount();
        const pubkey = NostrService.getPublicKeyFromPrivate(primaryPrivateKey);
        const storage = {
            hasProcessedControlEvent: vi.fn().mockResolvedValue(false),
            updateControlLastCheckedAt: vi.fn().mockResolvedValue(undefined),
            updateAccountConfiguration: vi.fn().mockResolvedValue(undefined),
            recordProcessedControlEvent: vi.fn().mockResolvedValue(undefined),
            findAccountIdByPostEventId: vi.fn().mockResolvedValue(null),
        } as any;
        const interpreter = {
            interpret: vi.fn(),
        } as any;
        const publishEvent = vi.fn().mockResolvedValue({
            eventId: 'ack-1',
            published: true,
            successCount: 1,
        });
        const processor = new ControlProcessor({
            AI: { run: vi.fn() } as any,
            AI_MODEL: '@cf/openai/gpt-oss-120b',
            DB: {} as any,
            MAX_POST_LENGTH: '280',
        } as any, storage, {
            interpreter,
            publishEvent,
            queryEvents: vi.fn().mockResolvedValue([
                createControlEvent({
                    pubkey: strangerPubkey,
                    tags: [['p', pubkey]],
                }),
            ]),
        });

        await processor.processAccounts([account]);

        expect(interpreter.interpret).not.toHaveBeenCalled();
        expect(storage.updateAccountConfiguration).not.toHaveBeenCalled();
        expect(storage.recordProcessedControlEvent).toHaveBeenCalledWith(
            expect.objectContaining({
                status: 'rejected',
            })
        );
    });

    it('ignores already processed control events', async () => {
        const account = createAccount();
        const storage = {
            hasProcessedControlEvent: vi.fn().mockResolvedValue(true),
            updateControlLastCheckedAt: vi.fn().mockResolvedValue(undefined),
            updateAccountConfiguration: vi.fn().mockResolvedValue(undefined),
            recordProcessedControlEvent: vi.fn().mockResolvedValue(undefined),
            findAccountIdByPostEventId: vi.fn().mockResolvedValue(null),
        } as any;
        const interpreter = {
            interpret: vi.fn(),
        } as any;
        const processor = new ControlProcessor({
            AI: { run: vi.fn() } as any,
            AI_MODEL: '@cf/openai/gpt-oss-120b',
            DB: {} as any,
            MAX_POST_LENGTH: '280',
        } as any, storage, {
            interpreter,
            publishEvent: vi.fn(),
            queryEvents: vi.fn().mockResolvedValue([
                createControlEvent({
                    tags: [['p', NostrService.getPublicKeyFromPrivate(primaryPrivateKey)]],
                }),
            ]),
        });

        await processor.processAccounts([account]);

        expect(interpreter.interpret).not.toHaveBeenCalled();
        expect(storage.recordProcessedControlEvent).not.toHaveBeenCalled();
    });
});

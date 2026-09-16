import { describe, expect, it, vi } from 'vitest';
import { ControlCommandInterpreter, ControlProcessor, resolveTargetAccount } from '../src/control';
import { NostrService } from '../src/nostr';
import { DEFAULT_AI_MODEL, NostrAccount } from '../src/types';

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

function createControlEvent(
    overrides: Partial<{
        id: string;
        pubkey: string;
        content: string;
        created_at: number;
        tags: string[][];
    }> = {}
) {
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
            [
                1,
                {
                    account: firstAccount,
                    accountId: 1,
                    pubkey: NostrService.getPublicKeyFromPrivate(primaryPrivateKey),
                },
            ],
            [
                2,
                {
                    account: secondAccount,
                    accountId: 2,
                    pubkey: NostrService.getPublicKeyFromPrivate(secondaryPrivateKey),
                },
            ],
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
                tags: [
                    ['p', firstPubkey],
                    ['p', secondPubkey],
                ],
            }) as any,
            1,
            new Map([
                [1, firstContext],
                [2, secondContext],
            ]) as any,
            new Map([
                [firstPubkey, firstContext],
                [secondPubkey, secondContext],
            ]) as any,
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
        const processor = new ControlProcessor(
            {
                AI: { run: vi.fn() } as any,
                AI_MODEL: '@cf/openai/gpt-oss-120b',
                DB: {} as any,
                MAX_POST_LENGTH: '280',
            } as any,
            storage,
            {
                interpreter,
                publishEvent,
                queryEvents: vi.fn().mockResolvedValue([
                    createControlEvent({
                        tags: [['p', pubkey]],
                    }),
                ]),
            }
        );

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
        const processor = new ControlProcessor(
            {
                AI: { run: vi.fn() } as any,
                AI_MODEL: '@cf/openai/gpt-oss-120b',
                DB: {} as any,
                MAX_POST_LENGTH: '280',
            } as any,
            storage,
            {
                interpreter,
                publishEvent,
                queryEvents: vi.fn().mockResolvedValue([
                    createControlEvent({
                        pubkey: strangerPubkey,
                        tags: [['p', pubkey]],
                    }),
                ]),
            }
        );

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
        const processor = new ControlProcessor(
            {
                AI: { run: vi.fn() } as any,
                AI_MODEL: '@cf/openai/gpt-oss-120b',
                DB: {} as any,
                MAX_POST_LENGTH: '280',
            } as any,
            storage,
            {
                interpreter,
                publishEvent: vi.fn(),
                queryEvents: vi.fn().mockResolvedValue([
                    createControlEvent({
                        tags: [['p', NostrService.getPublicKeyFromPrivate(primaryPrivateKey)]],
                    }),
                ]),
            }
        );

        await processor.processAccounts([account]);

        expect(interpreter.interpret).not.toHaveBeenCalled();
        expect(storage.recordProcessedControlEvent).not.toHaveBeenCalled();
    });

    it('processes informational query commands and replies without leaking prompt or keys', async () => {
        const account = createAccount({
            name: 'Test Bot',
            prompt_template: 'Super secret prompt template',
            data_resources: [
                {
                    type: 'rss',
                    url: 'https://example.com/rss.xml',
                    weight: 2,
                },
            ],
        });
        const pubkey = NostrService.getPublicKeyFromPrivate(primaryPrivateKey);
        const storage = {
            hasProcessedControlEvent: vi.fn().mockResolvedValue(false),
            updateControlLastCheckedAt: vi.fn().mockResolvedValue(undefined),
            updateAccountConfiguration: vi.fn().mockResolvedValue(undefined),
            recordProcessedControlEvent: vi.fn().mockResolvedValue(undefined),
            findAccountIdByPostEventId: vi.fn().mockResolvedValue(null),
        } as any;
        const interpreter = {
            interpret: vi
                .fn()
                .mockResolvedValue([
                    { type: 'show_details' },
                    { type: 'show_resources' },
                    { type: 'show_help' },
                ]),
        } as any;
        const publishEvent = vi.fn().mockResolvedValue({
            eventId: 'ack-query',
            published: true,
            successCount: 1,
        });
        const processor = new ControlProcessor(
            {
                AI: { run: vi.fn() } as any,
                AI_MODEL: '@cf/openai/gpt-oss-120b',
                DB: {} as any,
                MAX_POST_LENGTH: '280',
            } as any,
            storage,
            {
                interpreter,
                publishEvent,
                queryEvents: vi.fn().mockResolvedValue([
                    createControlEvent({
                        tags: [['p', pubkey]],
                        content: 'show your details and resources and what commands you support',
                    }),
                ]),
            }
        );

        await processor.processAccounts([account]);

        expect(interpreter.interpret).toHaveBeenCalledTimes(1);
        expect(storage.updateAccountConfiguration).not.toHaveBeenCalled();

        expect(publishEvent).toHaveBeenCalledTimes(1);
        const publishedContent = publishEvent.mock.calls[0][1];

        // Verify details
        expect(publishedContent).toContain('Account details:');
        expect(publishedContent).toContain('Name: Test Bot');
        expect(publishedContent).toContain('Posting frequency: daily');
        expect(publishedContent).toContain('Personality: informative');
        expect(publishedContent).toContain('Relays: wss://relay.example');
        // Verify prompt and keys are NOT in the published reply
        expect(publishedContent).not.toContain('Super secret prompt template');
        expect(publishedContent).not.toContain(primaryPrivateKey);

        // Verify resources
        expect(publishedContent).toContain('Configured resources (1):');
        expect(publishedContent).toContain('https://example.com/rss.xml');

        // Verify help
        expect(publishedContent).toContain('Supported commands:');

        // Verify event recorded as applied
        expect(storage.recordProcessedControlEvent).toHaveBeenCalledWith(
            expect.objectContaining({
                eventId: 'event-1',
                accountId: 1,
                status: 'applied',
            })
        );
    });
});

describe('ControlCommandInterpreter', () => {
    it('falls back to DEFAULT_AI_MODEL when env.AI_MODEL is undefined', async () => {
        const mockRun = vi.fn().mockResolvedValue({
            response: JSON.stringify({ actions: [{ type: 'show_details' }] }),
        });

        const env = {
            AI: { run: mockRun } as any,
            DB: {} as any,
        };

        const interpreter = new ControlCommandInterpreter(env as any);
        const account = createAccount();

        const result = await interpreter.interpret('show details', account);

        expect(result).toEqual([{ type: 'show_details' }]);
        expect(mockRun).toHaveBeenCalledTimes(1);
        expect(mockRun).toHaveBeenCalledWith(
            DEFAULT_AI_MODEL,
            expect.objectContaining({
                messages: [
                    {
                        role: 'system',
                        content: expect.any(String),
                    },
                    {
                        role: 'user',
                        content: expect.stringContaining('show details'),
                    },
                ],
            })
        );
    });

    it('uses env.AI_MODEL when explicitly configured', async () => {
        const mockRun = vi.fn().mockResolvedValue({
            response: JSON.stringify({ actions: [{ type: 'show_help' }] }),
        });

        const customModel = '@cf/openai/gpt-oss-120b';
        const env = {
            AI: { run: mockRun } as any,
            DB: {} as any,
            AI_MODEL: customModel,
        };

        const interpreter = new ControlCommandInterpreter(env as any);
        const account = createAccount();

        const result = await interpreter.interpret('show help', account);

        expect(result).toEqual([{ type: 'show_help' }]);
        expect(mockRun).toHaveBeenCalledTimes(1);
        expect(mockRun).toHaveBeenCalledWith(
            customModel,
            expect.objectContaining({
                messages: [
                    {
                        role: 'system',
                        content: expect.any(String),
                    },
                    {
                        role: 'user',
                        content: expect.stringContaining('show help'),
                    },
                ],
            })
        );
    });
});

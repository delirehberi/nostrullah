import { describe, expect, it } from 'vitest';
import { applyControlActions, validateInterpreterResponse } from '../src/control-actions';
import { NostrAccount } from '../src/types';

const baseAccount: NostrAccount = {
    id: 1,
    name: 'Tech Bot',
    privateKey: 'nsec1testkey',
    relays: ['wss://relay.example'],
    categories: ['technology'],
    frequency: 'daily',
    data_resources: [
        {
            type: 'rss',
            url: 'https://example.com/feed.xml',
        },
    ],
    prompt_template: 'Original prompt',
    personality: 'informative',
    is_active: true,
};

describe('validateInterpreterResponse', () => {
    it('accepts supported control actions', () => {
        const actions = validateInterpreterResponse(
            JSON.stringify({
                actions: [
                    {
                        type: 'set_prompt',
                        prompt_template: 'Write in a calmer tone.',
                    },
                    {
                        type: 'add_resource',
                        resource: {
                            type: 'rss',
                            url: 'https://example.com/second.xml',
                        },
                    },
                ],
            })
        );

        expect(actions).toHaveLength(2);
        expect(actions[0].type).toBe('set_prompt');
        expect(actions[1].type).toBe('add_resource');
    });

    it('rejects malformed JSON', () => {
        expect(() => validateInterpreterResponse('{actions:[')).toThrow();
    });

    it('rejects extra or disallowed fields like private_key', () => {
        expect(() =>
            validateInterpreterResponse(
                JSON.stringify({
                    actions: [
                        {
                            type: 'set_prompt',
                            prompt_template: 'new prompt',
                            private_key: 'nope',
                        },
                    ],
                })
            )
        ).toThrow();
    });

    it('rejects invalid frequencies and personalities', () => {
        expect(() =>
            validateInterpreterResponse(
                JSON.stringify({
                    actions: [
                        {
                            type: 'set_frequency',
                            frequency: 'weekly',
                        },
                    ],
                })
            )
        ).toThrow();

        expect(() =>
            validateInterpreterResponse(
                JSON.stringify({
                    actions: [
                        {
                            type: 'set_personality',
                            personality: 'chaotic',
                        },
                    ],
                })
            )
        ).toThrow();
    });

    it('tolerates flexible set_active formats (value, active, enabled, disabled, string booleans)', () => {
        const actionWithValue = validateInterpreterResponse(
            JSON.stringify({
                actions: [
                    {
                        type: 'set_active',
                        value: false,
                    },
                ],
            })
        );
        expect(actionWithValue[0]).toEqual({ type: 'set_active', is_active: false });

        const actionWithActive = validateInterpreterResponse(
            JSON.stringify({
                actions: [
                    {
                        type: 'set_active',
                        active: true,
                    },
                ],
            })
        );
        expect(actionWithActive[0]).toEqual({ type: 'set_active', is_active: true });

        const actionWithEnabled = validateInterpreterResponse(
            JSON.stringify({
                actions: [
                    {
                        type: 'set_active',
                        enabled: 'false',
                    },
                ],
            })
        );
        expect(actionWithEnabled[0]).toEqual({ type: 'set_active', is_active: false });

        const actionWithDisabled = validateInterpreterResponse(
            JSON.stringify({
                actions: [
                    {
                        type: 'set_active',
                        disabled: true,
                    },
                ],
            })
        );
        expect(actionWithDisabled[0]).toEqual({ type: 'set_active', is_active: false });

        const directEnable = validateInterpreterResponse(
            JSON.stringify({
                actions: [{ type: 'enable' }],
            })
        );
        expect(directEnable[0]).toEqual({ type: 'set_active', is_active: true });

        const directDisable = validateInterpreterResponse(
            JSON.stringify({
                actions: [{ type: 'disable' }],
            })
        );
        expect(directDisable[0]).toEqual({ type: 'set_active', is_active: false });
    });
});

describe('applyControlActions', () => {
    it('applies supported config changes and returns a patch', () => {
        const result = applyControlActions(baseAccount, [
            {
                type: 'set_name',
                name: 'Updated Bot',
            },
            {
                type: 'set_categories',
                categories: ['technology', 'ai'],
            },
            {
                type: 'set_frequency',
                frequency: 'hourly',
            },
            {
                type: 'set_personality',
                personality: 'humorous',
            },
            {
                type: 'set_relays',
                relays: ['wss://relay.example', 'wss://relay.second'],
            },
            {
                type: 'replace_resources',
                resources: [
                    {
                        type: 'rss',
                        url: 'https://example.com/new.xml',
                    },
                    {
                        type: 'quote',
                        categories: ['technology'],
                    },
                ],
            },
        ]);

        expect(result.updatedAccount.name).toBe('Updated Bot');
        expect(result.updatedAccount.categories).toEqual(['technology', 'ai']);
        expect(result.updatedAccount.frequency).toBe('hourly');
        expect(result.updatedAccount.personality).toBe('humorous');
        expect(result.updatedAccount.relays).toEqual(['wss://relay.example', 'wss://relay.second']);
        expect(result.updatedAccount.data_resources).toEqual([
            {
                type: 'rss',
                url: 'https://example.com/new.xml',
            },
            {
                type: 'quote',
                categories: ['technology'],
            },
        ]);
        expect(result.patch).toMatchObject({
            name: 'Updated Bot',
            frequency: 'hourly',
            personality: 'humorous',
        });
    });

    it('supports adding and removing resources without mutating the original account', () => {
        const originalResources = baseAccount.data_resources || [];

        const result = applyControlActions(baseAccount, [
            {
                type: 'add_resource',
                resource: {
                    type: 'rss',
                    url: 'https://example.com/second.xml',
                },
            },
            {
                type: 'remove_resource',
                match: {
                    type: 'rss',
                    url: 'https://example.com/feed.xml',
                },
            },
        ]);

        expect(originalResources).toEqual([
            {
                type: 'rss',
                url: 'https://example.com/feed.xml',
            },
        ]);
        expect(result.updatedAccount.data_resources).toEqual([
            {
                type: 'rss',
                url: 'https://example.com/second.xml',
            },
        ]);
    });

    it('handles query actions (show_resources, show_details, show_help)', () => {
        const result = applyControlActions(baseAccount, [
            { type: 'show_details' },
            { type: 'show_resources' },
            { type: 'show_help' },
        ]);

        expect(Object.keys(result.patch)).toHaveLength(0);
        expect(result.summary).toHaveLength(3);

        // Details check
        const detailsSummary = result.summary[0];
        expect(detailsSummary).toContain('Account details:');
        expect(detailsSummary).toContain('Name: Tech Bot');
        expect(detailsSummary).toContain('Status: active');
        expect(detailsSummary).toContain('Posting frequency: daily');
        expect(detailsSummary).toContain('Personality: informative');
        expect(detailsSummary).toContain('Categories: technology');
        expect(detailsSummary).toContain('Relays: wss://relay.example');
        // Ensure prompt template and private key are NOT leaked
        expect(detailsSummary).not.toContain('Original prompt');
        expect(detailsSummary).not.toContain('nsec1testkey');

        // Resources check
        const resourcesSummary = result.summary[1];
        expect(resourcesSummary).toContain('Configured resources (1):');
        expect(resourcesSummary).toContain('https://example.com/feed.xml');

        // Help check
        const helpSummary = result.summary[2];
        expect(helpSummary).toContain('Supported commands:');
        expect(helpSummary).toContain('show details');
        expect(helpSummary).toContain('show resources');
        expect(helpSummary).toContain('what commands do you support');
    });

    it('formats empty resource list properly', () => {
        const accountWithoutResources = { ...baseAccount, data_resources: [] };
        const result = applyControlActions(accountWithoutResources, [{ type: 'show_resources' }]);
        expect(result.summary[0]).toBe('Configured resources: none');
    });
});

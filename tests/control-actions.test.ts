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

describe('schedule control actions', () => {
    const scheduledAccount: NostrAccount = {
        ...baseAccount,
        timezone: 'Europe/Istanbul',
        active_hours: '07:00-23:00',
        jitter_minutes: 15,
    };

    it('updates timezone, active hours and jitter', () => {
        const result = applyControlActions(scheduledAccount, [
            { type: 'set_timezone', timezone: 'Europe/Berlin' },
            { type: 'set_active_hours', active_hours: '08:30-22:00' },
            { type: 'set_jitter', jitter_minutes: 5 },
        ]);

        expect(result.patch).toEqual({
            timezone: 'Europe/Berlin',
            active_hours: '08:30-22:00',
            jitter_minutes: 5,
        });
    });

    it('clears active hours with null or "off"', () => {
        for (const value of [null, 'off']) {
            const result = applyControlActions(scheduledAccount, [
                { type: 'set_active_hours', active_hours: value },
            ]);
            expect(result.patch).toEqual({ active_hours: null });
            expect(result.summary).toEqual(['removed active hours (posting all day)']);
        }
    });

    it('validates schedule actions from the interpreter', () => {
        expect(
            validateInterpreterResponse(
                JSON.stringify({
                    actions: [
                        { type: 'set_timezone', timezone: 'Europe/Istanbul' },
                        { type: 'set_active_hours', active_hours: '22:00-02:00' },
                        { type: 'set_jitter', jitter_minutes: '10' },
                    ],
                })
            )
        ).toEqual([
            { type: 'set_timezone', timezone: 'Europe/Istanbul' },
            { type: 'set_active_hours', active_hours: '22:00-02:00' },
            { type: 'set_jitter', jitter_minutes: 10 },
        ]);

        for (const action of [
            { type: 'set_timezone', timezone: 'Mars/Base' },
            { type: 'set_active_hours', active_hours: '7-23' },
            { type: 'set_jitter', jitter_minutes: 90 },
        ]) {
            expect(() =>
                validateInterpreterResponse(JSON.stringify({ actions: [action] }))
            ).toThrow();
        }
    });

    it('shows schedule settings and the next post time in show_details', () => {
        const result = applyControlActions(
            { ...scheduledAccount, jitter_minutes: 0, last_run_at: 1789549200 },
            [{ type: 'show_details' }]
        );

        expect(result.summary[0]).toContain('Timezone: Europe/Istanbul');
        expect(result.summary[0]).toContain('Active hours: 07:00-23:00');
        expect(result.summary[0]).toContain('Random delay: up to 0 min');
        expect(result.summary[0]).toMatch(/Next post: .+ \(Europe\/Istanbul\)/);
    });
});

describe('set_post_formats control action', () => {
    it('accepts a list, weights, default and off', () => {
        expect(
            validateInterpreterResponse(
                JSON.stringify({
                    actions: [
                        { type: 'set_post_formats', post_formats: ['question', 'tip'] },
                        { type: 'set_post_formats', post_formats: { tip: 3, hot_take: 1 } },
                        { type: 'set_post_formats', post_formats: 'default' },
                        { type: 'set_post_formats', post_formats: 'off' },
                    ],
                })
            )
        ).toEqual([
            { type: 'set_post_formats', post_formats: { question: 1, tip: 1 } },
            { type: 'set_post_formats', post_formats: { tip: 3, hot_take: 1 } },
            { type: 'set_post_formats', post_formats: 'default' },
            { type: 'set_post_formats', post_formats: 'off' },
        ]);
    });

    it('rejects unknown formats and all-zero weights', () => {
        for (const post_formats of [['poem'], { tip: 0 }, { poem: 2 }]) {
            expect(() =>
                validateInterpreterResponse(
                    JSON.stringify({ actions: [{ type: 'set_post_formats', post_formats }] })
                )
            ).toThrow();
        }
    });

    it('builds patches for weights, off and default', () => {
        expect(
            applyControlActions(baseAccount, [
                { type: 'set_post_formats', post_formats: { tip: 2 } },
            ]).patch
        ).toEqual({ post_formats: { tip: 2 } });
        expect(
            applyControlActions(baseAccount, [{ type: 'set_post_formats', post_formats: 'off' }])
                .patch
        ).toEqual({ post_formats: {} });
        expect(
            applyControlActions({ ...baseAccount, post_formats: { tip: 2 } }, [
                { type: 'set_post_formats', post_formats: 'default' },
            ]).patch
        ).toEqual({ post_formats: null });
    });
});

describe('set_max_length control action', () => {
    it('validates the range and accepts default', () => {
        expect(
            validateInterpreterResponse(
                JSON.stringify({
                    actions: [
                        { type: 'set_max_length', max_post_length: '600' },
                        { type: 'set_max_length', max_post_length: 'default' },
                    ],
                })
            )
        ).toEqual([
            { type: 'set_max_length', max_post_length: 600 },
            { type: 'set_max_length', max_post_length: 'default' },
        ]);

        for (const max_post_length of [50, 2500, 'long']) {
            expect(() =>
                validateInterpreterResponse(
                    JSON.stringify({ actions: [{ type: 'set_max_length', max_post_length }] })
                )
            ).toThrow();
        }
    });

    it('builds patches and shows the limit in details', () => {
        expect(
            applyControlActions(baseAccount, [{ type: 'set_max_length', max_post_length: 600 }])
                .patch
        ).toEqual({ max_post_length: 600 });

        const reset = applyControlActions({ ...baseAccount, max_post_length: 600 }, [
            { type: 'set_max_length', max_post_length: 'default' },
            { type: 'show_details' },
        ]);
        expect(reset.patch).toEqual({ max_post_length: null });
        expect(reset.summary[1]).toContain('Max post length: default (MAX_POST_LENGTH or 500)');
    });
});

describe('show_stats control action', () => {
    it('is a query action that renders the provided engagement stats', () => {
        expect(
            validateInterpreterResponse(JSON.stringify({ actions: [{ type: 'show_stats' }] }))
        ).toEqual([{ type: 'show_stats' }]);

        const result = applyControlActions(baseAccount, [{ type: 'show_stats' }], {
            engagementStats: {
                posts: 3,
                reactions: 5,
                reposts: 1,
                replies: 2,
                zaps: 0,
                zapSats: 0,
                checkedAt: 1_790_000_000,
            },
        });

        expect(result.patch).toEqual({});
        expect(result.summary[0]).toContain('Reactions: 5');
    });
});

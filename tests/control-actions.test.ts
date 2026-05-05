import { describe, expect, it } from 'vitest';
import {
    applyControlActions,
    validateInterpreterResponse,
} from '../src/control-actions';
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
        const actions = validateInterpreterResponse(JSON.stringify({
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
        }));

        expect(actions).toHaveLength(2);
        expect(actions[0].type).toBe('set_prompt');
        expect(actions[1].type).toBe('add_resource');
    });

    it('rejects malformed JSON', () => {
        expect(() => validateInterpreterResponse('{actions:[')).toThrow();
    });

    it('rejects extra or disallowed fields like private_key', () => {
        expect(() => validateInterpreterResponse(JSON.stringify({
            actions: [
                {
                    type: 'set_prompt',
                    prompt_template: 'new prompt',
                    private_key: 'nope',
                },
            ],
        }))).toThrow();
    });

    it('rejects invalid frequencies and personalities', () => {
        expect(() => validateInterpreterResponse(JSON.stringify({
            actions: [
                {
                    type: 'set_frequency',
                    frequency: 'weekly',
                },
            ],
        }))).toThrow();

        expect(() => validateInterpreterResponse(JSON.stringify({
            actions: [
                {
                    type: 'set_personality',
                    personality: 'chaotic',
                },
            ],
        }))).toThrow();
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
        expect(result.updatedAccount.relays).toEqual([
            'wss://relay.example',
            'wss://relay.second',
        ]);
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
});

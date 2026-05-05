import { z } from 'zod';
import {
    ControlAction,
    FREQUENCY_VALUES,
    Frequency,
    NostrAccount,
    PERSONALITY_VALUES,
    Personality,
    RemoveResourceMatch,
    Resource,
} from './types';

export interface AccountConfigPatch {
    name?: string;
    relays?: string[];
    categories?: string[];
    frequency?: string;
    data_resources?: Resource[];
    prompt_template?: string;
    personality?: Personality;
    is_active?: boolean;
}

export interface AppliedControlActions {
    updatedAccount: NostrAccount;
    patch: AccountConfigPatch;
    summary: string[];
}

const nonEmptyStringSchema = z.string().trim().min(1);
const httpUrlSchema = z.url().refine((value) => {
    try {
        const parsed = new URL(value);
        return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch {
        return false;
    }
}, 'Expected an http or https URL.');
const relayUrlSchema = z.url().refine((value) => {
    try {
        const parsed = new URL(value);
        return parsed.protocol === 'ws:' || parsed.protocol === 'wss:';
    } catch {
        return false;
    }
}, 'Expected a ws or wss relay URL.');
const weightSchema = z.number().positive().optional();

const rssResourceSchema = z.object({
    type: z.enum(['rss', 'scraping']),
    url: httpUrlSchema,
    weight: weightSchema,
}).strict();

const quoteResourceSchema = z.object({
    type: z.literal('quote'),
    categories: z.array(nonEmptyStringSchema).min(1),
    weight: weightSchema,
}).strict();

export const resourceSchema = z.union([
    rssResourceSchema,
    quoteResourceSchema,
]);

const removeResourceMatchSchema = z.object({
    type: z.enum(['rss', 'scraping', 'quote']),
    url: httpUrlSchema.optional(),
    categories: z.array(nonEmptyStringSchema).min(1).optional(),
}).strict().superRefine((value, ctx) => {
    if ((value.type === 'rss' || value.type === 'scraping') && !value.url) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'RSS and scraping resource removals require a URL.',
        });
    }

    if (value.type === 'quote' && (!value.categories || value.categories.length === 0)) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'Quote resource removals require categories.',
        });
    }
});

const controlActionSchema = z.discriminatedUnion('type', [
    z.object({
        type: z.literal('set_prompt'),
        prompt_template: z.string(),
    }).strict(),
    z.object({
        type: z.literal('set_name'),
        name: nonEmptyStringSchema,
    }).strict(),
    z.object({
        type: z.literal('set_categories'),
        categories: z.array(nonEmptyStringSchema).min(1),
    }).strict(),
    z.object({
        type: z.literal('set_personality'),
        personality: z.enum(PERSONALITY_VALUES),
    }).strict(),
    z.object({
        type: z.literal('set_frequency'),
        frequency: z.enum(FREQUENCY_VALUES),
    }).strict(),
    z.object({
        type: z.literal('set_relays'),
        relays: z.array(relayUrlSchema).min(1),
    }).strict(),
    z.object({
        type: z.literal('set_active'),
        is_active: z.boolean(),
    }).strict(),
    z.object({
        type: z.literal('add_resource'),
        resource: resourceSchema,
    }).strict(),
    z.object({
        type: z.literal('remove_resource'),
        match: removeResourceMatchSchema,
    }).strict(),
    z.object({
        type: z.literal('replace_resources'),
        resources: z.array(resourceSchema),
    }).strict(),
]);

const controlResponseSchema = z.object({
    actions: z.array(controlActionSchema).min(1),
}).strict();

export function parseControlActionsResponse(text: string): ControlAction[] {
    const parsedJson = JSON.parse(extractJsonObject(text));
    const parsed = controlResponseSchema.parse(parsedJson);
    return parsed.actions as ControlAction[];
}

export function applyControlActions(
    account: NostrAccount,
    actions: ControlAction[]
): AppliedControlActions {
    const updatedAccount: NostrAccount = cloneAccount(account);
    const summary: string[] = [];

    for (const action of actions) {
        switch (action.type) {
            case 'set_prompt':
                updatedAccount.prompt_template = action.prompt_template;
                summary.push('updated the prompt template');
                break;
            case 'set_name':
                updatedAccount.name = action.name.trim();
                summary.push(`set the account name to "${updatedAccount.name}"`);
                break;
            case 'set_categories':
                updatedAccount.categories = uniqueStrings(action.categories);
                summary.push(`set categories to ${updatedAccount.categories.join(', ')}`);
                break;
            case 'set_personality':
                updatedAccount.personality = action.personality;
                summary.push(`set personality to ${action.personality}`);
                break;
            case 'set_frequency':
                updatedAccount.frequency = action.frequency;
                summary.push(`set posting frequency to ${formatFrequency(action.frequency)}`);
                break;
            case 'set_relays':
                updatedAccount.relays = uniqueStrings(action.relays);
                summary.push(`set ${updatedAccount.relays.length} relay${updatedAccount.relays.length === 1 ? '' : 's'}`);
                break;
            case 'set_active':
                updatedAccount.is_active = action.is_active;
                summary.push(action.is_active ? 'activated the account' : 'deactivated the account');
                break;
            case 'add_resource': {
                const nextResources = [...(updatedAccount.data_resources || [])];
                const normalizedResource = normalizeResource(action.resource);
                if (!nextResources.some((resource) => resourcesEqual(resource, normalizedResource))) {
                    nextResources.push(normalizedResource);
                }
                updatedAccount.data_resources = nextResources;
                summary.push(`added a ${normalizedResource.type} resource`);
                break;
            }
            case 'remove_resource': {
                const beforeCount = (updatedAccount.data_resources || []).length;
                updatedAccount.data_resources = (updatedAccount.data_resources || [])
                    .filter((resource) => !resourceMatches(resource, action.match));
                const removedCount = beforeCount - updatedAccount.data_resources.length;
                summary.push(removedCount > 0
                    ? `removed ${removedCount} resource${removedCount === 1 ? '' : 's'}`
                    : 'found no matching resource to remove');
                break;
            }
            case 'replace_resources':
                updatedAccount.data_resources = dedupeResources(action.resources.map(normalizeResource));
                summary.push(`replaced resources with ${updatedAccount.data_resources.length} configured source${updatedAccount.data_resources.length === 1 ? '' : 's'}`);
                break;
        }
    }

    return {
        updatedAccount,
        patch: buildPatch(account, updatedAccount),
        summary,
    };
}

export function isSupportedFrequency(value: string): value is Frequency {
    return (FREQUENCY_VALUES as readonly string[]).includes(value);
}

export function buildControlSchemaPrompt(): string {
    return [
        'You convert admin Nostr notes into JSON account-update actions.',
        'Return JSON only with shape {"actions":[...]} and no markdown.',
        'Only use the allowed action types: set_prompt, set_name, set_categories, set_personality, set_frequency, set_relays, set_active, add_resource, remove_resource, replace_resources.',
        'Never output private_key, id, created_at, last_run_at, control fields, or any code-change instructions.',
        'Use exact frequency values only: hourly, every_2_hours, twice_a_day, daily.',
        `Use exact personality values only: ${PERSONALITY_VALUES.join(', ')}.`,
        'For add_resource and replace_resources, use resource.type values rss, scraping, or quote.',
        'For rss/scraping resources include a full http/https url. For quote resources include categories.',
        'For remove_resource, use {"type":"remove_resource","match":{...}} with type plus url for rss/scraping or categories for quote.',
        'If the request is ambiguous, unsupported, or does not clearly ask for a DB-backed config change, return {"actions":[]}.',
    ].join(' ');
}

export function validateInterpreterResponse(text: string): ControlAction[] {
    const parsedJson = JSON.parse(extractJsonObject(text));
    const looseSchema = z.object({
        actions: z.array(controlActionSchema),
    }).strict();
    const parsed = looseSchema.parse(parsedJson);

    if (parsed.actions.length === 0) {
        throw new Error('No supported control actions were found in the request.');
    }

    return parsed.actions as ControlAction[];
}

function cloneAccount(account: NostrAccount): NostrAccount {
    return {
        ...account,
        relays: [...account.relays],
        categories: [...account.categories],
        data_resources: [...(account.data_resources || [])].map((resource) => normalizeResource(resource)),
        control_admin_pubkeys: [...(account.control_admin_pubkeys || [])],
    };
}

function buildPatch(original: NostrAccount, updated: NostrAccount): AccountConfigPatch {
    const patch: AccountConfigPatch = {};

    if (original.name !== updated.name) {
        patch.name = updated.name;
    }

    if (!stringArraysEqual(original.relays, updated.relays)) {
        patch.relays = updated.relays;
    }

    if (!stringArraysEqual(original.categories, updated.categories)) {
        patch.categories = updated.categories;
    }

    if (original.frequency !== updated.frequency) {
        patch.frequency = updated.frequency;
    }

    if (original.prompt_template !== updated.prompt_template) {
        patch.prompt_template = updated.prompt_template;
    }

    if (original.personality !== updated.personality) {
        patch.personality = updated.personality;
    }

    if (Boolean(original.is_active) !== Boolean(updated.is_active)) {
        patch.is_active = Boolean(updated.is_active);
    }

    if (!resourcesListEqual(original.data_resources || [], updated.data_resources || [])) {
        patch.data_resources = updated.data_resources || [];
    }

    return patch;
}

function extractJsonObject(text: string): string {
    const trimmed = text.trim();
    const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fencedMatch && fencedMatch[1]) {
        return fencedMatch[1].trim();
    }

    const firstBrace = trimmed.indexOf('{');
    const lastBrace = trimmed.lastIndexOf('}');
    if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
        throw new Error('Expected the AI to return a JSON object.');
    }

    return trimmed.slice(firstBrace, lastBrace + 1);
}

function formatFrequency(frequency: Frequency): string {
    return frequency.replace(/_/g, ' ');
}

function uniqueStrings(values: string[]): string[] {
    const seen = new Set<string>();
    const output: string[] = [];

    for (const value of values) {
        const normalized = value.trim();
        if (!normalized || seen.has(normalized)) {
            continue;
        }
        seen.add(normalized);
        output.push(normalized);
    }

    return output;
}

function normalizeResource(resource: Resource): Resource {
    if (resource.type === 'quote') {
        return {
            type: 'quote',
            categories: uniqueStrings(resource.categories),
            ...(resource.weight ? { weight: resource.weight } : {}),
        };
    }

    return {
        type: resource.type,
        url: resource.url,
        ...(resource.weight ? { weight: resource.weight } : {}),
    };
}

function resourceMatches(resource: Resource, match: RemoveResourceMatch): boolean {
    if (resource.type !== match.type) {
        return false;
    }

    if (resource.type === 'quote') {
        return stringArraysEqual(
            uniqueStrings(resource.categories),
            uniqueStrings(match.categories || [])
        );
    }

    return resource.url === match.url;
}

function resourcesEqual(left: Resource, right: Resource): boolean {
    if (left.type !== right.type) {
        return false;
    }

    if (left.type === 'quote' && right.type === 'quote') {
        return left.weight === right.weight
            && stringArraysEqual(uniqueStrings(left.categories), uniqueStrings(right.categories));
    }

    if (left.type !== 'quote' && right.type !== 'quote') {
        return left.url === right.url && left.weight === right.weight;
    }

    return false;
}

function resourcesListEqual(left: Resource[], right: Resource[]): boolean {
    if (left.length !== right.length) {
        return false;
    }

    return left.every((resource, index) => resourcesEqual(normalizeResource(resource), normalizeResource(right[index])));
}

function dedupeResources(resources: Resource[]): Resource[] {
    const output: Resource[] = [];

    for (const resource of resources) {
        if (!output.some((existing) => resourcesEqual(existing, resource))) {
            output.push(resource);
        }
    }

    return output;
}

function stringArraysEqual(left: string[], right: string[]): boolean {
    if (left.length !== right.length) {
        return false;
    }

    return left.every((value, index) => value === right[index]);
}

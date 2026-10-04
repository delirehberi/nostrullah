import { z } from 'zod';
import {
    ControlAction,
    FREQUENCY_VALUES,
    Frequency,
    NostrAccount,
    PERSONALITY_VALUES,
    POST_FORMAT_VALUES,
    Personality,
    PostFormatWeights,
    RemoveResourceMatch,
    Resource,
} from './types';
import { MAX_JITTER_MINUTES, SchedulerService } from './scheduler';
import { DEFAULT_POST_FORMAT_WEIGHTS, formatPostFormats } from './post-formats';
import { DEFAULT_MAX_POST_LENGTH, MAX_MAX_POST_LENGTH, MIN_MAX_POST_LENGTH } from './post-length';

export interface AccountConfigPatch {
    name?: string;
    relays?: string[];
    categories?: string[];
    frequency?: string;
    timezone?: string;
    active_hours?: string | null;
    jitter_minutes?: number;
    /** `null` resets to the default weights. */
    post_formats?: PostFormatWeights | null;
    /** `null` clears the account value. */
    max_post_length?: number | null;
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

const rssResourceSchema = z
    .object({
        type: z.enum(['rss', 'scraping']),
        url: httpUrlSchema,
        weight: weightSchema,
    })
    .strict();

const quoteResourceSchema = z
    .object({
        type: z.literal('quote'),
        categories: z.array(nonEmptyStringSchema).min(1),
        weight: weightSchema,
    })
    .strict();

export const resourceSchema = z.union([rssResourceSchema, quoteResourceSchema]);

const removeResourceMatchSchema = z
    .object({
        type: z.enum(['rss', 'scraping', 'quote']),
        url: httpUrlSchema.optional(),
        categories: z.array(nonEmptyStringSchema).min(1).optional(),
    })
    .strict()
    .superRefine((value, ctx) => {
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

function booleanCoerce(val: unknown): boolean | undefined {
    if (typeof val === 'boolean') return val;
    if (typeof val === 'string') {
        const lower = val.trim().toLowerCase();
        if (lower === 'true' || lower === '1' || lower === 'active' || lower === 'enabled') {
            return true;
        }
        if (
            lower === 'false' ||
            lower === '0' ||
            lower === 'inactive' ||
            lower === 'disabled' ||
            lower === 'paused'
        ) {
            return false;
        }
    }
    if (typeof val === 'number') {
        return val !== 0;
    }
    return undefined;
}

function preprocessAction(val: any): any {
    if (!val || typeof val !== 'object') return val;
    const type = val.type;
    if (type === 'enable' || type === 'set_enabled') {
        return { type: 'set_active', is_active: true };
    }
    if (type === 'disable' || type === 'set_disabled' || type === 'pause') {
        return { type: 'set_active', is_active: false };
    }
    if (type === 'set_active') {
        const rawActive =
            val.is_active !== undefined
                ? val.is_active
                : val.active !== undefined
                  ? val.active
                  : val.enabled !== undefined
                    ? val.enabled
                    : val.value !== undefined
                      ? val.value
                      : val.disabled !== undefined
                        ? !val.disabled
                        : undefined;

        const resolved = booleanCoerce(rawActive);
        return {
            type: 'set_active',
            is_active: resolved !== undefined ? resolved : rawActive,
        };
    }
    return val;
}

const baseControlActionSchema = z.discriminatedUnion('type', [
    z
        .object({
            type: z.literal('set_prompt'),
            prompt_template: z.string(),
        })
        .strict(),
    z
        .object({
            type: z.literal('set_name'),
            name: nonEmptyStringSchema,
        })
        .strict(),
    z
        .object({
            type: z.literal('set_categories'),
            categories: z.array(nonEmptyStringSchema).min(1),
        })
        .strict(),
    z
        .object({
            type: z.literal('set_personality'),
            personality: z.enum(PERSONALITY_VALUES),
        })
        .strict(),
    z
        .object({
            type: z.literal('set_frequency'),
            frequency: z
                .string()
                .trim()
                .refine((val) => SchedulerService.isValidFrequency(val), {
                    message:
                        'Must be a supported frequency preset (hourly, every_2_hours, twice_a_day, daily) or a valid cron expression',
                }),
        })
        .strict(),
    z
        .object({
            type: z.literal('set_timezone'),
            timezone: z
                .string()
                .trim()
                .refine((val) => SchedulerService.isValidTimezone(val), {
                    message: 'Must be a valid IANA timezone (e.g. Europe/Istanbul, UTC)',
                }),
        })
        .strict(),
    z
        .object({
            type: z.literal('set_active_hours'),
            active_hours: z
                .string()
                .trim()
                .refine(
                    (val) => isActiveHoursOff(val) || SchedulerService.isValidActiveHours(val),
                    {
                        message: 'Must be HH:MM-HH:MM (e.g. 07:00-23:00) or "off"',
                    }
                )
                .nullable(),
        })
        .strict(),
    z
        .object({
            type: z.literal('set_jitter'),
            jitter_minutes: z.coerce
                .number()
                .int()
                .min(0)
                .max(MAX_JITTER_MINUTES, {
                    message: `Must be between 0 and ${MAX_JITTER_MINUTES} minutes`,
                }),
        })
        .strict(),
    z
        .object({
            type: z.literal('set_post_formats'),
            post_formats: z.union([
                z.enum(['default', 'off']),
                z
                    .array(z.enum(POST_FORMAT_VALUES))
                    .min(1)
                    .transform((formats) =>
                        Object.fromEntries(formats.map((format) => [format, 1]))
                    ),
                z
                    .partialRecord(z.enum(POST_FORMAT_VALUES), z.number().min(0).max(10))
                    .refine((weights) => Object.values(weights).some((w) => (w || 0) > 0), {
                        message: 'At least one format needs a weight above 0',
                    }),
            ]),
        })
        .strict(),
    z
        .object({
            type: z.literal('set_max_length'),
            max_post_length: z.union([
                z.literal('default'),
                z.coerce
                    .number()
                    .int()
                    .min(MIN_MAX_POST_LENGTH)
                    .max(MAX_MAX_POST_LENGTH, {
                        message: `Must be between ${MIN_MAX_POST_LENGTH} and ${MAX_MAX_POST_LENGTH} characters`,
                    }),
            ]),
        })
        .strict(),
    z
        .object({
            type: z.literal('set_relays'),
            relays: z.array(relayUrlSchema).min(1),
        })
        .strict(),
    z
        .object({
            type: z.literal('set_active'),
            is_active: z.boolean({
                message: 'is_active must be a boolean (true or false)',
            }),
        })
        .strict(),
    z
        .object({
            type: z.literal('add_resource'),
            resource: resourceSchema,
        })
        .strict(),
    z
        .object({
            type: z.literal('remove_resource'),
            match: removeResourceMatchSchema,
        })
        .strict(),
    z
        .object({
            type: z.literal('replace_resources'),
            resources: z.array(resourceSchema),
        })
        .strict(),
    z
        .object({
            type: z.literal('show_resources'),
        })
        .strict(),
    z
        .object({
            type: z.literal('show_details'),
        })
        .strict(),
    z
        .object({
            type: z.literal('show_help'),
        })
        .strict(),
]);

const controlActionSchema = z.preprocess(preprocessAction, baseControlActionSchema);

const controlResponseSchema = z
    .object({
        actions: z.array(controlActionSchema).min(1),
    })
    .strict();

export function parseControlActionsResponse(text: string): ControlAction[] {
    const parsedJson = JSON.parse(extractJsonObject(text));
    const parsed = controlResponseSchema.parse(parsedJson);
    return parsed.actions as ControlAction[];
}

export function formatResources(resources?: Resource[]): string {
    if (!resources || resources.length === 0) {
        return 'Configured resources: none';
    }

    const items = resources.map((r) => {
        const weightStr = r.weight !== undefined ? ` (weight: ${r.weight})` : '';
        if (r.type === 'quote') {
            return `• [quote] categories: ${r.categories.join(', ')}${weightStr}`;
        }
        return `• [${r.type}] ${r.url}${weightStr}`;
    });

    return `Configured resources (${resources.length}):\n${items.join('\n')}`;
}

export function formatAccountDetails(account: NostrAccount, now: Date = new Date()): string {
    const categories =
        account.categories && account.categories.length > 0
            ? account.categories.join(', ')
            : 'none';
    const relays = account.relays && account.relays.length > 0 ? account.relays.join(', ') : 'none';
    const frequency = account.frequency
        ? formatFrequency(account.frequency as Frequency)
        : 'unspecified';

    const lines = [
        `Name: ${account.name || 'unnamed'}`,
        `Status: ${account.is_active ? 'active' : 'inactive'}`,
        `Posting frequency: ${frequency}`,
        `Timezone: ${account.timezone || 'UTC'}`,
        `Active hours: ${account.active_hours || 'all day'}`,
        `Random delay: up to ${account.jitter_minutes || 0} min`,
        `Next post: ${formatNextRun(account, now)}`,
        `Post formats: ${formatPostFormats(account.post_formats, account.prompt_template)}`,
        `Max post length: ${account.max_post_length ? `${account.max_post_length} characters` : `default (MAX_POST_LENGTH or ${DEFAULT_MAX_POST_LENGTH})`}, links not counted`,
        `Personality: ${account.personality || 'unspecified'}`,
        `Categories: ${categories}`,
        `Relays: ${relays}`,
    ];

    return `Account details:\n${lines.join('\n')}`;
}

export function formatSupportedCommands(): string {
    return [
        'Supported commands:',
        '• show details - View account schedule, personality, categories, and relays',
        '• show resources - List configured RSS feeds, scraping feeds, and quote sources',
        '• what commands do you support / help - View this command guide',
        '• set personality <informative|humorous|enthusiastic|sarcastic|philosophical> - Update tone',
        '• set frequency <hourly|every_2_hours|twice_a_day|daily|cron> - Update posting schedule (daily = 09:00, twice a day = 09:00 & 18:00)',
        '• set timezone <Area/City> - Timezone for the schedule and active hours (e.g. Europe/Istanbul)',
        '• set active hours <HH:MM-HH:MM|off> - Only post inside this window (e.g. 07:00-23:00)',
        '• set random delay <0-60> - Max minutes of random delay added to each post',
        '• set active <true|false> - Activate or pause the bot',
        '• set categories <cat1, cat2, ...> - Update topic categories',
        '• set name <name> - Update bot display name',
        '• set relays <relay1, relay2, ...> - Update target Nostr relays',
        `• set max length <${MIN_MAX_POST_LENGTH}-${MAX_MAX_POST_LENGTH} | default> - Post length limit in characters (links not counted)`,
        `• set post formats <list | format=weight ... | default | off> - Rotate post formats (${POST_FORMAT_VALUES.join(', ')})`,
        '• set prompt <template> - Update prompt template',
        '• add resource <rss/scraping url | quote categories> [weight] - Add content source',
        '• remove resource <url | categories> - Remove content source',
        '• replace resources <sources> - Overwrite all data sources',
    ].join('\n');
}

export function isQueryAction(action: ControlAction): boolean {
    return (
        action.type === 'show_resources' ||
        action.type === 'show_details' ||
        action.type === 'show_help'
    );
}

export function applyControlActions(
    account: NostrAccount,
    actions: ControlAction[]
): AppliedControlActions {
    const updatedAccount: NostrAccount = cloneAccount(account);
    const summary: string[] = [];

    for (const action of actions) {
        switch (action.type) {
            case 'show_resources':
                summary.push(formatResources(updatedAccount.data_resources));
                break;
            case 'show_details':
                summary.push(formatAccountDetails(updatedAccount));
                break;
            case 'show_help':
                summary.push(formatSupportedCommands());
                break;
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
            case 'set_timezone':
                updatedAccount.timezone = action.timezone;
                summary.push(`set timezone to ${action.timezone}`);
                break;
            case 'set_active_hours':
                updatedAccount.active_hours =
                    action.active_hours && !isActiveHoursOff(action.active_hours)
                        ? action.active_hours
                        : undefined;
                summary.push(
                    updatedAccount.active_hours
                        ? `set active hours to ${updatedAccount.active_hours}`
                        : 'removed active hours (posting all day)'
                );
                break;
            case 'set_jitter':
                updatedAccount.jitter_minutes = action.jitter_minutes;
                summary.push(`set random delay to up to ${action.jitter_minutes} min`);
                break;
            case 'set_post_formats':
                if (action.post_formats === 'default') {
                    updatedAccount.post_formats = undefined;
                    summary.push('reset post formats to the defaults');
                } else if (action.post_formats === 'off') {
                    updatedAccount.post_formats = {};
                    summary.push('turned post format rotation off');
                } else {
                    updatedAccount.post_formats = { ...action.post_formats };
                    summary.push(
                        `set post formats to ${formatPostFormats(updatedAccount.post_formats)}`
                    );
                }
                break;
            case 'set_max_length':
                updatedAccount.max_post_length =
                    action.max_post_length === 'default' ? undefined : action.max_post_length;
                summary.push(
                    updatedAccount.max_post_length
                        ? `set max post length to ${updatedAccount.max_post_length} characters`
                        : 'reset max post length to the default'
                );
                break;
            case 'set_relays':
                updatedAccount.relays = uniqueStrings(action.relays);
                summary.push(
                    `set ${updatedAccount.relays.length} relay${updatedAccount.relays.length === 1 ? '' : 's'}`
                );
                break;
            case 'set_active':
                updatedAccount.is_active = action.is_active;
                summary.push(
                    action.is_active ? 'activated the account' : 'deactivated the account'
                );
                break;
            case 'add_resource': {
                const nextResources = [...(updatedAccount.data_resources || [])];
                const normalizedResource = normalizeResource(action.resource);
                if (
                    !nextResources.some((resource) => resourcesEqual(resource, normalizedResource))
                ) {
                    nextResources.push(normalizedResource);
                }
                updatedAccount.data_resources = nextResources;
                summary.push(`added a ${normalizedResource.type} resource`);
                break;
            }
            case 'remove_resource': {
                const beforeCount = (updatedAccount.data_resources || []).length;
                updatedAccount.data_resources = (updatedAccount.data_resources || []).filter(
                    (resource) => !resourceMatches(resource, action.match)
                );
                const removedCount = beforeCount - updatedAccount.data_resources.length;
                summary.push(
                    removedCount > 0
                        ? `removed ${removedCount} resource${removedCount === 1 ? '' : 's'}`
                        : 'found no matching resource to remove'
                );
                break;
            }
            case 'replace_resources':
                updatedAccount.data_resources = dedupeResources(
                    action.resources.map(normalizeResource)
                );
                summary.push(
                    `replaced resources with ${updatedAccount.data_resources.length} configured source${updatedAccount.data_resources.length === 1 ? '' : 's'}`
                );
                break;
        }
    }

    return {
        updatedAccount,
        patch: buildPatch(account, updatedAccount),
        summary,
    };
}

export function isSupportedFrequency(value: string): boolean {
    return SchedulerService.isValidFrequency(value);
}

export function buildControlSchemaPrompt(): string {
    return [
        'You convert admin Nostr notes into JSON account-update or query actions.',
        'Return JSON only with shape {"actions":[...]} and no markdown.',
        'Allowed action types and shapes:',
        '• Query actions: {"type":"show_details"}, {"type":"show_resources"}, {"type":"show_help"}.',
        '• set_active: {"type":"set_active","is_active":true|false}. Use is_active=true for activate/enable/resume/disable false. Use is_active=false for deactivate/disable/pause/active false.',
        '• set_prompt: {"type":"set_prompt","prompt_template":"<template string>"}.',
        '• set_name: {"type":"set_name","name":"<name string>"}.',
        '• set_categories: {"type":"set_categories","categories":["<cat1>","<cat2>"]}.',
        `• set_personality: {"type":"set_personality","personality":"<value>"}. Allowed values: ${PERSONALITY_VALUES.join(', ')}.`,
        '• set_frequency: {"type":"set_frequency","frequency":"<preset or cron>"}. Presets: hourly, every_2_hours, twice_a_day, daily. Cron: 5-part cron (e.g. 0 9,21 * * *).',
        '• set_timezone: {"type":"set_timezone","timezone":"<IANA timezone, e.g. Europe/Istanbul>"}.',
        '• set_active_hours: {"type":"set_active_hours","active_hours":"HH:MM-HH:MM"}. Use null to remove the window and post all day.',
        '• set_jitter: {"type":"set_jitter","jitter_minutes":<integer 0-60>}. Random delay added to each scheduled post.',
        `• set_post_formats: {"type":"set_post_formats","post_formats":["<format>",...]} for equal weights, {"type":"set_post_formats","post_formats":{"<format>":<weight 0-10>}} for weights, or "default" / "off". Formats: ${POST_FORMAT_VALUES.join(', ')}. Default weights: ${JSON.stringify(DEFAULT_POST_FORMAT_WEIGHTS)}.`,
        `• set_max_length: {"type":"set_max_length","max_post_length":<integer ${MIN_MAX_POST_LENGTH}-${MAX_MAX_POST_LENGTH}>} or {"type":"set_max_length","max_post_length":"default"}. Character limit for posts, links not counted.`,
        '• set_relays: {"type":"set_relays","relays":["<ws/wss url>"]}.',
        '• add_resource: {"type":"add_resource","resource":{"type":"rss"|"scraping","url":"<http/https url>","weight":<optional number>}} or {"type":"add_resource","resource":{"type":"quote","categories":["<cat1>"],"weight":<optional number>}}.',
        '• remove_resource: {"type":"remove_resource","match":{"type":"rss"|"scraping","url":"<url>"}} or {"type":"remove_resource","match":{"type":"quote","categories":["<cat1>"]}}.',
        '• replace_resources: {"type":"replace_resources","resources":[<array of resources>]}.',
        'Never output private_key, id, created_at, last_run_at, control fields, or any code-change instructions.',
        'If the request is ambiguous, unsupported, or does not clearly ask for a supported action or query, return {"actions":[]}.',
    ].join('\n');
}

export function formatControlValidationError(error: unknown): string {
    if (error instanceof z.ZodError) {
        const messages = error.issues.map((issue) => {
            const pathParts = issue.path.filter(
                (p) => typeof p === 'string' && p !== 'actions' && isNaN(Number(p))
            );
            const path = pathParts.join('.');
            const fieldPrefix = path ? `Field '${path}': ` : '';
            return `${fieldPrefix}${issue.message}`;
        });
        return `Validation failed: ${messages.join('; ')}`;
    }
    if (error instanceof Error) {
        return error.message;
    }
    return 'An unexpected error occurred while processing the command.';
}

export function validateInterpreterResponse(text: string): ControlAction[] {
    const parsedJson = JSON.parse(extractJsonObject(text));
    const looseSchema = z
        .object({
            actions: z.array(controlActionSchema),
        })
        .strict();
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
        data_resources: [...(account.data_resources || [])].map((resource) =>
            normalizeResource(resource)
        ),
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

    if (original.timezone !== updated.timezone) {
        patch.timezone = updated.timezone;
    }

    if (original.active_hours !== updated.active_hours) {
        patch.active_hours = updated.active_hours || null;
    }

    if (original.jitter_minutes !== updated.jitter_minutes) {
        patch.jitter_minutes = updated.jitter_minutes;
    }

    if (original.max_post_length !== updated.max_post_length) {
        patch.max_post_length = updated.max_post_length ?? null;
    }

    if (JSON.stringify(original.post_formats) !== JSON.stringify(updated.post_formats)) {
        patch.post_formats = updated.post_formats || null;
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

function formatFrequency(frequency: string): string {
    return frequency.replace(/_/g, ' ');
}

function isActiveHoursOff(value: string): boolean {
    return ['off', 'none', 'all day', ''].includes(value.trim().toLowerCase());
}

function formatNextRun(account: NostrAccount, now: Date): string {
    const timezone = SchedulerService.isValidTimezone(account.timezone || '')
        ? (account.timezone as string)
        : 'UTC';
    const nextRun = SchedulerService.getNextRunTimestamp(
        account.last_run_at || 0,
        SchedulerService.fromAccount(account),
        now
    );
    const formatted = new Intl.DateTimeFormat('en-GB', {
        timeZone: timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
    }).format(new Date(nextRun));
    return `${formatted} (${timezone})`;
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
        return (
            left.weight === right.weight &&
            stringArraysEqual(uniqueStrings(left.categories), uniqueStrings(right.categories))
        );
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

    return left.every((resource, index) =>
        resourcesEqual(normalizeResource(resource), normalizeResource(right[index]))
    );
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

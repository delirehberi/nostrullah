import { z } from 'zod';
import { Env, NostrAccount } from './types';
import { resourceSchema } from './control-actions';
import { DEFAULT_ACTIVE_HOURS, DEFAULT_JITTER_MINUTES, DEFAULT_TIMEZONE } from './scheduler';

interface GetAccountsOptions {
    includeInactive?: boolean;
}

const stringArraySchema = z.array(z.string()).default([]);
const resourcesArraySchema = z.array(resourceSchema).default([]);

const safeParseJson = <T>(
    jsonString: string | null | undefined,
    schema: z.ZodType<T>,
    defaultValue: T
): T => {
    if (!jsonString) return defaultValue;
    try {
        const parsed = JSON.parse(jsonString);
        const result = schema.safeParse(parsed);
        if (result.success) {
            return result.data;
        }
        console.warn(`Zod parsing failed for DB field: ${result.error.message}`);
        return defaultValue;
    } catch (e) {
        console.warn(`JSON parsing failed for DB field: ${e}`);
        return defaultValue;
    }
};

export const getAccounts = async (
    env: Env,
    options: GetAccountsOptions = {}
): Promise<NostrAccount[]> => {
    try {
        const query = options.includeInactive
            ? 'SELECT * FROM accounts'
            : 'SELECT * FROM accounts WHERE is_active = 1';
        const { results } = await env.DB.prepare(query).all();

        return results.map((row: any) => ({
            id: row.id,
            name: row.name || undefined,
            privateKey: row.private_key,
            relays: safeParseJson(row.relays, stringArraySchema, []),
            categories: safeParseJson(row.categories, stringArraySchema, []),
            frequency: row.frequency,
            data_resources: safeParseJson(row.data_resources, resourcesArraySchema, []),
            prompt_template: row.prompt_template,
            last_run_at: row.last_run_at || 0,
            personality: row.personality || undefined,
            is_active: Boolean(row.is_active),
            // Columns from migration 0006; fall back to defaults if it is not applied yet.
            timezone: row.timezone || DEFAULT_TIMEZONE,
            active_hours:
                row.active_hours === undefined
                    ? DEFAULT_ACTIVE_HOURS
                    : row.active_hours || undefined,
            jitter_minutes: row.jitter_minutes ?? DEFAULT_JITTER_MINUTES,
            control_enabled: Boolean(row.control_enabled),
            control_admin_pubkeys: safeParseJson(row.control_admin_pubkeys, stringArraySchema, []),
            control_last_checked_at: row.control_last_checked_at || 0,
        }));
    } catch (e) {
        console.error('Failed to fetch accounts from DB:', e);
        return [];
    }
};

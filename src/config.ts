import { Env, NostrAccount } from './types';

interface GetAccountsOptions {
    includeInactive?: boolean;
}

export const getAccounts = async (
    env: Env,
    options: GetAccountsOptions = {}
): Promise<NostrAccount[]> => {
    try {
        const query = options.includeInactive
            ? 'SELECT * FROM accounts'
            : 'SELECT * FROM accounts WHERE is_active = 1';
        const { results } = await env.DB.prepare(
            query
        ).all();

        return results.map((row: any) => ({
            id: row.id,
            name: row.name || undefined,
            privateKey: row.private_key,
            relays: JSON.parse(row.relays),
            categories: JSON.parse(row.categories),
            frequency: row.frequency,
            data_resources: row.data_resources ? JSON.parse(row.data_resources) : [],
            prompt_template: row.prompt_template,
            last_run_at: row.last_run_at || 0,
            personality: row.personality || undefined,
            is_active: Boolean(row.is_active),
            control_enabled: Boolean(row.control_enabled),
            control_admin_pubkeys: row.control_admin_pubkeys
                ? JSON.parse(row.control_admin_pubkeys)
                : [],
            control_last_checked_at: row.control_last_checked_at || 0,
        }));
    } catch (e) {
        console.error('Failed to fetch accounts from DB:', e);
        return [];
    }
};

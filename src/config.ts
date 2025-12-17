import { Env, NostrAccount } from './types';

export const getAccounts = async (env: Env): Promise<NostrAccount[]> => {
    try {
        const { results } = await env.DB.prepare(
            'SELECT * FROM accounts WHERE is_active = 1'
        ).all();

        return results.map((row: any) => ({
            id: row.id,
            privateKey: row.private_key,
            relays: JSON.parse(row.relays),
            categories: JSON.parse(row.categories),
            frequency: row.frequency,
            data_resources: row.data_resources ? JSON.parse(row.data_resources) : [],
            prompt_template: row.prompt_template,
            last_run_at: row.last_run_at || 0
        }));
    } catch (e) {
        console.error('Failed to fetch accounts from DB:', e);
        return [];
    }
};

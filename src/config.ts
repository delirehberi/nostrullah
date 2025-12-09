import { z } from 'zod';
import { Env, NostrAccount } from './types';

const AccountSchema = z.object({
    privateKey: z.string(),
    relays: z.array(z.string()),
    categories: z.array(z.string()),
    frequency: z.string(),
});

export const parseAccounts = (env: Env): NostrAccount[] => {
    try {
        const accounts = JSON.parse(env.NOSTR_ACCOUNTS);
        return z.array(AccountSchema).parse(accounts);
    } catch (e) {
        console.error('Failed to parse NOSTR_ACCOUNTS:', e);
        return [];
    }
};

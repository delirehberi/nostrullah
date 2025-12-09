import { Ai } from '@cloudflare/workers-types';

export interface NostrAccount {
    privateKey: string;
    relays: string[];
    categories: string[];
    frequency: string; // "every_2_hours", "daily", etc.
}

export interface Env {
    AI: Ai;
    BOT_STATE: KVNamespace;
    NOSTR_ACCOUNTS: string; // JSON string
    AI_MODEL: string;
    MAX_POST_LENGTH: string;
}

export interface BotState {
    lastRun: number;
}

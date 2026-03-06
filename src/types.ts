import { Ai } from '@cloudflare/workers-types';

export type Resource =
    | {
          type: 'rss' | 'scraping';
          url: string;
          weight?: number; // Default to 1
      }
    | {
          type: 'quote';
          categories: string[];
          weight?: number; // Default to 1
      };

export type Personality = 'informative' | 'humorous' | 'enthusiastic' | 'sarcastic' | 'philosophical';

export interface NostrAccount {
    id?: number; // Added ID for DB reference
    privateKey: string;
    relays: string[];
    categories: string[];
    frequency: string; // "every_2_hours", "daily", etc.
    data_resources?: Resource[]; // JSON array
    prompt_template?: string;
    last_run_at?: number;
    personality?: Personality;
}

export interface Env {
    AI: Ai;
    DB: D1Database;
    AI_MODEL: string;
    MAX_POST_LENGTH: string;
}

export interface BotState {
    lastRun: number;
}

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

export const PERSONALITY_VALUES = [
    'informative',
    'humorous',
    'enthusiastic',
    'sarcastic',
    'philosophical',
] as const;

export type Personality = typeof PERSONALITY_VALUES[number];

export const FREQUENCY_VALUES = [
    'every_2_hours',
    'daily',
    'hourly',
    'twice_a_day',
] as const;

export type Frequency = typeof FREQUENCY_VALUES[number];

export interface RemoveResourceMatch {
    type: Resource['type'];
    url?: string;
    categories?: string[];
}

export type ControlAction =
    | {
          type: 'set_prompt';
          prompt_template: string;
      }
    | {
          type: 'set_name';
          name: string;
      }
    | {
          type: 'set_categories';
          categories: string[];
      }
    | {
          type: 'set_personality';
          personality: Personality;
      }
    | {
          type: 'set_frequency';
          frequency: Frequency;
      }
    | {
          type: 'set_relays';
          relays: string[];
      }
    | {
          type: 'set_active';
          is_active: boolean;
      }
    | {
          type: 'add_resource';
          resource: Resource;
      }
    | {
          type: 'remove_resource';
          match: RemoveResourceMatch;
      }
    | {
          type: 'replace_resources';
          resources: Resource[];
      };

export interface NostrAccount {
    id?: number; // Added ID for DB reference
    name?: string;
    privateKey: string;
    relays: string[];
    categories: string[];
    frequency: string; // "every_2_hours", "daily", etc.
    data_resources?: Resource[]; // JSON array
    prompt_template?: string;
    last_run_at?: number;
    personality?: Personality;
    is_active?: boolean;
    control_enabled?: boolean;
    control_admin_pubkeys?: string[];
    control_last_checked_at?: number;
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

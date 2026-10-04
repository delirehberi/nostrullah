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

/**
 * Prompt context produced from an account resource. `sourceUrl` identifies the
 * item (e.g. an RSS article) the context was built from, so it can be recorded
 * as shared after a successful publish.
 */
export interface ResourceContext {
    context: string;
    sourceUrl?: string;
    sourceTitle?: string;
}

export interface FetchResourcesOptions {
    /** Normalized item URLs already shared by the account; these are skipped. */
    excludeUrls?: Set<string>;
}

export const PERSONALITY_VALUES = [
    'informative',
    'humorous',
    'enthusiastic',
    'sarcastic',
    'philosophical',
] as const;

export type Personality = (typeof PERSONALITY_VALUES)[number];

export const POST_FORMAT_VALUES = [
    'news_commentary',
    'question',
    'tip',
    'hot_take',
    'short_list',
] as const;

export type PostFormat = (typeof POST_FORMAT_VALUES)[number];
export type PostFormatWeights = Partial<Record<PostFormat, number>>;

export const FREQUENCY_VALUES = ['every_2_hours', 'daily', 'hourly', 'twice_a_day'] as const;

export type FrequencyPreset = (typeof FREQUENCY_VALUES)[number];
export type Frequency = FrequencyPreset | (string & {});

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
          frequency: string;
      }
    | {
          type: 'set_timezone';
          timezone: string;
      }
    | {
          type: 'set_active_hours';
          active_hours: string | null;
      }
    | {
          type: 'set_jitter';
          jitter_minutes: number;
      }
    | {
          type: 'set_post_formats';
          /** `default` resets to the default weights; `off` disables rotation. */
          post_formats: PostFormatWeights | 'default' | 'off';
      }
    | {
          type: 'set_max_length';
          /** `default` clears the account value (env var or 500 applies). */
          max_post_length: number | 'default';
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
      }
    | {
          type: 'show_resources';
      }
    | {
          type: 'show_details';
      }
    | {
          type: 'show_help';
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
    /** IANA timezone the frequency and active hours are evaluated in. */
    timezone?: string;
    /** `HH:MM-HH:MM` posting window in `timezone`; unset means all day. */
    active_hours?: string;
    /** Maximum random delay in minutes added after each scheduled slot. */
    jitter_minutes?: number;
    /** Post format weights; unset = defaults, empty object = rotation off. */
    post_formats?: PostFormatWeights;
    /** Post length limit in characters, links excluded; unset = env var or default. */
    max_post_length?: number;
    control_enabled?: boolean;
    control_admin_pubkeys?: string[];
    control_last_checked_at?: number;
}

export const DEFAULT_AI_MODEL = '@cf/meta/llama-3.1-8b-instruct-fp8';

export interface Env {
    AI: Ai;
    DB: D1Database;
    AI_MODEL?: string;
    MAX_POST_LENGTH?: string;
    FAILED_POSTS?: Queue;
}

export interface BotState {
    lastRun: number;
}

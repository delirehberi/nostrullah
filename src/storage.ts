import { Env } from './types';

export class StorageService {
    private kv: KVNamespace;

    constructor(env: Env) {
        this.kv = env.BOT_STATE;
    }

    private getKey(publicKey: string): string {
        return `last_run:${publicKey}`;
    }

    async getLastRun(publicKey: string): Promise<number> {
        const val = await this.kv.get(this.getKey(publicKey));
        return val ? parseInt(val) : 0;
    }

    async updateLastRun(publicKey: string): Promise<void> {
        await this.kv.put(this.getKey(publicKey), Date.now().toString());
    }

    shouldRun(lastRun: number, frequency: string): boolean {
        const now = Date.now();
        const diff = now - lastRun;

        // Simple frequency parsing
        if (frequency === 'every_2_hours') {
            return diff > 2 * 60 * 60 * 1000;
        }
        if (frequency === 'daily') {
            return diff > 24 * 60 * 60 * 1000;
        }
        if (frequency === 'hourly') {
            return diff > 60 * 60 * 1000;
        }

        // Default to 1 hour if unknown
        return diff > 60 * 60 * 1000;
    }
}

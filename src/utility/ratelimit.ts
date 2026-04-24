export class RateLimit {
    // Key: "userId:commandName" | Value: Expiration Timestamp (Date.now() + limit)
    private static expirations: Map<string, number> = new Map(); 
    private static limits: Map<string, number> = new Map();

    public setLimit(commandName: string, limitInMs: number) {
        RateLimit.limits.set(commandName, limitInMs);
    }

    public getTimeLeft(userId: string, commandName: string): number | undefined {
        const key = this.getKey(userId, commandName);
        const expiry = RateLimit.expirations.get(key);
        if (!expiry) return undefined;
        const now = Date.now();
        return expiry > now ? expiry - now : 0;
    }

    private getKey(userId: string, commandName: string): string {
        return `${userId}:${commandName}`;
    }

    public isRateLimited(userId: string, commandName: string): boolean {
        const limit = RateLimit.limits.get(commandName);
        if (!limit) return false; // fast exit if command has no limit

        const key = this.getKey(userId, commandName);
        const expiry = RateLimit.expirations.get(key);
        const now = Date.now();

        // 1. Check if user is still on cooldown
        if (expiry && now < expiry) {
            return true;
        }

        // 2. Not limited? Set the NEW expiration time
        RateLimit.expirations.set(key, now + limit);
        
        // 3. Cleanup: Automatically delete the key after the limit expires 
        // (Prevents memory leaks - see note below)
        setTimeout(() => {
            RateLimit.expirations.delete(key);
            console.log(`-> Cleared rate limit for ${key}`);
        }, limit);

        return false;
    }
}
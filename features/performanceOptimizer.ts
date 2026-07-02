interface CacheEntry<T> {
    value: T;
    timestamp: number;
}

export class CacheManager<T> {
    private cache: Map<string, CacheEntry<T>>;
    private ttl: number;

    constructor(ttl = 10000) {
        this.cache = new Map();
        this.ttl = ttl;
    }

    get(key: string): T | null {
        const item = this.cache.get(key);
        if (!item) return null;

        if (Date.now() - item.timestamp > this.ttl) {
            this.cache.delete(key);
            return null;
        }

        return item.value;
    }

    set(key: string, value: T): void {
        this.cache.set(key, {
            value,
            timestamp: Date.now()
        });
    }

    clear(key?: string | null): void {
        if (key) {
            this.cache.delete(key);
        } else {
            this.cache.clear();
        }
    }

    prune(): void {
        const now = Date.now();
        for (const [key, item] of this.cache.entries()) {
            if (now - item.timestamp > this.ttl) {
                this.cache.delete(key);
            }
        }
    }
}

export function debounce(func: (...args: any[]) => void, wait: number): (...args: any[]) => void {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    return function executedFunction(this: any, ...args: any[]) {
        const later = () => {
            clearTimeout(timeout);
            func.apply(this, args);
        };
        clearTimeout(timeout);
        timeout = setTimeout(later, wait);
    };
}

export function throttle(func: (...args: any[]) => void, limit: number): (...args: any[]) => void {
    let inThrottle = false;
    return function (this: any, ...args: any[]) {
        if (!inThrottle) {
            func.apply(this, args);
            inThrottle = true;
            setTimeout(() => inThrottle = false, limit);
        }
    };
}

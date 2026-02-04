type CacheEntry<T> = { value: T; expiresAt: number };

export class TtlCache {
  private map = new Map<string, CacheEntry<unknown>>();

  constructor(private defaultTtlMs: number) {}

  get<T>(key: string): T | undefined {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.map.delete(key);
      return undefined;
    }
    return entry.value as T;
  }

  set<T>(key: string, value: T, ttlMs?: number) {
    const expiresAt = Date.now() + (ttlMs ?? this.defaultTtlMs);
    this.map.set(key, { value, expiresAt });
  }
}

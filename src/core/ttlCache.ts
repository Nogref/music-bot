/** Minimal in-memory cache with per-entry expiry (search sessions, dedupe keys, lookups). */
export class TtlCache<K, V> {
  private map = new Map<K, { value: V; expires: number }>();

  constructor(private readonly ttlMs: number, private readonly maxEntries = 1000) {}

  get(key: K): V | undefined {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    if (hit.expires < Date.now()) {
      this.map.delete(key);
      return undefined;
    }
    return hit.value;
  }

  has(key: K): boolean {
    return this.get(key) !== undefined;
  }

  set(key: K, value: V, ttlMs = this.ttlMs): void {
    if (this.map.size >= this.maxEntries) this.prune();
    this.map.set(key, { value, expires: Date.now() + ttlMs });
  }

  delete(key: K): void {
    this.map.delete(key);
  }

  private prune() {
    const now = Date.now();
    for (const [k, v] of this.map) if (v.expires < now) this.map.delete(k);
    // Still full: drop the oldest insertions.
    while (this.map.size >= this.maxEntries) {
      const first = this.map.keys().next();
      if (first.done) break;
      this.map.delete(first.value);
    }
  }
}

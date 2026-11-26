/** Small in-memory TTL cache with in-flight de-duplication and a size cap. */
export class TtlCache<V> {
  private map = new Map<string, { v: V; exp: number }>();
  private inflight = new Map<string, Promise<V>>();
  private ttlMs: number;
  private max: number;

  constructor(ttlMs: number, max = 2000) {
    this.ttlMs = ttlMs;
    this.max = max;
  }

  get(key: string): V | undefined {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    if (hit.exp < Date.now()) {
      this.map.delete(key);
      return undefined;
    }
    return hit.v;
  }

  set(key: string, v: V, ttlMs = this.ttlMs): void {
    if (this.map.size >= this.max) {
      const first = this.map.keys().next().value;
      if (first !== undefined) this.map.delete(first);
    }
    this.map.set(key, { v, exp: Date.now() + ttlMs });
  }

  delete(key: string): void {
    this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
  }

  async wrap(key: string, fn: () => Promise<V>, ttlMs = this.ttlMs): Promise<V> {
    const hit = this.get(key);
    if (hit !== undefined) return hit;
    const running = this.inflight.get(key);
    if (running) return running;
    const p = fn()
      .then((v) => {
        this.set(key, v, ttlMs);
        return v;
      })
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }
}

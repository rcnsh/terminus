export class Lru<K, V> {
  readonly max: number;
  readonly #entries = new Map<K, V>();

  constructor(max: number) {
    this.max = max;
  }

  get size(): number {
    return this.#entries.size;
  }

  has(key: K): boolean {
    return this.#entries.has(key);
  }

  get(key: K): V | undefined {
    if (!this.#entries.has(key)) return undefined;
    const value = this.#entries.get(key) as V;
    this.#entries.delete(key);
    this.#entries.set(key, value);
    return value;
  }

  set(key: K, value: V): this {
    this.#entries.delete(key);
    this.#entries.set(key, value);
    while (this.#entries.size > this.max) this.#entries.delete(this.#entries.keys().next().value as K);
    return this;
  }

  delete(key: K): boolean {
    return this.#entries.delete(key);
  }

  clear(): void {
    this.#entries.clear();
  }
}

export const within = (atMs: number, nowMs: number, windowMs: number): boolean => nowMs >= atMs && nowMs - atMs < windowMs;

export interface OnceEvery {
  due(key: string, nowMs: number): boolean;
  readonly size: number;
}

export function onceEvery(windowMs: number, maxKeys: number): OnceEvery {
  const last = new Lru<string, number>(maxKeys);
  return {
    due(key, nowMs) {
      const at = last.get(key);
      if (at !== undefined && within(at, nowMs, windowMs)) return false;
      last.set(key, nowMs);
      return true;
    },
    get size() {
      return last.size;
    },
  };
}

export function perScope<T>(make: () => T): (scope?: object | null) => T {
  const all = new WeakMap<object, T>();
  const unscoped = make();
  return (scope) => {
    if (!scope) return unscoped;
    let kept = all.get(scope);
    if (kept === undefined) all.set(scope, (kept = make()));
    return kept;
  };
}

export interface KvMemo<E, T> {
  get(env: E, nowMs: number): Promise<T>;
  clear(env: E): void;
}

export function kvMemo<E extends { KV?: KVNamespace }, T>(ttlMs: number, read: (env: E, nowMs: number) => Promise<T>): KvMemo<E, T> {
  const kept = new WeakMap<object, { atMs: number; value: Promise<T> }>();
  return {
    get(env, nowMs) {
      const kv = env.KV;
      if (!kv) return read(env, nowMs);
      const hit = kept.get(kv);
      if (hit && within(hit.atMs, nowMs, ttlMs)) return hit.value;
      const entry = { atMs: nowMs, value: read(env, nowMs) };
      kept.set(kv, entry);
      entry.value.catch(() => kept.get(kv) === entry && kept.delete(kv));
      return entry.value;
    },
    clear(env) {
      if (env.KV) kept.delete(env.KV);
    },
  };
}

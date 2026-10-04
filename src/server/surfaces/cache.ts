import "server-only";

type Entry<T> = { at: number; value: T };

/**
 * Tiny per-key in-memory cache for UI surfaces that call slow providers.
 * Survives dev hot reloads via globalThis; one process only, which is fine
 * for panels that tolerate a minute of staleness.
 */
const store: Map<string, Entry<unknown>> = (globalThis.__augustSurfaceCache ??= new Map());

declare global {
  var __augustSurfaceCache: Map<string, Entry<unknown>> | undefined;
}

export async function cached<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
  const hit = store.get(key) as Entry<T> | undefined;
  if (hit && Date.now() - hit.at < ttlMs) return hit.value;
  const value = await load();
  store.set(key, { at: Date.now(), value });
  return value;
}

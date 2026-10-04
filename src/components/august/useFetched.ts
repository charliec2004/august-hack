"use client";

import { useCallback, useEffect, useState } from "react";

export type Fetched<T> = {
  data: T | null;
  error: string | null;
  loading: boolean;
  reload: () => void;
};

/** GET `url` as JSON while `enabled`, refetching on reload(). Errors become user-facing text. */
export function useFetched<T>(url: string, enabled: boolean): Fetched<T> {
  const [tick, setTick] = useState(0);
  const [result, setResult] = useState<{ key: string; data: T | null; error: string | null } | null>(null);
  const key = `${url}#${tick}`;

  useEffect(() => {
    if (!enabled) return;
    const ctrl = new AbortController();
    fetch(url, { cache: "no-store", signal: ctrl.signal })
      .then(async (res) => {
        const body = (await res.json().catch(() => null)) as (T & { error?: unknown }) | null;
        if (!res.ok || !body) {
          const error = typeof body?.error === "string" ? body.error : "Couldn't load this right now.";
          setResult({ key, data: null, error });
        } else {
          setResult({ key, data: body, error: null });
        }
      })
      .catch((err: Error) => {
        if (err.name !== "AbortError") setResult({ key, data: null, error: "Couldn't reach August. Check your connection." });
      });
    return () => ctrl.abort();
  }, [url, key, enabled]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  // Keep showing the previous data while a reload is in flight.
  return {
    data: result?.data ?? null,
    error: result?.key === key ? result.error : null,
    loading: enabled && result?.key !== key,
    reload,
  };
}

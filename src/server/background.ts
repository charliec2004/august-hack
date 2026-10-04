import "server-only";

import { after } from "next/server";

/**
 * Run work after the response without blocking it. Inside a Next request this
 * uses `after()` (kept alive on serverless); outside one (scripts, cron) it
 * just runs detached. Durable state lives in Postgres either way: if this
 * process dies, the wake stays claimable and the sweeper re-runs it.
 */
export function runInBackground(label: string, fn: () => Promise<unknown>) {
  const wrapped = () =>
    fn().catch((e) => console.error(`[background:${label}]`, (e as Error).message));
  try {
    after(wrapped);
  } catch {
    void wrapped();
  }
}

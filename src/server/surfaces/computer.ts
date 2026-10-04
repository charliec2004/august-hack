import "server-only";

import { getActiveEnvironment } from "@/server/computers/environment";
import { liveBrowsersFor } from "@/server/liveBrowsers";
import { getSpritesProvider } from "@/server/providers/sprites";
import type { ComputerStatus } from "@/server/types/api";
import { cached } from "./cache";

const TTL_MS = 60_000;

/** Whether August's computer provider answers at all (cheap list call). */
async function availability(): Promise<{ available: boolean; reason: string | null }> {
  const provider = getSpritesProvider();
  if (!provider) return { available: false, reason: "August's computer isn't set up yet." };
  const res = await provider.list("aug-");
  if (res.ok) return { available: true, reason: null };
  if (res.error.code === "provider_billing_restricted") {
    return { available: false, reason: "August's computer isn't available yet (the Fly account needs billing)." };
  }
  return { available: false, reason: "Couldn't reach August's computer right now." };
}

export async function computerStatus(userId: string): Promise<ComputerStatus> {
  const [avail, env, live] = await Promise.all([
    cached("computer:availability", TTL_MS, availability),
    getActiveEnvironment(userId).catch(() => null),
    liveBrowsersFor(userId).catch(() => []),
  ]);
  return {
    ...avail,
    generation: env?.generation ?? 0,
    liveSessions: live.length,
    tools: (env?.manifest.tools ?? []).map((t) => ({
      toolKey: t.toolKey,
      packageName: t.packageName,
      packageVersion: t.packageVersion,
    })),
  };
}

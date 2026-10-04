import "server-only";

import { getActiveEnvironment } from "@/server/computers/environment";
import { liveBrowsersFor } from "@/server/liveBrowsers";
import { getSpritesProvider } from "@/server/providers/sprites";
import type { ComputerStatus } from "@/server/types/api";
import { cached } from "./cache";

const TTL_MS = 15 * 60_000;
const PROBE_NAME = "aug-availability-probe";

/**
 * Whether August can actually get a computer. Listing only proves the token
 * works (it succeeds even when creation is blocked), so: a running computer is
 * proof; otherwise probe a create and immediately destroy it. Cached.
 */
async function availability(): Promise<{ available: boolean; reason: string | null }> {
  const provider = getSpritesProvider();
  if (!provider) return { available: false, reason: "August's computer isn't set up yet." };
  const listed = await provider.list("aug-");
  if (!listed.ok) return { available: false, reason: "Couldn't reach August's computer right now." };
  if (listed.value.some((s) => s.name !== PROBE_NAME)) return { available: true, reason: null };
  const created = await provider.create(PROBE_NAME);
  if (created.ok || created.error.code === "already_exists") {
    await provider.destroy(PROBE_NAME);
    return { available: true, reason: null };
  }
  if (created.error.code === "provider_billing_restricted") {
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

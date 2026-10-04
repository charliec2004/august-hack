import "server-only";

import { reconcileBrowserSessions } from "@/server/browser/sessions";
import { computerBrowsers } from "@/server/browser/userBrowser";
import { getActiveEnvironment } from "@/server/computers/environment";
import { query } from "@/server/db/client";
import { getSpritesProvider } from "@/server/providers/sprites";
import type { ComputerCommand, ComputerFile, ComputerWorkspace } from "@/server/types/computer";
import { cached } from "./cache";

const AVAILABILITY_TTL_MS = 15 * 60_000;
const RECONCILE_EVERY_MS = 20_000;
const PROBE_NAME = "aug-availability-probe";

type Availability = Pick<ComputerWorkspace, "available" | "blockedBy">;

/**
 * Whether August can actually get a computer. Listing only proves the token
 * works (it succeeds even when creation is blocked), so: a running computer is
 * proof; otherwise probe a create and immediately destroy it. Cached.
 */
async function probeAvailability(): Promise<Availability> {
  const provider = getSpritesProvider();
  if (!provider) return { available: false, blockedBy: "not_configured" };
  const listed = await provider.list("aug-");
  if (!listed.ok) return { available: false, blockedBy: "unreachable" };
  if (listed.value.some((s) => s.name !== PROBE_NAME)) return { available: true, blockedBy: null };
  const created = await provider.create(PROBE_NAME);
  if (created.ok || created.error.code === "already_exists") {
    await provider.destroy(PROBE_NAME);
    return { available: true, blockedBy: null };
  }
  if (created.error.code === "provider_billing_restricted") return { available: false, blockedBy: "billing" };
  return { available: false, blockedBy: "unreachable" };
}

export function availability(): Promise<Availability> {
  return cached("computer:availability", AVAILABILITY_TTL_MS, probeAvailability);
}

/** Records a fresh availability verdict (e.g. after an exec was blocked). */
export function forgetAvailability(): void {
  globalThis.__augustSurfaceCache?.delete("computer:availability");
}

export function toCommand(r: {
  id: string;
  command: string;
  exit_code: number | null;
  safe_output: string | null;
  created_at: Date;
}): ComputerCommand {
  return {
    id: r.id,
    command: r.command,
    exitCode: r.exit_code,
    output: r.safe_output ?? "",
    createdAt: r.created_at.toISOString(),
  };
}

/** The newest commands run on any of the user's computers, oldest first. */
async function recentCommands(userId: string): Promise<ComputerCommand[]> {
  const { rows } = await query<{
    id: string;
    command: string;
    exit_code: number | null;
    safe_output: string | null;
    created_at: Date;
  }>(
    `select id, command, exit_code, safe_output, created_at from computer_commands
      where user_id = $1 order by created_at desc limit 50`,
    [userId],
  );
  return rows.reverse().map(toCommand);
}

async function recentFiles(userId: string): Promise<ComputerFile[]> {
  const { rows } = await query<{
    id: string;
    filename: string;
    media_type: string;
    byte_count: string;
    created_at: Date;
  }>(
    `select id, filename, media_type, byte_count, created_at from artifacts
      where user_id = $1 order by created_at desc limit 100`,
    [userId],
  );
  return rows.map((r) => ({
    id: r.id,
    filename: r.filename,
    mediaType: r.media_type,
    byteCount: Number(r.byte_count),
    createdAt: r.created_at.toISOString(),
  }));
}

export async function computerWorkspace(userId: string): Promise<ComputerWorkspace> {
  // Close rows Kernel no longer has (idle timeout) before listing; throttled.
  await cached(`computer:reconcile:${userId}`, RECONCILE_EVERY_MS, () =>
    reconcileBrowserSessions(userId).catch(() => 0),
  );
  const [avail, env, browsers, commands, files] = await Promise.all([
    availability(),
    getActiveEnvironment(userId).catch(() => null),
    computerBrowsers(userId),
    recentCommands(userId),
    recentFiles(userId),
  ]);
  return {
    ...avail,
    tools: (env?.manifest.tools ?? []).map((t) => t.toolKey),
    browsers,
    commands,
    files,
  };
}

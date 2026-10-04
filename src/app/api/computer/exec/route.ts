import { currentUser } from "@/server/auth/currentUser";
import { acquireComputer, runOnComputer } from "@/server/computers/runtime";
import { query } from "@/server/db/client";
import { availability, forgetAvailability, toCommand } from "@/server/surfaces/computer";
import type { ComputerExecResult } from "@/server/types/computer";

export const dynamic = "force-dynamic";

const BILLING = "August's computer is waiting on Fly billing.";
const TIMEOUT_MS = 60_000;

function reply(body: ComputerExecResult, status = 200): Response {
  return Response.json(body, { status });
}

/**
 * Runs a command the user typed on August's computer (the user's own console
 * Computer). The user is acting directly, so there is no approval step; the
 * command is recorded in computer_commands like August's.
 */
export async function POST(req: Request) {
  const user = await currentUser();
  const body = (await req.json().catch(() => null)) as { command?: unknown } | null;
  const command = typeof body?.command === "string" ? body.command.trim() : "";
  if (!command || command.length > 4000) {
    return reply({ status: "failed", message: "Enter a command." }, 400);
  }

  const avail = await availability().catch(() => null);
  if (avail?.blockedBy === "billing") return reply({ status: "blocked", blockedBy: "billing", message: BILLING });

  const lease = await acquireComputer({ userId: user.id, responsibilityId: null, workerSessionId: null });
  if (!lease.data) {
    if (lease.safeSummary.includes("provider_billing_restricted")) {
      forgetAvailability();
      return reply({ status: "blocked", blockedBy: "billing", message: BILLING });
    }
    if (lease.status === "blocked") {
      return reply({ status: "blocked", blockedBy: "not_configured", message: "August's computer isn't set up yet." });
    }
    return reply({ status: "failed", message: "Couldn't start August's computer. Try again." }, 502);
  }

  const ran = await runOnComputer({ lease: lease.data, command, timeoutMs: TIMEOUT_MS });
  if (!ran.data || !ran.providerRequestId) {
    return reply({ status: "failed", message: ran.safeSummary }, 502);
  }
  const { rows } = await query<{
    id: string;
    command: string;
    exit_code: number | null;
    safe_output: string | null;
    created_at: Date;
  }>(`select id, command, exit_code, safe_output, created_at from computer_commands where id = $1 and user_id = $2`, [
    ran.providerRequestId,
    user.id,
  ]);
  return reply({ status: "ran", command: toCommand(rows[0]) });
}

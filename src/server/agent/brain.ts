import "server-only";

import { Agent } from "@mastra/core/agent";
import { query } from "@/server/db/client";
import { pendingApprovals } from "@/server/db/effects";
import { listResponsibilities } from "@/server/db/responsibilities";
import { brainSystemPrompt } from "./prompts/brain";
import { brainTools, type BrainContext } from "./brainTools";
import { modelFor } from "./model";

/** Bounded per-turn context packet (spec 15). Never dumps the database. */
export async function brainContextPacket(userId: string): Promise<string> {
  const [{ rows: u }, resps, approvals] = await Promise.all([
    query<{ timezone: string }>(`select timezone from app_users where id = $1`, [userId]),
    listResponsibilities(userId),
    pendingApprovals(userId),
  ]);
  const tz = u[0]?.timezone ?? "UTC";
  const now = new Date();
  const local = now.toLocaleString("en-US", { timeZone: tz, dateStyle: "full", timeStyle: "short" });
  const fmt = (d: Date | null) =>
    d ? d.toLocaleTimeString("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" }) : null;

  const owned = resps.length
    ? resps
        .map(
          (r) =>
            `- [${r.id}] ${r.title}: ${r.status}` +
            (r.waiting_on ? `, waiting on ${r.waiting_on.startsWith("approval:") ? "user approval" : r.waiting_on}` : "") +
            (r.next_wake_at ? `, next check ${fmt(r.next_wake_at)}` : "") +
            (r.next_action ? `. Next: ${r.next_action}` : ""),
        )
        .join("\n")
    : "(nothing yet)";
  const pending = approvals.length
    ? approvals.map((a) => `- ${a.responsibility_title}: ${a.provider}.${a.action} (card shown to user)`).join("\n")
    : "(none)";

  return `# Now
${local} (${tz}).

# What you currently own
${owned}

# Pending approvals
${pending}`;
}

export async function brainAgent(ctx: BrainContext) {
  const packet = await brainContextPacket(ctx.userId);
  return new Agent({
    id: "august-brain",
    name: "August",
    instructions: `${brainSystemPrompt()}\n\n${packet}`,
    model: modelFor("brain"),
    tools: brainTools(ctx),
  });
}

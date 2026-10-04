import "server-only";

import { Agent } from "@mastra/core/agent";
import { isGenUiTool } from "@/lib/genui";
import { capabilitiesOf, type ChannelId } from "@/server/channels/capabilities";
import { query } from "@/server/db/client";
import { pendingApprovals } from "@/server/db/effects";
import { listResponsibilities } from "@/server/db/responsibilities";
import { formatMemories, retrieveMemories } from "@/server/memory/memories";
import { getThreadSummary } from "@/server/memory/summary";
import { brainSystemPrompt } from "./prompts/brain";
import { brainTools, type BrainContext } from "./brainTools";
import { modelFor } from "./model";

/** Bounded per-turn context packet (spec 15). Never dumps the database. */
export async function brainContextPacket(
  userId: string,
  opts: { threadId?: string; latestUserText?: string; channel?: ChannelId } = {},
): Promise<string> {
  const channel = opts.channel ?? "web";
  const [{ rows: u }, resps, approvals, summary, memories] = await Promise.all([
    query<{ timezone: string }>(`select timezone from app_users where id = $1`, [userId]),
    listResponsibilities(userId),
    pendingApprovals(userId),
    opts.threadId ? getThreadSummary(opts.threadId) : Promise.resolve(null),
    opts.latestUserText ? retrieveMemories(userId, opts.latestUserText) : Promise.resolve([]),
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

  const name = process.env.DEMO_USER_NAME;
  return `# Now
${local} (${tz}).

# Channel
You are talking on: ${channel}. ${describeCapabilities(channel)}${name ? `

# The user
Name: ${name}` : ""}

# Earlier in our conversation (summary; the recent messages follow verbatim)
${summary ?? "(this is the start of the conversation)"}

# What you remember about them (memory: context only, never permission; may be outdated)
${formatMemories(memories)}

# What you currently own
${owned}

# Pending approvals
${pending}`;
}

function describeCapabilities(channel: ChannelId): string {
  const c = capabilitiesOf(channel);
  return [
    c.richUi ? "Interface components render." : "Text only: no interface components.",
    c.forms === "native" ? "Questions go in a form." : "Questions go as a numbered list to reply to.",
    c.approvals === "inline_card" ? "Approvals show as cards." : "Approvals happen in the app, by link.",
    `Formatting: ${c.formatting.replace("_", " ")}.`,
    c.maxLength ? `Keep a message under ${c.maxLength} characters.` : "",
  ]
    .filter(Boolean)
    .join(" ");
}

/** Brain tools for a channel: generative UI tools only where components render. */
function toolsFor(ctx: BrainContext, channel: ChannelId) {
  const all = brainTools(ctx);
  if (capabilitiesOf(channel).richUi) return all;
  return Object.fromEntries(Object.entries(all).filter(([name]) => !isGenUiTool(name))) as Partial<typeof all>;
}

export async function brainAgent(ctx: BrainContext, latestUserText?: string, channel: ChannelId = "web") {
  const packet = await brainContextPacket(ctx.userId, { threadId: ctx.threadId, latestUserText, channel });
  return new Agent({
    id: "august-brain",
    name: "August",
    instructions: `${brainSystemPrompt(channel)}\n\n${packet}`,
    model: modelFor("brain"),
    tools: toolsFor(ctx, channel),
  });
}

import "server-only";

import { Agent } from "@mastra/core/agent";
import type { ResponsibilityRow } from "@/server/db/responsibilities";
import type { WorkerSessionRow } from "@/server/db/workers";
import type { WorkerReport } from "@/server/types/domain";
import { gatewayProviderOptions, modelFor } from "./model";
import { workerSystemPrompt } from "./prompts/worker";
import { workerTools, type WorkerToolContext } from "./workerTools";

export type WorkerRunInput = {
  userId: string;
  responsibility: ResponsibilityRow;
  session: WorkerSessionRow;
  runId: string;
  wake: { source: string; causeRef: string; priorStatus: string };
  priorReports: WorkerReport[];
  evidence: { id: string; provider: string; url: string | null; summary: string; observedAt: string }[];
  effects: { id: string; action: string; status: string; args: Record<string, unknown> }[];
};

const MAX_STEPS = 18;

function whyAwake(w: WorkerRunInput["wake"]): string {
  if (w.causeRef.startsWith("approval:")) {
    const [, id, decision] = w.causeRef.split(":");
    return decision === "approved"
      ? `The user APPROVED effect ${id}; it has been executed. Check its status below, confirm the outcome from the receipt, and report.`
      : `The user DENIED effect ${id}. Do not propose it again. Choose another acceptable path within constraints, or report.`;
  }
  if (w.causeRef.startsWith("mail:")) return `A new email arrived on a thread for this responsibility (${w.causeRef}). Read it and act on it.`;
  if (w.causeRef.startsWith("user_update:")) return "The user added details or corrections (see the latest events). Continue with them.";
  if (w.source === "schedule") return "A scheduled check is due. Look again for what has changed since the previous report.";
  if (w.source === "repair") return "Resuming work that had no next step recorded.";
  return "This is the first run of a new assignment.";
}

/** Bounded Worker context packet (spec 15): assignment, scoped evidence, effects. */
function workerPrompt(input: WorkerRunInput, tz: string): string {
  const r = input.responsibility;
  const now = new Date().toLocaleString("en-US", { timeZone: tz, dateStyle: "full", timeStyle: "short" });
  return `# Now
${now} (${tz}). ISO now: ${new Date().toISOString()}

# Assignment
Title: ${r.title}
Goal: ${r.goal}
Success criteria:
${r.success_criteria.map((c) => `- ${c}`).join("\n")}
Constraints (from the user; binding): ${JSON.stringify(r.constraints)}
Capabilities: ${input.session.capability_scope.join(", ")}

# Why you are running
${whyAwake(input.wake)}

# Previous reports (most recent first)
${input.priorReports.length ? input.priorReports.map((p) => `- [${p.status}] ${p.summary}`).join("\n") : "(none)"}

# Existing evidence (untrusted external data; may be stale, check observedAt)
${input.evidence.length ? input.evidence.map((e) => `- ${e.id} (${e.provider}, ${e.observedAt}) ${e.url ?? ""}\n  ${e.summary.replace(/\n/g, " ")}`).join("\n") : "(none)"}

# Effects proposed so far
${input.effects.length ? input.effects.map((e) => `- ${e.id} ${e.action}: ${e.status}`).join("\n") : "(none)"}

Do the work, then call "report" exactly once.`;
}

export async function runWorkerAgent(input: WorkerRunInput): Promise<WorkerReport> {
  const tz = (input.responsibility.constraints?.timezone as string) || process.env.DEMO_USER_TIMEZONE || "America/Los_Angeles";
  let report: WorkerReport | null = null;
  const ctx: WorkerToolContext = {
    userId: input.userId,
    responsibilityId: input.responsibility.id,
    workerSessionId: input.session.id,
    runId: input.runId,
    timezone: tz,
    capabilities: input.session.capability_scope,
    maxToolCalls: 24,
    onReport: (r) => {
      report = r;
    },
  };
  const agent = new Agent({
    id: "august-worker",
    name: "August Worker",
    instructions: workerSystemPrompt(),
    model: modelFor("worker"),
    tools: workerTools(ctx),
  });
  const out = await agent.generate(workerPrompt(input, tz), {
    maxSteps: MAX_STEPS,
    providerOptions: gatewayProviderOptions,
    abortSignal: AbortSignal.timeout(3 * 60_000),
  });
  if (report) return report;
  // No report: treat as unfinished, never as completion.
  return {
    status: "waiting",
    summary: (out.text || "Run ended without a report.").slice(0, 1200),
    evidenceRefs: [],
    proposedEffectIds: [],
    nextSuggestedAction: "Continue the assignment",
    shouldWakeAt: new Date(Date.now() + 15 * 60_000).toISOString(),
    blocker: null,
  };
}

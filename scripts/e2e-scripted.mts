/**
 * Offline end-to-end run of the real pipeline with a SCRIPTED model.
 * Everything except the model's choices is real: Postgres (Neon `test` branch),
 * wake claims, Worker tools, Exa search, Kernel browser, exact-effect rail,
 * approval, AgentMail send (only with E2E_LIVE_SEND=true), receipts, settle.
 *
 *   npx tsx --conditions=react-server --env-file=.env.local --env-file=.env.test.local scripts/e2e-scripted.ts
 */
import { randomUUID } from "node:crypto";
import { MockLanguageModelV4 } from "ai/test";

if (!process.env.TEST_DATABASE_URL) throw new Error("TEST_DATABASE_URL missing (.env.test.local)");
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
delete process.env.NEON_AI_GATEWAY_BASE_URL;
delete process.env.NEON_AI_GATEWAY_TOKEN;
const LIVE_SEND = process.env.E2E_LIVE_SEND === "true";
const SAFE_TO = "charlieconner04@gmail.com";

const { setModelOverrideForTesting } = await import("../src/server/agent/model");
const { query, getPool } = await import("../src/server/db/client");
const { ensureUser } = await import("../src/server/auth/currentUser");
const { ensurePrimaryThread, insertMessage, recentMessages } = await import("../src/server/db/messages");
const { createResponsibility, getResponsibility } = await import("../src/server/db/responsibilities");
const { scheduleResponsibilityWake, processDueWakes } = await import("../src/server/orchestration/wakes");
const { demoRunNextWake } = await import("../src/server/orchestration/demo");
const { pendingApprovals } = await import("../src/server/db/effects");
const { toApprovalView } = await import("../src/server/effects/display");
const { decideApproval } = await import("../src/server/effects/approve");
const { executeEffect } = await import("../src/server/effects/execute");

// ---- scripted model -------------------------------------------------------
type Prompt = { role: string; content: unknown }[];
const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};
const promptText = (p: Prompt) => JSON.stringify(p);
function toolResults(p: Prompt): { toolName: string; output: unknown }[] {
  const out: { toolName: string; output: unknown }[] = [];
  for (const m of p) {
    if (m.role !== "tool" || !Array.isArray(m.content)) continue;
    for (const part of m.content as { type: string; toolName: string; output: unknown }[]) {
      if (part.type === "tool-result") out.push({ toolName: part.toolName, output: part.output });
    }
  }
  return out;
}
function firstUrlFromSearch(p: Prompt): string {
  const r = toolResults(p).find((t) => t.toolName === "web_search");
  const m = JSON.stringify(r?.output ?? "").match(/https?:\/\/[^"\\\s]+/);
  return m?.[0] ?? "https://example.com";
}
function call(toolName: string, input: unknown) {
  return { type: "tool-call" as const, toolCallId: randomUUID(), toolName, input: JSON.stringify(input) };
}
const inAnHour = () => new Date(Date.now() + 3600_000).toISOString();

function workerStep(p: Prompt) {
  const text = promptText(p);
  const done = toolResults(p).map((t) => t.toolName);
  if (text.includes("APPROVED effect")) {
    return [call("report", { status: "completed", summary: "Email sent to the restaurant; receipt recorded.", evidenceRefs: [], proposedEffectIds: [], nextSuggestedAction: null, shouldWakeAt: null, blocker: null })];
  }
  if (text.includes("scheduled check is due")) {
    if (!done.includes("propose_email")) {
      return [call("propose_email", {
        to: [SAFE_TO],
        subject: "August e2e test: table for two tonight",
        text: "Hi, do you have a table for two around 7 PM tonight? Thanks, August (assistant to Charlie)",
      })];
    }
    return [call("report", { status: "waiting", summary: "Asked the restaurant by email; waiting on approval.", evidenceRefs: [], proposedEffectIds: [], nextSuggestedAction: "Wait for approval", shouldWakeAt: inAnHour(), blocker: null })];
  }
  if (!done.includes("web_search")) return [call("web_search", { query: "dinner for two Hayes Valley San Francisco tonight under $120", numResults: 3 })];
  if (!done.includes("browser_inspect")) return [call("browser_inspect", { url: firstUrlFromSearch(p), instruction: "reservation availability around 7pm" })];
  return [call("report", { status: "waiting", summary: "Found candidates but no confirmed 7 PM availability yet.", evidenceRefs: [], proposedEffectIds: [], nextSuggestedAction: "Check availability again", shouldWakeAt: inAnHour(), blocker: null })];
}

function respond(options: { prompt: Prompt; tools?: { name: string }[] }) {
  const isWorker = (options.tools ?? []).some((t) => t.name === "report");
  const text = promptText(options.prompt);
  if (isWorker) return { content: workerStep(options.prompt), finish: "tool-calls" as const };
  if (text.includes("You review ONE frozen")) {
    return { content: [{ type: "text" as const, text: JSON.stringify({ decision: "needs_confirmation", reasonCode: "new_outside_recipient", userFacingQuestion: "OK to email the restaurant?" }) }], finish: "stop" as const };
  }
  return { content: [{ type: "text" as const, text: "Scripted delivery message." }], finish: "stop" as const };
}

const mock = new MockLanguageModelV4({
  provider: "scripted",
  modelId: "scripted",
  doGenerate: async (options) => {
    const r = respond(options as never);
    return { content: r.content, finishReason: { unified: r.finish, raw: r.finish }, usage, warnings: [] } as never;
  },
  doStream: async (options) => {
    const r = respond(options as never);
    const parts: unknown[] = [{ type: "stream-start", warnings: [] }];
    for (const c of r.content) {
      if (c.type === "text") parts.push({ type: "text-start", id: "t" }, { type: "text-delta", id: "t", delta: c.text }, { type: "text-end", id: "t" });
      else parts.push(c);
    }
    parts.push({ type: "finish", finishReason: { unified: r.finish, raw: r.finish }, usage });
    return {
      stream: new ReadableStream({
        start(ctrl) {
          for (const p of parts) ctrl.enqueue(p);
          ctrl.close();
        },
      }),
    } as never;
  },
});
setModelOverrideForTesting(() => mock as never);

// ---- run --------------------------------------------------------------------
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
  if (!ok) process.exitCode = 1;
};

const user = await ensureUser(`e2e-${randomUUID().slice(0, 8)}`);
const threadId = await ensurePrimaryThread(user.id);
const msg = await insertMessage({ threadId, userId: user.id, role: "user", content: "Find a good dinner for two tonight around 7 near Hayes Valley, under $120. Keep checking. Email the restaurant to ask if needed, but ask me before sending anything." });
const resp = await createResponsibility({
  userId: user.id, threadId, sourceMessageId: msg.id, title: "Dinner tonight",
  goal: "Dinner for two tonight around 7 near Hayes Valley", successCriteria: ["A confirmed table or a restaurant reply"],
  constraints: { partySize: 2, time: "19:00", area: "Hayes Valley", budgetUsd: 120, askBeforeCommitting: true }, nextAction: "Start",
});

// Run 1: first assignment.
const w1 = await scheduleResponsibilityWake({ userId: user.id, responsibilityId: resp.id, dueAt: new Date(), source: "user", causeRef: `delegation:${msg.id}` });
const r1 = await processDueWakes({ onlyId: w1.id });
check("run 1 executed once", r1.length === 1, JSON.stringify(r1));
const after1 = await getResponsibility(user.id, resp.id);
check("run 1 settled to scheduled", after1?.status === "scheduled", `status=${after1?.status}`);
const ev = await query<{ provider: string; n: number }>(`select provider, count(*)::int n from evidence_records where responsibility_id = $1 group by provider`, [resp.id]);
const byProv = Object.fromEntries(ev.rows.map((r) => [r.provider, r.n]));
check("real Exa evidence stored", (byProv.exa ?? 0) > 0, JSON.stringify(byProv));
check("real Kernel evidence stored", (byProv.kernel ?? 0) > 0, JSON.stringify(byProv));
const pending = await query(`select 1 from wakeups where responsibility_id = $1 and status = 'pending'`, [resp.id]);
check("future wake persisted (no silent limbo)", (pending.rowCount ?? 0) === 1);

// Run 2: fast-forward the persisted wake.
const r2 = await demoRunNextWake(user.id, resp.id);
check("run 2 via fast-forward", r2.ok === true, JSON.stringify(r2));
const after2 = await getResponsibility(user.id, resp.id);
check("email parked for approval", after2?.status === "waiting_user" && Boolean(after2?.waiting_on?.startsWith("approval:")), `status=${after2?.status} waiting_on=${after2?.waiting_on}`);
const approvals = await pendingApprovals(user.id);
check("approval card rendered from frozen proposal", approvals.length === 1);
const card = approvals[0] ? toApprovalView(approvals[0]) : null;
if (card) console.log("      card:", card.title, card.fields.map((f) => `${f.label}=${f.value}`).join(" | "));

if (card && LIVE_SEND) {
  await decideApproval({ userId: user.id, effectId: card.effectId, decision: "approved", shownProposalHash: card.proposalHash });
  const res = await executeEffect(user.id, card.effectId);
  check("AgentMail send executed once with receipt", res?.outcome === "succeeded", res?.safeSummary);
  const again = await executeEffect(user.id, card.effectId);
  check("second execute is a no-op", again === null);
  const w3 = await scheduleResponsibilityWake({ userId: user.id, responsibilityId: resp.id, dueAt: new Date(), source: "user", causeRef: `approval:${card.effectId}:approved` });
  await processDueWakes({ onlyId: w3.id });
  const after3 = await getResponsibility(user.id, resp.id);
  check("completed with evidence", after3?.status === "completed", `status=${after3?.status}`);
} else {
  console.log("SKIP  live AgentMail send (set E2E_LIVE_SEND=true)");
}

const msgs = await recentMessages(user.id, threadId, 20);
check("Brain delivered async updates", msgs.filter((m) => m.role === "assistant").length >= 1, `${msgs.length} messages`);
await getPool().end();

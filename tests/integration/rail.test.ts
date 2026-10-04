/**
 * Integration tests against the Neon `test` branch (spec 35): wakes claim once,
 * approvals bind to the exact hash, effects execute once, uncertainty is not retried.
 * Skipped when TEST_DATABASE_URL is absent.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const enabled = Boolean(process.env.TEST_DATABASE_URL);
const d = enabled ? describe : describe.skip;

d("exact-effect rail + wakes (real Postgres)", async () => {
  const { query, getPool } = await import("@/server/db/client");
  const { ensureUser } = await import("@/server/auth/currentUser");
  const { ensurePrimaryThread, insertMessage } = await import("@/server/db/messages");
  const { createResponsibility, getResponsibility, transition } = await import("@/server/db/responsibilities");
  const { tx } = await import("@/server/db/client");
  const { scheduleWake, claimDueWakes } = await import("@/server/db/wakeups");
  const { prepareEffect } = await import("@/server/effects/prepare");
  const { decideApproval, ApprovalConflict } = await import("@/server/effects/approve");
  const { executeEffect, EffectIntegrityError } = await import("@/server/effects/execute");
  const { registerDispatcher } = await import("@/server/effects/registry");
  const { reviseEmailEffect } = await import("@/server/effects/revise");
  const { buildSendDraft } = await import("@/server/providers/agentmail");
  const { dispatchDueScheduledEffects } = await import("@/server/orchestration/wakes");

  let userId = "";
  let threadId = "";
  let dispatchCount = 0;
  let mode: "ok" | "throw" = "ok";

  registerDispatcher("testprov.send_note", {
    dispatch: async (e) => {
      dispatchCount += 1;
      if (mode === "throw") throw new Error("socket timeout after write");
      return {
        outcome: "succeeded",
        providerReceiptRef: `rcpt_${e.id}`,
        providerRequestId: null,
        evidenceRefs: [],
        safeSummary: "sent",
      };
    },
  });

  // Stand-in for AgentMail: records exactly what would be sent.
  const mailSent: Record<string, unknown>[] = [];
  registerDispatcher("agentmail.send_email", {
    dispatch: async (e) => {
      mailSent.push(e.canonicalArgs);
      return { outcome: "succeeded", providerReceiptRef: `m_${e.id}`, providerRequestId: null, evidenceRefs: [], safeSummary: "sent" };
    },
  });

  async function newResp(title = "Test") {
    const msg = await insertMessage({ threadId, userId, role: "user", content: "Email Bob and ask about Friday." });
    return createResponsibility({
      userId,
      threadId,
      sourceMessageId: msg.id,
      title,
      goal: "g",
      successCriteria: ["c"],
      constraints: {},
      nextAction: "x",
    });
  }

  const draft = (to = "bob@example.com") => ({
    provider: "testprov",
    action: "send_note",
    args: { to: [to], text: "Are you free Friday?" },
    materialFacts: { recipient: to },
  });

  beforeAll(async () => {
    const u = await ensureUser(`test-${randomUUID()}`);
    userId = u.id;
    threadId = await ensurePrimaryThread(userId);
  });

  afterAll(async () => {
    await getPool().end();
  });

  it("two concurrent scanners claim a due wake exactly once", async () => {
    const r = await newResp();
    const w = await tx((c) =>
      scheduleWake(c, { userId, responsibilityId: r.id, source: "schedule", causeRef: "t", dueAt: new Date() }),
    );
    const [a, b] = await Promise.all([
      claimDueWakes("scanner-a", { onlyId: w.id }),
      claimDueWakes("scanner-b", { onlyId: w.id }),
    ]);
    expect(a.length + b.length).toBe(1);
  });

  it("future wakes are not claimable; completed responsibilities' wakes are cancelled", async () => {
    const r = await newResp();
    const future = await tx((c) =>
      scheduleWake(c, { userId, responsibilityId: r.id, source: "schedule", causeRef: "f", dueAt: new Date(Date.now() + 3600_000) }),
    );
    expect(await claimDueWakes("s", { limit: 50 }).then((rows) => rows.some((x) => x.id === future.id))).toBe(false);

    const r2 = await newResp();
    const w2 = await tx((c) =>
      scheduleWake(c, { userId, responsibilityId: r2.id, source: "schedule", causeRef: "d", dueAt: new Date() }),
    );
    await tx((c) => transition(c, { userId, responsibilityId: r2.id, to: "completed", eventText: "done" }));
    const claimed = await claimDueWakes("s", { onlyId: w2.id });
    expect(claimed).toHaveLength(0);
    const { rows } = await query<{ status: string }>(`select status from wakeups where id = $1`, [w2.id]);
    expect(rows[0].status).toBe("cancelled");
  });

  it("terminal responsibilities cannot be moved back", async () => {
    const r = await newResp();
    await tx((c) => transition(c, { userId, responsibilityId: r.id, to: "cancelled", eventText: "x" }));
    const res = await tx((c) => transition(c, { userId, responsibilityId: r.id, to: "running", eventText: "x" }));
    expect(res).toBeNull();
    expect((await getResponsibility(userId, r.id))?.status).toBe("cancelled");
  });

  it("reviewer fails closed without a model, and parks for approval", async () => {
    const r = await newResp();
    const p = await prepareEffect({ userId, responsibilityId: r.id, workerSessionId: null, draft: draft() });
    expect(p.status).toBe("waiting_approval");
    expect((await getResponsibility(userId, r.id))?.status).toBe("waiting_user");
  });

  it("approval hash mismatch blocks; exact approval executes exactly once", async () => {
    const r = await newResp();
    const p = await prepareEffect({ userId, responsibilityId: r.id, workerSessionId: null, draft: draft() });
    await expect(
      decideApproval({ userId, effectId: p.effectId, decision: "approved", shownProposalHash: "sha256:deadbeef" }),
    ).rejects.toBeInstanceOf(ApprovalConflict);

    await decideApproval({ userId, effectId: p.effectId, decision: "approved", shownProposalHash: p.proposalHash });
    const before = dispatchCount;
    const [x, y] = await Promise.all([executeEffect(userId, p.effectId), executeEffect(userId, p.effectId)]);
    expect([x, y].filter(Boolean)).toHaveLength(1);
    expect(dispatchCount - before).toBe(1);
    const { rows } = await query<{ n: number }>(
      `select count(*)::int n from effect_receipts where effect_proposal_id = $1`,
      [p.effectId],
    );
    expect(rows[0].n).toBe(1);
  });

  it("a changed recipient is a new proposal; the old approval cannot be reused", async () => {
    const r = await newResp();
    const p1 = await prepareEffect({ userId, responsibilityId: r.id, workerSessionId: null, draft: draft("bob@example.com") });
    await decideApproval({ userId, effectId: p1.effectId, decision: "approved", shownProposalHash: p1.proposalHash });
    const p2 = await prepareEffect({ userId, responsibilityId: r.id, workerSessionId: null, draft: draft("mallory@example.com") });
    expect(p2.effectId).not.toBe(p1.effectId);
    expect(p2.proposalHash).not.toBe(p1.proposalHash);
    expect(p2.status).toBe("waiting_approval");
    expect(await executeEffect(userId, p2.effectId)).toBeNull();
  });

  it("tampering with frozen args after approval blocks execution", async () => {
    const r = await newResp();
    const p = await prepareEffect({ userId, responsibilityId: r.id, workerSessionId: null, draft: draft() });
    await decideApproval({ userId, effectId: p.effectId, decision: "approved", shownProposalHash: p.proposalHash });
    await query(
      `update effect_proposals set canonical_args = jsonb_set(canonical_args, '{to}', '["evil@example.com"]') where id = $1`,
      [p.effectId],
    );
    const before = dispatchCount;
    await expect(executeEffect(userId, p.effectId)).rejects.toBeInstanceOf(EffectIntegrityError);
    expect(dispatchCount).toBe(before);
  });

  it("denied approval cannot be reused", async () => {
    const r = await newResp();
    const p = await prepareEffect({ userId, responsibilityId: r.id, workerSessionId: null, draft: draft() });
    await decideApproval({ userId, effectId: p.effectId, decision: "denied", shownProposalHash: p.proposalHash });
    await expect(
      decideApproval({ userId, effectId: p.effectId, decision: "approved", shownProposalHash: p.proposalHash }),
    ).rejects.toBeInstanceOf(ApprovalConflict);
    expect(await executeEffect(userId, p.effectId)).toBeNull();
  });

  it("post-dispatch error is uncertain and never blindly retried", async () => {
    const r = await newResp();
    const p = await prepareEffect({ userId, responsibilityId: r.id, workerSessionId: null, draft: draft("carol@example.com") });
    await decideApproval({ userId, effectId: p.effectId, decision: "approved", shownProposalHash: p.proposalHash });
    mode = "throw";
    const res = await executeEffect(userId, p.effectId);
    mode = "ok";
    expect(res?.outcome).toBe("uncertain");
    const before = dispatchCount;
    expect(await executeEffect(userId, p.effectId)).toBeNull();
    expect(dispatchCount).toBe(before);
  });

  it("other users cannot see or approve the effect", async () => {
    const r = await newResp();
    const p = await prepareEffect({ userId, responsibilityId: r.id, workerSessionId: null, draft: draft("dave@example.com") });
    const other = await ensureUser(`test-other-${randomUUID()}`);
    await expect(
      decideApproval({ userId: other.id, effectId: p.effectId, decision: "approved", shownProposalHash: p.proposalHash }),
    ).rejects.toBeInstanceOf(ApprovalConflict);
  });

  it("a user edit supersedes the proposal: new hash executes, the original never can", async () => {
    const r = await newResp();
    const inbox = "august-test@agentmail.to";
    const p = await prepareEffect({
      userId,
      responsibilityId: r.id,
      workerSessionId: null,
      draft: buildSendDraft({ to: "bob@example.com", subject: "Coffee?", text: "Free Thursday?" }, inbox),
    });
    expect(p.status).toBe("waiting_approval");

    await expect(
      reviseEmailEffect({
        userId,
        effectId: p.effectId,
        shownProposalHash: "sha256:stale",
        edit: { to: ["bob@example.com"], subject: "x", body: "y" },
      }),
    ).rejects.toBeInstanceOf(ApprovalConflict);

    const edit = { to: ["Bob@Example.com"], subject: "Coffee Thursday?", body: "Free Thursday at 10?" };
    const rev = await reviseEmailEffect({ userId, effectId: p.effectId, shownProposalHash: p.proposalHash, edit });
    expect(rev.effectId).not.toBe(p.effectId);
    expect(rev.proposalHash).not.toBe(p.proposalHash);

    const { rows } = await query<{ id: string; status: string; review_reason: string | null; review_decision: string | null }>(
      `select id, status, review_reason, review_decision from effect_proposals where id = any($1::uuid[])`,
      [[p.effectId, rev.effectId]],
    );
    const orig = rows.find((x) => x.id === p.effectId)!;
    const next = rows.find((x) => x.id === rev.effectId)!;
    expect(orig).toMatchObject({ status: "denied", review_reason: "superseded_by_user_edit" });
    expect(next).toMatchObject({ status: "authorized", review_decision: "user_authored" });

    await expect(
      decideApproval({ userId, effectId: p.effectId, decision: "approved", shownProposalHash: p.proposalHash }),
    ).rejects.toBeInstanceOf(ApprovalConflict);
    expect(await executeEffect(userId, p.effectId)).toBeNull();

    const before = mailSent.length;
    expect((await executeEffect(userId, rev.effectId))?.outcome).toBe("succeeded");
    expect(await executeEffect(userId, rev.effectId)).toBeNull();
    expect(mailSent.length - before).toBe(1);
    expect(mailSent.at(-1)).toEqual({ fromInbox: inbox, to: ["bob@example.com"], subject: edit.subject, text: edit.body });
  });

  it("a scheduled effect is not dispatched before it is due, then exactly once", async () => {
    const r = await newResp();
    const p = await prepareEffect({ userId, responsibilityId: r.id, workerSessionId: null, draft: draft("erin@example.com") });
    const sendAt = new Date(Date.now() + 3600_000).toISOString();
    await decideApproval({ userId, effectId: p.effectId, decision: "approved", shownProposalHash: p.proposalHash, sendAt });
    expect((await getResponsibility(userId, r.id))?.status).toBe("scheduled");

    const resumed: string[] = [];
    const resume = async (e: { effectId: string }) => void resumed.push(e.effectId);
    const before = dispatchCount;
    expect(await executeEffect(userId, p.effectId)).toBeNull();
    expect(await dispatchDueScheduledEffects({ userId, resume })).toBe(0);
    expect(dispatchCount).toBe(before);

    await query(`update effect_proposals set scheduled_for = now() - interval '1 second' where id = $1`, [p.effectId]);
    const [a, b] = await Promise.all([
      dispatchDueScheduledEffects({ userId, resume }),
      dispatchDueScheduledEffects({ userId, resume }),
    ]);
    expect(a + b).toBe(1);
    expect(dispatchCount - before).toBe(1);
    expect(resumed).toEqual([p.effectId]);
    expect(await dispatchDueScheduledEffects({ userId, resume })).toBe(0);
  });
});

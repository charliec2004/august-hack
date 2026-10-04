/** Regression: an email already sent for a responsibility is never proposed again. */
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";

const d = process.env.TEST_DATABASE_URL ? describe : describe.skip;

d("duplicate send guard (real Postgres)", async () => {
  const { getPool, query } = await import("@/server/db/client");
  const { ensureUser } = await import("@/server/auth/currentUser");
  const { ensurePrimaryThread, insertMessage } = await import("@/server/db/messages");
  const { createResponsibility } = await import("@/server/db/responsibilities");
  const { prepareEffect } = await import("@/server/effects/prepare");

  afterAll(async () => {
    await getPool().end();
  });

  it("refuses a resend of the same email, allows a different follow-up", async () => {
    const user = await ensureUser(`dup-${randomUUID()}`);
    const threadId = await ensurePrimaryThread(user.id);
    const msg = await insertMessage({ threadId, userId: user.id, role: "user", content: "Email Bob about Friday." });
    const r = await createResponsibility({
      userId: user.id, threadId, sourceMessageId: msg.id, title: "t", goal: "g",
      successCriteria: ["c"], constraints: {}, nextAction: "x",
    });
    const draft = (subject: string) => ({
      provider: "agentmail",
      action: "send_email",
      args: { fromInbox: "a@agentmail.to", to: ["bob@example.com"], subject, text: "Free Friday?" },
      materialFacts: {},
    });

    const first = await prepareEffect({ userId: user.id, responsibilityId: r.id, workerSessionId: null, draft: draft("Friday?") });
    await query(`update effect_proposals set status = 'succeeded' where id = $1`, [first.effectId]);

    const resend = await prepareEffect({ userId: user.id, responsibilityId: r.id, workerSessionId: null, draft: draft("Re: friday? ") });
    expect(resend.status).toBe("denied");
    expect(resend.decision.reasonCode).toBe("duplicate_of_sent_email");

    const followUp = await prepareEffect({ userId: user.id, responsibilityId: r.id, workerSessionId: null, draft: draft("Following up on Friday") });
    expect(followUp.status).not.toBe("denied");
  });
});

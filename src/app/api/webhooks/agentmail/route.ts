import { createHash } from "node:crypto";
import { query } from "@/server/db/client";
import { recordEvidence } from "@/server/db/evidence";
import { trace } from "@/server/db/traces";
import { kickResponsibility } from "@/server/orchestration/wakes";
import { normalizeAgentMailEvent, verifyAgentMailWebhook } from "@/server/providers/agentmail";

/**
 * AgentMail inbound webhook (spec 21, 41.4): verify -> dedupe by event id ->
 * persist a safe provider event -> map thread to responsibility -> wake.
 * Returns 200 promptly; the Worker resumes in the background.
 */
export async function POST(req: Request) {
  const raw = await req.text();
  const secret = process.env.AGENTMAIL_WEBHOOK_SECRET ?? "";
  const v = verifyAgentMailWebhook(raw, Object.fromEntries(req.headers), secret);
  if (!v.ok) return Response.json({ error: v.reason }, { status: 401 });

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return Response.json({ error: "bad_json" }, { status: 400 });
  }
  const ev = normalizeAgentMailEvent(payload, process.env.AGENTMAIL_INBOX_ID);
  const eventId = ev.eventId ?? v.webhookId;
  const digest = createHash("sha256").update(raw).digest("hex");

  // Map thread -> responsibility (only threads August itself started are linked).
  const link = ev.threadId
    ? await query<{ user_id: string; responsibility_id: string }>(
        `select m.user_id, m.responsibility_id from mail_threads m
           join responsibilities r on r.id = m.responsibility_id
          where m.provider_thread_id = $1 and ($2::text is null or m.inbox_id = $2)
          limit 1`,
        [ev.threadId, ev.inboxId],
      )
    : { rows: [] as { user_id: string; responsibility_id: string }[] };
  const owner = link.rows[0] ?? null;

  const inserted = await query<{ id: string }>(
    `insert into provider_events
       (user_id, responsibility_id, provider, external_event_id, event_kind, payload_digest, safe_payload)
     values ($1, $2, 'agentmail', $3, $4, $5, $6)
     on conflict (provider, external_event_id) do nothing
     returning id`,
    [
      owner?.user_id ?? null,
      owner?.responsibility_id ?? null,
      eventId,
      ev.eventType,
      digest,
      JSON.stringify({ threadId: ev.threadId, messageId: ev.messageId, from: ev.from, subject: ev.subject }),
    ],
  );
  // Replay of an already-seen event: acknowledge, never wake twice.
  if (!inserted.rows[0]) return Response.json({ ok: true, duplicate: true });

  // Loop prevention: only genuine inbound mail on a linked thread wakes work.
  if (!ev.isInboundMessage || !owner) return Response.json({ ok: true, ignored: true });

  await recordEvidence({
    userId: owner.user_id,
    responsibilityId: owner.responsibility_id,
    provider: "agentmail",
    sourceRef: ev.messageId,
    safeSummary: `Reply from ${ev.from ?? "unknown"}: "${ev.subject ?? ""}". ${ev.textPreview ?? ""}`.slice(0, 1500),
    payload: { threadId: ev.threadId, messageId: ev.messageId },
  });
  await trace({
    userId: owner.user_id,
    responsibilityId: owner.responsibility_id,
    kind: "provider.event_received",
    detail: { text: "Got a reply", eventId },
  });
  await kickResponsibility({
    userId: owner.user_id,
    responsibilityId: owner.responsibility_id,
    source: "provider_event",
    causeRef: `mail:${ev.threadId}:${eventId}`,
  });
  await query(`update provider_events set consumed_at = now() where id = $1`, [inserted.rows[0].id]);
  return Response.json({ ok: true });
}

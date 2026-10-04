import "server-only";

import { stripHistoryLines } from "@/lib/genui";
import { brainAgent } from "@/server/agent/brain";
import { brainHistory } from "@/server/agent/history";
import { gatewayProviderOptions, modelConfigured } from "@/server/agent/model";
import { runInBackground } from "@/server/background";
import { pendingApprovals } from "@/server/db/effects";
import { ensurePrimaryThread, insertMessage, type MessageRow } from "@/server/db/messages";
import { trace } from "@/server/db/traces";
import { captureMemories } from "@/server/memory/memories";
import { updateThreadSummary, VERBATIM_TAIL } from "@/server/memory/summary";
import { agentMailInboxId, mailSendToUser } from "@/server/providers/agentmail";
import type { EmailChannelRef } from "./capabilities";
import type { InboundEmail } from "./emailInbound";
import { renderEmailBody, responsibilityLink } from "./render";

const NO_MODEL_REPLY =
  "I can't think right now: my model access isn't switched on yet. Your message is saved, and I'll pick it up once it is.";

/**
 * The user wrote to August by email. Persist it as a user message on the
 * email channel (before any model work), then answer in the background with
 * a Brain turn and an email reply in the same thread.
 */
export async function receiveEmailMessage(input: {
  userId: string;
  replyTo: string;
  mail: InboundEmail;
  authority: "user_instruction" | "unverified_channel";
}): Promise<MessageRow> {
  const { userId, mail, authority } = input;
  const threadId = await ensurePrimaryThread(userId);
  const ref: EmailChannelRef = { inboxId: mail.inboxId ?? agentMailInboxId(), threadId: mail.threadId, messageId: mail.messageId };
  const msg = await insertMessage({
    threadId,
    userId,
    role: "user",
    content: mail.text,
    channel: "email",
    channelRef: { ...ref, subject: mail.subject },
    authorityKind: authority,
  });
  await trace({ userId, kind: "provider.event_received", detail: { channel: "email", messageId: msg.id, authority } });
  runInBackground("email-turn", () =>
    answerEmail({ userId, threadId, source: msg, replyTo: input.replyTo, subject: mail.subject }),
  );
  return msg;
}

async function answerEmail(input: {
  userId: string;
  threadId: string;
  source: MessageRow;
  replyTo: string;
  subject: string | null;
}): Promise<void> {
  const { userId, threadId, source } = input;
  let text = NO_MODEL_REPLY;
  if (modelConfigured()) {
    const agent = await brainAgent({ userId, threadId, sourceMessageId: source.id }, source.content, "email");
    const history = await brainHistory(userId, threadId, VERBATIM_TAIL);
    const out = await agent.generate(history, {
      maxSteps: 6,
      providerOptions: gatewayProviderOptions,
      abortSignal: AbortSignal.timeout(3 * 60_000),
    });
    text = stripHistoryLines(out.text ?? "").trim();
  }
  if (!text) return;

  // Approvals never happen by email: point at the card in the app instead.
  const approvals = await pendingApprovals(userId);
  const links = approvals.map((a) => `${a.responsibility_title}: ${responsibilityLink(a.responsibility_id)}`);
  const body = [renderEmailBody({ text }), ...(links.length ? [`Waiting for your OK in the app:\n${links.join("\n")}`] : [])].join(
    "\n\n",
  );

  const sourceRef = source.channel_ref as (EmailChannelRef & { subject?: string | null }) | null;
  // A conversational reply to the user's own verified address, like a chat
  // message: not an external effect, so it does not go through the effect rail.
  let sent: { messageId: string; threadId: string } | null = null;
  try {
    sent = await mailSendToUser({
      to: input.replyTo,
      subject: input.subject ? `Re: ${input.subject.replace(/^re:\s*/i, "")}` : "From August",
      text: body,
      replyToMessageId: sourceRef?.messageId ?? null,
      idempotencyKey: `email-reply-${source.id}`,
    });
  } catch (e) {
    console.error("email reply send failed:", (e as Error).message);
  }

  await insertMessage({
    threadId,
    userId,
    role: "assistant",
    content: text,
    channel: "email",
    channelRef: {
      inboxId: sourceRef?.inboxId ?? agentMailInboxId(),
      threadId: sent?.threadId ?? sourceRef?.threadId ?? null,
      messageId: sent?.messageId ?? null,
      sent: Boolean(sent),
    },
  });
  await trace({ userId, kind: "brain.delivered", detail: { deliveryKind: "turn", channel: "email", sent: Boolean(sent) } });

  // Unverified mail is answered but never becomes remembered fact.
  if (source.authority_kind === "user_instruction") {
    await captureMemories({ userId, sourceMessageId: source.id, userText: source.content, assistantText: text });
  }
  await updateThreadSummary(userId, threadId);
}

import "server-only";

import { query } from "@/server/db/client";
import { messageChannel } from "@/server/db/messages";
import { agentMailInboxId, mailSendToUser } from "@/server/providers/agentmail";
import type { ChannelId, EmailChannelRef } from "./capabilities";
import { verifiedAddressFor } from "./identities";
import { renderEmailBody } from "./render";

export type DeliveryTarget =
  | { channel: "web" }
  | { channel: "email"; to: string; replyToMessageId: string | null; inboxId: string | null; threadId: string | null };

/**
 * Where an async update about a responsibility goes: the channel its request
 * came in on. Email needs a verified address; without one it falls back to web.
 */
export async function deliveryTarget(userId: string, sourceMessageId: string | null): Promise<DeliveryTarget> {
  const source = sourceMessageId ? await messageChannel(userId, sourceMessageId) : null;
  const channel: ChannelId = source?.channel ?? "web";
  if (channel !== "email") return { channel: "web" };
  const to = await verifiedAddressFor(userId, "email");
  if (!to) return { channel: "web" };
  const ref = (source?.channel_ref ?? {}) as Partial<EmailChannelRef>;
  return {
    channel: "email",
    to,
    replyToMessageId: ref.messageId ?? null,
    inboxId: ref.inboxId ?? null,
    threadId: ref.threadId ?? null,
  };
}

/**
 * Send a persisted delivery message out on its email target (in the original
 * thread when there is one), with components as text and approvals as a link
 * to the app. Like the conversational reply, this goes only to the user's own
 * verified address, so it is not an external effect and skips the effect rail.
 * Best-effort: the message is already in the conversation of record.
 */
export async function sendDeliveryEmail(input: {
  userId: string;
  target: Extract<DeliveryTarget, { channel: "email" }>;
  messageId: string;
  title: string;
  text: string;
  ui: { kind: string; data: unknown } | null;
  approvalResponsibilityId: string | null;
}): Promise<void> {
  const { target } = input;
  const body = renderEmailBody({ text: input.text, ui: input.ui, approvalResponsibilityId: input.approvalResponsibilityId });
  try {
    const sent = await mailSendToUser({
      to: target.to,
      subject: `August: ${input.title}`,
      text: body,
      replyToMessageId: target.replyToMessageId,
      idempotencyKey: `delivery-${input.messageId}`,
    });
    const ref: EmailChannelRef & { sent: boolean } = {
      inboxId: target.inboxId ?? agentMailInboxId(),
      threadId: sent.threadId,
      messageId: sent.messageId,
      sent: true,
    };
    await query(`update messages set channel_ref = $3 where user_id = $1 and id = $2`, [
      input.userId,
      input.messageId,
      JSON.stringify(ref),
    ]);
  } catch (e) {
    console.error("delivery email failed:", (e as Error).message);
  }
}

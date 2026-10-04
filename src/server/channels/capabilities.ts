/**
 * Channels August talks on. Web chat is the rich one (generative UI, forms,
 * approval cards, reactions); other channels get the same Brain with their
 * capabilities spelled out, and components downgraded to text.
 */

export const CHANNELS = ["web", "email", "imessage"] as const;
export type ChannelId = (typeof CHANNELS)[number];

export type ChannelCapabilities = {
  /** Generative UI components (cards, charts, mini apps) render natively. */
  richUi: boolean;
  /** How questions for the user are asked. */
  forms: "native" | "numbered_text";
  /** How an action awaiting approval is presented. */
  approvals: "inline_card" | "link";
  /** Tapback reactions are available. */
  reactions: boolean;
  /** Soft cap on one outgoing message, in characters. */
  maxLength?: number;
  formatting: "markdown" | "plain" | "light_markdown";
};

export const CHANNEL_CAPABILITIES: Record<ChannelId, ChannelCapabilities> = {
  web: { richUi: true, forms: "native", approvals: "inline_card", reactions: true, formatting: "markdown" },
  email: { richUi: false, forms: "numbered_text", approvals: "link", reactions: false, maxLength: 4000, formatting: "plain" },
  imessage: {
    richUi: false,
    forms: "numbered_text",
    approvals: "link",
    reactions: true,
    maxLength: 1200,
    formatting: "plain",
  },
};

export function isChannelId(v: unknown): v is ChannelId {
  return typeof v === "string" && (CHANNELS as readonly string[]).includes(v);
}

export function capabilitiesOf(channel: ChannelId): ChannelCapabilities {
  return CHANNEL_CAPABILITIES[channel];
}

/** Email channel reference stored on messages.channel_ref. */
export type EmailChannelRef = { inboxId: string; threadId: string | null; messageId: string | null };

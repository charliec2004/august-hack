/**
 * Tapback reactions: a lightweight message type the user can put on any
 * message. Shared by the API, the timeline, the Brain history, and the UI.
 */

export const TAPBACKS = ["❤️", "👍", "👎", "😂", "‼️", "❓"] as const;
export type Tapback = (typeof TAPBACKS)[number];

export const TAPBACK_LABELS: Record<Tapback, string> = {
  "❤️": "Love",
  "👍": "Like",
  "👎": "Dislike",
  "😂": "Laugh",
  "‼️": "Emphasize",
  "❓": "Question",
};

export function isTapback(v: unknown): v is Tapback {
  return typeof v === "string" && (TAPBACKS as readonly string[]).includes(v);
}

const QUOTE_CHARS = 60;

/** The compact line the model sees after a reacted message. */
export function reactionHistoryLine(who: string, emoji: Tapback, reactedText: string): string {
  const flat = reactedText.replace(/\s+/g, " ").trim();
  const quote = flat.length > QUOTE_CHARS ? `${flat.slice(0, QUOTE_CHARS - 1)}…` : flat;
  return `[${who} reacted ${emoji} to: "${quote}"]`;
}

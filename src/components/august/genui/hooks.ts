"use client";

import { useCallback, useMemo } from "react";
import { useAui, useAuiState } from "@assistant-ui/react";
import { ANSWER_PART, readAnswer, type CardAnswer } from "@/lib/genui";

/**
 * Send a reply as the user, through the same runtime as the composer. A card
 * submission also carries a `data-answer` part naming the card, so the card
 * (and only that card) resolves from it; the text part is what the model reads.
 */
export function useSendReply() {
  const aui = useAui();
  const running = useAuiState((s) => s.thread.isRunning);
  const send = useCallback(
    (text: string, answer?: CardAnswer) => {
      const t = text.trim();
      if (!t) return;
      if (!answer) return aui.thread().append(t);
      aui.thread().append({
        role: "user",
        content: [
          { type: "text", text: t },
          { type: "data", name: ANSWER_PART, data: answer },
        ],
      });
    },
    [aui],
  );
  return { send, disabled: running };
}

/** The submission of the card with this id, from any user message in the thread. */
export function useCardAnswer(cardId: string | null): CardAnswer | null {
  // Select the stored part data itself (a stable reference); parse outside the selector.
  const raw = useAuiState((s) => {
    if (!cardId) return null;
    for (const m of s.thread.messages) {
      if (m.role !== "user") continue;
      for (const p of m.content) {
        if (p.type !== "data" || p.name !== ANSWER_PART) continue;
        if ((p.data as { cardId?: unknown } | null)?.cardId === cardId) return p.data;
      }
    }
    return null;
  });
  return useMemo(() => readAnswer(raw), [raw]);
}

/**
 * A stable id for the card rendering here: the tool call id for Brain tool
 * cards; for delivery data parts, the id stored in the part (older parts fall
 * back to their message id).
 */
export function useDataCardId(id: string | null | undefined): string {
  const messageId = useAuiState((s) => s.message.id);
  return id || `msg:${messageId}`;
}

export const CHOOSE_PREFIX = "I choose: ";

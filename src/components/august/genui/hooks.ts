"use client";

import { useCallback } from "react";
import { useAui, useAuiState } from "@assistant-ui/react";

/** Send a reply as the user, through the same runtime as the composer. */
export function useSendReply() {
  const aui = useAui();
  const running = useAuiState((s) => s.thread.isRunning);
  const send = useCallback(
    (text: string) => {
      if (!text.trim()) return;
      aui.thread().append(text.trim());
    },
    [aui],
  );
  return { send, disabled: running };
}

/** Text of the first user message after the one rendering this part, if any. */
export function useLaterUserReply(): string | null {
  return useAuiState((s) => {
    const messages = s.thread.messages;
    for (let i = s.message.index + 1; i < messages.length; i++) {
      const m = messages[i];
      if (m.role !== "user") continue;
      return m.content
        .map((p) => (p.type === "text" ? p.text : ""))
        .join("")
        .trim();
    }
    return null;
  });
}

export const CHOOSE_PREFIX = "I choose: ";

/** "I choose: Zuni Café" -> "Zuni Café"; other replies unchanged. */
export function stripChoice(reply: string): string {
  return reply.startsWith(CHOOSE_PREFIX) ? reply.slice(CHOOSE_PREFIX.length).trim() : reply;
}

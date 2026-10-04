"use client";

import { useEffect, useRef } from "react";
import { AssistantRuntimeProvider } from "@assistant-ui/react";
import {
  useAISDKChat,
  useChatRuntime,
  AssistantChatTransport,
} from "@assistant-ui/ai-sdk";
import type { UIMessage } from "ai";
import { AugustShell } from "@/components/august/AugustShell";
import { useHistory } from "@/components/august/history";
import { isGenUiTool } from "@/lib/genui";
import { AugustProvider, useAugust } from "@/components/august/useAugustState";

export const Assistant = () => {
  // All of August's tools run server-side, so the client never auto-resends.
  const runtime = useChatRuntime({
    transport: new AssistantChatTransport({
      api: "/api/chat",
    }),
  });

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <AugustProvider>
        <ConversationSync />
        <AugustShell />
      </AugustProvider>
    </AssistantRuntimeProvider>
  );
};

/**
 * Keeps the thread in step with the timeline of record. Loads history on first
 * state, and reloads whenever the server's timelineVersion changes (a message,
 * an activity line, or an approval's state) while nothing is streaming.
 * GET /api/messages returns AI SDK UIMessages, so they go straight to the chat.
 */
function ConversationSync() {
  const { state, mock } = useAugust();
  const chat = useAISDKChat();
  const { limit, nonce, setHasEarlier } = useHistory();
  // Re-sync on new timeline data, and when the user asks for earlier history.
  const version = state ? `${state.timelineVersion}:${nonce}` : null;
  const synced = useRef<string | null | undefined>(undefined);
  const busy = useRef(false);
  const streaming = chat?.status === "submitted" || chat?.status === "streaming";

  useEffect(() => {
    if (!chat || mock || state === null || busy.current || streaming) return;
    if (synced.current === version) return;
    busy.current = true;
    void (async () => {
      try {
        const res = await fetch(`/api/messages?limit=${limit}`, { cache: "no-store" });
        setHasEarlier(res.headers.get("x-has-earlier") === "1");
        if (!res.ok) {
          synced.current = version; // no history available; don't hammer it
          return;
        }
        const rows = (await res.json()) as UIMessage[];
        // Empty history, or the streamed reply isn't persisted yet: keep what's shown.
        const behind =
          repliedAfterLastUser(chat.messages) && !repliedAfterLastUser(rows);
        if ((rows.length === 0 && chat.messages.length > 0) || behind) {
          synced.current = version;
          return;
        }
        chat.setMessages(rows);
        chat.clearError();
        synced.current = version;
      } catch {
        // Network hiccup: try again on the next poll.
      } finally {
        busy.current = false;
      }
    })();
  }, [chat, mock, state, version, streaming, limit, setHasEarlier]);

  return null;
}

/** True when an assistant reply (text or a component) follows the last user message. */
function repliedAfterLastUser(messages: UIMessage[]): boolean {
  const lastUser = messages.findLastIndex((m) => m.role === "user");
  if (lastUser < 0) return false;
  return messages
    .slice(lastUser + 1)
    .some(
      (m) =>
        m.role === "assistant" &&
        m.parts.some(
          (p) =>
            (p.type === "text" && p.text.trim() !== "") ||
            (p.type.startsWith("tool-") && isGenUiTool(p.type.slice(5))),
        ),
    );
}

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
 * Keeps the thread in step with the conversation of record. Loads history on
 * first state, and reloads whenever the server reports a newer message (August
 * writing back after a scheduled check or a reply) while nothing is streaming.
 * GET /api/messages returns AI SDK UIMessages, so they go straight to the chat.
 */
function ConversationSync() {
  const { state, mock } = useAugust();
  const chat = useAISDKChat();
  const latest = state?.latestMessageId ?? null;
  const synced = useRef<string | null | undefined>(undefined);
  const busy = useRef(false);
  const streaming = chat?.status === "submitted" || chat?.status === "streaming";

  useEffect(() => {
    if (!chat || mock || state === null || busy.current || streaming) return;
    if (synced.current === latest) return;
    if (latest && chat.messages.some((m) => m.id === latest)) {
      synced.current = latest;
      return;
    }
    busy.current = true;
    void (async () => {
      try {
        const res = await fetch("/api/messages", { cache: "no-store" });
        if (!res.ok) {
          synced.current = latest; // no history available; don't hammer it
          return;
        }
        const rows = (await res.json()) as UIMessage[];
        if (rows.length === 0 && chat.messages.length > 0) {
          synced.current = latest;
          return;
        }
        chat.setMessages(rows);
        chat.clearError();
        synced.current = latest;
      } catch {
        // Network hiccup: try again on the next poll.
      } finally {
        busy.current = false;
      }
    })();
  }, [chat, mock, state, latest, streaming]);

  return null;
}

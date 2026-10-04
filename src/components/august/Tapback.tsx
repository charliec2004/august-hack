"use client";

import { useAuiState } from "@assistant-ui/react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { isTapback, TAPBACK_LABELS, TAPBACKS, type Tapback } from "@/lib/tapbacks";
import { cn } from "@/lib/utils";

type StoredMeta = { messageId: string | null; reaction: Tapback | null; channel: string | null };

/** The stored message behind this bubble (timeline metadata), if it has one. */
function useStoredMeta(): StoredMeta {
  const messageId = useAuiState((s) => {
    const custom = (s.message.metadata as { custom?: { messageId?: unknown } }).custom;
    return typeof custom?.messageId === "string" ? custom.messageId : null;
  });
  const reaction = useAuiState((s) => {
    const custom = (s.message.metadata as { custom?: { reaction?: unknown } }).custom;
    return isTapback(custom?.reaction) ? custom.reaction : null;
  });
  const channel = useAuiState((s) => {
    const custom = (s.message.metadata as { custom?: { channel?: unknown } }).custom;
    return typeof custom?.channel === "string" ? custom.channel : null;
  });
  return { messageId, reaction, channel };
}

const LONG_PRESS_MS = 450;

/**
 * For the message root that hosts a Tapbackable. Message roots use
 * `content-visibility: auto`, whose paint containment would clip the floating
 * bar and the corner badge; lift it while the bar is in use, and make room
 * for a corner badge.
 */
export const TAPBACK_HOST_CLASS =
  "has-[[data-slot=tapback-root]:hover]:[content-visibility:visible] has-[[data-slot=tapback-root]:focus-within]:[content-visibility:visible] has-[[data-slot=tapback-bar][data-open]]:[content-visibility:visible] has-[[data-slot=tapback-badge][data-corner]]:pt-3";

/**
 * iMessage-style tapbacks on a message: a small floating bar of six reactions
 * on hover (desktop) or long-press (touch), and the chosen one as a badge on
 * the message's corner. One reaction per message; picking the current one
 * removes it. Reacting never sends a message.
 */
export function Tapbackable({ align, children }: { align: "start" | "end"; children: ReactNode }) {
  const { messageId, reaction: stored } = useStoredMeta();
  // Optimistic choice, valid only while the server value it was made against is current.
  const [pending, setPending] = useState<{ value: Tapback | null; base: Tapback | null } | null>(null);
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const press = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reaction = pending && pending.base === stored ? pending.value : stored;

  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [open]);

  if (!messageId) return <>{children}</>;

  const choose = async (emoji: Tapback) => {
    const next = emoji === reaction ? null : emoji;
    setPending({ value: next, base: stored });
    setOpen(false);
    try {
      const res = await fetch(`/api/messages/${messageId}/reaction`, {
        method: next ? "POST" : "DELETE",
        headers: { "content-type": "application/json" },
        body: next ? JSON.stringify({ emoji: next }) : undefined,
      });
      if (!res.ok) throw new Error(String(res.status));
    } catch {
      setPending(null);
    }
  };

  const cancelPress = () => {
    if (press.current) clearTimeout(press.current);
    press.current = null;
  };

  return (
    <div
      ref={root}
      data-slot="tapback-root"
      className="group/tapback relative"
      onPointerDown={(e) => {
        if (e.pointerType !== "touch") return;
        cancelPress();
        press.current = setTimeout(() => setOpen(true), LONG_PRESS_MS);
      }}
      onPointerUp={cancelPress}
      onPointerCancel={cancelPress}
      onPointerMove={(e) => {
        if (e.pointerType === "touch" && (Math.abs(e.movementX) > 4 || Math.abs(e.movementY) > 4)) cancelPress();
      }}
      onContextMenu={(e) => {
        // Long-press on touch opens the bar instead of the system menu.
        if (open) e.preventDefault();
      }}
    >
      {children}
      <div
        role="toolbar"
        data-slot="tapback-bar"
        aria-label="React to this message"
        data-open={open || undefined}
        className={cn(
          "bg-background absolute -top-10 z-20 flex items-center gap-0.5 rounded-full border p-1 shadow-sm transition-opacity duration-150",
          "pointer-events-none opacity-0 group-focus-within/tapback:pointer-events-auto group-focus-within/tapback:opacity-100",
          "data-open:pointer-events-auto data-open:opacity-100",
          "group-hover/tapback:pointer-events-auto group-hover/tapback:opacity-100",
          align === "end" ? "end-0" : "start-0",
        )}
      >
        {TAPBACKS.map((emoji) => (
          <button
            key={emoji}
            type="button"
            aria-label={TAPBACK_LABELS[emoji]}
            aria-pressed={reaction === emoji}
            onClick={() => void choose(emoji)}
            className={cn(
              "flex size-7 items-center justify-center rounded-full text-[15px] leading-none transition-transform outline-none hover:scale-110 focus-visible:ring-1 focus-visible:ring-ring motion-reduce:transition-none",
              reaction === emoji && "bg-muted",
            )}
          >
            {emoji}
          </button>
        ))}
      </div>
      {reaction ? (
        <button
          type="button"
          data-slot="tapback-badge"
          data-corner={align === "end" || undefined}
          aria-label={`${TAPBACK_LABELS[reaction]} reaction. Change`}
          onClick={() => setOpen((o) => !o)}
          className={cn(
            "bg-muted z-10 flex size-6 items-center justify-center rounded-full border-2 border-[var(--background)] text-[12px] leading-none",
            // A bubble wears it on its corner; full-width assistant text gets it just below, at the start.
            align === "end" ? "absolute -start-3 -top-3" : "ms-1.5 mt-1",
          )}
        >
          {reaction}
        </button>
      ) : null}
    </div>
  );
}

/** A quiet "via email" note under a message that arrived on, or went out by, another channel. */
export function ChannelMarker({ align }: { align: "start" | "end" }) {
  const { channel } = useStoredMeta();
  if (!channel || channel === "web") return null;
  const label = channel === "imessage" ? "iMessage" : channel;
  return (
    <span
      data-slot="channel-marker"
      className={cn("text-muted-foreground/80 block text-[11px] leading-4", align === "end" ? "text-end" : "text-start")}
    >
      via {label}
    </span>
  );
}

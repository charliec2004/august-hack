"use client";

import { useAuiState } from "@assistant-ui/react";
import { isGenUiTool } from "@/lib/genui";

/**
 * Three quiet dots at the end of an assistant message while its run is still
 * going but nothing is visibly streaming (text finished, a tool is about to be
 * called or is executing), so the thread never looks finished too early.
 * Components have their own skeletons, so they don't get dots.
 */
export function WorkingIndicator() {
  const show = useAuiState((s) => {
    if (s.message.role !== "assistant" || s.message.status?.type !== "running") return false;
    const last = s.message.parts[s.message.parts.length - 1];
    if (!last) return false; // the runtime's own empty-message indicator covers this
    if (last.type === "text") return last.status.type !== "running";
    if (last.type === "tool-call") return !isGenUiTool(last.toolName);
    return false;
  });
  if (!show) return null;
  return (
    <span role="status" aria-label="Still working" data-slot="genui-working" className="inline-flex gap-1 px-0.5 py-2">
      {[0, 150, 300].map((delay) => (
        <span
          key={delay}
          aria-hidden
          className="bg-muted-foreground/60 size-1.5 animate-pulse rounded-full motion-reduce:animate-none"
          style={{ animationDelay: `${delay}ms` }}
        />
      ))}
    </span>
  );
}

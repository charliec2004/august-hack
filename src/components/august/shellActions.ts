"use client";

import { createContext, useContext } from "react";
import type { AugustState, LiveBrowser } from "@/server/types/api";

/** Shell-level actions reachable from inside thread parts. */
export type ShellActions = {
  /** Open the live view for a session that is live now (no-op otherwise). */
  watch: (browser: LiveBrowser) => void;
  openResponsibility: (id: string) => void;
};

export const ShellActionsContext = createContext<ShellActions>({
  watch: () => {},
  openResponsibility: () => {},
});

export const useShellActions = () => useContext(ShellActionsContext);

/**
 * The live browser an activity line may offer to watch: its own session if
 * that is live, or, for lines without a session id, the responsibility's live
 * browser on its newest line only. Never a frozen URL from the trace.
 */
export function liveBrowserForLine(
  state: AugustState | null,
  line: { id: string; responsibilityId: string | null; browserSessionId: string | null },
): LiveBrowser | null {
  if (!state) return null;
  if (line.browserSessionId) {
    return state.liveBrowsers.find((b) => b.sessionId === line.browserSessionId) ?? null;
  }
  if (!line.responsibilityId) return null;
  const browser = state.liveBrowsers.find((b) => b.responsibilityId === line.responsibilityId);
  if (!browser) return null;
  const newest = state.activity.findLast((a) => a.responsibilityId === line.responsibilityId);
  return newest?.id === line.id ? browser : null;
}

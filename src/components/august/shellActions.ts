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
 * The live browser an activity line may offer to watch: only the line's own
 * browser session, and only while it is live. Never a frozen URL from a trace.
 */
export function liveBrowserForLine(
  state: AugustState | null,
  line: { browserSessionId: string | null },
): LiveBrowser | null {
  if (!state || !line.browserSessionId) return null;
  return state.liveBrowsers.find((b) => b.sessionId === line.browserSessionId) ?? null;
}

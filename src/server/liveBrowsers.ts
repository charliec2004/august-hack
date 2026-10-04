import "server-only";

import { liveBrowserSessions } from "@/server/browser/sessions";
import type { LiveBrowser } from "@/server/types/api";

/**
 * Browser sessions that are live right now (browser_sessions.status = 'live'):
 * the only source of live-view links the UI may show. A trace row's frozen
 * `liveViewUrl` is never used.
 */
export async function liveBrowsersFor(userId: string): Promise<LiveBrowser[]> {
  const sessions = await liveBrowserSessions(userId);
  return sessions.map((s) => ({
    sessionId: s.sessionId,
    responsibilityId: s.responsibilityId,
    liveViewUrl: s.liveViewUrl,
  }));
}

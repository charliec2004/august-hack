import "server-only";

import { activeRunsFor } from "@/server/db/workers";
import type { LiveBrowser } from "@/server/types/api";

/**
 * Browser sessions that are live right now: the only source of live-view links
 * the UI may show. Trace rows' frozen `liveViewUrl` is never used.
 *
 * Derived from running worker runs with an unexpired lease (live_view_url is
 * cleared when a run finishes). When `browser_sessions` lands, swap this for
 * `liveBrowserSessions(userId)` (status = 'live').
 */
export async function liveBrowsersFor(userId: string): Promise<LiveBrowser[]> {
  const runs = await activeRunsFor(userId);
  return runs
    .filter((r) => r.live_view_url)
    .map((r) => ({ sessionId: r.id, responsibilityId: r.responsibility_id, liveViewUrl: r.live_view_url! }));
}

import "server-only";

import { query } from "@/server/db/client";
import type { ComputerBrowser } from "@/server/types/computer";
import { closeBrowserSession, openBrowserSession } from "./sessions";

/**
 * The browser the user drives themselves from the Computer panel: the user's
 * persistent profile (writer lease when free, so manual sign-ins persist for
 * August), stealth, the saved-logins vault linked. One per user. Kernel's idle
 * timeout ends it; reconcileBrowserSessions closes the row once Kernel reports
 * it gone.
 */

const USER_BROWSER_IDLE_TIMEOUT_S = 15 * 60;

/** Live browsers the user can watch, with the task each belongs to. */
export async function computerBrowsers(userId: string): Promise<ComputerBrowser[]> {
  const { rows } = await query<{
    id: string;
    kind: string;
    title: string | null;
    live_view_url: string;
    saves: boolean;
    opened_at: Date;
  }>(
    `select s.id, s.kind, r.title, s.live_view_url,
            (s.browser_profile_id is null or s.profile_lease_id is not null) as saves, s.opened_at
       from browser_sessions s left join responsibilities r on r.id = s.responsibility_id
      where s.user_id = $1 and s.status = 'live' and s.live_view_url is not null
      order by (s.kind = 'user') desc, s.opened_at desc limit 10`,
    [userId],
  );
  return rows.map((r) => ({
    sessionId: r.id,
    owner: r.kind === "user" ? "user" : "august",
    taskTitle: r.title,
    liveViewUrl: r.live_view_url,
    savesSignIns: r.saves,
    openedAt: r.opened_at.toISOString(),
  }));
}

async function openUserRow(userId: string): Promise<string | null> {
  const { rows } = await query<{ id: string }>(
    `select id from browser_sessions where user_id = $1 and kind = 'user' and status <> 'closed' limit 1`,
    [userId],
  );
  return rows[0]?.id ?? null;
}

/** Opens (or returns) the user's own browser session. */
export async function openUserBrowser(userId: string): Promise<{ sessionId: string }> {
  const existing = await openUserRow(userId);
  if (existing) return { sessionId: existing };
  try {
    const opened = await openBrowserSession({
      userId,
      responsibilityId: null,
      workerRunId: null,
      kind: "user",
      timeoutSeconds: USER_BROWSER_IDLE_TIMEOUT_S,
      withProfile: true,
      withVault: true,
      stealth: true,
    });
    return { sessionId: opened.id };
  } catch (err) {
    // A concurrent open won the one-per-user index.
    if ((err as { code?: string }).code === "23505") {
      const winner = await openUserRow(userId);
      if (winner) return { sessionId: winner };
    }
    throw err;
  }
}

/** Closes the user's own browser session. False when it isn't theirs. */
export async function closeUserBrowser(userId: string, sessionId: string): Promise<boolean> {
  if (!/^[0-9a-f-]{36}$/i.test(sessionId)) return false;
  const { rows } = await query<{ id: string }>(
    `select id from browser_sessions where id = $1 and user_id = $2 and kind = 'user'`,
    [sessionId, userId],
  );
  if (!rows[0]) return false;
  await closeBrowserSession(sessionId, "user_closed");
  return true;
}

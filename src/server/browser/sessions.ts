import "server-only";

import { query } from "@/server/db/client";
import { isKernelNotFound, kernel, kernelVaultName } from "@/server/providers/kernelClient";
import { attachLeaseSession, openProfile, releaseProfileLease } from "./profiles";

/**
 * Lifecycle owner for every Kernel browser session August creates.
 *
 * A row is inserted before the Kernel session exists ('opening'), becomes
 * 'live' once Kernel returns the session and its interactive live view URL, and
 * is 'closed' by exactly one of: the adapter's `finally` ('released'), the end
 * of the worker run ('released'), or reconcileBrowserSessions ('expired' when
 * the owning run's lease is gone, 'gone' when Kernel no longer has it).
 *
 * The UI offers "Watch browser" only for rows returned by liveBrowserSessions;
 * activity lines carry our row id (browserSessionId), never the raw URL.
 */

/** task: one tool call; run: a worker run's browser; user: opened by the user from the Computer panel. */
export type BrowserSessionKind = "task" | "run" | "user";

export type OpenedBrowser = {
  /** Our browser_sessions row id (safe to put in trace detail). */
  id: string;
  kernelSessionId: string;
  /** Interactive live view: the user can watch and take control. */
  liveViewUrl: string | null;
  profileName: string | null;
  /** True when this session holds the profile's writer lease (saves sign-ins). */
  savesProfile: boolean;
  vaultLinked: boolean;
};

export type LiveBrowser = {
  sessionId: string;
  responsibilityId: string | null;
  workerRunId: string | null;
  liveViewUrl: string;
  openedAt: string;
};

type Row = {
  id: string;
  user_id: string;
  worker_run_id: string | null;
  kind: BrowserSessionKind;
  kernel_session_id: string | null;
  live_view_url: string | null;
  profile_lease_id: string | null;
  status: "opening" | "live" | "closed";
  opened_at: Date;
};

export async function openBrowserSession(args: {
  userId: string;
  responsibilityId: string | null;
  workerRunId: string | null;
  kind: BrowserSessionKind;
  timeoutSeconds: number;
  /** Load the user's persistent profile (saved sign-ins). */
  withProfile?: boolean;
  /** Link the saved-logins vault so vault fill can target this browser. */
  withVault?: boolean;
  /** Kernel stealth mode + CAPTCHA solver. */
  stealth?: boolean;
}): Promise<OpenedBrowser> {
  const profile = args.withProfile
    ? await openProfile({ userId: args.userId, workerRunId: args.workerRunId, owner: `browser:${args.workerRunId ?? args.kind}` })
    : null;

  let id: string;
  try {
    const ins = await query<{ id: string }>(
      `insert into browser_sessions (user_id, responsibility_id, worker_run_id, kind, browser_profile_id, profile_lease_id, status)
       values ($1, $2, $3, $4, $5, $6, 'opening') returning id`,
      [args.userId, args.responsibilityId, args.workerRunId, args.kind, profile?.profileId ?? null, profile?.leaseId ?? null],
    );
    id = ins.rows[0].id;
  } catch (err) {
    if (profile?.leaseId) await releaseProfileLease(profile.leaseId);
    throw err;
  }

  try {
    const created = await kernel().browsers.create({
      headless: false,
      timeout_seconds: args.timeoutSeconds,
      ...(args.stealth ? { stealth: true } : {}),
      ...(profile ? { profile: { name: profile.kernelProfileName, save_changes: profile.leaseId !== null } } : {}),
      ...(args.withVault ? { vaults: [{ name: kernelVaultName() }] } : {}),
    });
    const liveViewUrl = created.browser_live_view_url ?? null;
    await query(
      `update browser_sessions set kernel_session_id = $2, live_view_url = $3, status = 'live' where id = $1`,
      [id, created.session_id, liveViewUrl],
    );
    if (profile?.leaseId) await attachLeaseSession(profile.leaseId, created.session_id);
    if (args.workerRunId && liveViewUrl) {
      await query(`update worker_runs set live_view_url = $2 where id = $1`, [args.workerRunId, liveViewUrl]);
    }
    return {
      id,
      kernelSessionId: created.session_id,
      liveViewUrl,
      profileName: profile?.kernelProfileName ?? null,
      savesProfile: profile?.leaseId != null,
      vaultLinked: !!args.withVault,
    };
  } catch (err) {
    await markClosed(id, "create_failed");
    if (profile?.leaseId) await releaseProfileLease(profile.leaseId);
    throw err;
  }
}

async function markClosed(id: string, reason: string): Promise<Row | null> {
  const { rows } = await query<Row>(
    `update browser_sessions set status = 'closed', closed_at = now(), close_reason = $2
      where id = $1 and status <> 'closed'
      returning id, user_id, worker_run_id, kind, kernel_session_id, live_view_url, profile_lease_id, status, opened_at`,
    [id, reason],
  );
  const row = rows[0] ?? null;
  if (!row) return null;
  if (row.profile_lease_id) await releaseProfileLease(row.profile_lease_id);
  if (row.worker_run_id && row.live_view_url) {
    await query(`update worker_runs set live_view_url = null where id = $1 and live_view_url = $2`, [
      row.worker_run_id,
      row.live_view_url,
    ]);
  }
  return row;
}

/**
 * Deletes the Kernel session (which also persists profile changes when this
 * session holds the writer lease) and closes the row. Idempotent.
 */
export async function closeBrowserSession(id: string, reason = "released"): Promise<void> {
  const { rows } = await query<{ kernel_session_id: string | null; status: string }>(
    `select kernel_session_id, status from browser_sessions where id = $1`,
    [id],
  );
  const row = rows[0];
  if (!row || row.status === "closed") return;
  if (row.kernel_session_id) {
    await kernel()
      .browsers.deleteByID(row.kernel_session_id)
      .catch(() => {
        // Kernel also enforces timeout_seconds; reconcile picks up stragglers.
      });
  }
  await markClosed(id, reason);
}

/** The run's live browser row, if any. */
export async function runBrowserFor(workerRunId: string): Promise<(OpenedBrowser & { userId: string }) | null> {
  const { rows } = await query<
    Row & { profile_name: string | null; has_lease: boolean }
  >(
    `select s.id, s.user_id, s.worker_run_id, s.kind, s.kernel_session_id, s.live_view_url, s.profile_lease_id,
            s.status, s.opened_at, p.kernel_profile_ref as profile_name, (s.profile_lease_id is not null) as has_lease
       from browser_sessions s left join browser_profiles p on p.id = s.browser_profile_id
      where s.worker_run_id = $1 and s.kind = 'run' and s.status = 'live'
      limit 1`,
    [workerRunId],
  );
  const r = rows[0];
  if (!r || !r.kernel_session_id) return null;
  return {
    id: r.id,
    userId: r.user_id,
    kernelSessionId: r.kernel_session_id,
    liveViewUrl: r.live_view_url,
    profileName: r.profile_name,
    savesProfile: r.has_lease,
    vaultLinked: true,
  };
}

/** Closes every open session owned by a worker run (called when the run ends). */
export async function closeRunBrowsers(workerRunId: string): Promise<void> {
  const { rows } = await query<{ id: string }>(
    `select id from browser_sessions where worker_run_id = $1 and status <> 'closed'`,
    [workerRunId],
  );
  for (const r of rows) await closeBrowserSession(r.id, "released");
}

/** Sessions the user can watch / take over right now. */
export async function liveBrowserSessions(userId: string): Promise<LiveBrowser[]> {
  const { rows } = await query<{
    id: string;
    responsibility_id: string | null;
    worker_run_id: string | null;
    live_view_url: string;
    opened_at: Date;
  }>(
    `select id, responsibility_id, worker_run_id, live_view_url, opened_at from browser_sessions
      where user_id = $1 and status = 'live' and live_view_url is not null
      order by opened_at desc limit 20`,
    [userId],
  );
  return rows.map((r) => ({
    sessionId: r.id,
    responsibilityId: r.responsibility_id,
    workerRunId: r.worker_run_id,
    liveViewUrl: r.live_view_url,
    openedAt: r.opened_at.toISOString(),
  }));
}

/** One-shot sessions never legitimately outlive a single tool call by this much. */
const TASK_SESSION_MAX_MS = 15 * 60_000;

/**
 * Closes rows whose owner is gone: the worker run is no longer running or its
 * lease expired ('expired'), a one-shot session outlived any tool call
 * ('expired'), or Kernel no longer has the session ('gone'). Cheap: only open
 * rows are inspected. Called from the wake scanner's repair pass.
 */
export async function reconcileBrowserSessions(userId?: string): Promise<number> {
  const { rows } = await query<{
    id: string;
    kind: BrowserSessionKind;
    kernel_session_id: string | null;
    opened_at: Date;
    run_status: string | null;
    run_lease_expires_at: Date | null;
    has_run: boolean;
  }>(
    `select s.id, s.kind, s.kernel_session_id, s.opened_at,
            r.status as run_status, r.lease_expires_at as run_lease_expires_at, (s.worker_run_id is not null) as has_run
       from browser_sessions s left join worker_runs r on r.id = s.worker_run_id
      where s.status <> 'closed' and ($1::uuid is null or s.user_id = $1)
      order by s.opened_at limit 100`,
    [userId ?? null],
  );
  let closed = 0;
  const now = Date.now();
  for (const r of rows) {
    const runOver =
      r.has_run &&
      (r.run_status !== "running" || (r.run_lease_expires_at !== null && r.run_lease_expires_at.getTime() < now));
    const taskStale = r.kind === "task" && now - r.opened_at.getTime() > TASK_SESSION_MAX_MS;
    if (runOver || taskStale) {
      await closeBrowserSession(r.id, "expired");
      closed += 1;
      continue;
    }
    if (!r.kernel_session_id) {
      if (now - r.opened_at.getTime() > 5 * 60_000) {
        await markClosed(r.id, "gone");
        closed += 1;
      }
      continue;
    }
    try {
      await kernel().browsers.retrieve(r.kernel_session_id);
    } catch (err) {
      if (isKernelNotFound(err)) {
        await markClosed(r.id, "gone");
        closed += 1;
      }
      // Other errors: leave it; next scan retries.
    }
  }
  return closed;
}

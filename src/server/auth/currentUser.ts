import "server-only";

import { ensureDemoChannelIdentity } from "@/server/channels/identities";
import { query } from "@/server/db/client";

export type CurrentUser = { id: string; authSubject: string; timezone: string };

/**
 * Server-derived identity (spec 25: never accept userId from the browser).
 * Hackathon P0: a single demo identity (DEMO_USER_SUBJECT). Neon Managed Better
 * Auth is provisioned (neon.ts) and can replace this resolver without touching
 * callers.
 */
export async function currentUser(): Promise<CurrentUser> {
  const subject = process.env.DEMO_USER_SUBJECT || "demo-user";
  const user = await ensureUser(subject);
  await ensureDemoChannelIdentity(user.id);
  return user;
}

export async function ensureUser(subject: string): Promise<CurrentUser> {
  const { rows } = await query<{ id: string; auth_subject: string; timezone: string }>(
    `insert into app_users (auth_subject, timezone)
     values ($1, $2)
     on conflict (auth_subject) do update set timezone = excluded.timezone
     returning id, auth_subject, timezone`,
    [subject, process.env.DEMO_USER_TIMEZONE || "America/Los_Angeles"],
  );
  const r = rows[0];
  return { id: r.id, authSubject: r.auth_subject, timezone: r.timezone };
}

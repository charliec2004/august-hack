import "server-only";

import { tx } from "@/server/db/client";

/**
 * Deterministic demo reset (spec 45): deletes ONLY the demo user's application
 * rows. Never touches provider accounts, keys, the user environment, or other users.
 */
export async function resetDemoUser(authSubject: string) {
  await tx(async (c) => {
    const { rows } = await c.query<{ id: string }>(`select id from app_users where auth_subject = $1`, [authSubject]);
    const uid = rows[0]?.id;
    if (!uid) return;
    const del = (sql: string) => c.query(sql, [uid]);
    await del(`delete from trace_events where user_id = $1`);
    await del(`delete from effect_receipts where user_id = $1`);
    await del(`delete from approvals where user_id = $1`);
    await del(`delete from computer_commands where user_id = $1`);
    await del(`update computers set responsibility_id = null, worker_session_id = null where user_id = $1`);
    await del(`update user_environments set source_effect_id = null where user_id = $1`);
    await del(`delete from effect_proposals where user_id = $1`);
    await del(`delete from mail_threads where user_id = $1`);
    await del(`delete from provider_events where user_id = $1`);
    await del(`delete from evidence_records where user_id = $1`);
    await del(`delete from artifacts where user_id = $1 and responsibility_id is not null`);
    await del(`delete from wakeups where user_id = $1`);
    // Browser session history and leases go; the saved profile and vault logins stay.
    await del(`delete from browser_sessions where user_id = $1`);
    await del(
      `delete from browser_profile_leases where browser_profile_id in (select id from browser_profiles where user_id = $1)`,
    );
    await del(`delete from worker_runs where user_id = $1`);
    await del(`delete from worker_sessions where user_id = $1`);
    await del(`delete from responsibility_events where user_id = $1`);
    await del(`update messages set responsibility_id = null where user_id = $1`);
    await del(`delete from responsibilities where user_id = $1`);
    await del(`delete from messages where user_id = $1`);
    await del(`delete from threads where user_id = $1`);
  });
}

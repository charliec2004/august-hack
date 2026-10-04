import "server-only";

import { query } from "@/server/db/client";
import type { ChannelId } from "./capabilities";

export type ChannelIdentity = {
  user_id: string;
  channel: ChannelId;
  address: string;
  verified_at: Date | null;
};

export function normalizeChannelAddress(address: string): string {
  return address.trim().toLowerCase();
}

const ensured = new Set<string>();

/**
 * Hackathon P0: the demo user's email (DEMO_USER_EMAIL) is a verified email
 * identity. Idempotent; called from currentUser so it exists before any mail.
 */
export async function ensureDemoChannelIdentity(userId: string): Promise<void> {
  const email = process.env.DEMO_USER_EMAIL;
  if (!email || ensured.has(userId)) return;
  await query(
    `insert into channel_identities (user_id, channel, address, verified_at)
     values ($1, 'email', $2, now())
     on conflict (channel, address) do nothing`,
    [userId, normalizeChannelAddress(email)],
  );
  ensured.add(userId);
}

/** The user (if any) who owns a verified identity at this address. */
export async function findVerifiedIdentity(channel: ChannelId, address: string): Promise<ChannelIdentity | null> {
  const { rows } = await query<ChannelIdentity>(
    `select user_id, channel, address, verified_at from channel_identities
      where channel = $1 and address = $2 and verified_at is not null
      limit 1`,
    [channel, normalizeChannelAddress(address)],
  );
  return rows[0] ?? null;
}

/** The user's verified address on a channel (where August may write to them). */
export async function verifiedAddressFor(userId: string, channel: ChannelId): Promise<string | null> {
  const { rows } = await query<{ address: string }>(
    `select address from channel_identities
      where user_id = $1 and channel = $2 and verified_at is not null
      order by verified_at asc limit 1`,
    [userId, channel],
  );
  return rows[0]?.address ?? null;
}

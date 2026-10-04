import "server-only";

import path from "node:path";

import { getObjectVerified, putObjectVerified, sha256Bytes } from "@/server/computers/storage";
import { query } from "@/server/db/client";

/**
 * Durable files (browser downloads, screenshots, Computer outputs) in Neon
 * Object Storage, addressed by an `artifacts` row id. Bytes are content-
 * addressed by sha256 and every write is verified by full readback. This is the
 * hand-off point between August's browser and its Computer.
 */

export const MAX_ARTIFACT_BYTES = 50 * 1024 * 1024;

const MEDIA_TYPES: Record<string, string> = {
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".csv": "text/csv",
  ".json": "application/json",
  ".html": "text/html",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".zip": "application/zip",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};

export function safeFilename(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "").slice(0, 128) || "file";
}

export function mediaTypeFor(filename: string): string {
  return MEDIA_TYPES[path.posix.extname(filename).toLowerCase()] ?? "application/octet-stream";
}

export type StoredArtifact = { artifactId: string; filename: string; mediaType: string; sha256: string; byteCount: number };

export async function storeArtifact(args: {
  userId: string;
  responsibilityId: string | null;
  bytes: Buffer;
  filename: string;
  mediaType?: string;
}): Promise<StoredArtifact> {
  if (args.bytes.length > MAX_ARTIFACT_BYTES) throw new Error(`file exceeds ${MAX_ARTIFACT_BYTES} bytes`);
  const filename = safeFilename(args.filename);
  const mediaType = args.mediaType || mediaTypeFor(filename);
  const digest = sha256Bytes(args.bytes);
  const stored = await putObjectVerified({
    key: `artifacts/${args.userId}/${digest}/${filename}`,
    bytes: args.bytes,
    contentType: mediaType,
    expectedSha256: digest,
  });
  const { rows } = await query<{ id: string }>(
    `insert into artifacts (user_id, responsibility_id, storage_key, filename, media_type, byte_count, sha256)
     values ($1, $2, $3, $4, $5, $6, $7) returning id`,
    [args.userId, args.responsibilityId, stored.key, filename, mediaType, stored.byteCount, stored.sha256],
  );
  return { artifactId: rows[0].id, filename, mediaType, sha256: stored.sha256, byteCount: stored.byteCount };
}

/** Loads an artifact the user owns, verifying its digest. Null when not theirs / missing. */
export async function loadArtifact(
  userId: string,
  artifactId: string,
): Promise<(StoredArtifact & { bytes: Buffer }) | null> {
  if (!/^[0-9a-f-]{36}$/i.test(artifactId)) return null;
  const { rows } = await query<{
    id: string;
    storage_key: string;
    filename: string;
    media_type: string;
    sha256: string;
    byte_count: string;
  }>(`select id, storage_key, filename, media_type, sha256, byte_count from artifacts where id = $1 and user_id = $2`, [
    artifactId,
    userId,
  ]);
  const r = rows[0];
  if (!r) return null;
  const bytes = await getObjectVerified(r.storage_key, r.sha256, MAX_ARTIFACT_BYTES);
  return { artifactId: r.id, filename: r.filename, mediaType: r.media_type, sha256: r.sha256, byteCount: Number(r.byte_count), bytes };
}

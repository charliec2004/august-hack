import "server-only";

import { createHash } from "node:crypto";

import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

/**
 * Neon Object Storage (S3-compatible) for durable Computer outputs and
 * User Environment bundles. A Sprite never holds storage credentials: bytes are
 * proxied through the server, and every write is verified by full readback.
 *
 * Env: AWS_ENDPOINT_URL_S3, AWS_REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY,
 * optional AUGUST_ARTIFACTS_BUCKET (default "august-artifacts").
 */

export const DEFAULT_BUCKET = "august-artifacts";

declare global {
  var __augustS3Client: S3Client | undefined;
}

export function artifactsBucket(): string {
  return process.env.AUGUST_ARTIFACTS_BUCKET || DEFAULT_BUCKET;
}

function client(): S3Client {
  if (!globalThis.__augustS3Client) {
    const endpoint = process.env.AWS_ENDPOINT_URL_S3;
    if (!endpoint) throw new Error("AWS_ENDPOINT_URL_S3 is not set");
    globalThis.__augustS3Client = new S3Client({
      endpoint,
      region: process.env.AWS_REGION || "auto",
      forcePathStyle: true,
      // One dispatch is one physical request; callers own retry decisions.
      maxAttempts: 1,
      // Neon's S3 surface does not need the SDK's default CRC32 trailers.
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
    });
  }
  return globalThis.__augustS3Client;
}

export function sha256Bytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export type StoredObject = {
  key: string;
  sha256: string;
  byteCount: number;
};

export class StorageVerificationError extends Error {
  constructor(
    message: string,
    readonly key: string,
  ) {
    super(message);
    this.name = "StorageVerificationError";
  }
}

/** Reads a whole object, refusing anything above `maxBytes`. */
export async function getObjectBytes(key: string, maxBytes = 256 * 1024 * 1024): Promise<Buffer> {
  const res = await client().send(new GetObjectCommand({ Bucket: artifactsBucket(), Key: key }));
  if (typeof res.ContentLength === "number" && res.ContentLength > maxBytes) {
    throw new StorageVerificationError(`object exceeds ${maxBytes} bytes`, key);
  }
  if (!res.Body) throw new StorageVerificationError("object has no body", key);
  const bytes = Buffer.from(await res.Body.transformToByteArray());
  if (bytes.length > maxBytes) {
    throw new StorageVerificationError(`object exceeds ${maxBytes} bytes`, key);
  }
  return bytes;
}

/** Returns size if the object exists, null on 404. Other errors throw. */
export async function headObject(key: string): Promise<{ byteCount: number } | null> {
  try {
    const res = await client().send(new HeadObjectCommand({ Bucket: artifactsBucket(), Key: key }));
    return { byteCount: res.ContentLength ?? 0 };
  } catch (err) {
    const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
    if (e.name === "NotFound" || e.name === "NoSuchKey" || e.$metadata?.httpStatusCode === 404) {
      return null;
    }
    throw err;
  }
}

/**
 * PUT then full GET readback; throws StorageVerificationError unless the stored
 * bytes hash to the same sha256. `expectedSha256` (hex) lets callers bind the
 * upload to a digest computed elsewhere (e.g. inside the builder Sprite).
 */
export async function putObjectVerified(args: {
  key: string;
  bytes: Uint8Array;
  contentType: string;
  expectedSha256?: string;
}): Promise<StoredObject> {
  const sha256 = sha256Bytes(args.bytes);
  if (args.expectedSha256 && args.expectedSha256 !== sha256) {
    throw new StorageVerificationError("local bytes do not match expected sha256", args.key);
  }
  await client().send(
    new PutObjectCommand({
      Bucket: artifactsBucket(),
      Key: args.key,
      Body: args.bytes,
      ContentType: args.contentType,
      ContentLength: args.bytes.length,
      Metadata: { sha256 },
    }),
  );
  const readback = await getObjectBytes(args.key, Math.max(args.bytes.length, 1));
  const readbackSha = sha256Bytes(readback);
  if (readbackSha !== sha256 || readback.length !== args.bytes.length) {
    throw new StorageVerificationError("readback digest mismatch", args.key);
  }
  return { key: args.key, sha256, byteCount: args.bytes.length };
}

/** Reads an object and verifies its digest before returning the bytes. */
export async function getObjectVerified(
  key: string,
  expectedSha256: string,
  maxBytes?: number,
): Promise<Buffer> {
  const bytes = await getObjectBytes(key, maxBytes);
  if (sha256Bytes(bytes) !== expectedSha256) {
    throw new StorageVerificationError("stored object digest mismatch", key);
  }
  return bytes;
}

export async function deleteObject(key: string): Promise<void> {
  await client().send(new DeleteObjectCommand({ Bucket: artifactsBucket(), Key: key }));
}

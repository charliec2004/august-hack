import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * AES-256-GCM envelope for CLI credentials. Pure (key passed in) so it is
 * unit-testable. The AAD binds a ciphertext to its owner, tool and kind:
 * a row copied to another user or tool fails authentication.
 */

export const CREDENTIALS_KEY_VERSION = 1;

export type SealedCredential = {
  ciphertext: Buffer;
  iv: Buffer;
  authTag: Buffer;
  keyVersion: number;
};

export type CredentialBinding = { userId: string; toolKey: string; kind: "env" | "file" };

export class CredentialKeyError extends Error {}

/** Parses CREDENTIALS_KEY (base64, exactly 32 bytes). */
export function parseCredentialsKey(raw: string | undefined): Buffer {
  if (!raw) throw new CredentialKeyError("CREDENTIALS_KEY is not set");
  const key = Buffer.from(raw.trim(), "base64");
  if (key.length !== 32) throw new CredentialKeyError("CREDENTIALS_KEY must be 32 bytes (base64)");
  return key;
}

function aad(b: CredentialBinding): Buffer {
  return Buffer.from(`august-tool-credential:v1\0${b.userId}\0${b.toolKey}\0${b.kind}`, "utf8");
}

export function sealCredential(key: Buffer, binding: CredentialBinding, plaintext: string): SealedCredential {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(aad(binding));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return { ciphertext, iv, authTag: cipher.getAuthTag(), keyVersion: CREDENTIALS_KEY_VERSION };
}

/** Throws if the ciphertext, iv, tag, or binding was altered. */
export function openCredential(key: Buffer, binding: CredentialBinding, sealed: SealedCredential): string {
  if (sealed.keyVersion !== CREDENTIALS_KEY_VERSION) throw new CredentialKeyError("unknown credentials key version");
  if (sealed.iv.length !== 12 || sealed.authTag.length !== 16) throw new Error("credential envelope is malformed");
  const decipher = createDecipheriv("aes-256-gcm", key, sealed.iv, { authTagLength: 16 });
  decipher.setAAD(aad(binding));
  decipher.setAuthTag(sealed.authTag);
  return Buffer.concat([decipher.update(sealed.ciphertext), decipher.final()]).toString("utf8");
}

import "server-only";

import Kernel from "@onkernel/sdk";

let client: Kernel | null = null;

/** Shared Kernel SDK client (KERNEL_API_KEY). */
export function kernel(): Kernel {
  if (!client) {
    const apiKey = process.env.KERNEL_API_KEY;
    if (!apiKey) throw new Error("KERNEL_API_KEY is not set");
    client = new Kernel({ apiKey });
  }
  return client;
}

/** Project vault holding saved website logins (items keyed by vault_items.id). */
export function kernelVaultName(): string {
  return process.env.KERNEL_VAULT_NAME || "august-logins";
}

export function isKernelNotFound(err: unknown): boolean {
  return (err as { status?: number } | null)?.status === 404;
}

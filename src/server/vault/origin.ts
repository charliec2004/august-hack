/**
 * Login origin binding (ported at shape level from the main August repo's
 * website-accounts fill scope): a saved login may only be entered on its
 * declared exact HTTPS origins. Scheme, hostname and port must match; sibling
 * subdomains and SSO providers are NOT implicitly allowed. IP literals,
 * single-label hosts and non-HTTPS URLs are refused. Pure; no I/O.
 */

/** Exact origin ("https://host[:port]") or null when the input can't be a login origin. */
export function normalizeLoginOrigin(input: string): string | null {
  let u: URL;
  try {
    u = new URL(input.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "https:") return null;
  if (u.username || u.password) return null;
  const host = u.hostname.toLowerCase();
  if (!host.includes(".") || host.endsWith(".")) return null;
  if (host.startsWith("[") || /^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return null;
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return null;
  return u.origin;
}

/** True when `pageUrl`'s exact origin is one of the login's declared origins. */
export function originAllowed(pageUrl: string, loginOrigins: readonly string[]): boolean {
  const o = normalizeLoginOrigin(pageUrl);
  return o !== null && loginOrigins.includes(o);
}

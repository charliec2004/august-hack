/** App surfaces beyond the conversation, opened from the rail or `?panel=`. */
export type Surface = "logins" | "connections" | "computer";

export const SURFACES: readonly Surface[] = ["logins", "connections", "computer"];

export function isSurface(v: string | null): v is Surface {
  return v !== null && (SURFACES as readonly string[]).includes(v);
}

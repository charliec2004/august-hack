import type { ResponsibilityView } from "@/server/types/api";

const timeFmt = new Intl.DateTimeFormat(undefined, {
  hour: "numeric",
  minute: "2-digit",
});
const dayFmt = new Intl.DateTimeFormat(undefined, { weekday: "short" });
const dateFmt = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
});

function sameDay(a: Date, b: Date) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/** "2:30 PM", "Tomorrow 9:00 AM", "Fri 2:30 PM", "Oct 12 2:30 PM" in local time. */
export function formatWhen(iso: string, now = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const time = timeFmt.format(d);
  if (sameDay(d, now)) return time;
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  if (sameDay(d, tomorrow)) return `Tomorrow ${time}`;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (sameDay(d, yesterday)) return `Yesterday ${time}`;
  const days = Math.abs(d.getTime() - now.getTime()) / 86_400_000;
  if (days < 6) return `${dayFmt.format(d)} ${time}`;
  return `${dateFmt.format(d)} ${time}`;
}

export function isFinished(r: Pick<ResponsibilityView, "status">): boolean {
  return (
    r.status === "completed" || r.status === "failed" || r.status === "cancelled"
  );
}

/** 0 needs you, 1 working now, 2 scheduled/waiting, 3 finished. */
function rank(r: ResponsibilityView): number {
  if (r.status === "waiting_user" || r.humanStatus === "Needs you") return 0;
  if (isFinished(r)) return 3;
  if (r.active || r.status === "running" || r.status === "active") return 1;
  return 2;
}

export function sortResponsibilities(
  list: ResponsibilityView[],
): ResponsibilityView[] {
  const t = (iso: string | null, fallback: number) =>
    iso ? new Date(iso).getTime() : fallback;
  return [...list].sort((a, b) => {
    const ra = rank(a);
    const rb = rank(b);
    if (ra !== rb) return ra - rb;
    if (ra === 2) {
      // Soonest next check first.
      return t(a.nextWakeAt, Infinity) - t(b.nextWakeAt, Infinity);
    }
    // Most recently touched first.
    return t(b.updatedAt, 0) - t(a.updatedAt, 0);
  });
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** "partySize" -> "Party size"; "dietary_needs" -> "Dietary needs". */
export function humanizeKey(key: string): string {
  const spaced = key
    .replace(/[_-]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .trim()
    .toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

export function humanizeValue(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);
  if (Array.isArray(value)) return value.map(humanizeValue).join(", ");
  if (typeof value === "object")
    return Object.entries(value as Record<string, unknown>)
      .map(([k, v]) => `${humanizeKey(k)}: ${humanizeValue(v)}`)
      .join("; ");
  return String(value);
}

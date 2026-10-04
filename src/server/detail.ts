import "server-only";

import { stripHistoryLines } from "@/lib/genui";
import { query } from "@/server/db/client";
import type { DetailMoment, SourceGroup, SourceItem } from "@/server/types/api";

/**
 * Pure shaping for the responsibility drawer: a few human tags instead of a
 * constraints table, key moments instead of a raw event log, and sources
 * grouped by where they came from. Nothing internal (ids, receipts) leaks.
 */

const THREAD_ID = /thread [0-9a-f-]{8,}/i;

/* Facts ------------------------------------------------------------------- */

const SKIP_KEY = /demo|recipient|approval|monitor|email|note|instruction|quality|criteria|contact|phone/i;
const ORDER = ["date", "day", "time", "party", "people", "guests", "location", "area", "neighborhood", "budget", "price"];
const MAX_FACTS = 5;
const MAX_FACT_LENGTH = 28;

function factFor(key: string, value: unknown): string | null {
  if (typeof value === "number") {
    return /party|people|guests|size|covers/i.test(key) ? `Party of ${value}` : null;
  }
  if (typeof value !== "string") return null;
  let v = value.trim();
  if (/party|people|guests|size/i.test(key) && /^\d+$/.test(v)) return `Party of ${v}`;
  v = v.replace(/^(around|about|approximately|near|by|~)\s+/i, "").replace(/\s+total$/i, "");
  if (v.length > MAX_FACT_LENGTH || /location|area|neighborhood|place|date|day/i.test(key)) v = v.split(",")[0].trim();
  if (!v || v.length > MAX_FACT_LENGTH) return null;
  return v.charAt(0).toUpperCase() + v.slice(1);
}

export function factsFrom(constraints: Record<string, unknown>): string[] {
  const rank = (k: string) => {
    const i = ORDER.findIndex((o) => k.toLowerCase().includes(o));
    return i < 0 ? ORDER.length : i;
  };
  const facts = Object.entries(constraints ?? {})
    .filter(([k]) => !SKIP_KEY.test(k))
    .sort(([a], [b]) => rank(a) - rank(b))
    .map(([k, v]) => factFor(k, v))
    .filter((f): f is string => Boolean(f));
  return [...new Set(facts)].slice(0, MAX_FACTS);
}

/* Moments ----------------------------------------------------------------- */

const KEY_EVENT = /^(created|status\.(scheduled|waiting_user|active|completed|failed|cancelled)|effect\.(succeeded|failed))$/;
const ISO = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g;

type RawMoment = { id: string; at: Date; text: string; key: boolean };

function cleanText(text: string, tz: string): string {
  return text
    .replace(/[;,]?\s*\(?thread [0-9a-f-]{8,}\)?/gi, "")
    .replace(ISO, (iso) =>
      new Date(iso).toLocaleTimeString("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" }),
    )
    .replace(/^Will check again at/i, "Checking again at")
    .replace(/\s+\./g, ".")
    .trim();
}

export function momentsFrom(input: {
  events: { id: string; event_kind: string; safe_detail: { text?: string }; created_at: Date }[];
  activity: { id: string; at: string; text: string }[];
  tz: string;
}): DetailMoment[] {
  const events: RawMoment[] = input.events
    .filter((e) => e.safe_detail?.text)
    .map((e) => ({
      id: `e-${e.id}`,
      at: e.created_at,
      text: cleanText(e.safe_detail.text!, input.tz),
      key: KEY_EVENT.test(e.event_kind),
    }));
  // Activity lines that merely repeat an event (same text within a minute) are dropped.
  const activity: RawMoment[] = input.activity
    .map((a) => ({ id: `a-${a.id}`, at: new Date(a.at), text: cleanText(a.text, input.tz), key: false }))
    .filter((a) => !events.some((e) => e.text === a.text && Math.abs(e.at.getTime() - a.at.getTime()) < 60_000));

  const merged = [...events, ...activity]
    .filter((m) => m.text && !THREAD_ID.test(m.text))
    .sort((a, b) => a.at.getTime() - b.at.getTime());

  const out: DetailMoment[] = [];
  for (const m of merged) {
    const prev = out[out.length - 1];
    if (prev && prev.text === m.text && prev.key === m.key) {
      prev.count += 1;
      continue;
    }
    out.push({ id: m.id, at: m.at.toISOString(), text: m.text, key: m.key, count: 1 });
  }
  return out;
}

/* Sources ----------------------------------------------------------------- */

const CONNECTOR_LABEL: Record<string, string> = {
  exa: "Web search",
  executor: "Your calendar",
  agentmail: "Email",
  kernel: "Browser",
};
const SUMMARY_LIMIT = 900;

type EvidenceRow = {
  id: string;
  provider: string;
  source_url: string | null;
  safe_summary: string;
  observed_at: Date;
};

function domainOf(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

function titleOf(summary: string): string {
  const first = summary.split("\n")[0].replace(/^[#>*\-\s]+|[*_`]+/g, "").trim();
  // Search results read "Page title: page text"; keep the title.
  const head = first.split(/:\s/)[0].trim();
  return (head.length >= 8 ? head : first).slice(0, 140) || "Untitled";
}

function clip(summary: string): string {
  if (summary.length <= SUMMARY_LIMIT) return summary;
  const cut = summary.slice(0, SUMMARY_LIMIT);
  const end = Math.max(cut.lastIndexOf("\n\n"), cut.lastIndexOf(". "));
  return `${cut.slice(0, end > SUMMARY_LIMIT / 2 ? end + 1 : SUMMARY_LIMIT).trim()}…`;
}

/** A provider receipt (e.g. our own sent email) is not a source. */
function isReceipt(e: EvidenceRow): boolean {
  if (THREAD_ID.test(e.safe_summary)) return true;
  return e.provider === "agentmail" && /^(sent|replied|delivered)\b/i.test(e.safe_summary.trim());
}

export function sourcesFrom(evidence: EvidenceRow[]): SourceGroup[] {
  const groups = new Map<string, SourceGroup>();
  const seen = new Set<string>();
  // Newest first, so each URL keeps its latest reading.
  for (const e of [...evidence].sort((a, b) => b.observed_at.getTime() - a.observed_at.getTime())) {
    if (isReceipt(e)) continue;
    const domain = e.source_url ? domainOf(e.source_url) : null;
    const dedupeKey = e.source_url ? e.source_url.replace(/[#?].*$/, "").replace(/\/$/, "") : `id:${e.id}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    const key = domain ?? `connector:${e.provider}`;
    const label = domain ?? CONNECTOR_LABEL[e.provider] ?? e.provider.replace(/^\w/, (c) => c.toUpperCase());
    const item: SourceItem = {
      id: e.id,
      title: titleOf(e.safe_summary),
      url: e.source_url,
      summary: clip(e.safe_summary),
      observedAt: e.observed_at.toISOString(),
    };
    const group = groups.get(key) ?? { key, label, items: [] };
    group.items.push(item);
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => b.items.length - a.items.length || a.label.localeCompare(b.label));
}

/* Standing ---------------------------------------------------------------- */

/** August's latest message about this responsibility, as the user saw it. */
export async function standingFor(userId: string, responsibilityId: string) {
  const { rows } = await query<{ content: string; parts: { type?: string; text?: string }[] | null; created_at: Date }>(
    `select content, parts, created_at from messages
      where user_id = $1 and responsibility_id = $2 and role = 'assistant'
      order by created_at desc limit 1`,
    [userId, responsibilityId],
  );
  const m = rows[0];
  if (!m) return null;
  const fromParts = Array.isArray(m.parts)
    ? m.parts
        .filter((p) => p?.type === "text" && p.text)
        .map((p) => p.text!)
        .join("\n\n")
    : "";
  const text = stripHistoryLines(fromParts || m.content);
  return text ? { text, at: m.created_at.toISOString() } : null;
}

import "server-only";

import type { UIMessage } from "ai";
import { stripHistoryLines } from "@/lib/genui";
import { listActivity } from "@/server/activity";
import { recentUserFacingEffects } from "@/server/db/effects";
import { ensurePrimaryThread, recentMessages, type MessageRow } from "@/server/db/messages";
import { listResponsibilities } from "@/server/db/responsibilities";
import type {
  ActivityItem,
  TimelineActivityData,
  TimelineActivityItem,
  TimelineApprovalData,
} from "@/server/types/api";

const DEFAULT_MESSAGES = 60;
const MAX_MESSAGES = 2000;
const ACTIVITY_LIMIT = 400;

type Entry =
  | { at: number; kind: "message"; message: MessageRow }
  | { at: number; kind: "activity"; item: ActivityItem }
  | { at: number; kind: "approval"; effectId: string; createdAt: string; responsibilityId: string };

type Part = UIMessage["parts"][number];

/** Lines the conversation already says better (its messages and cards). */
const REDUNDANT = [
  /^took on/i,
  /^working on it$/i,
  /^checking again$/i,
  /^will check again/i,
  /^waiting for your ok/i,
  /^needs your approval/i,
  /^you approved/i,
  /^you said not now/i,
  /^emailed /i,
  /^confirmed it went through/i,
  /^that didn't go through/i,
  /^checking whether that went through/i,
  /^done$/i,
];
const BROWSER_STEP = /^(?:opening|opened|checked|browsed|reading|read) (.+)$/i;

/**
 * Condense a run of activity into the steps worth seeing: drop lines that
 * duplicate messages/cards, fold each site's open/check/browse into one
 * "Visited site", and keep each distinct step once.
 */
function condense(items: TimelineActivityItem[]): TimelineActivityItem[] {
  const out: TimelineActivityItem[] = [];
  const seen = new Map<string, number>();
  for (const item of items) {
    if (REDUNDANT.some((r) => r.test(item.text))) continue;
    const site = item.text.match(BROWSER_STEP)?.[1];
    const text = site ? `Visited ${site.replace(/^www\./, "")}` : item.text;
    const at = seen.get(text);
    if (at !== undefined) {
      // Keep the latest occurrence's session so a live browser stays watchable.
      out[at] = { ...out[at], browserSessionId: item.browserSessionId ?? out[at].browserSessionId };
      continue;
    }
    seen.set(text, out.length);
    out.push({ ...item, text, responsibilityTitle: null });
  }
  return out;
}

/**
 * Parts the UI renders. Stored `parts` win whenever present (text plus the
 * generative UI tool/data parts); `content` is only a fallback for rows without
 * parts. `content` may carry history-only "(Options shown: ...)" lines for the
 * model; those are stripped from anything shown.
 */
function renderableParts(m: MessageRow): Part[] {
  if (Array.isArray(m.parts) && m.parts.length > 0) {
    return (m.parts as Part[]).flatMap((p): Part[] => {
      if (!p || typeof p !== "object" || typeof p.type !== "string") return [];
      if (p.type === "text") {
        const text = stripHistoryLines((p as { text?: string }).text ?? "");
        return text ? [{ ...p, text }] : [];
      }
      return p.type.startsWith("data-") || p.type.startsWith("tool-") ? [p] : [];
    });
  }
  const text = stripHistoryLines(m.content);
  return text ? [{ type: "text", text }] : [];
}

/**
 * The conversation of record as one chronological timeline of AI SDK
 * UIMessages: user/assistant messages as stored, runs of activity lines as
 * `data-activity` parts, and each user-facing effect as a `data-approval` part
 * at the moment it was proposed.
 */
export async function buildTimeline(
  userId: string,
  opts: { limit?: number } = {},
): Promise<{ messages: UIMessage[]; hasEarlier: boolean }> {
  const MESSAGE_LIMIT = Math.min(Math.max(opts.limit ?? DEFAULT_MESSAGES, 1), MAX_MESSAGES);
  const threadId = await ensurePrimaryThread(userId);
  const messages = (await recentMessages(userId, threadId, MESSAGE_LIMIT)).filter((m) => m.role !== "system");
  // A full page of messages bounds the window; otherwise show everything recent.
  const since = messages.length >= MESSAGE_LIMIT ? messages[0].created_at : null;
  const [activity, effects, responsibilities] = await Promise.all([
    listActivity(userId, { since, limit: ACTIVITY_LIMIT }),
    recentUserFacingEffects(userId),
    listResponsibilities(userId),
  ]);
  const titles = new Map(responsibilities.map((r) => [r.id, r.title]));

  const entries: Entry[] = [
    ...messages.map((m): Entry => ({ at: m.created_at.getTime(), kind: "message", message: m })),
    ...activity.map((item): Entry => ({ at: Date.parse(item.at), kind: "activity", item })),
    ...effects
      // A user-edited replacement renders in its original's card, not as a second card.
      .filter((e) => !e.supersedes_effect_id && (!since || e.created_at >= since))
      .map(
        (e): Entry => ({
          at: e.created_at.getTime(),
          kind: "approval",
          effectId: e.id,
          createdAt: e.created_at.toISOString(),
          responsibilityId: e.responsibility_id,
        }),
      ),
  ].sort((a, b) => a.at - b.at);

  const out: UIMessage[] = [];
  let run: TimelineActivityItem[] = [];
  const flush = () => {
    const items = condense(run);
    if (items.length === 0) {
      run = [];
      return;
    }
    const data: TimelineActivityData = { items };
    out.push({
      id: `activity-${run[0].id}`,
      role: "assistant",
      parts: [{ type: "data-activity", data }],
      metadata: { createdAt: run[0].at, kind: "activity" },
    });
    run = [];
  };

  for (const e of entries) {
    if (e.kind === "activity") {
      run.push({
        id: e.item.id,
        text: e.item.text,
        at: e.item.at,
        responsibilityId: e.item.responsibilityId,
        responsibilityTitle: e.item.responsibilityId ? (titles.get(e.item.responsibilityId) ?? null) : null,
        browserSessionId: e.item.browserSessionId,
      });
      continue;
    }
    flush();
    if (e.kind === "approval") {
      const data: TimelineApprovalData = { effectId: e.effectId };
      out.push({
        id: `approval-${e.effectId}`,
        role: "assistant",
        parts: [{ type: "data-approval", data }],
        metadata: { createdAt: e.createdAt, kind: "approval", responsibilityId: e.responsibilityId },
      });
      continue;
    }
    const m = e.message;
    const parts = renderableParts(m);
    if (parts.length === 0) continue;
    out.push({
      id: m.id,
      role: m.role as "user" | "assistant",
      parts,
      metadata: { createdAt: m.created_at.toISOString(), responsibilityId: m.responsibility_id },
    });
  }
  flush();
  return { messages: out, hasEarlier: messages.length >= MESSAGE_LIMIT };
}

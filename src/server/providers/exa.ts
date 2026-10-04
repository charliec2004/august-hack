import "server-only";

import Exa, { ExaError, type SearchResponse } from "exa-js";

import { recordEvidence } from "@/server/db/evidence";
import { trace } from "@/server/db/traces";
import type { ToolResult } from "@/server/types/domain";

/**
 * Exa research adapter (spec sections 20, 41.1).
 *
 * One call = one Exa Search (`type: "auto"`, highlights). Every result is
 * persisted as an evidence row BEFORE we return, and the model only sees a
 * bounded, normalized view (~600 chars of highlight text per result).
 */

export const EXA_MAX_TEXT_PER_RESULT = 600;
const EXA_MAX_RESULTS = 10;

export type ExaResult = {
  evidenceId: string;
  title: string;
  url: string;
  publishedDate: string | null;
  /** Bounded highlight text; untrusted web content. */
  highlights: string;
  retrievedAt: string;
};

export type ResearchWebData = {
  query: string;
  results: ExaResult[];
};

type RawExaResult = {
  title?: string | null;
  url?: string;
  publishedDate?: string | null;
  highlights?: string[] | null;
  text?: string | null;
};

export type NormalizedExaResult = Omit<ExaResult, "evidenceId">;

/** Collapse whitespace and clip to `max` chars on a word boundary when possible. */
export function boundText(input: string, max: number): string {
  const s = input.replace(/\s+/g, " ").trim();
  if (s.length <= max) return s;
  const cut = s.slice(0, max - 1);
  const lastSpace = cut.lastIndexOf(" ");
  return `${lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut}…`;
}

/** Pure normalization of one raw Exa result. Returns null for unusable rows. */
export function normalizeExaResult(
  raw: RawExaResult,
  retrievedAt: string,
  maxChars = EXA_MAX_TEXT_PER_RESULT,
): NormalizedExaResult | null {
  if (!raw || typeof raw.url !== "string" || !/^https?:\/\//i.test(raw.url)) return null;
  const hl = Array.isArray(raw.highlights)
    ? raw.highlights.filter((h): h is string => typeof h === "string" && h.trim().length > 0)
    : [];
  const text = hl.length > 0 ? hl.join(" … ") : (raw.text ?? "");
  let publishedDate: string | null = null;
  if (raw.publishedDate) {
    const d = new Date(raw.publishedDate);
    publishedDate = Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
  }
  return {
    title: boundText((raw.title ?? "").trim() || raw.url, 200),
    url: raw.url,
    publishedDate,
    highlights: boundText(text, maxChars),
    retrievedAt,
  };
}

/** 429 / 5xx / network errors are retryable. */
export function isRetryableStatus(status: number | undefined): boolean {
  if (status === undefined) return true;
  return status === 429 || status >= 500;
}

let client: Exa | null = null;
function exa(): Exa {
  if (!client) {
    const key = process.env.EXA_API_KEY;
    if (!key) throw new Error("EXA_API_KEY is not set");
    client = new Exa(key);
  }
  return client;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const status = err instanceof ExaError ? err.statusCode : undefined;
      if (!isRetryableStatus(status) || i === attempts - 1) break;
      await sleep(400 * 2 ** i + Math.floor(Math.random() * 200));
    }
  }
  throw lastErr;
}

async function safeTrace(t: Parameters<typeof trace>[0]) {
  try {
    await trace(t);
  } catch {
    // Trace is observability only; never fail the tool call because of it.
  }
}

export async function researchWeb(args: {
  userId: string;
  responsibilityId: string | null;
  query: string;
  numResults?: number;
}): Promise<ToolResult<ResearchWebData>> {
  const { userId, responsibilityId } = args;
  const query = args.query.trim().slice(0, 500);
  const numResults = Math.max(1, Math.min(args.numResults ?? 5, EXA_MAX_RESULTS));

  if (!query) {
    return { status: "failed", evidenceRefs: [], safeSummary: "Empty search query.", retry: "never" };
  }

  let response: SearchResponse<{ highlights: true }>;
  try {
    response = await withRetry(() =>
      exa().search(query, { type: "auto", numResults, contents: { highlights: true } }),
    );
  } catch (err) {
    const status = err instanceof ExaError ? err.statusCode : undefined;
    await safeTrace({
      userId,
      responsibilityId,
      kind: "tool.failed",
      detail: { text: "Web search failed", provider: "exa" },
    });
    return {
      status: "failed",
      evidenceRefs: [],
      safeSummary: `Web search failed${status ? ` (HTTP ${status})` : ""}.`,
      retry: isRetryableStatus(status) ? "after_backoff" : "never",
    };
  }

  const retrievedAt = new Date().toISOString();
  const normalized = (response.results as RawExaResult[])
    .map((r) => normalizeExaResult(r, retrievedAt))
    .filter((r): r is NormalizedExaResult => r !== null);

  const results: ExaResult[] = [];
  for (const r of normalized) {
    const evidenceId = await recordEvidence({
      userId,
      responsibilityId,
      provider: "exa",
      sourceUrl: r.url,
      sourceRef: response.requestId ?? null,
      safeSummary: `${r.title}${r.publishedDate ? ` (${r.publishedDate})` : ""}: ${r.highlights}`,
      payload: { query, ...r },
    });
    results.push({ evidenceId, ...r });
  }

  await safeTrace({
    userId,
    responsibilityId,
    kind: "tool.succeeded",
    detail: { text: "Searched the web", provider: "exa", resultCount: results.length },
  });

  return {
    status: "succeeded",
    data: { query, results },
    evidenceRefs: results.map((r) => r.evidenceId),
    providerRequestId: response.requestId,
    safeSummary:
      results.length > 0
        ? `Found ${results.length} web result${results.length === 1 ? "" : "s"} for "${boundText(query, 80)}".`
        : `No web results for "${boundText(query, 80)}".`,
    retry: "safe",
  };
}

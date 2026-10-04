"use client";

import { useMemo, useState } from "react";
import { ArrowUpRightIcon, ChevronRightIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import type { EvidenceView } from "@/server/types/api";
import { formatWhen, hostOf } from "./format";
import { MarkdownBlock } from "./MarkdownBlock";

const COLLAPSED_COUNT = 8;

/** Newest first, one row per source URL. */
function dedupe(evidence: EvidenceView[]): EvidenceView[] {
  const seen = new Set<string>();
  return evidence.filter((ev) => {
    const key = ev.url ? ev.url.replace(/[#?].*$/, "").replace(/\/$/, "") : `id:${ev.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Compact rows (title · domain · time); click to read the summary inline. */
export function EvidenceList({ evidence }: { evidence: EvidenceView[] }) {
  const items = useMemo(() => dedupe(evidence), [evidence]);
  const [showAll, setShowAll] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const visible = showAll ? items : items.slice(0, COLLAPSED_COUNT);

  return (
    <div>
      <ul className="-mx-2 flex flex-col">
        {visible.map((ev) => {
          const open = openId === ev.id;
          return (
            <li key={ev.id} className="rounded-lg">
              <button
                type="button"
                aria-expanded={open}
                onClick={() => setOpenId(open ? null : ev.id)}
                className="hover:bg-muted/60 focus-visible:ring-ring/50 flex w-full items-start gap-1.5 rounded-lg px-2 py-1.5 text-left outline-none focus-visible:ring-2"
              >
                <ChevronRightIcon
                  className={cn(
                    "text-muted-foreground mt-0.5 size-3.5 shrink-0 transition-transform",
                    open && "rotate-90",
                  )}
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{ev.title || "Untitled"}</span>
                  <span className="text-muted-foreground block truncate text-xs">
                    {ev.url ? `${hostOf(ev.url)} · ` : ""}
                    {formatWhen(ev.observedAt)}
                  </span>
                </span>
              </button>
              {open && (
                <div className="animate-in fade-in mb-2 ml-7 mr-2 duration-200">
                  {ev.summary && <MarkdownBlock>{ev.summary}</MarkdownBlock>}
                  {ev.url && (
                    <a
                      href={ev.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-muted-foreground hover:text-foreground mt-1.5 inline-flex items-center gap-0.5 text-xs transition-colors"
                    >
                      Open {hostOf(ev.url)}
                      <ArrowUpRightIcon className="size-3" />
                    </a>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {items.length > COLLAPSED_COUNT && (
        <button
          type="button"
          onClick={() => setShowAll((v) => !v)}
          className="text-muted-foreground hover:text-foreground mt-1 text-xs transition-colors"
        >
          {showAll ? "Show less" : `Show ${items.length - COLLAPSED_COUNT} more`}
        </button>
      )}
    </div>
  );
}

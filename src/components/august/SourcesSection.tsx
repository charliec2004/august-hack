"use client";

import { useState } from "react";
import { ArrowUpRightIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import type { SourceGroup } from "@/server/types/api";
import { hostOf } from "./format";
import { MarkdownBlock } from "./MarkdownBlock";

const CHIP_LIMIT = 8;

/**
 * Where August looked, as quiet chips (label and count). A chip opens its page
 * titles; a title opens its summary. Nothing is expanded by default.
 */
export function SourcesSection({ groups }: { groups: SourceGroup[] }) {
  const [groupKey, setGroupKey] = useState<string | null>(null);
  const [itemId, setItemId] = useState<string | null>(null);
  const [allChips, setAllChips] = useState(false);
  const open = groups.find((g) => g.key === groupKey) ?? null;
  const chips = allChips ? groups : groups.slice(0, CHIP_LIMIT);

  return (
    <div>
      <div className="flex flex-wrap gap-1.5">
        {chips.map((g) => {
          const active = g.key === groupKey;
          return (
            <button
              key={g.key}
              type="button"
              aria-expanded={active}
              onClick={() => {
                setGroupKey(active ? null : g.key);
                setItemId(null);
              }}
              className={cn(
                "focus-visible:ring-ring/50 rounded-full px-2.5 py-1 text-xs transition-colors outline-none focus-visible:ring-2",
                active
                  ? "bg-foreground text-background"
                  : "bg-muted/70 text-foreground/75 hover:bg-muted hover:text-foreground",
              )}
            >
              {g.label}
              {g.items.length > 1 && (
                <span className={cn("ml-1 tabular-nums", active ? "text-background/70" : "text-muted-foreground")}>
                  ×{g.items.length}
                </span>
              )}
            </button>
          );
        })}
        {groups.length > CHIP_LIMIT && (
          <button
            type="button"
            onClick={() => setAllChips((v) => !v)}
            className="text-muted-foreground hover:text-foreground rounded-full px-2 py-1 text-xs transition-colors"
          >
            {allChips ? "Fewer" : `+${groups.length - CHIP_LIMIT} more`}
          </button>
        )}
      </div>

      {open && (
        <ul className="animate-in fade-in mt-3 flex flex-col duration-200">
          {open.items.map((item) => {
            const expanded = item.id === itemId;
            return (
              <li key={item.id}>
                <button
                  type="button"
                  aria-expanded={expanded}
                  onClick={() => setItemId(expanded ? null : item.id)}
                  className={cn(
                    "hover:text-foreground block w-full truncate py-1.5 text-left text-sm transition-colors",
                    expanded ? "text-foreground font-medium" : "text-foreground/75",
                  )}
                >
                  {item.title}
                </button>
                {expanded && (
                  <div className="animate-in fade-in mb-3 pt-0.5 duration-200">
                    {item.summary && <MarkdownBlock className="text-[13px]">{item.summary}</MarkdownBlock>}
                    {item.url && (
                      <a
                        href={item.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-muted-foreground hover:text-foreground mt-2 inline-flex items-center gap-0.5 text-xs transition-colors"
                      >
                        Open source
                        <ArrowUpRightIcon className="size-3" />
                        <span className="sr-only">({hostOf(item.url)})</span>
                      </a>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

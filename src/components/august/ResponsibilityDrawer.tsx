"use client";

import { useEffect, useState } from "react";
import {
  ChevronRightIcon,
  LoaderCircleIcon,
  MonitorPlayIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type {
  ResponsibilityDetail,
  ResponsibilityView,
} from "@/server/types/api";
import { MarkdownBlock } from "./MarkdownBlock";
import { PanelSection, SidePanel, SidePanelHeader } from "./SidePanel";
import { SourcesSection } from "./SourcesSection";
import { isFinished } from "./format";
import { useAugust } from "./useAugustState";

const FACT_LIMIT = 5;

/**
 * Inspection surface for one responsibility. Shows only what the conversation
 * doesn't: where it stands in one line, the key facts, and the sources.
 */
export function ResponsibilityDrawer({
  responsibilityId,
  onClose,
  onWatch,
}: {
  responsibilityId: string | null;
  onClose: () => void;
  onWatch: (id: string) => void;
}) {
  const { state, loadDetail } = useAugust();
  const summary =
    state?.responsibilities.find((r) => r.id === responsibilityId) ?? null;
  const [detail, setDetail] = useState<ResponsibilityDetail | null>(null);
  const [failedId, setFailedId] = useState<string | null>(null);

  // Load on open, and again whenever the server says this item changed.
  const version = summary?.updatedAt ?? "";
  useEffect(() => {
    if (!responsibilityId) return;
    let cancelled = false;
    void loadDetail(responsibilityId).then((d) => {
      if (cancelled) return;
      if (d) {
        setDetail(d);
        setFailedId(null);
      } else {
        setFailedId(responsibilityId);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [responsibilityId, version, loadDetail]);

  const view: ResponsibilityView | null =
    summary ?? (detail && detail.id === responsibilityId ? detail : null);
  // Detail from a previously opened item is never shown for this one.
  const d = detail && detail.id === responsibilityId ? detail : null;
  const loadFailed = failedId !== null && failedId === responsibilityId;

  return (
    <SidePanel open={responsibilityId !== null} onClose={onClose}>
      {view ? (
        <DrawerBody
          view={view}
          detail={d}
          loadFailed={loadFailed}
          onWatch={() => onWatch(view.id)}
        />
      ) : (
        <div className="text-muted-foreground flex flex-1 items-center justify-center text-sm">
          <LoaderCircleIcon className="size-4 animate-spin" />
        </div>
      )}
    </SidePanel>
  );
}

function DrawerBody({
  view,
  detail,
  loadFailed,
  onWatch,
}: {
  view: ResponsibilityView;
  detail: ResponsibilityDetail | null;
  loadFailed: boolean;
  onWatch: () => void;
}) {
  return (
    <>
      <SidePanelHeader title={view.title} />

      <div className="flex-1 overflow-y-auto px-6 pt-2 pb-8">
        <div className="flex flex-col gap-8">
          <div className="flex flex-col gap-4">
            {detail?.standing ? (
              <MarkdownBlock className="text-foreground text-[15px]">{detail.standing}</MarkdownBlock>
            ) : detail ? (
              <p className="text-foreground/85 text-[15px] leading-relaxed">
                {standingFallback(view, detail)}
              </p>
            ) : null}
            {detail && detail.facts.length > 0 && (
              <ul className="flex flex-wrap gap-1.5" aria-label="Key facts">
                {detail.facts.slice(0, FACT_LIMIT).map((f) => (
                  <li key={f} className="bg-muted/70 text-muted-foreground rounded-full px-2.5 py-0.5 text-xs">
                    {f}
                  </li>
                ))}
              </ul>
            )}
            {view.liveViewUrl && (
              <div>
                <Button variant="outline" className="rounded-full" onClick={onWatch}>
                  <MonitorPlayIcon />
                  Watch browser
                </Button>
              </div>
            )}
          </div>

          {!detail && !loadFailed && <DetailSkeleton />}
          {!detail && loadFailed && (
            <p className="text-muted-foreground text-sm">
              Details aren&apos;t available right now.
            </p>
          )}

          {detail && detail.sources.length > 0 && (
            <PanelSection title="Sources">
              <SourcesSection groups={detail.sources} />
            </PanelSection>
          )}

          {detail && (detail.goal || detail.successCriteria.length > 0) && (
            <Details detail={detail} />
          )}
        </div>
      </div>

    </>
  );
}

function standingFallback(view: ResponsibilityView, detail: ResponsibilityDetail): string {
  if (isFinished(view)) return `${view.humanStatus}.`;
  if (view.waitingOn) return `Waiting on ${view.waitingOn}.`;
  return detail.nextAction ?? `${view.humanStatus}.`;
}

/** Goal and "Done when", tucked away by default. */
function Details({ detail }: { detail: ResponsibilityDetail }) {
  const [open, setOpen] = useState(false);
  return (
    <section>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-xs transition-colors"
      >
        <ChevronRightIcon className={cn("size-3.5 transition-transform", open && "rotate-90")} />
        Details
      </button>
      {open && (
        <div className="animate-in fade-in mt-3 flex flex-col gap-4 text-sm leading-relaxed duration-200">
          {detail.goal && (
            <div>
              <p className="text-muted-foreground mb-1 text-xs">Goal</p>
              <p className="text-foreground/85">{detail.goal}</p>
            </div>
          )}
          {detail.successCriteria.length > 0 && (
            <div>
              <p className="text-muted-foreground mb-1 text-xs">Done when</p>
              <ul className="flex flex-col gap-1">
                {detail.successCriteria.map((c, i) => (
                  <li key={i} className="text-foreground/85 flex gap-2.5">
                    <span className="bg-foreground/30 mt-2 size-1 shrink-0 rounded-full" />
                    {c}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function DetailSkeleton() {
  return (
    <div className="flex flex-col gap-2" aria-hidden>
      <div className="bg-muted h-3 w-16 animate-pulse rounded" />
      <div className="bg-muted h-4 w-full animate-pulse rounded" />
      <div className="bg-muted h-4 w-4/5 animate-pulse rounded" />
    </div>
  );
}

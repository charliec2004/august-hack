"use client";

import { useEffect, useState } from "react";
import { useAuiState } from "@assistant-ui/react";
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
import { WakeButton } from "./DemoControls";
import { MarkdownBlock } from "./MarkdownBlock";
import { PanelSection, SidePanel, SidePanelHeader } from "./SidePanel";
import { SourcesSection } from "./SourcesSection";
import { formatWhen, isFinished } from "./format";
import { useAugust } from "./useAugustState";

const FACT_LIMIT = 5;

/**
 * Inspection surface for one responsibility. Shows only what the conversation
 * doesn't: where it stands in one line, the key facts, what happens next, and
 * the sources August used.
 */
export function ResponsibilityDrawer({
  responsibilityId,
  onClose,
  onWatch,
  onShowInConversation,
}: {
  responsibilityId: string | null;
  onClose: () => void;
  onWatch: (id: string) => void;
  onShowInConversation: (id: string) => void;
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
          demoControls={state?.demoControls ?? false}
          onWatch={() => onWatch(view.id)}
          onShowInConversation={() => onShowInConversation(view.id)}
          onClose={onClose}
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
  demoControls,
  onWatch,
  onShowInConversation,
  onClose,
}: {
  view: ResponsibilityView;
  detail: ResponsibilityDetail | null;
  loadFailed: boolean;
  demoControls: boolean;
  onWatch: () => void;
  onShowInConversation: () => void;
  onClose: () => void;
}) {
  const finished = isFinished(view);
  const next = finished ? null : nextLine(view);
  const inConversation = useAuiState((s) =>
    s.thread.messages.some(
      (m) => responsibilityOf(m.metadata) === view.id,
    ),
  );

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
            {next && (
              <p
                className={cn(
                  "text-muted-foreground flex items-center gap-2 text-sm",
                  next.attention && "text-attention-foreground font-medium",
                )}
              >
                {view.active && (
                  <span className="bg-live relative flex size-2 rounded-full" aria-hidden>
                    <span className="bg-live absolute inset-0 animate-ping rounded-full opacity-50 motion-reduce:hidden" />
                  </span>
                )}
                {next.text}
              </p>
            )}
            {(view.liveViewUrl || inConversation) && (
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                {view.liveViewUrl && (
                  <Button variant="outline" className="rounded-full" onClick={onWatch}>
                    <MonitorPlayIcon />
                    Watch browser
                  </Button>
                )}
                {inConversation && (
                  <button
                    type="button"
                    onClick={onShowInConversation}
                    className="text-muted-foreground hover:text-foreground text-xs underline-offset-4 transition-colors hover:underline"
                  >
                    Show in conversation
                  </button>
                )}
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

      {!finished && (
        <footer className="flex flex-col gap-2 border-t px-6 py-4">
          {demoControls && <WakeButton responsibilityId={view.id} />}
          <CancelControl responsibilityId={view.id} onDone={onClose} />
        </footer>
      )}
    </>
  );
}

/** Message metadata from GET /api/messages lands in `custom`. */
function responsibilityOf(metadata: unknown): string | null {
  const custom = (metadata as { custom?: { responsibilityId?: unknown } } | null)?.custom;
  return typeof custom?.responsibilityId === "string" ? custom.responsibilityId : null;
}

/** What happens next, for responsibilities that are still open. */
function nextLine(view: ResponsibilityView): { text: string; attention: boolean } | null {
  if (view.humanStatus === "Needs you") return { text: "Waiting for your OK", attention: true };
  if (view.active) return { text: "Working on it now", attention: false };
  const check = view.nextWakeAt ? `Next check ${formatWhen(view.nextWakeAt)}` : null;
  if (view.status === "waiting_external") {
    const text = view.nextWakeAt
      ? `Waiting for a reply · next check ${formatWhen(view.nextWakeAt)}`
      : "Waiting for a reply";
    return { text, attention: false };
  }
  return check ? { text: check, attention: false } : null;
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

function CancelControl({
  responsibilityId,
  onDone,
}: {
  responsibilityId: string;
  onDone: () => void;
}) {
  const { cancel } = useAugust();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onConfirm() {
    setBusy(true);
    setError(null);
    const result = await cancel(responsibilityId);
    setBusy(false);
    if (result.ok) onDone();
    else setError(result.error);
  }

  if (!confirming) {
    return (
      <Button
        variant="ghost"
        className="text-muted-foreground self-start"
        onClick={() => setConfirming(true)}
      >
        Cancel this
      </Button>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm">August will stop working on this.</p>
      <div className="flex gap-2">
        <Button variant="destructive" disabled={busy} onClick={onConfirm}>
          {busy && <LoaderCircleIcon className="animate-spin" />}
          Stop
        </Button>
        <Button
          variant="ghost"
          disabled={busy}
          onClick={() => setConfirming(false)}
        >
          Keep going
        </Button>
      </div>
      {error && <p className="text-irreversible text-sm">{error}</p>}
    </div>
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

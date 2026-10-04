"use client";

import { useEffect, useState } from "react";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import {
  ChevronRightIcon,
  LoaderCircleIcon,
  MonitorPlayIcon,
  XIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type {
  ResponsibilityDetail,
  ResponsibilityView,
} from "@/server/types/api";
import { WakeButton } from "./DemoControls";
import { MarkdownBlock } from "./MarkdownBlock";
import { MomentsTimeline } from "./MomentsTimeline";
import { SourcesSection } from "./SourcesSection";
import {
  formatWhen,
  isFinished,
} from "./format";
import { useAugust } from "./useAugustState";

/**
 * Inspection surface for one responsibility. August keeps working whether or
 * not this is open; it exists so the user can see why something is waiting and
 * when it resumes.
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
    <DialogPrimitive.Root
      open={responsibilityId !== null}
      onOpenChange={(open) => !open && onClose()}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Backdrop className="data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0 fixed inset-0 z-40 bg-black/15 duration-200" />
        <DialogPrimitive.Popup className="bg-background data-open:animate-in data-open:slide-in-from-right data-closed:animate-out data-closed:slide-out-to-right fixed inset-y-0 right-0 z-40 flex w-full max-w-md flex-col border-l shadow-2xl duration-200 outline-none">
          {view ? (
            <DrawerBody
              view={view}
              detail={d}
              loadFailed={loadFailed}
              demoControls={state?.demoControls ?? false}
              onWatch={() => onWatch(view.id)}
              onClose={onClose}
            />
          ) : (
            <div className="text-muted-foreground flex flex-1 items-center justify-center text-sm">
              <LoaderCircleIcon className="size-4 animate-spin" />
            </div>
          )}
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

function DrawerBody({
  view,
  detail,
  loadFailed,
  demoControls,
  onWatch,
  onClose,
}: {
  view: ResponsibilityView;
  detail: ResponsibilityDetail | null;
  loadFailed: boolean;
  demoControls: boolean;
  onWatch: () => void;
  onClose: () => void;
}) {
  const finished = isFinished(view);
  const needsYou = view.humanStatus === "Needs you";

  return (
    <>
      <header className="flex items-start gap-3 px-6 pt-6 pb-2">
        <div className="min-w-0 flex-1">
          <DialogPrimitive.Title className="font-heading text-xl leading-tight font-medium tracking-tight">
            {view.title}
          </DialogPrimitive.Title>
          <DialogPrimitive.Description
            className={cn(
              "text-muted-foreground mt-1 flex items-center gap-2 text-sm",
              needsYou && "text-attention-foreground font-medium",
            )}
          >
            {view.active && (
              <span className="bg-live relative flex size-2 rounded-full" aria-hidden>
                <span className="bg-live absolute inset-0 animate-ping rounded-full opacity-50 motion-reduce:hidden" />
              </span>
            )}
            {view.humanStatus}
            {!finished && view.nextWakeAt && (
              <span className="text-muted-foreground/80 font-normal">
                · next check {formatWhen(view.nextWakeAt)}
              </span>
            )}
          </DialogPrimitive.Description>
        </div>
        <DialogPrimitive.Close render={<Button variant="ghost" size="icon-sm" />}>
          <XIcon />
          <span className="sr-only">Close</span>
        </DialogPrimitive.Close>
      </header>

      <div className="flex-1 overflow-y-auto px-6 pt-3 pb-8">
        <div className="flex flex-col gap-9">
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
                {detail.facts.map((f) => (
                  <li key={f} className="bg-muted/70 text-muted-foreground rounded-full px-2.5 py-0.5 text-xs">
                    {f}
                  </li>
                ))}
              </ul>
            )}
            {view.liveViewUrl && (
              <Button variant="outline" className="self-start rounded-full" onClick={onWatch}>
                <MonitorPlayIcon />
                Watch browser
              </Button>
            )}
          </div>

          {!detail && !loadFailed && <DetailSkeleton />}
          {!detail && loadFailed && (
            <p className="text-muted-foreground text-sm">
              Details aren&apos;t available right now.
            </p>
          )}

          {detail && detail.moments.length > 0 && (
            <Section title="Timeline">
              <MomentsTimeline moments={detail.moments} />
            </Section>
          )}

          {detail && detail.sources.length > 0 && (
            <Section title="Sources">
              <SourcesSection groups={detail.sources} />
            </Section>
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

function standingFallback(view: ResponsibilityView, detail: ResponsibilityDetail): string {
  if (view.waitingOn && !isFinished(view)) return `${view.humanStatus}: waiting on ${view.waitingOn}.`;
  if (detail.nextAction && !isFinished(view)) return `${view.humanStatus}. Next: ${detail.nextAction}`;
  return `${view.humanStatus}.`;
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

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <h3 className="text-muted-foreground mb-2 text-[11px] font-semibold tracking-[0.12em] uppercase">
        {title}
      </h3>
      {children}
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

"use client";

import { useEffect, useState } from "react";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import {
  ArrowUpRightIcon,
  LoaderCircleIcon,
  MonitorPlayIcon,
  XIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type {
  ActivityItem,
  ResponsibilityDetail,
  ResponsibilityView,
} from "@/server/types/api";
import { ActivityList } from "./ActivityFeed";
import { WakeButton } from "./DemoControls";
import {
  formatWhen,
  hostOf,
  humanizeKey,
  humanizeValue,
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
  const activity = (state?.activity ?? []).filter(
    (a) => a.responsibilityId === responsibilityId,
  );

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
              activity={activity}
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
  activity,
  demoControls,
  onWatch,
  onClose,
}: {
  view: ResponsibilityView;
  detail: ResponsibilityDetail | null;
  loadFailed: boolean;
  activity: ActivityItem[];
  demoControls: boolean;
  onWatch: () => void;
  onClose: () => void;
}) {
  const finished = isFinished(view);
  const needsYou = view.humanStatus === "Needs you";
  const constraints = detail
    ? Object.entries(detail.constraints ?? {}).filter(
        ([, v]) => v != null && v !== "",
      )
    : [];
  const timeline = detail
    ? [...detail.timeline].sort(
        (a, b) => new Date(b.at).getTime() - new Date(a.at).getTime(),
      )
    : [];
  const recentActivity = [...activity]
    .sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime())
    .slice(-8);

  return (
    <>
      <header className="flex items-start gap-3 border-b px-6 pt-5 pb-4">
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
          </DialogPrimitive.Description>
        </div>
        <DialogPrimitive.Close render={<Button variant="ghost" size="icon-sm" />}>
          <XIcon />
          <span className="sr-only">Close</span>
        </DialogPrimitive.Close>
      </header>

      <div className="flex-1 overflow-y-auto px-6 py-5">
        <div className="flex flex-col gap-6">
          {(view.nextWakeAt || view.waitingOn || detail?.nextAction) &&
            !finished && (
              <div className="bg-muted/60 rounded-xl px-4 py-3 text-sm">
                {view.waitingOn && (
                  <p>
                    <span className="text-muted-foreground">Waiting on </span>
                    {view.waitingOn}
                  </p>
                )}
                {detail?.nextAction && (
                  <p className={cn(view.waitingOn && "mt-1")}>
                    <span className="text-muted-foreground">Next: </span>
                    {detail.nextAction}
                  </p>
                )}
                {view.nextWakeAt && (
                  <p className="text-muted-foreground mt-1">
                    Next check {formatWhen(view.nextWakeAt)}
                  </p>
                )}
              </div>
            )}

          {view.liveViewUrl && (
            <Button
              variant="outline"
              className="self-start rounded-full"
              onClick={onWatch}
            >
              <MonitorPlayIcon />
              Watch browser
            </Button>
          )}

          {!detail && !loadFailed && <DetailSkeleton />}
          {!detail && loadFailed && (
            <p className="text-muted-foreground text-sm">
              Details aren&apos;t available right now.
            </p>
          )}

          {detail?.goal && (
            <Section title="Goal">
              <p className="text-[15px] leading-relaxed">{detail.goal}</p>
            </Section>
          )}

          {detail && detail.successCriteria.length > 0 && (
            <Section title="Done when">
              <ul className="flex flex-col gap-1.5 text-sm leading-relaxed">
                {detail.successCriteria.map((c, i) => (
                  <li key={i} className="flex gap-2.5">
                    <span className="bg-foreground/30 mt-2 size-1 shrink-0 rounded-full" />
                    {c}
                  </li>
                ))}
              </ul>
            </Section>
          )}

          {constraints.length > 0 && (
            <Section title="Constraints">
              <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1.5 text-sm">
                {constraints.map(([k, v]) => (
                  <div key={k} className="contents">
                    <dt className="text-muted-foreground">{humanizeKey(k)}</dt>
                    <dd className="min-w-0 break-words">{humanizeValue(v)}</dd>
                  </div>
                ))}
              </dl>
            </Section>
          )}

          {recentActivity.length > 0 && (
            <Section title="Recent activity">
              <div className="-ml-3">
                <ActivityList items={recentActivity} />
              </div>
            </Section>
          )}

          {timeline.length > 0 && (
            <Section title="Timeline">
              <ol className="border-border relative ml-1 flex flex-col gap-3 border-l pl-4">
                {timeline.map((e) => (
                  <li key={e.id} className="relative text-sm leading-snug">
                    <span className="bg-background border-foreground/30 absolute top-1.5 -left-[21px] size-2 rounded-full border" />
                    <p>{e.text}</p>
                    <time
                      dateTime={e.at}
                      className="text-muted-foreground text-xs"
                    >
                      {formatWhen(e.at)}
                    </time>
                  </li>
                ))}
              </ol>
            </Section>
          )}

          {detail && detail.evidence.length > 0 && (
            <Section title="What August found">
              <ul className="flex flex-col gap-2">
                {detail.evidence.map((ev) => (
                  <li
                    key={ev.id}
                    className="rounded-xl border px-3.5 py-2.5 text-sm"
                  >
                    {ev.url ? (
                      <a
                        href={ev.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="group/ev inline-flex items-start gap-1 font-medium hover:underline"
                      >
                        {ev.title}
                        <ArrowUpRightIcon className="text-muted-foreground mt-0.5 size-3.5 shrink-0" />
                      </a>
                    ) : (
                      <p className="font-medium">{ev.title}</p>
                    )}
                    {ev.summary && (
                      <p className="text-foreground/80 mt-0.5 leading-relaxed">
                        {ev.summary}
                      </p>
                    )}
                    <p className="text-muted-foreground mt-1 text-xs">
                      {ev.url ? `${hostOf(ev.url)} · ` : ""}
                      {formatWhen(ev.observedAt)}
                    </p>
                  </li>
                ))}
              </ul>
            </Section>
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

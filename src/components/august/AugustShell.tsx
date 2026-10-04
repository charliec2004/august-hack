"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { useAuiState, type ToolCallMessagePartComponent } from "@assistant-ui/react";
import { ChevronRightIcon, XIcon } from "lucide-react";
import {
  Thread,
  type ThreadComponents,
} from "@/components/assistant-ui/elements/thread.aui";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { ActivityItem } from "@/server/types/api";
import { ActivityFeed } from "./ActivityFeed";
import { ApprovalStack } from "./ApprovalCard";
import { BrowserLiveView, type LiveViewTarget } from "./BrowserLiveView";
import { DemoControls } from "./DemoControls";
import { isFinished } from "./format";
import { ResponsibilityDrawer } from "./ResponsibilityDrawer";
import { ResponsibilityRail } from "./ResponsibilityRail";
import { useAugust, type Connection } from "./useAugustState";

/**
 * One route: what August owns on the left, the conversation on the right,
 * approvals docked above the composer. Must render inside both
 * AssistantRuntimeProvider and AugustProvider.
 */
export function AugustShell() {
  const { state, connection } = useAugust();
  const [drawerId, setDrawerId] = useState<string | null>(null);
  const [liveTarget, setLiveTarget] = useState<LiveViewTarget | null>(null);
  const [railOpen, setRailOpen] = useState(false);

  const responsibilities = useMemo(
    () => state?.responsibilities ?? [],
    [state],
  );
  const openCount = responsibilities.filter((r) => !isFinished(r)).length;
  const needsYouCount = responsibilities.filter(
    (r) => r.humanStatus === "Needs you",
  ).length;
  const loading = state === null && connection === "connecting";

  const openDrawer = useCallback((id: string) => {
    setRailOpen(false);
    setDrawerId(id);
  }, []);
  const watchResponsibility = useCallback((id: string) => {
    setRailOpen(false);
    setLiveTarget({ responsibilityId: id, activityId: null });
  }, []);
  const watchActivity = useCallback((item: ActivityItem) => {
    setLiveTarget({
      responsibilityId: item.responsibilityId,
      activityId: item.id,
    });
  }, []);

  // Resolve the live view from the freshest state so it closes out when done.
  const liveResponsibility = liveTarget?.responsibilityId
    ? responsibilities.find((r) => r.id === liveTarget.responsibilityId)
    : undefined;
  const liveActivity = liveTarget?.activityId
    ? state?.activity.find((a) => a.id === liveTarget.activityId)
    : undefined;
  const liveUrl = liveTarget
    ? (liveResponsibility?.liveViewUrl ?? liveActivity?.liveViewUrl ?? null)
    : null;

  const threadComponents = useMemo<ThreadComponents>(
    () => ({
      Welcome,
      ToolFallback: QuietTool,
      ToolGroup: PlainGroup,
      ReasoningGroup: HiddenGroup,
      composerPlaceholder: "Hand August something to take care of…",
      AfterMessages: () => (
        <ActivitySlot
          onWatch={watchActivity}
          onOpenResponsibility={openDrawer}
        />
      ),
      BeforeComposer: ApprovalSlot,
    }),
    [watchActivity, openDrawer],
  );

  const rail = (
    <ResponsibilityRail
      responsibilities={responsibilities}
      loading={loading}
      selectedId={drawerId}
      onOpen={openDrawer}
      onWatch={watchResponsibility}
      footer={
        state?.demoControls ? (
          <DemoControls responsibilities={responsibilities} />
        ) : null
      }
    />
  );

  return (
    <div className="bg-background flex h-dvh flex-col">
      <RefetchAfterChat />
      <header className="flex h-14 shrink-0 items-center gap-3 border-b px-4 md:px-5">
        <h1 className="font-heading text-[1.35rem] leading-none font-medium tracking-tight">
          August
        </h1>
        <ConnectionIndicator connection={connection} />
        <div className="flex-1" />
        <Button
          variant="ghost"
          size="sm"
          className="md:hidden"
          onClick={() => setRailOpen(true)}
        >
          {needsYouCount > 0 && (
            <span className="bg-attention size-1.5 rounded-full" aria-hidden />
          )}
          August owns {openCount} {openCount === 1 ? "thing" : "things"}
          <ChevronRightIcon />
        </Button>
      </header>

      <div className="flex min-h-0 flex-1">
        <aside className="bg-sidebar hidden w-[280px] shrink-0 flex-col border-r md:flex">
          {rail}
        </aside>
        <main className="min-w-0 flex-1">
          <Thread components={threadComponents} />
        </main>
      </div>

      {/* Mobile rail */}
      <DialogPrimitive.Root open={railOpen} onOpenChange={setRailOpen}>
        <DialogPrimitive.Portal>
          <DialogPrimitive.Backdrop className="data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0 fixed inset-0 z-40 bg-black/20 duration-200" />
          <DialogPrimitive.Popup className="bg-sidebar data-open:animate-in data-open:slide-in-from-left data-closed:animate-out data-closed:slide-out-to-left fixed inset-y-0 left-0 z-40 flex w-[86vw] max-w-[320px] flex-col border-r shadow-xl duration-200 outline-none">
            <DialogPrimitive.Title className="sr-only">
              What August owns
            </DialogPrimitive.Title>
            <DialogPrimitive.Close
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="absolute top-3 right-3 z-10"
                />
              }
            >
              <XIcon />
              <span className="sr-only">Close</span>
            </DialogPrimitive.Close>
            {rail}
          </DialogPrimitive.Popup>
        </DialogPrimitive.Portal>
      </DialogPrimitive.Root>

      <ResponsibilityDrawer
        responsibilityId={drawerId}
        onClose={() => setDrawerId(null)}
        onWatch={watchResponsibility}
      />

      <BrowserLiveView
        open={liveTarget !== null}
        title={liveResponsibility?.title ?? "August at work"}
        url={liveUrl}
        onOpenChange={(open) => !open && setLiveTarget(null)}
      />
    </div>
  );
}

/* ------------------------------------------------------------------------- */

const CONNECTION_COPY: Record<Connection, { label: string; tone: string }> = {
  connecting: { label: "Connecting", tone: "bg-muted-foreground/40" },
  live: { label: "Connected", tone: "bg-live" },
  unavailable: { label: "Getting ready", tone: "bg-muted-foreground/40" },
  reconnecting: { label: "Reconnecting", tone: "bg-attention" },
};

function ConnectionIndicator({ connection }: { connection: Connection }) {
  const { label, tone } = CONNECTION_COPY[connection];
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            role="status"
            aria-label={label}
            className="flex items-center gap-1.5 rounded-full px-1.5 py-1"
          />
        }
      >
        <span
          className={cn(
            "size-1.5 rounded-full transition-colors duration-500",
            tone,
            connection === "reconnecting" && "animate-pulse",
          )}
        />
        {connection === "reconnecting" && (
          <span className="text-muted-foreground text-xs">{label}</span>
        )}
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
}

/** Refetch state as soon as an assistant reply finishes streaming. */
function RefetchAfterChat() {
  const { refresh } = useAugust();
  const running = useAuiState((s) => s.thread.isRunning);
  const was = useRef(running);
  useEffect(() => {
    if (was.current && !running) void refresh();
    was.current = running;
  }, [running, refresh]);
  return null;
}

function ApprovalSlot() {
  const { state } = useAugust();
  return <ApprovalStack approvals={state?.approvals ?? []} />;
}

function ActivitySlot({
  onWatch,
  onOpenResponsibility,
}: {
  onWatch: (item: ActivityItem) => void;
  onOpenResponsibility: (id: string) => void;
}) {
  const { state } = useAugust();
  if (!state) return null;
  return (
    <ActivityFeed
      activity={state.activity}
      responsibilities={state.responsibilities}
      onWatch={onWatch}
      onOpenResponsibility={onOpenResponsibility}
    />
  );
}

function Welcome() {
  const { state } = useAugust();
  const hasAny = (state?.responsibilities.length ?? 0) > 0;
  return (
    <div className="mb-8 flex flex-col px-2">
      <p className="font-heading animate-in fade-in slide-in-from-bottom-1 fill-mode-both text-3xl leading-tight font-medium tracking-tight text-balance duration-300">
        {hasAny
          ? "What else can August take off your plate?"
          : "Hand August something you don't want to keep chasing."}
      </p>
      <p className="text-muted-foreground animate-in fade-in fill-mode-both mt-3 max-w-md text-[15px] leading-relaxed delay-100 duration-300">
        August keeps checking on its own and only comes back when something
        changes or it needs you.
      </p>
    </div>
  );
}

/** Tool calls stay out of the conversation; a quiet line while one runs. */
const QuietTool: ToolCallMessagePartComponent = ({ status }) =>
  status?.type === "running" ? (
    <p className="text-muted-foreground my-1 animate-pulse text-sm">
      Working on it…
    </p>
  ) : null;

function PlainGroup({ children }: { children?: React.ReactNode }) {
  return <>{children}</>;
}

function HiddenGroup() {
  return null;
}

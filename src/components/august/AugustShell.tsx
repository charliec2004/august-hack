"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import {
  useAuiState,
  type ToolCallMessagePartComponent,
} from "@assistant-ui/react";
import { ChevronRightIcon, XIcon } from "lucide-react";
import {
  Thread,
  type ThreadComponents,
} from "@/components/assistant-ui/elements/thread.aui";
import { Button } from "@/components/ui/button";
import type { LiveBrowser } from "@/server/types/api";
import { AppSurfaces } from "./AppSurfaces";
import { BrowserLiveView, type LiveViewTarget } from "./BrowserLiveView";
import { ComputerPanel } from "./ComputerPanel";
import { ConnectionsPanel } from "./ConnectionsPanel";
import { DemoControls } from "./DemoControls";
import { isFinished } from "./format";
import { LoginsPanel } from "./LoginsPanel";
import { ResponsibilityDrawer } from "./ResponsibilityDrawer";
import { AugustRenderers } from "./genui/registry";
import { ResponsibilityRail } from "./ResponsibilityRail";
import { ShellActionsContext, type ShellActions } from "./shellActions";
import { isSurface, type Surface } from "./surfaces";
import { useAugust, type Connection } from "./useAugustState";

/**
 * One route: what August owns on the left, one chronological conversation on
 * the right (messages, activity lines, and approval cards where they
 * happened). Must render inside both AssistantRuntimeProvider and
 * AugustProvider.
 */
export function AugustShell() {
  const { state, connection } = useAugust();
  // `?panel=logins|connections|computer` and `?responsibility=<id>` open a
  // panel on load (deep links, screenshots); after that, local state wins.
  const urlPanel = useSyncExternalStore(noopSubscribe, readUrlPanel, () => null);
  const urlDrawer = useSyncExternalStore(noopSubscribe, readUrlDrawer, () => null);
  const [drawerState, setDrawerId] = useState<string | null | undefined>();
  const [panelState, setPanel] = useState<Surface | null | undefined>();
  const drawerId = drawerState === undefined ? urlDrawer : drawerState;
  const panel = panelState === undefined ? urlPanel : panelState;
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
    setPanel(null);
    setDrawerId(id);
  }, []);
  const openPanel = useCallback((surface: Surface) => {
    setRailOpen(false);
    setDrawerId(null);
    setPanel(surface);
  }, []);
  const showInConversation = useCallback((id: string) => {
    setDrawerId(null);
    // Let the drawer start closing before scrolling the thread underneath.
    requestAnimationFrame(() => {
      document
        .querySelector(`[data-responsibility-id="${CSS.escape(id)}"]`)
        ?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }, []);
  // Live views open only for sessions that are live in the latest state.
  const liveBrowsers = useMemo(() => state?.liveBrowsers ?? [], [state]);
  const watch = useCallback(
    (browser: LiveBrowser) => {
      if (!liveBrowsers.some((b) => b.sessionId === browser.sessionId)) return;
      setRailOpen(false);
      setLiveTarget({
        sessionId: browser.sessionId,
        responsibilityId: browser.responsibilityId,
      });
    },
    [liveBrowsers],
  );
  const watchResponsibility = useCallback(
    (id: string) => {
      const browser = liveBrowsers.find((b) => b.responsibilityId === id);
      if (browser) watch(browser);
    },
    [liveBrowsers, watch],
  );
  const actions = useMemo<ShellActions>(
    () => ({ watch, openResponsibility: openDrawer }),
    [watch, openDrawer],
  );

  // Resolve the URL from the freshest state so the view closes out when it ends.
  const liveUrl = liveTarget
    ? (liveBrowsers.find((b) => b.sessionId === liveTarget.sessionId)
        ?.liveViewUrl ?? null)
    : null;
  const liveResponsibility = liveTarget?.responsibilityId
    ? responsibilities.find((r) => r.id === liveTarget.responsibilityId)
    : undefined;

  const threadComponents = useMemo<ThreadComponents>(
    () => ({
      Welcome,
      ToolFallback: QuietTool,
      ToolGroup: PlainGroup,
      ReasoningGroup: HiddenGroup,
      composerPlaceholder: "Hand August something to take care of…",
    }),
    [],
  );

  const rail = (
    <ResponsibilityRail
      responsibilities={responsibilities}
      loading={loading}
      selectedId={drawerId}
      onOpen={openDrawer}
      onWatch={watchResponsibility}
      footer={
        <>
          <AppSurfaces active={panel} onOpen={openPanel} />
          {state?.demoControls ? (
            <DemoControls responsibilities={responsibilities} />
          ) : null}
        </>
      }
    />
  );

  return (
    <ShellActionsContext.Provider value={actions}>
      <div className="bg-background flex h-dvh flex-col">
        <AugustRenderers />
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
              <span
                className="bg-attention size-1.5 rounded-full"
                aria-hidden
              />
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
          onShowInConversation={showInConversation}
        />
        <LoginsPanel open={panel === "logins"} onClose={() => setPanel(null)} />
        <ConnectionsPanel
          open={panel === "connections"}
          onClose={() => setPanel(null)}
        />
        <ComputerPanel
          open={panel === "computer"}
          onClose={() => setPanel(null)}
          liveSessions={liveBrowsers.length}
        />

        <BrowserLiveView
          open={liveTarget !== null}
          title={liveResponsibility?.title ?? "August at work"}
          url={liveUrl}
          onOpenChange={(open) => !open && setLiveTarget(null)}
        />
      </div>
    </ShellActionsContext.Provider>
  );
}

/* ------------------------------------------------------------------------- */

const noopSubscribe = () => () => {};
const readUrlPanel = (): Surface | null => {
  const v = new URLSearchParams(window.location.search).get("panel");
  return isSurface(v) ? v : null;
};
const readUrlDrawer = () =>
  new URLSearchParams(window.location.search).get("responsibility");

/** No status dot; only a quiet word while the connection is being restored. */
function ConnectionIndicator({ connection }: { connection: Connection }) {
  if (connection !== "reconnecting") return null;
  return (
    <span role="status" className="text-muted-foreground animate-pulse text-xs">
      Reconnecting
    </span>
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

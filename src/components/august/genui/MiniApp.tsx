"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { AppWindowIcon, Maximize2Icon, Minimize2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { buildMiniAppDoc, parseMiniAppMessage, type MiniAppTheme } from "@/lib/miniApp";
import { cn } from "@/lib/utils";
import { GenUiSkeleton } from "./GenUiSkeleton";
import { useSendReply } from "./hooks";

const MIN_H = 60;
const MAX_H = 720;
const clampHeight = (h: number) => Math.min(Math.max(Math.round(h), MIN_H), MAX_H);

/**
 * A model-written HTML app in a sandboxed frame: scripts run, but with an
 * opaque origin (no cookies, storage, or parent access) and a CSP that blocks
 * all network. The app can propose a reply; the person confirms before it sends.
 */
export function MiniApp({
  title,
  html,
  images = [],
  height: heightHint,
  complete = true,
}: {
  title: string | null | undefined;
  /** The document to run; for show_html this is the server-vetted copy, never the raw model output. */
  html: string | null | undefined;
  /** Exact remote image URLs the CSP may allow (vetted server-side). */
  images?: readonly string[];
  height?: number | null;
  complete?: boolean;
}) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const cardRef = useRef<HTMLElement>(null);
  const { send, disabled } = useSendReply();
  const [theme] = useState<MiniAppTheme>(() =>
    typeof document !== "undefined" && document.documentElement.classList.contains("dark") ? "dark" : "light",
  );
  const [measured, setMeasured] = useState<number | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [proposed, setProposed] = useState<string | null>(null);
  // The frame stays behind a skeleton until it reports its size (or a moment passes).
  const [painted, setPainted] = useState(false);
  const imageKey = images.join(" ");
  const doc = useMemo(
    () => (complete && html ? buildMiniAppDoc(html, theme, imageKey ? imageKey.split(" ") : []) : null),
    [complete, html, theme, imageKey],
  );

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (!frameRef.current || e.source !== frameRef.current.contentWindow) return;
      const msg = parseMiniAppMessage(e.data);
      if (msg?.type === "august:height") {
        setMeasured(clampHeight(msg.height));
        setPainted(true);
      }
      if (msg?.type === "august:reply") setProposed(msg.text);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  useEffect(() => {
    if (!doc) return;
    const t = setTimeout(() => setPainted(true), 2500);
    return () => clearTimeout(t);
  }, [doc]);

  // Native full screen keeps the same frame (and the app's state); moving it would reload it.
  useEffect(() => {
    const onChange = () => setExpanded(document.fullscreenElement === cardRef.current && cardRef.current !== null);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);
  const toggleFullScreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void cardRef.current?.requestFullscreen();
  };

  if (!title && !doc) return complete ? null : <GenUiSkeleton kind="html" />;
  if (!doc) return <GenUiSkeleton kind="html" />;
  // The app's own content height wins; the model's hint only sizes the frame until it reports.
  const height = measured ?? (heightHint ? clampHeight(heightHint) : 160);

  return (
    <div className="relative my-3 max-w-2xl">
      {!painted && <GenUiSkeleton kind="html" className="my-0" />}
      <section
        ref={cardRef}
        aria-label={title ?? "Generated view"}
        aria-hidden={!painted}
        className={cn(
          "bg-card flex w-full flex-col overflow-hidden rounded-2xl border transition-opacity duration-300",
          painted ? "opacity-100" : "pointer-events-none absolute inset-x-0 top-0 opacity-0",
          expanded && "rounded-none border-0",
        )}
      >
        <div className="flex items-center gap-2 py-1.5 pr-1.5 pl-3.5">
          <AppWindowIcon className="text-muted-foreground size-4 shrink-0" />
          <p className="min-w-0 flex-1 truncate text-sm font-medium">{title}</p>
          <Button
            variant="ghost"
            size="icon-sm"
            className="text-muted-foreground"
            onClick={toggleFullScreen}
          >
            {expanded ? <Minimize2Icon /> : <Maximize2Icon />}
            <span className="sr-only">{expanded ? "Exit full screen" : "Full screen"}</span>
          </Button>
        </div>
        <iframe
          ref={frameRef}
          title={title ?? "Generated view"}
          srcDoc={doc}
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          className={cn("block w-full border-t", expanded && "flex-1")}
          style={expanded ? undefined : { height }}
        />
        {proposed && (
          <div className="bg-muted/40 flex flex-wrap items-center gap-2 border-t px-3.5 py-2 text-sm">
            <p className="min-w-0 flex-1">
              <span className="text-muted-foreground">Send as your reply: </span>
              {proposed}
            </p>
            <Button variant="ghost" size="sm" className="rounded-full" onClick={() => setProposed(null)}>
              Dismiss
            </Button>
            <Button
              size="sm"
              className="rounded-full px-4"
              disabled={disabled}
              onClick={() => {
                send(proposed);
                setProposed(null);
                if (document.fullscreenElement) void document.exitFullscreen();
              }}
            >
              Send
            </Button>
          </div>
        )}
      </section>
    </div>
  );
}

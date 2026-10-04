"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { AppWindowIcon, Maximize2Icon, Minimize2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { ShowApp } from "@/lib/genui";
import { buildMiniAppDoc, parseMiniAppMessage, type MiniAppTheme } from "@/lib/miniApp";
import { cn } from "@/lib/utils";
import { useSendReply } from "./hooks";

const MIN_H = 60;
const MAX_H = 720;
const clampHeight = (h: number) => Math.min(Math.max(Math.round(h), MIN_H), MAX_H);

/**
 * A model-written HTML app in a sandboxed frame: scripts run, but with an
 * opaque origin (no cookies, storage, or parent access) and a CSP that blocks
 * all network. The app can propose a reply; the person confirms before it sends.
 */
export function MiniApp({ data, complete = true }: { data: Partial<ShowApp>; complete?: boolean }) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const cardRef = useRef<HTMLElement>(null);
  const { send, disabled } = useSendReply();
  const [theme] = useState<MiniAppTheme>(() =>
    typeof document !== "undefined" && document.documentElement.classList.contains("dark") ? "dark" : "light",
  );
  const [measured, setMeasured] = useState<number | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [proposed, setProposed] = useState<string | null>(null);
  const ready = complete && Boolean(data.html);
  const doc = useMemo(() => (ready && data.html ? buildMiniAppDoc(data.html, theme) : null), [ready, data.html, theme]);

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (!frameRef.current || e.source !== frameRef.current.contentWindow) return;
      const msg = parseMiniAppMessage(e.data);
      if (msg?.type === "august:height") setMeasured(clampHeight(msg.height));
      if (msg?.type === "august:reply") setProposed(msg.text);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

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

  if (!data.title) return null;
  // The app's own content height wins; the model's hint only sizes the frame until it reports.
  const height = measured ?? (data.height ? clampHeight(data.height) : 160);

  return (
    <div className="my-3 max-w-2xl">
      <section
        ref={cardRef}
        aria-label={data.title}
        className={cn("bg-card flex w-full flex-col overflow-hidden rounded-2xl border", expanded && "rounded-none border-0")}
      >
        <div className="flex items-center gap-2 py-1.5 pr-1.5 pl-3.5">
          <AppWindowIcon className="text-muted-foreground size-4 shrink-0" />
          <p className="min-w-0 flex-1 truncate text-sm font-medium">{data.title}</p>
          <Button
            variant="ghost"
            size="icon-sm"
            className="text-muted-foreground"
            disabled={!doc}
            onClick={toggleFullScreen}
          >
            {expanded ? <Minimize2Icon /> : <Maximize2Icon />}
            <span className="sr-only">{expanded ? "Exit full screen" : "Full screen"}</span>
          </Button>
        </div>
        {doc ? (
          <iframe
            ref={frameRef}
            title={data.title}
            srcDoc={doc}
            sandbox="allow-scripts"
            referrerPolicy="no-referrer"
            className={cn("block w-full border-t", expanded && "flex-1")}
            style={expanded ? undefined : { height }}
          />
        ) : (
          <div className="bg-muted/40 text-muted-foreground flex h-28 items-center justify-center border-t text-sm">
            Building…
          </div>
        )}
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

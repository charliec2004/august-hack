"use client";

import { useEffect, useRef, useState } from "react";
import { ExternalLinkIcon, FileIcon, LoaderCircleIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type {
  ComputerBrowser,
  ComputerExecResult,
  ComputerFile,
  ComputerWorkspace,
} from "@/server/types/computer";
import { formatWhen } from "./format";
import { SidePanel, SidePanelHeader } from "./SidePanel";
import { useFetched } from "./useFetched";

const POLL_MS = 3000;
const BILLING_LINE = "August's computer is waiting on Fly billing.";

type Tab = "screen" | "terminal" | "files";
const TABS: { id: Tab; label: string }[] = [
  { id: "screen", label: "Screen" },
  { id: "terminal", label: "Terminal" },
  { id: "files", label: "Files" },
];

/** August's computer: its browser (watch, take control), its terminal, its files. */
export function ComputerPanel({
  open,
  onClose,
  liveSessions,
}: {
  open: boolean;
  onClose: () => void;
  /** Live browser sessions from the shell's state poll; a change triggers a refresh. */
  liveSessions: number;
}) {
  const [tab, setTab] = useState<Tab>("screen");
  const { data, error, reload } = useFetched<ComputerWorkspace>("/api/computer", open);

  useEffect(() => {
    if (!open) return;
    const timer = setInterval(reload, POLL_MS);
    return () => clearInterval(timer);
  }, [open, reload]);

  useEffect(() => {
    if (open) reload();
  }, [open, liveSessions, reload]);

  return (
    <SidePanel open={open} onClose={onClose}>
      <SidePanelHeader title="Computer" subtitle="August's browser, terminal, and files." />
      <div className="px-6 pt-2 pb-4">
        <div role="tablist" className="bg-muted inline-flex rounded-lg p-0.5">
          {TABS.map((t) => (
            <button
              key={t.id}
              role="tab"
              type="button"
              aria-selected={tab === t.id}
              onClick={() => setTab(t.id)}
              className={cn(
                "rounded-md px-3 py-1 text-sm transition-colors",
                tab === t.id
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>
      <div className="flex min-h-0 flex-1 flex-col px-6 pb-6">
        {!data ? (
          error ? (
            <p className="text-muted-foreground text-sm">{error}</p>
          ) : (
            <div className="bg-muted aspect-[16/10] w-full animate-pulse rounded-lg" aria-hidden />
          )
        ) : tab === "screen" ? (
          <Screen browsers={data.browsers} onChange={reload} />
        ) : tab === "terminal" ? (
          <Terminal workspace={data} onRan={reload} />
        ) : (
          <Files files={data.files} />
        )}
      </div>
    </SidePanel>
  );
}

function Screen({ browsers, onChange }: { browsers: ComputerBrowser[]; onChange: () => void }) {
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const browser = browsers.find((b) => b.sessionId === selected) ?? browsers[0] ?? null;

  async function send(url: string, method: "POST" | "DELETE", failure: string) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(url, { method });
      if (!res.ok) setError(failure);
    } catch {
      setError(failure);
    } finally {
      setBusy(false);
      onChange();
    }
  }

  if (!browser) {
    return (
      <div className="flex flex-col gap-2">
        <div className="bg-muted/50 flex aspect-[16/10] w-full items-center justify-center rounded-lg border">
          <Button
            variant="outline"
            className="rounded-full"
            disabled={busy}
            onClick={() => send("/api/computer/browser", "POST", "Couldn't open a browser. Try again.")}
          >
            {busy && <LoaderCircleIcon className="animate-spin" />}
            {busy ? "Opening" : "Open browser"}
          </Button>
        </div>
        {error && <p className="text-muted-foreground text-xs">{error}</p>}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {browsers.length > 1 && (
        <div className="flex flex-wrap gap-1">
          {browsers.map((b) => (
            <button
              key={b.sessionId}
              type="button"
              onClick={() => setSelected(b.sessionId)}
              className={cn(
                "max-w-48 truncate rounded-md px-2 py-0.5 text-xs transition-colors",
                b.sessionId === browser.sessionId
                  ? "bg-muted text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {browserLabel(b)}
            </button>
          ))}
        </div>
      )}
      <div className="bg-muted/50 relative aspect-[16/10] w-full overflow-hidden rounded-lg border">
        <iframe
          key={browser.liveViewUrl}
          src={browser.liveViewUrl}
          title={`Live view: ${browserLabel(browser)}`}
          className="absolute inset-0 size-full border-0"
          allow="clipboard-read; clipboard-write; fullscreen"
          referrerPolicy="no-referrer"
        />
      </div>
      <div className="flex items-center gap-2">
        <span className="bg-live size-1.5 shrink-0 rounded-full" aria-hidden />
        <p className="text-muted-foreground min-w-0 flex-1 truncate text-xs">
          {browserLabel(browser)}
          {!browser.savesSignIns && " · sign-ins won't be saved while August is browsing"}
        </p>
        <Button
          variant="ghost"
          size="sm"
          nativeButton={false}
          render={<a href={browser.liveViewUrl} target="_blank" rel="noopener noreferrer" />}
        >
          <ExternalLinkIcon />
          Take control
        </Button>
        {browser.owner === "user" && (
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() =>
              send(`/api/computer/browser/${browser.sessionId}`, "DELETE", "Couldn't close the browser. Try again.")
            }
          >
            <XIcon />
            Close
          </Button>
        )}
      </div>
      {error && <p className="text-muted-foreground text-xs">{error}</p>}
    </div>
  );
}

function browserLabel(b: ComputerBrowser): string {
  if (b.taskTitle) return b.taskTitle;
  return b.owner === "user" ? "Your browser" : "August's browser";
}

function Terminal({ workspace, onRan }: { workspace: ComputerWorkspace; onRan: () => void }) {
  const [input, setInput] = useState("");
  const [running, setRunning] = useState<string | null>(null);
  const [blocked, setBlocked] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const { commands, tools } = workspace;
  const blockedLine =
    blocked ??
    (workspace.blockedBy === "billing"
      ? BILLING_LINE
      : workspace.blockedBy === "not_configured"
        ? "August's computer isn't set up yet."
        : null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [commands.length, running]);

  async function run(e: React.FormEvent) {
    e.preventDefault();
    const command = input.trim();
    if (!command || running) return;
    setRunning(command);
    setError(null);
    try {
      const res = await fetch("/api/computer/exec", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command }),
      });
      const body = (await res.json().catch(() => null)) as ComputerExecResult | null;
      if (body?.status === "ran") setInput("");
      else if (body?.status === "blocked") setBlocked(body.message);
      else setError(body?.message ?? "Couldn't run that. Try again.");
    } catch {
      setError("Couldn't reach August. Check your connection.");
    } finally {
      setRunning(null);
      onRan();
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div
        ref={scrollRef}
        className={cn(
          "bg-muted/60 overflow-y-auto rounded-lg px-3 py-2.5 font-mono text-xs leading-relaxed",
          (commands.length > 0 || running) && "min-h-48 flex-1",
        )}
      >
        {commands.length === 0 && !running ? (
          <p className="text-muted-foreground">No commands yet.</p>
        ) : (
          <>
            {commands.map((c) => (
              <div key={c.id} className="mb-2 last:mb-0">
                <p className="break-all whitespace-pre-wrap">
                  <span className="text-muted-foreground select-none">$ </span>
                  {c.command}
                </p>
                {c.output && (
                  <pre className="text-muted-foreground font-mono break-all whitespace-pre-wrap">{c.output}</pre>
                )}
                {c.exitCode !== null && c.exitCode !== 0 && (
                  <p className="text-muted-foreground/70">exit {c.exitCode}</p>
                )}
              </div>
            ))}
            {running && (
              <p className="break-all whitespace-pre-wrap">
                <span className="text-muted-foreground select-none">$ </span>
                {running}
                <LoaderCircleIcon className="text-muted-foreground ml-2 inline size-3 animate-spin" />
              </p>
            )}
          </>
        )}
      </div>
      {blockedLine ? (
        <p className="text-muted-foreground text-sm">{blockedLine}</p>
      ) : (
        <form onSubmit={run} className="flex flex-col gap-1">
          <label className="border-input focus-within:ring-ring/50 flex h-9 items-center gap-2 rounded-lg border px-3 focus-within:ring-2">
            <span className="text-muted-foreground font-mono text-xs select-none">$</span>
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              disabled={!!running}
              placeholder="Run a command"
              aria-label="Command"
              spellCheck={false}
              autoComplete="off"
              className="placeholder:text-muted-foreground/70 h-full min-w-0 flex-1 bg-transparent font-mono text-xs outline-none"
            />
          </label>
          {error && <p className="text-muted-foreground text-xs">{error}</p>}
        </form>
      )}
      {tools.length > 0 && <p className="text-muted-foreground text-xs">Installed: {tools.join(", ")}</p>}
    </div>
  );
}

const RASTER = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

function Files({ files }: { files: ComputerFile[] }) {
  if (files.length === 0) return <p className="text-muted-foreground text-sm">No files yet.</p>;
  return (
    <ul className="-mx-2 flex min-h-0 flex-1 flex-col overflow-y-auto">
      {files.map((f) => (
        <li key={f.id}>
          <a
            href={`/api/artifacts/${f.id}`}
            download={f.filename}
            className="hover:bg-muted/60 flex items-center gap-3 rounded-lg px-2 py-2 transition-colors"
          >
            {RASTER.has(f.mediaType) ? (
              // eslint-disable-next-line @next/next/no-img-element -- user-scoped, authenticated route
              <img
                src={`/api/artifacts/${f.id}?inline=1`}
                alt=""
                loading="lazy"
                className="bg-muted size-9 shrink-0 rounded-md object-cover"
              />
            ) : (
              <span className="bg-muted text-muted-foreground flex size-9 shrink-0 items-center justify-center rounded-md">
                <FileIcon className="size-4" />
              </span>
            )}
            <span className="min-w-0 flex-1 truncate text-sm">{f.filename}</span>
            <span className="text-muted-foreground shrink-0 text-xs">
              {formatBytes(f.byteCount)} · {formatWhen(f.createdAt)}
            </span>
          </a>
        </li>
      ))}
    </ul>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

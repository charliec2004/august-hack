"use client";

import { TerminalIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ComputerStatus } from "@/server/types/api";
import { ListSkeleton } from "./LoginsPanel";
import { PanelSection, SidePanel, SidePanelHeader } from "./SidePanel";
import { useFetched } from "./useFetched";

/** August's own computer: whether it's reachable and what's installed on it. */
export function ComputerPanel({
  open,
  onClose,
  liveSessions,
}: {
  open: boolean;
  onClose: () => void;
  /** Live browser sessions, from the shell's state poll. */
  liveSessions: number;
}) {
  const { data, error, loading } = useFetched<ComputerStatus>("/api/computer", open);

  return (
    <SidePanel open={open} onClose={onClose}>
      <SidePanelHeader
        title="Computer"
        subtitle="August's own computer, where it runs commands and the tools you've asked it to install."
      />
      <div className="flex-1 overflow-y-auto px-6 pt-4 pb-8">
        <div className="flex flex-col gap-8">
          <PanelSection title="Status">
            {loading && !data ? (
              <div className="bg-muted h-4 w-2/3 animate-pulse rounded" aria-hidden />
            ) : (
              <div className="flex flex-col gap-1.5 text-sm">
                <p className="flex items-center gap-2">
                  <span
                    className={cn("size-2 rounded-full", data?.available ? "bg-live" : "bg-muted-foreground/40")}
                    aria-hidden
                  />
                  {data?.available ? "Ready" : (data?.reason ?? error ?? "Couldn't reach August's computer right now.")}
                </p>
                <p className="text-muted-foreground">Live browser sessions: {liveSessions}</p>
              </div>
            )}
          </PanelSection>

          <PanelSection title="Installed tools">
            {loading && !data ? (
              <ListSkeleton />
            ) : !data || data.tools.length === 0 ? (
              <p className="text-muted-foreground text-sm leading-relaxed">
                No extra tools installed yet. Ask August to install one.
              </p>
            ) : (
              <>
                <ul className="flex flex-col divide-y">
                  {data.tools.map((t) => (
                    <li key={t.toolKey} className="flex items-center gap-3 py-2.5 first:pt-0">
                      <span className="bg-muted text-muted-foreground flex size-8 shrink-0 items-center justify-center rounded-full">
                        <TerminalIcon className="size-3.5" />
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-mono text-sm">{t.toolKey}</p>
                        {t.packageName !== "-" && (
                          <p className="text-muted-foreground truncate text-xs">
                            {t.packageName}@{t.packageVersion}
                          </p>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
                <p className="text-muted-foreground/80 mt-3 text-xs">Setup version {data.generation}</p>
              </>
            )}
          </PanelSection>
        </div>
      </div>
    </SidePanel>
  );
}

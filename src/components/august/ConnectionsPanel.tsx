"use client";

import { ArrowUpRightIcon } from "lucide-react";
import type { ConnectionsResponse } from "@/server/types/api";
import { ListSkeleton } from "./LoginsPanel";
import { PanelSection, SidePanel, SidePanelHeader } from "./SidePanel";
import { useFetched } from "./useFetched";

/** Apps the user connected through Executor. Read-only here. */
export function ConnectionsPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { data, error, loading } = useFetched<ConnectionsResponse>("/api/connections", open);
  const connections = data?.connections ?? [];
  const message = error ?? data?.message ?? null;

  return (
    <SidePanel open={open} onClose={onClose}>
      <SidePanelHeader
        title="Connections"
        subtitle="Apps August can read from for you. Anything that changes them still asks you first."
      />
      <div className="flex-1 overflow-y-auto px-6 pt-4 pb-8">
        <div className="flex flex-col gap-6">
          <PanelSection title="Connected apps">
            {loading && !data ? (
              <ListSkeleton />
            ) : connections.length === 0 ? (
              <p className="text-muted-foreground text-sm leading-relaxed">
                {message ?? "No apps connected yet."}
              </p>
            ) : (
              <ul className="flex flex-col divide-y">
                {connections.map((c, i) => (
                  <li key={`${c.integration}-${i}`} className="flex items-center gap-3 py-3 first:pt-0">
                    <span
                      className="bg-muted text-foreground/70 font-heading flex size-8 shrink-0 items-center justify-center rounded-full text-sm font-medium"
                      aria-hidden
                    >
                      {c.name.charAt(0)}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{c.name}</p>
                      <p className="text-muted-foreground text-xs">{c.scope}</p>
                    </div>
                    <span className="text-muted-foreground flex items-center gap-1.5 text-xs">
                      <span className="bg-live size-1.5 rounded-full" aria-hidden />
                      {c.status}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </PanelSection>
          <a
            href="https://executor.sh"
            target="_blank"
            rel="noreferrer"
            className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 self-start text-xs underline-offset-4 transition-colors hover:underline"
          >
            Manage connections in Executor
            <ArrowUpRightIcon className="size-3" />
          </a>
        </div>
      </div>
    </SidePanel>
  );
}

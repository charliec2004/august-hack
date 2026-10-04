"use client";

import { useState } from "react";
import { ArrowUpRightIcon } from "lucide-react";
import type { ConnectionsResponse } from "@/server/types/api";
import { ListSkeleton } from "./LoginsPanel";
import { SidePanel, SidePanelHeader } from "./SidePanel";
import { useFetched } from "./useFetched";

const GOOGLE_PRODUCT = (name: string) =>
  `https://www.gstatic.com/images/branding/product/2x/${name}_2020q4_48dp.png`;

/** Official product icons for integrations we know. */
const ICONS: Record<string, string> = {
  google_calendar: GOOGLE_PRODUCT("calendar"),
  google_drive: GOOGLE_PRODUCT("drive"),
  google_sheets: GOOGLE_PRODUCT("sheets"),
  google_docs: GOOGLE_PRODUCT("docs"),
  gmail: GOOGLE_PRODUCT("gmail"),
};

/** Site domains for the favicon fallback. */
const DOMAINS: Record<string, string> = {
  github: "github.com",
  gitlab: "gitlab.com",
  slack: "slack.com",
  notion: "notion.so",
  linear: "linear.app",
  hubspot: "hubspot.com",
  openai: "openai.com",
  stripe: "stripe.com",
  figma: "figma.com",
  jira: "atlassian.com",
  asana: "asana.com",
  dropbox: "dropbox.com",
  airtable: "airtable.com",
  discord: "discord.com",
  zoom: "zoom.us",
  salesforce: "salesforce.com",
  shopify: "shopify.com",
  todoist: "todoist.com",
};

function iconFor(integration: string): string | null {
  const key = integration.toLowerCase();
  if (ICONS[key]) return ICONS[key];
  const domain = DOMAINS[key] ?? (/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(key) ? key : null);
  return domain ? `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=64` : null;
}

function AppIcon({ integration, name }: { integration: string; name: string }) {
  const [failed, setFailed] = useState(false);
  const src = iconFor(integration);
  if (!src || failed) {
    return (
      <span
        className="bg-muted text-foreground/70 flex size-8 shrink-0 items-center justify-center rounded-lg text-sm font-medium"
        aria-hidden
      >
        {name.charAt(0)}
      </span>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element -- small external brand icons, no optimization needed
    <img src={src} alt="" width={32} height={32} className="size-8 shrink-0 object-contain" onError={() => setFailed(true)} />
  );
}

/** Apps the user connected through Executor. Read-only here. */
export function ConnectionsPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { data, error, loading } = useFetched<ConnectionsResponse>("/api/connections", open);
  const connections = data?.connections ?? [];
  const message = error ?? data?.message ?? null;

  return (
    <SidePanel open={open} onClose={onClose}>
      <SidePanelHeader title="Connections" subtitle="Apps August can read from for you." />
      <div className="flex-1 overflow-y-auto px-6 pt-2 pb-8">
        <div className="flex flex-col gap-4">
          {loading && !data ? (
            <ListSkeleton />
          ) : connections.length === 0 ? (
            <p className="text-muted-foreground text-sm">{message ?? "No apps connected yet."}</p>
          ) : (
            <ul className="flex flex-col gap-1">
              {connections.map((c, i) => (
                <li key={`${c.integration}-${i}`} className="flex items-center gap-3 py-1.5">
                  <AppIcon integration={c.integration} name={c.name} />
                  <p className="min-w-0 flex-1 truncate text-sm">{c.name}</p>
                  {c.scope === "Shared" && <span className="text-muted-foreground text-xs">Shared</span>}
                </li>
              ))}
            </ul>
          )}
          <a
            href="https://executor.sh"
            target="_blank"
            rel="noreferrer"
            className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 self-start text-xs transition-colors"
          >
            Manage in Executor
            <ArrowUpRightIcon className="size-3" />
          </a>
        </div>
      </div>
    </SidePanel>
  );
}

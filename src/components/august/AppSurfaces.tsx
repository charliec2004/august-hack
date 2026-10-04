"use client";

import { KeyRoundIcon, MonitorIcon, PlugIcon, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Surface } from "./surfaces";

const ENTRIES: { id: Surface; label: string; icon: LucideIcon }[] = [
  { id: "logins", label: "Logins", icon: KeyRoundIcon },
  { id: "connections", label: "Connections", icon: PlugIcon },
  { id: "computer", label: "Computer", icon: MonitorIcon },
];

/** Rail entries for what August works with: logins, connected apps, its computer. */
export function AppSurfaces({
  active,
  onOpen,
}: {
  active: Surface | null;
  onOpen: (surface: Surface) => void;
}) {
  return (
    <ul className="border-sidebar-border flex flex-col gap-0.5 border-t px-2 py-2" aria-label="What August works with">
      {ENTRIES.map(({ id, label, icon: Icon }) => (
        <li key={id}>
          <button
            type="button"
            onClick={() => onOpen(id)}
            aria-current={active === id ? "true" : undefined}
            className={cn(
              "text-foreground/75 hover:bg-sidebar-accent hover:text-foreground focus-visible:ring-ring/50 flex w-full items-center gap-2.5 rounded-lg px-3 py-1.5 text-sm transition-colors outline-none focus-visible:ring-2",
              active === id && "bg-sidebar-accent text-foreground",
            )}
          >
            <Icon className="text-muted-foreground size-4" />
            {label}
          </button>
        </li>
      ))}
    </ul>
  );
}

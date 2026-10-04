"use client";

import { useAugust } from "./useAugustState";

/** Signed-in person, pinned to the bottom-left of the rail. */
export function ProfileRow() {
  const { state } = useAugust();
  const name = state?.viewer.name ?? "";
  if (!name) return null;
  const initials = name
    .split(/\s+/)
    .map((w) => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
  return (
    <div className="border-sidebar-border flex items-center gap-2.5 border-t px-4 py-3">
      <span
        className="bg-foreground text-background flex size-7 shrink-0 items-center justify-center rounded-full text-xs font-medium"
        aria-hidden
      >
        {initials}
      </span>
      <p className="min-w-0 truncate text-sm">{name}</p>
    </div>
  );
}

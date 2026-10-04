"use client";

import { cn } from "@/lib/utils";

export type SkeletonKind = "form" | "poll" | "chart" | "html";

const LABEL: Record<SkeletonKind, string> = {
  form: "Preparing a few questions…",
  poll: "Making a poll…",
  chart: "Building a chart…",
  html: "Putting this together…",
};

/** Rough shape of each component, so the layout doesn't jump when it arrives. */
const SHAPE: Record<SkeletonKind, { rows: string[]; block?: string; width: string }> = {
  form: { rows: ["w-2/5", "w-3/4", "w-1/3", "w-2/3"], width: "max-w-xl" },
  poll: { rows: ["w-full", "w-full", "w-full"], width: "max-w-md" },
  chart: { rows: [], block: "h-48", width: "max-w-2xl" },
  html: { rows: ["w-1/2", "w-5/6"], block: "h-36", width: "max-w-2xl" },
};

/** A calm placeholder while a component is on its way. */
export function GenUiSkeleton({ kind, className }: { kind: SkeletonKind; className?: string }) {
  const shape = SHAPE[kind];
  return (
    <div
      role="status"
      aria-live="polite"
      data-slot="genui-skeleton"
      className={cn("bg-card my-3 w-full rounded-2xl border px-4 py-3.5", shape.width, className)}
    >
      <p className="shimmer text-muted-foreground text-sm motion-reduce:animate-none">{LABEL[kind]}</p>
      <div className="mt-3 flex flex-col gap-2.5" aria-hidden>
        {shape.rows.map((w, i) => (
          <div key={i} className={cn("bg-muted h-7 animate-pulse rounded-lg motion-reduce:animate-none", kind === "poll" && "h-9 rounded-xl", w)} />
        ))}
        {shape.block && <div className={cn("bg-muted animate-pulse rounded-xl motion-reduce:animate-none", shape.block)} />}
      </div>
    </div>
  );
}

"use client";

import { CheckIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/** A selectable answer. `role` is radio for one-of-many, checkbox for any-of-many. */
export function ChoiceChip({
  label,
  detail,
  selected,
  role,
  disabled,
  wide,
  onClick,
}: {
  label: string;
  detail?: string | null;
  selected: boolean;
  role: "radio" | "checkbox";
  disabled?: boolean;
  wide?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role={role}
      aria-checked={selected}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "focus-visible:ring-ring/50 inline-flex max-w-full border text-left text-sm transition-colors outline-none focus-visible:ring-2 disabled:pointer-events-none",
        wide
          ? "w-full flex-wrap items-baseline gap-x-2 rounded-xl px-3.5 py-1.5"
          : "flex-col items-start rounded-full px-3.5 py-1.5",
        selected ? "border-foreground bg-foreground text-background" : "bg-background hover:bg-muted",
        disabled && !selected && "opacity-60",
      )}
    >
      <span className="flex items-center gap-1.5">
        {selected && <CheckIcon className="size-3.5 shrink-0" />}
        {label}
      </span>
      {detail && (
        <span className={cn("text-xs", selected ? "text-background/75" : "text-muted-foreground")}>{detail}</span>
      )}
    </button>
  );
}

/** A 1..N segmented scale with optional end labels. */
export function ScaleControl({
  min,
  max,
  minLabel,
  maxLabel,
  value,
  disabled,
  label,
  onChange,
}: {
  min: number;
  max: number;
  minLabel: string | null;
  maxLabel: string | null;
  value: number | null;
  disabled?: boolean;
  label: string;
  onChange: (v: number) => void;
}) {
  const lo = Math.min(min, max);
  const hi = Math.min(Math.max(min, max), lo + 10);
  const steps = Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);
  return (
    <div className="max-w-md">
      <div role="radiogroup" aria-label={label} className="bg-muted flex gap-0.5 rounded-full p-0.5">
        {steps.map((n) => (
          <button
            key={n}
            type="button"
            role="radio"
            aria-checked={value === n}
            disabled={disabled}
            onClick={() => onChange(n)}
            className={cn(
              "focus-visible:ring-ring/50 h-8 min-w-0 flex-1 rounded-full text-sm tabular-nums transition-colors outline-none focus-visible:ring-2",
              value === n
                ? "bg-background text-foreground font-medium shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {n}
          </button>
        ))}
      </div>
      {(minLabel || maxLabel) && (
        <div className="text-muted-foreground mt-1 flex justify-between px-2 text-xs">
          <span>{minLabel}</span>
          <span>{maxLabel}</span>
        </div>
      )}
    </div>
  );
}

/** Shared input look for typed answers; grows with its content. */
export const textFieldClass =
  "bg-background placeholder:text-muted-foreground focus-visible:border-foreground/30 w-full max-w-md rounded-xl border px-3 py-2 text-sm outline-none";

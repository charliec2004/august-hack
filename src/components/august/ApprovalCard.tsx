"use client";

import { useState } from "react";
import { CheckIcon, LoaderCircleIcon, TriangleAlertIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { ApprovalView } from "@/server/types/api";
import { useAugust } from "./useAugustState";

const CLASS_NOTE: Record<ApprovalView["effectClass"], string | null> = {
  irreversible: "Can't be undone once sent",
  consequential: null,
  reversible: "Can be undone",
};

/**
 * Renders one frozen effect proposal exactly as persisted. Approving posts the
 * proposalHash shown here, so the server executes precisely this card.
 */
export function ApprovalCard({ approval }: { approval: ApprovalView }) {
  const { decide } = useAugust();
  const [pending, setPending] = useState<"approved" | "denied" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const irreversible = approval.effectClass === "irreversible";
  const note = CLASS_NOTE[approval.effectClass];

  async function onDecide(decision: "approved" | "denied") {
    setPending(decision);
    setError(null);
    const result = await decide(approval, decision);
    if (!result.ok) {
      setError(result.error);
      setPending(null);
    }
    // On success the card leaves with the next state refresh.
  }

  return (
    <section
      aria-label={`Approval needed: ${approval.responsibilityTitle}`}
      data-effect-class={approval.effectClass}
      className={cn(
        "bg-card text-card-foreground animate-in fade-in slide-in-from-bottom-2 relative overflow-hidden rounded-2xl border shadow-[0_1px_2px_rgba(60,40,20,0.04),0_8px_24px_-12px_rgba(60,40,20,0.18)] duration-300",
        irreversible && "border-irreversible/40",
      )}
    >
      {irreversible && (
        <div
          aria-hidden
          className="bg-irreversible absolute inset-y-0 left-0 w-1"
        />
      )}
      <div className="px-5 pt-4 pb-4">
        <div className="flex items-center justify-between gap-3">
          <p className="text-muted-foreground truncate text-xs font-medium tracking-wide">
            {approval.responsibilityTitle}
          </p>
          {note && (
            <span
              className={cn(
                "inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium",
                irreversible
                  ? "bg-irreversible/10 text-irreversible"
                  : "bg-muted text-muted-foreground",
              )}
            >
              {irreversible && <TriangleAlertIcon className="size-3" />}
              {note}
            </span>
          )}
        </div>

        <h3 className="font-heading mt-1.5 text-[1.05rem] leading-snug font-medium">
          {approval.headline}
        </h3>

        {approval.fields.length > 0 && (
          <dl className="mt-3 grid grid-cols-[minmax(4.5rem,max-content)_1fr] gap-x-4 gap-y-1.5 text-sm">
            {approval.fields.map((f, i) => (
              <div key={`${f.label}-${i}`} className="contents">
                <dt className="text-muted-foreground">{f.label}</dt>
                <dd className="min-w-0 font-medium break-words whitespace-pre-wrap">
                  {f.value}
                </dd>
              </div>
            ))}
          </dl>
        )}

        {approval.body != null && approval.body !== "" && (
          <blockquote className="border-foreground/15 bg-muted/50 text-foreground/90 mt-3 max-h-80 overflow-y-auto rounded-r-lg border-l-2 px-4 py-3 text-sm leading-relaxed break-words whitespace-pre-wrap">
            {approval.body}
          </blockquote>
        )}

        {approval.question && (
          <p className="text-foreground/80 mt-3 text-sm">{approval.question}</p>
        )}

        {error && (
          <p role="alert" className="text-irreversible mt-3 text-sm">
            {error}
          </p>
        )}

        <div className="mt-4 flex items-center gap-2">
          <Button
            size="lg"
            className="min-w-24 rounded-full px-4"
            disabled={pending !== null}
            onClick={() => onDecide("approved")}
          >
            {pending === "approved" ? (
              <LoaderCircleIcon className="animate-spin" />
            ) : (
              <CheckIcon />
            )}
            {pending === "approved" ? "Approving" : "Approve"}
          </Button>
          <Button
            size="lg"
            variant="ghost"
            className="rounded-full px-4"
            disabled={pending !== null}
            onClick={() => onDecide("denied")}
          >
            {pending === "denied" && (
              <LoaderCircleIcon className="animate-spin" />
            )}
            Not now
          </Button>
        </div>
      </div>
    </section>
  );
}

export function ApprovalStack({ approvals }: { approvals: ApprovalView[] }) {
  if (approvals.length === 0) return null;
  return (
    <div className="flex max-h-[55dvh] flex-col gap-3 overflow-y-auto px-0.5 pt-1 pb-0.5">
      {approvals.map((a) => (
        <ApprovalCard key={`${a.effectId}:${a.proposalHash}`} approval={a} />
      ))}
    </div>
  );
}

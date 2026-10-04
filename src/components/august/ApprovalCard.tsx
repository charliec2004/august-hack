"use client";

import { useState } from "react";
import {
  CheckIcon,
  CircleSlashIcon,
  LoaderCircleIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { ApprovalView, TimelineApprovalData } from "@/server/types/api";
import { formatWhen } from "./format";
import { useAugust } from "./useAugustState";

const CLASS_NOTE: Record<ApprovalView["effectClass"], string | null> = {
  irreversible: "Can't be undone once sent",
  consequential: null,
  reversible: "Can be undone",
};

/**
 * Renders one frozen effect proposal exactly as persisted, where it appeared in
 * the conversation. Pending: Approve / Not now (approving posts the proposalHash
 * shown here, so the server executes precisely this card). Resolved: the same
 * card with a status line in place of the buttons.
 */
export function ApprovalCard({ approval }: { approval: ApprovalView }) {
  const { decide } = useAugust();
  const [pending, setPending] = useState<"approved" | "denied" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const isPending = approval.state === "pending";
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
    // On success the card turns into its resolved state on the next refresh.
  }

  return (
    <section
      aria-label={`${isPending ? "Approval needed" : "Approval"}: ${approval.responsibilityTitle}`}
      data-effect-class={approval.effectClass}
      data-state={approval.state}
      className={cn(
        "bg-card text-card-foreground animate-in fade-in relative my-2 overflow-hidden rounded-2xl border duration-300",
        isPending
          ? "shadow-[0_1px_2px_rgba(60,40,20,0.04),0_8px_24px_-12px_rgba(60,40,20,0.18)]"
          : "shadow-[0_1px_2px_rgba(60,40,20,0.04)]",
        irreversible && isPending && "border-irreversible/40",
      )}
    >
      {irreversible && isPending && (
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
          {note && isPending && (
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
          <blockquote
            className={cn(
              "border-foreground/15 bg-muted/50 text-foreground/90 mt-3 overflow-y-auto rounded-r-lg border-l-2 px-4 py-3 text-sm leading-relaxed break-words whitespace-pre-wrap",
              isPending ? "max-h-80" : "max-h-44",
            )}
          >
            {approval.body}
          </blockquote>
        )}

        {approval.question && isPending && (
          <p className="text-foreground/80 mt-3 text-sm">{approval.question}</p>
        )}

        {error && (
          <p role="alert" className="text-irreversible mt-3 text-sm">
            {error}
          </p>
        )}

        {isPending ? (
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
        ) : (
          <ResolvedStatus approval={approval} />
        )}
      </div>
    </section>
  );
}

function ResolvedStatus({ approval }: { approval: ApprovalView }) {
  const when = approval.settledAt ?? approval.decidedAt;
  const at = when ? ` ${formatWhen(when)}` : "";
  const sentVerb = approval.kind === "email" ? "Sent" : "Done";
  const line: Record<Exclude<ApprovalView["state"], "pending">, { icon: React.ReactNode; text: string; tone: string }> = {
    sending: {
      icon: <LoaderCircleIcon className="size-4 animate-spin" />,
      text: approval.kind === "email" ? "Sending…" : "Working on it…",
      tone: "text-muted-foreground",
    },
    sent: { icon: <CheckIcon className="text-live size-4" />, text: `${sentVerb}${at}`, tone: "text-foreground/80" },
    declined: {
      icon: <CircleSlashIcon className="size-4" />,
      text: approval.kind === "email" ? "Not sent — you declined" : "Not done — you declined",
      tone: "text-muted-foreground",
    },
    failed: {
      icon: <TriangleAlertIcon className="text-irreversible size-4" />,
      text: approval.kind === "email" ? "Couldn't send" : "Couldn't finish this",
      tone: "text-irreversible",
    },
    uncertain: {
      icon: <LoaderCircleIcon className="size-4 animate-spin [animation-duration:2s]" />,
      text: "Checking whether it went through",
      tone: "text-muted-foreground",
    },
  };
  if (approval.state === "pending") return null;
  const { icon, text, tone } = line[approval.state];
  return (
    <p role="status" className={cn("mt-4 flex items-center gap-2 text-sm font-medium", tone)}>
      {icon}
      {text}
    </p>
  );
}

/** `data-approval` timeline part: the card for one effect, from live state. */
export function ApprovalPart({ data }: { data: TimelineApprovalData }) {
  const { state } = useAugust();
  const approval = state?.approvals.find((a) => a.effectId === data.effectId);
  if (!approval) return null;
  return <ApprovalCard key={`${approval.effectId}:${approval.proposalHash}`} approval={approval} />;
}

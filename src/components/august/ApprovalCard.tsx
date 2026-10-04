"use client";

import { useState } from "react";
import { CheckIcon, CircleSlashIcon, LoaderCircleIcon, TriangleAlertIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { ApprovalView, TimelineApprovalData } from "@/server/types/api";
import { EmailApprovalCard } from "./EmailApprovalCard";
import { formatWhen } from "./format";
import { useAugust } from "./useAugustState";

/**
 * Renders one frozen effect proposal exactly as persisted, where it appeared in
 * the conversation. Email effects get a composer (EmailApprovalCard). Other
 * effects: one line saying what will happen, the material fields, Approve /
 * Not now (approving posts the proposalHash shown here, so the server executes
 * precisely this card). Resolved: one status line.
 */
export function ApprovalCard({ approval }: { approval: ApprovalView }) {
  if (approval.kind === "email" && approval.email) {
    return <EmailApprovalCard approval={approval} email={approval.email} />;
  }
  return <EffectCard approval={approval} />;
}

function EffectCard({ approval }: { approval: ApprovalView }) {
  const { decide } = useAugust();
  const [pending, setPending] = useState<"approved" | "denied" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const isPending = approval.state === "pending";

  async function onDecide(decision: "approved" | "denied") {
    setPending(decision);
    setError(null);
    const result = await decide(approval, decision);
    if (!result.ok) {
      setError(result.error === "not_awaiting_approval" ? "This was already handled." : result.error);
      setPending(null);
    }
    // On success the card turns into its resolved state on the next refresh.
  }

  if (!isPending) {
    return (
      <section
        aria-label={approval.title}
        data-state={approval.state}
        className="bg-card text-card-foreground my-2 flex items-center gap-2 rounded-2xl border px-4 py-2.5 text-sm"
      >
        <ResolvedStatus approval={approval} />
        <span className="text-muted-foreground min-w-0 truncate">{approval.title}</span>
      </section>
    );
  }

  return (
    <section
      aria-label={`Approval needed: ${approval.title}`}
      data-effect-class={approval.effectClass}
      data-state={approval.state}
      className="bg-card text-card-foreground animate-in fade-in my-2 overflow-hidden rounded-2xl border px-4 pt-3.5 pb-4 shadow-sm duration-300"
    >
      <h3 className="text-[0.95rem] leading-snug font-medium">{approval.title}</h3>

      {approval.fields.length > 0 && (
        <dl className="mt-2.5 grid grid-cols-[minmax(4.5rem,max-content)_1fr] gap-x-4 gap-y-1 text-sm">
          {approval.fields.map((f, i) => (
            <div key={`${f.label}-${i}`} className="contents">
              <dt className="text-muted-foreground">{f.label}</dt>
              <dd className="min-w-0 break-words whitespace-pre-wrap">{f.value}</dd>
            </div>
          ))}
        </dl>
      )}

      {approval.body != null && approval.body !== "" && (
        <pre className="bg-muted mt-3 max-h-60 overflow-auto rounded-lg px-3 py-2 font-sans text-sm leading-relaxed break-words whitespace-pre-wrap">
          {approval.body}
        </pre>
      )}

      {approval.question && <p className="text-muted-foreground mt-3 text-sm">{approval.question}</p>}

      {approval.effectClass === "irreversible" && (
        <p className="text-irreversible mt-3 flex items-center gap-1.5 text-xs">
          <TriangleAlertIcon className="size-3.5" />
          This can&apos;t be undone.
        </p>
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
          {pending === "approved" && <LoaderCircleIcon className="animate-spin" />}
          Approve
        </Button>
        <Button
          size="lg"
          variant="ghost"
          className="text-muted-foreground rounded-full px-4"
          disabled={pending !== null}
          onClick={() => onDecide("denied")}
        >
          {pending === "denied" && <LoaderCircleIcon className="animate-spin" />}
          Not now
        </Button>
      </div>
    </section>
  );
}

function ResolvedStatus({ approval }: { approval: ApprovalView }) {
  const when = approval.settledAt ?? approval.decidedAt;
  const at = when ? ` ${formatWhen(when)}` : "";
  const line: Record<Exclude<ApprovalView["state"], "pending">, { icon: React.ReactNode; text: string; tone: string }> = {
    scheduled: {
      icon: <LoaderCircleIcon className="size-3.5" />,
      text: approval.scheduledFor ? `Scheduled for ${formatWhen(approval.scheduledFor)}` : "Scheduled",
      tone: "text-foreground/80",
    },
    sending: {
      icon: <LoaderCircleIcon className="size-3.5 animate-spin" />,
      text: "Working on it…",
      tone: "text-muted-foreground",
    },
    sent: { icon: <CheckIcon className="text-live size-3.5" />, text: `Done${at}`, tone: "text-foreground/80" },
    declined: { icon: <CircleSlashIcon className="size-3.5" />, text: "Not done", tone: "text-muted-foreground" },
    failed: {
      icon: <TriangleAlertIcon className="size-3.5" />,
      text: "Couldn't finish this",
      tone: "text-irreversible",
    },
    uncertain: {
      icon: <LoaderCircleIcon className="size-3.5 animate-spin [animation-duration:2s]" />,
      text: "Checking whether it went through",
      tone: "text-muted-foreground",
    },
  };
  if (approval.state === "pending") return null;
  const { icon, text, tone } = line[approval.state];
  return (
    <span role="status" className={cn("flex shrink-0 items-center gap-1.5 font-medium", tone)}>
      {icon}
      {text}
    </span>
  );
}

/**
 * `data-approval` timeline part: the card for one effect, from live state. If
 * the user edited it, the card shows the replacement they sent, in place.
 */
export function ApprovalPart({ data }: { data: TimelineApprovalData }) {
  const { state } = useAugust();
  const byId = new Map(state?.approvals.map((a) => [a.effectId, a]) ?? []);
  let approval = byId.get(data.effectId);
  for (let hops = 0; approval?.supersededBy && byId.has(approval.supersededBy) && hops < 5; hops++) {
    approval = byId.get(approval.supersededBy);
  }
  if (!approval) return null;
  return <ApprovalCard key={`${approval.effectId}:${approval.proposalHash}`} approval={approval} />;
}

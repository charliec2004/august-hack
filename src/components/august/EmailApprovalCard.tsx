"use client";

import { useId, useMemo, useRef, useState } from "react";
import { Menu } from "@base-ui/react/menu";
import {
  CheckIcon,
  ChevronDownIcon,
  CircleSlashIcon,
  ClockIcon,
  LoaderCircleIcon,
  TriangleAlertIcon,
  XIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { ApprovalEmail, ApprovalView } from "@/server/types/api";
import { formatWhen } from "./format";
import { useAugust, type DecisionResult } from "./useAugustState";

const EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

const ERRORS: Record<string, string> = {
  not_awaiting_approval: "This was already handled.",
  proposal_hash_mismatch: "This email changed since you opened it.",
  bad_recipients: "One of the recipients isn't a valid email address.",
  duplicate_of_existing_effect: "That exact email was already sent.",
  bad_send_at: "Pick a time in the future.",
  not_scheduled: "This already went out or was cancelled.",
  too_long: "This email is too long to send.",
};

function friendly(r: DecisionResult): string | null {
  if (r.ok) return null;
  return ERRORS[r.error] ?? (/\s/.test(r.error) ? r.error : "That didn't go through. Try again.");
}

const timeFmt = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });

/** Preset send-later times, in the user's local time. */
function sendLaterPresets(now = new Date()): { label: string; at: Date }[] {
  const inHour = new Date(now.getTime() + 3600_000);
  inHour.setSeconds(0, 0);
  const evening = new Date(now);
  evening.setHours(18, 0, 0, 0);
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  tomorrow.setHours(9, 0, 0, 0);
  return [
    { label: "In 1 hour", at: inHour },
    ...(evening.getTime() - now.getTime() > 30 * 60_000 ? [{ label: "This evening", at: evening }] : []),
    { label: "Tomorrow morning", at: tomorrow },
  ];
}

/** "2026-10-05T09:00" for a datetime-local input, in local time. */
function toLocalInput(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

function scheduledLabel(iso: string): string {
  const w = formatWhen(iso);
  return `Scheduled for ${w.replace(/^(Tomorrow|Yesterday)/, (m) => m.toLowerCase())}`;
}

/** Thin-divided row with an inline muted label, Gmail style. */
function Row({
  label,
  htmlFor,
  last = false,
  children,
}: {
  label: string;
  htmlFor?: string;
  last?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className={cn("flex min-h-10 items-center gap-3 px-4 py-1.5", !last && "border-border/60 border-b")}>
      <label htmlFor={htmlFor} className="text-muted-foreground w-14 shrink-0 text-sm">
        {label}
      </label>
      <div className="min-w-0 flex-1 text-sm">{children}</div>
    </div>
  );
}

function RecipientsInput({
  id,
  value,
  onChange,
  disabled,
}: {
  id: string;
  value: string[];
  onChange: (v: string[]) => void;
  disabled: boolean;
}) {
  const [draft, setDraft] = useState("");
  const commit = (raw: string) => {
    const parts = raw
      .split(/[,;\s]+/)
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    if (parts.length) onChange([...value, ...parts.filter((p) => !value.includes(p))]);
    setDraft("");
  };
  return (
    <div className="flex flex-wrap items-center gap-1">
      {value.map((addr) => (
        <span
          key={addr}
          className={cn(
            "inline-flex items-center gap-1 rounded-full py-px pr-1 pl-2.5 text-sm",
            EMAIL_RE.test(addr) ? "bg-muted" : "bg-irreversible/10 text-irreversible",
          )}
        >
          {addr}
          {!disabled && (
            <button
              type="button"
              aria-label={`Remove ${addr}`}
              className="text-muted-foreground hover:text-foreground rounded-full p-0.5"
              onClick={() => onChange(value.filter((a) => a !== addr))}
            >
              <XIcon className="size-3" />
            </button>
          )}
        </span>
      ))}
      {!disabled && (
        <input
          id={id}
          value={draft}
          inputMode="email"
          autoComplete="off"
          placeholder={value.length ? "" : "Recipients"}
          className="min-w-32 flex-1 bg-transparent py-0.5 outline-none"
          onChange={(e) => {
            const v = e.target.value;
            if (/[,;\s]$/.test(v)) commit(v);
            else setDraft(v);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && draft.trim()) {
              e.preventDefault();
              commit(draft);
            } else if (e.key === "Backspace" && !draft && value.length) {
              onChange(value.slice(0, -1));
            }
          }}
          onBlur={() => draft.trim() && commit(draft)}
          onPaste={(e) => {
            e.preventDefault();
            commit(draft + e.clipboardData.getData("text"));
          }}
        />
      )}
    </div>
  );
}

/** Pending email: an editable composer. Unedited Send approves the exact shown proposal. */
function Composer({ approval, email }: { approval: ApprovalView; email: ApprovalEmail }) {
  const { decide, revise } = useAugust();
  const ids = useId();
  const editable = approval.editable;
  const [to, setTo] = useState(email.to);
  const [subject, setSubject] = useState(email.subject);
  const [body, setBody] = useState(email.body);
  const [busy, setBusy] = useState<"send" | "discard" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [custom, setCustom] = useState("");
  const presets = useMemo(() => sendLaterPresets(), []);
  const customRef = useRef<HTMLInputElement>(null);

  const edited =
    to.join(",") !== email.to.join(",") || subject !== email.subject || body !== email.body;
  const valid = to.length > 0 && to.every((a) => EMAIL_RE.test(a)) && body.trim().length > 0;

  async function send(sendAt: Date | null) {
    setBusy("send");
    setError(null);
    const at = sendAt ? sendAt.toISOString() : null;
    const r = edited
      ? await revise(approval, { to, subject, body, sendAt: at })
      : await decide(approval, "approved", { sendAt: at });
    if (!r.ok) {
      setError(friendly(r));
      setBusy(null);
    }
  }

  async function discard() {
    setBusy("discard");
    setError(null);
    const r = await decide(approval, "denied");
    if (!r.ok) {
      setError(friendly(r));
      setBusy(null);
    }
  }

  const disabled = busy !== null;
  return (
    <>
      <Row label="From">
        <span className="text-foreground/80">{email.from}</span>
      </Row>
      <Row label="To" htmlFor={`${ids}-to`}>
        <RecipientsInput id={`${ids}-to`} value={to} onChange={setTo} disabled={!editable || disabled} />
      </Row>
      {email.cc.length > 0 && (
        <Row label="Cc">
          <span>{email.cc.join(", ")}</span>
        </Row>
      )}
      <Row label="Subject" htmlFor={`${ids}-subject`} last>
        {editable && !email.isReply ? (
          <input
            id={`${ids}-subject`}
            value={subject}
            disabled={disabled}
            maxLength={300}
            onChange={(e) => setSubject(e.target.value)}
            className="w-full bg-transparent font-medium outline-none"
          />
        ) : (
          <span className="font-medium">{subject}</span>
        )}
      </Row>
      <div className="px-4 pt-3 pb-1">
        {editable ? (
          <textarea
            aria-label="Message"
            value={body}
            disabled={disabled}
            onChange={(e) => setBody(e.target.value)}
            className="field-sizing-content block max-h-[28rem] min-h-24 w-full resize-none bg-transparent text-sm leading-relaxed outline-none"
          />
        ) : (
          <p className="max-h-[28rem] overflow-y-auto text-sm leading-relaxed break-words whitespace-pre-wrap">
            {body}
          </p>
        )}
      </div>

      {approval.effectClass === "irreversible" && (
        <p className="text-irreversible flex items-center gap-1.5 px-4 pt-1 text-xs">
          <TriangleAlertIcon className="size-3.5" />
          This can&apos;t be undone once sent.
        </p>
      )}
      {error && (
        <p role="alert" className="text-irreversible px-4 pt-2 text-sm">
          {error}
        </p>
      )}

      {picking && (
        <div className="flex flex-wrap items-center gap-2 px-4 pt-3">
          <input
            ref={customRef}
            type="datetime-local"
            aria-label="Send at"
            value={custom}
            min={toLocalInput(new Date())}
            onChange={(e) => setCustom(e.target.value)}
            className="border-input rounded-md border bg-transparent px-2 py-1 text-sm"
          />
          <Button
            size="sm"
            variant="outline"
            className="rounded-full"
            disabled={disabled || !valid || !custom}
            onClick={() => {
              const at = new Date(custom);
              if (at.getTime() <= Date.now()) setError(ERRORS.bad_send_at);
              else void send(at);
            }}
          >
            Schedule
          </Button>
          <Button size="sm" variant="ghost" className="rounded-full" onClick={() => setPicking(false)}>
            Cancel
          </Button>
        </div>
      )}

      <div className="flex items-center gap-2 px-4 pt-3 pb-4">
        <div className="flex items-center">
          <Button
            size="lg"
            className="min-w-20 rounded-l-full rounded-r-none pr-3 pl-4"
            disabled={disabled || !valid}
            onClick={() => send(null)}
          >
            {busy === "send" && <LoaderCircleIcon className="animate-spin" />}
            {busy === "send" ? "Sending" : "Send"}
          </Button>
          <Menu.Root>
            <Menu.Trigger
              aria-label="Send later"
              disabled={disabled || !valid}
              render={
                <Button
                  size="lg"
                  className="border-primary-foreground/20 rounded-l-none rounded-r-full border-l pr-3 pl-2"
                />
              }
            >
              <ChevronDownIcon />
            </Menu.Trigger>
            <Menu.Portal>
              <Menu.Positioner side="bottom" align="start" sideOffset={6} className="isolate z-50">
                <Menu.Popup className="bg-popover text-popover-foreground min-w-56 rounded-xl border p-1 text-sm shadow-lg outline-none">
                  <p className="text-muted-foreground px-2.5 pt-1.5 pb-1 text-xs">Send later</p>
                  {presets.map((p) => (
                    <Menu.Item
                      key={p.label}
                      onClick={() => send(p.at)}
                      className="data-highlighted:bg-muted flex cursor-default items-center justify-between gap-6 rounded-lg px-2.5 py-1.5 outline-none"
                    >
                      <span>{p.label}</span>
                      <span className="text-muted-foreground">
                        {formatWhen(p.at.toISOString()).replace(/^Tomorrow /, "")}
                      </span>
                    </Menu.Item>
                  ))}
                  <Menu.Item
                    onClick={() => {
                      setCustom(toLocalInput(presets[presets.length - 1].at));
                      setPicking(true);
                      setTimeout(() => customRef.current?.focus(), 0);
                    }}
                    className="data-highlighted:bg-muted flex cursor-default items-center gap-2 rounded-lg px-2.5 py-1.5 outline-none"
                  >
                    Pick date &amp; time…
                  </Menu.Item>
                </Menu.Popup>
              </Menu.Positioner>
            </Menu.Portal>
          </Menu.Root>
        </div>
        <Button
          size="lg"
          variant="ghost"
          className="text-muted-foreground ml-auto rounded-full px-3"
          disabled={disabled}
          onClick={discard}
        >
          {busy === "discard" && <LoaderCircleIcon className="animate-spin" />}
          Discard
        </Button>
      </div>
    </>
  );
}

/** Settled or scheduled email: one line (status, subject), expandable to the full email. */
function SentEmail({ approval, email }: { approval: ApprovalView; email: ApprovalEmail }) {
  const { cancelSchedule, sendNow } = useAugust();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<"cancel" | "now" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const status = statusFor(approval);

  async function act(kind: "cancel" | "now") {
    setBusy(kind);
    setError(null);
    const r = kind === "cancel" ? await cancelSchedule(approval) : await sendNow(approval);
    if (!r.ok) setError(friendly(r));
    setBusy(null);
  }

  return (
    <div className="px-4 py-2.5">
      <div className="flex items-center gap-3">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className="flex min-w-0 flex-1 items-center gap-2 text-left text-sm"
        >
          <span role="status" className={cn("flex shrink-0 items-center gap-1.5 font-medium", status.tone)}>
            {status.icon}
            {status.text}
          </span>
          <span className="text-muted-foreground min-w-0 truncate">
            {email.subject || "(no subject)"} to {email.to.join(", ")}
          </span>
          <ChevronDownIcon
            className={cn("text-muted-foreground ml-auto size-4 shrink-0 transition-transform", open && "rotate-180")}
          />
        </button>
        {approval.state === "scheduled" && (
          <div className="flex shrink-0 items-center gap-1">
            <Button size="sm" variant="ghost" className="rounded-full" disabled={busy !== null} onClick={() => act("now")}>
              {busy === "now" && <LoaderCircleIcon className="animate-spin" />}
              Send now
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="text-muted-foreground rounded-full"
              disabled={busy !== null}
              onClick={() => act("cancel")}
            >
              {busy === "cancel" && <LoaderCircleIcon className="animate-spin" />}
              Cancel
            </Button>
          </div>
        )}
      </div>
      {open && (
        <div className="text-sm">
          <p className="text-muted-foreground mt-2">
            To <span className="text-foreground">{email.to.join(", ")}</span>
          </p>
          <p className="mt-0.5 font-medium">{email.subject}</p>
          <p className="text-foreground/90 mt-2 max-h-96 overflow-y-auto leading-relaxed break-words whitespace-pre-wrap">
            {email.body}
          </p>
        </div>
      )}
      {error && (
        <p role="alert" className="text-irreversible mt-2 text-sm">
          {error}
        </p>
      )}
    </div>
  );
}

function statusFor(a: ApprovalView): { icon: React.ReactNode; text: string; tone: string } {
  const when = a.settledAt ?? a.decidedAt;
  switch (a.state) {
    case "scheduled":
      return {
        icon: <ClockIcon className="size-3.5" />,
        text: a.scheduledFor ? scheduledLabel(a.scheduledFor) : "Scheduled",
        tone: "text-foreground/80",
      };
    case "sending":
      return { icon: <LoaderCircleIcon className="size-3.5 animate-spin" />, text: "Sending…", tone: "text-muted-foreground" };
    case "sent":
      return {
        icon: <CheckIcon className="text-live size-3.5" />,
        text: when ? `Sent ${timeFmt.format(new Date(when))}` : "Sent",
        tone: "text-muted-foreground",
      };
    case "declined":
      return { icon: <CircleSlashIcon className="size-3.5" />, text: "Discarded", tone: "text-muted-foreground" };
    case "failed":
      return { icon: <TriangleAlertIcon className="size-3.5" />, text: "Couldn't send", tone: "text-irreversible" };
    case "uncertain":
      return {
        icon: <LoaderCircleIcon className="size-3.5 animate-spin [animation-duration:2s]" />,
        text: "Checking whether it went through",
        tone: "text-muted-foreground",
      };
    default:
      return { icon: null, text: "", tone: "" };
  }
}

/** An email effect: composer while pending, compact record once decided. */
export function EmailApprovalCard({ approval, email }: { approval: ApprovalView; email: ApprovalEmail }) {
  const pending = approval.state === "pending";
  return (
    <section
      aria-label={pending ? "Email to review" : "Email"}
      data-state={approval.state}
      className={cn(
        "bg-card text-card-foreground animate-in fade-in my-2 overflow-hidden rounded-2xl border duration-300",
        pending ? "shadow-sm" : "shadow-none",
      )}
    >
      {pending ? <Composer approval={approval} email={email} /> : <SentEmail approval={approval} email={email} />}
    </section>
  );
}

"use client";

import { useState } from "react";
import { KeyRoundIcon, LoaderCircleIcon, LockIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { SavedLogin } from "@/server/types/api";
import { normalizeLoginOrigin } from "@/server/vault/origin";
import { formatWhen } from "./format";
import { PanelSection, SidePanel, SidePanelHeader } from "./SidePanel";
import { useFetched } from "./useFetched";

const STATUS: Record<SavedLogin["status"], string> = {
  ready: "Ready",
  pending: "Saving",
  failed: "Couldn't save",
};

const inputClass =
  "border-input bg-background focus-visible:ring-ring/50 h-9 w-full rounded-lg border px-3 text-sm outline-none placeholder:text-muted-foreground/70 focus-visible:ring-2";

/** Saved website logins (the vault). Secrets go in once and never come back. */
export function LoginsPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { data, error, loading, reload } = useFetched<{ logins: SavedLogin[] }>("/api/vault", open);
  const logins = data?.logins ?? [];

  return (
    <SidePanel open={open} onClose={onClose}>
      <SidePanelHeader
        title="Logins"
        subtitle="August signs in for you on these sites only. Passwords go straight to an encrypted vault; August never sees them."
      />
      <div className="flex-1 overflow-y-auto px-6 pt-4 pb-8">
        <div className="flex flex-col gap-8">
          <PanelSection title="Saved">
            {loading && !data ? (
              <ListSkeleton />
            ) : error ? (
              <p className="text-muted-foreground text-sm">{error}</p>
            ) : logins.length === 0 ? (
              <p className="text-muted-foreground text-sm leading-relaxed">
                No saved logins yet. Add one below and August can sign in there when a task needs it.
              </p>
            ) : (
              <ul className="flex flex-col divide-y">
                {logins.map((l) => (
                  <LoginRow key={l.id} login={l} onRemoved={reload} />
                ))}
              </ul>
            )}
          </PanelSection>
          <PanelSection title="Add a login">
            <AddLoginForm onAdded={reload} />
          </PanelSection>
        </div>
      </div>
    </SidePanel>
  );
}

function LoginRow({ login, onRemoved }: { login: SavedLogin; onRemoved: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sites = login.origins.map((o) => o.replace(/^https:\/\//, "")).join(", ");

  async function remove() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/vault/${encodeURIComponent(login.id)}`, { method: "DELETE" });
      if (!res.ok && res.status !== 404) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error || "Couldn't remove this login. Try again in a moment.");
      }
      onRemoved();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <li className="flex flex-col gap-2 py-3 first:pt-0">
      <div className="flex items-start gap-3">
        <span className="bg-muted text-muted-foreground mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full">
          <KeyRoundIcon className="size-3.5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{login.label}</p>
          {sites !== login.label && (
            <p className="text-muted-foreground truncate text-xs">{sites}</p>
          )}
          <p className="text-muted-foreground/80 mt-0.5 text-xs">
            {STATUS[login.status]} · added {formatWhen(login.createdAt)}
          </p>
        </div>
        {!confirming && (
          <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={() => setConfirming(true)}>
            Remove
          </Button>
        )}
      </div>
      {confirming && (
        <div className="bg-muted/50 flex flex-col gap-2 rounded-lg p-3">
          <p className="text-sm">August won&apos;t be able to sign in here anymore.</p>
          <div className="flex gap-2">
            <Button variant="destructive" size="sm" disabled={busy} onClick={remove}>
              {busy && <LoaderCircleIcon className="animate-spin" />}
              Remove login
            </Button>
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => setConfirming(false)}>
              Keep it
            </Button>
          </div>
        </div>
      )}
      {error && <p className="text-irreversible text-sm">{error}</p>}
    </li>
  );
}

/** Accepts "example.com/login" as well as full URLs; https only. */
function toUrl(input: string): string {
  const t = input.trim();
  if (!t) return "";
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(t) ? t : `https://${t}`;
}

function AddLoginForm({ onAdded }: { onAdded: () => void }) {
  const [site, setSite] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const url = toUrl(site);
  const origin = url ? normalizeLoginOrigin(url) : null;
  const canSubmit = origin !== null && username.trim() !== "" && password !== "" && !busy;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/vault", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ origin: url, username, password, label: label.trim() || undefined }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error || "Couldn't save this login. Try again in a moment.");
      }
      setSite("");
      setUsername("");
      setPassword("");
      setLabel("");
      onAdded();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} autoComplete="off" className="flex flex-col gap-3">
      <Field label="Website">
        <input
          className={inputClass}
          value={site}
          onChange={(e) => setSite(e.target.value)}
          placeholder="https://example.com/login"
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
        />
        {site.trim() !== "" && (
          <span className="text-muted-foreground mt-1 flex items-center gap-1.5 text-xs">
            {origin ? (
              <>
                <LockIcon className="size-3" />
                Only used on {origin}
              </>
            ) : (
              "Enter an https:// website address."
            )}
          </span>
        )}
      </Field>
      <Field label="Username or email">
        <input
          className={inputClass}
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          autoComplete="off"
          spellCheck={false}
        />
      </Field>
      <Field label="Password">
        <input
          className={inputClass}
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="off"
        />
      </Field>
      <Field label="Label (optional)">
        <input
          className={inputClass}
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder={origin ? new URL(origin).hostname : "e.g. Airline account"}
          autoComplete="off"
        />
      </Field>
      {error && <p className="text-irreversible text-sm">{error}</p>}
      <Button type="submit" className="self-start rounded-full" disabled={!canSubmit}>
        {busy && <LoaderCircleIcon className="animate-spin" />}
        Add login
      </Button>
    </form>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-muted-foreground text-xs">{label}</span>
      {children}
    </label>
  );
}

export function ListSkeleton() {
  return (
    <div className="flex flex-col gap-3" aria-hidden>
      {[0, 1].map((i) => (
        <div key={i} className="flex items-center gap-3">
          <div className="bg-muted size-8 animate-pulse rounded-full" />
          <div className="flex flex-1 flex-col gap-1.5">
            <div className="bg-muted h-3.5 w-1/2 animate-pulse rounded" />
            <div className="bg-muted/70 h-3 w-1/3 animate-pulse rounded" />
          </div>
        </div>
      ))}
    </div>
  );
}

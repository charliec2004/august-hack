"use client";

import { useState } from "react";
import { LoaderCircleIcon, TerminalIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { ToolLogin } from "@/server/types/api";
import { formatWhen } from "./format";
import { useFetched } from "./useFetched";

const inputClass =
  "border-input bg-background focus-visible:ring-ring/50 h-9 w-full rounded-lg border px-3 text-sm outline-none placeholder:text-muted-foreground/70 focus-visible:ring-2";

/** CLI logins for tools in the user's environment. Values are write-only. */
export function ToolLogins({ open }: { open: boolean }) {
  const { data, error, loading, reload } = useFetched<{ tools: ToolLogin[] }>("/api/tool-credentials", open);
  const tools = data?.tools ?? [];
  if (loading && !data) return null;
  if (error) return <p className="text-muted-foreground text-sm">{error}</p>;
  if (tools.length === 0) return <p className="text-muted-foreground text-sm">No tools need a login.</p>;
  return (
    <ul className="flex flex-col divide-y">
      {tools.map((t) => (
        <ToolRow key={t.toolKey} tool={t} onChanged={reload} />
      ))}
    </ul>
  );
}

function ToolRow({ tool, onChanged }: { tool: ToolLogin; onChanged: () => void }) {
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = tool.updatedAt !== null;

  async function remove() {
    setBusy(true);
    setError(null);
    const res = await fetch(`/api/tool-credentials/${encodeURIComponent(tool.toolKey)}`, { method: "DELETE" }).catch(() => null);
    setBusy(false);
    if (!res || (!res.ok && res.status !== 404)) return setError("Couldn't remove this login.");
    onChanged();
  }

  return (
    <li className="flex flex-col gap-2 py-3 first:pt-0">
      <div className="flex items-start gap-3">
        <span className="bg-muted text-muted-foreground mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full">
          <TerminalIcon className="size-3.5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{tool.toolKey}</p>
          <p className="text-muted-foreground/80 mt-0.5 text-xs">
            {set ? `Set · ${formatWhen(tool.updatedAt!)}` : "Not set"}
            {tool.auth === null && " · no longer installed"}
          </p>
        </div>
        {!editing && tool.auth && (
          <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={() => setEditing(true)}>
            {set ? "Update" : "Set"}
          </Button>
        )}
        {!editing && set && (
          <Button variant="ghost" size="sm" className="text-muted-foreground" disabled={busy} onClick={remove}>
            {busy && <LoaderCircleIcon className="animate-spin" />}
            Remove
          </Button>
        )}
      </div>
      {editing && tool.auth && (
        <ToolLoginForm
          tool={tool}
          auth={tool.auth}
          onDone={(saved) => {
            setEditing(false);
            if (saved) onChanged();
          }}
        />
      )}
      {error && <p className="text-irreversible text-sm">{error}</p>}
    </li>
  );
}

function ToolLoginForm({
  tool,
  auth,
  onDone,
}: {
  tool: ToolLogin;
  auth: NonNullable<ToolLogin["auth"]>;
  onDone: (saved: boolean) => void;
}) {
  const [env, setEnv] = useState<Record<string, string>>({});
  const [file, setFile] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const complete = auth.kind === "env" ? auth.vars.every((v) => (env[v] ?? "").trim() !== "") : file.trim() !== "";

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!complete || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/tool-credentials/${encodeURIComponent(tool.toolKey)}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(auth.kind === "env" ? { env } : { file }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error || "Couldn't save this login.");
      }
      onDone(true);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} autoComplete="off" className="bg-muted/50 flex flex-col gap-3 rounded-lg p-3">
      {auth.kind === "env" ? (
        auth.vars.map((name) => (
          <label key={name} className="flex flex-col gap-1">
            <span className="text-muted-foreground font-mono text-xs">{name}</span>
            <input
              className={inputClass}
              type="password"
              value={env[name] ?? ""}
              onChange={(e) => setEnv((prev) => ({ ...prev, [name]: e.target.value }))}
              autoComplete="off"
            />
          </label>
        ))
      ) : (
        <label className="flex flex-col gap-1">
          <span className="text-muted-foreground font-mono text-xs">~/{auth.path}</span>
          <textarea
            className={`${inputClass} h-28 py-2 font-mono text-xs`}
            value={file}
            onChange={(e) => setFile(e.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
        </label>
      )}
      {error && <p className="text-irreversible text-sm">{error}</p>}
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={!complete || busy}>
          {busy && <LoaderCircleIcon className="animate-spin" />}
          Save
        </Button>
        <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => onDone(false)}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

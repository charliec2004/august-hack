"use client";

import { useState } from "react";
import { LoaderCircleIcon, PlayIcon, RotateCcwIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { ResponsibilityView } from "@/server/types/api";
import { isFinished, sortResponsibilities } from "./format";
import { useAugust } from "./useAugustState";

/**
 * Development/demo-only triggers. Both call real server endpoints; nothing here
 * changes client state on its own. Rendered only when state.demoControls.
 */
export function DemoControls({
  responsibilities,
}: {
  responsibilities: ResponsibilityView[];
}) {
  const { resetDemo } = useAugust();
  const open = sortResponsibilities(responsibilities).filter(
    (r) => !isFinished(r),
  );
  const [picked, setPicked] = useState<string>("");
  const [confirmReset, setConfirmReset] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const target = open.find((r) => r.id === picked) ?? open[0];

  async function onReset() {
    setBusy(true);
    setError(null);
    const result = await resetDemo();
    setBusy(false);
    setConfirmReset(false);
    if (!result.ok) setError(result.error);
  }

  return (
    <div className="border-sidebar-border mx-3 mb-3 rounded-xl border border-dashed p-3">
      <p className="text-muted-foreground mb-2 text-[11px] font-semibold tracking-[0.12em] uppercase">
        Demo
      </p>
      {target && (
        <div className="mb-2 flex flex-col gap-1.5">
          {open.length > 1 && (
            <select
              aria-label="Which item"
              value={target.id}
              onChange={(e) => setPicked(e.target.value)}
              className="border-input bg-background focus-visible:ring-ring/50 h-7 w-full rounded-md border px-2 text-xs outline-none focus-visible:ring-2"
            >
              {open.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.title}
                </option>
              ))}
            </select>
          )}
          <WakeButton responsibilityId={target.id} className="w-full" />
        </div>
      )}
      {confirmReset ? (
        <div className="flex items-center gap-1.5">
          <Button
            size="sm"
            variant="destructive"
            className="flex-1"
            disabled={busy}
            onClick={onReset}
          >
            {busy && <LoaderCircleIcon className="animate-spin" />}
            Reset everything
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => setConfirmReset(false)}
          >
            Keep
          </Button>
        </div>
      ) : (
        <Button
          size="sm"
          variant="ghost"
          className="text-muted-foreground w-full justify-start"
          onClick={() => setConfirmReset(true)}
        >
          <RotateCcwIcon />
          Reset demo
        </Button>
      )}
      {error && <p className="text-irreversible mt-1.5 text-xs">{error}</p>}
    </div>
  );
}

export function WakeButton({
  responsibilityId,
  className,
}: {
  responsibilityId: string;
  className?: string;
}) {
  const { wake } = useAugust();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onWake() {
    setBusy(true);
    setError(null);
    const result = await wake(responsibilityId);
    setBusy(false);
    if (!result.ok) setError(result.error);
  }

  return (
    <>
      <Button
        size="sm"
        variant="outline"
        className={className}
        disabled={busy}
        onClick={onWake}
      >
        {busy ? <LoaderCircleIcon className="animate-spin" /> : <PlayIcon />}
        Run next check now
      </Button>
      {error && <p className="text-irreversible text-xs">{error}</p>}
    </>
  );
}

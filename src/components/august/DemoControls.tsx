"use client";

import { useState } from "react";
import { LoaderCircleIcon, RotateCcwIcon } from "lucide-react";
import { useAugust } from "./useAugustState";

/** Demo rehearsal only (?demo): wipe the demo user's rows and start fresh. */
export function DemoControls() {
  const { resetDemo } = useAugust();
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onReset() {
    setBusy(true);
    setError(null);
    const result = await resetDemo();
    setBusy(false);
    setConfirm(false);
    if (!result.ok) setError(result.error);
  }

  return (
    <div className="px-5 pb-4">
      {confirm ? (
        <div className="flex items-center gap-3 text-xs">
          <button type="button" disabled={busy} onClick={onReset} className="text-irreversible inline-flex items-center gap-1.5">
            {busy && <LoaderCircleIcon className="size-3 animate-spin" />}
            Reset everything
          </button>
          <button type="button" disabled={busy} onClick={() => setConfirm(false)} className="text-muted-foreground">
            Keep
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setConfirm(true)}
          className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1.5 text-xs transition-colors"
        >
          <RotateCcwIcon className="size-3" />
          Reset
        </button>
      )}
      {error && <p className="text-irreversible mt-1.5 text-xs">{error}</p>}
    </div>
  );
}

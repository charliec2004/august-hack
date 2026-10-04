"use client";

import { useHistory } from "./history";

/** Quiet link at the top of the thread to page back through the conversation. */
export function LoadEarlier() {
  const { hasEarlier, loadEarlier } = useHistory();
  if (!hasEarlier) return null;
  return (
    <div className="flex justify-center py-3">
      <button
        type="button"
        onClick={loadEarlier}
        className="text-muted-foreground hover:text-foreground text-sm transition-colors"
      >
        Show earlier
      </button>
    </div>
  );
}

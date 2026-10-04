"use client";

import { create } from "zustand";

/** How much of the forever conversation the thread has loaded. */
type HistoryState = {
  limit: number;
  hasEarlier: boolean;
  /** Bumped to force a reload after `limit` grows. */
  nonce: number;
  setHasEarlier: (v: boolean) => void;
  loadEarlier: () => void;
};

const PAGE = 60;

export const useHistory = create<HistoryState>((set) => ({
  limit: PAGE,
  hasEarlier: false,
  nonce: 0,
  setHasEarlier: (hasEarlier) => set({ hasEarlier }),
  loadEarlier: () => set((s) => ({ limit: s.limit + PAGE, nonce: s.nonce + 1 })),
}));

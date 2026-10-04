import "server-only";

import type { AuthorizedEffect, DispatchResult } from "./types";

/**
 * provider.action -> adapter. Only execute.ts calls dispatch(); integration
 * modules never execute mutations on their own (spec 10: one gateway per side effect).
 */
export type Dispatcher = {
  dispatch: (effect: AuthorizedEffect) => Promise<DispatchResult>;
  /**
   * Readback for uncertain outcomes. Returns a settled result if provider state
   * proves success or absence, or null if still ambiguous.
   */
  readback?: (effect: AuthorizedEffect) => Promise<DispatchResult | null>;
};

const dispatchers = new Map<string, Dispatcher>();

export function registerDispatcher(key: string, d: Dispatcher) {
  dispatchers.set(key.toLowerCase(), d);
}

export function getDispatcher(provider: string, action: string): Dispatcher | undefined {
  return dispatchers.get(`${provider}.${action}`.toLowerCase());
}

"use client";

import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type {
  ApprovalView,
  AugustState,
  ResponsibilityDetail,
} from "@/server/types/api";

/**
 * Client view of August's server state. The UI renders only what GET /api/state
 * returns; nothing here simulates progress. `?mock=1` swaps in local fixtures
 * for design work and screenshots, and is never used without the flag.
 */

const POLL_MS = 2000;

export type Connection =
  /** First load has not come back yet. */
  | "connecting"
  /** The last poll succeeded. */
  | "live"
  /** The server answered but August's state endpoint is not there yet. */
  | "unavailable"
  /** The last poll failed (network or 5xx); still retrying. */
  | "reconnecting";

export type DecisionResult = { ok: true } | { ok: false; error: string };

export type EmailEditInput = {
  to: string[];
  subject: string;
  body: string;
  sendAt?: string | null;
};

export type AugustStore = {
  state: AugustState | null;
  connection: Connection;
  mock: boolean;
  refresh: () => Promise<void>;
  decide: (
    approval: ApprovalView,
    decision: "approved" | "denied",
    opts?: { sendAt?: string | null },
  ) => Promise<DecisionResult>;
  /** Send the user's edited email (a new user-authored effect replaces the shown one). */
  revise: (approval: ApprovalView, edit: EmailEditInput) => Promise<DecisionResult>;
  cancelSchedule: (approval: ApprovalView) => Promise<DecisionResult>;
  sendNow: (approval: ApprovalView) => Promise<DecisionResult>;
  cancel: (responsibilityId: string) => Promise<DecisionResult>;
  loadDetail: (responsibilityId: string) => Promise<ResponsibilityDetail | null>;
  wake: (responsibilityId: string) => Promise<DecisionResult>;
  resetDemo: () => Promise<DecisionResult>;
};

const AugustContext = createContext<AugustStore | null>(null);

export function useAugust(): AugustStore {
  const store = useContext(AugustContext);
  if (!store) throw new Error("useAugust must be used inside AugustProvider");
  return store;
}

async function readError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: unknown };
    if (typeof body.error === "string" && body.error) return body.error;
  } catch {
    // fall through
  }
  return res.status === 409
    ? "This changed since you saw it."
    : "That didn't go through. Try again in a moment.";
}

async function post(url: string, body?: unknown): Promise<DecisionResult> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.ok) return { ok: true };
    return { ok: false, error: await readError(res) };
  } catch {
    return { ok: false, error: "Couldn't reach August. Check your connection." };
  }
}

const noopSubscribe = () => () => {};
const readMockFlag = () =>
  new URLSearchParams(window.location.search).get("mock") === "1";

export function useAugustState(): AugustStore {
  // False on the server and during hydration; true only with ?mock=1.
  const mock = useSyncExternalStore(noopSubscribe, readMockFlag, () => false);
  const [serverState, setState] = useState<AugustState | null>(null);
  const [serverConnection, setConnection] = useState<Connection>("connecting");
  const [mockData, setMockData] = useState<AugustState | null>(null);
  const inflight = useRef<AbortController | null>(null);
  const mockRef = useRef(mock);
  useEffect(() => {
    mockRef.current = mock;
  }, [mock]);

  const fixtures = useMemo(() => (mock ? mockState() : null), [mock]);
  const state = mock ? (mockData ?? fixtures) : serverState;
  const connection: Connection = mock ? "live" : serverConnection;

  const refresh = useCallback(async () => {
    if (mockRef.current) return;
    inflight.current?.abort();
    const ctrl = new AbortController();
    inflight.current = ctrl;
    try {
      const res = await fetch("/api/state", {
        cache: "no-store",
        signal: ctrl.signal,
      });
      if (res.status === 404) {
        setConnection("unavailable");
        return;
      }
      if (!res.ok) {
        setConnection("reconnecting");
        return;
      }
      const next = (await res.json()) as AugustState;
      setState(next);
      setConnection("live");
    } catch (err) {
      if ((err as Error).name === "AbortError") return;
      setConnection("reconnecting");
    }
  }, []);

  // Poll while the tab is visible; refetch as soon as it becomes visible again.
  useEffect(() => {
    if (mock) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    const tick = async () => {
      if (document.visibilityState === "visible") await refresh();
      if (!stopped) timer = setTimeout(tick, POLL_MS);
    };
    void tick();
    const onVisible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      inflight.current?.abort();
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [mock, refresh]);

  /** Mock mode only: settle an approval locally. */
  const settleMock = useCallback(
    (effectId: string, patch: Partial<ApprovalView>) =>
      setMockData((prev) => {
        const s = prev ?? mockState();
        return {
          ...s,
          approvals: s.approvals.map((a) =>
            a.effectId === effectId ? { ...a, decidedAt: new Date().toISOString(), ...patch } : a,
          ),
        };
      }),
    [],
  );

  const decide = useCallback<AugustStore["decide"]>(
    async (approval, decision, opts) => {
      if (mockRef.current) {
        settleMock(approval.effectId, {
          state: decision === "denied" ? "declined" : opts?.sendAt ? "scheduled" : "sent",
          scheduledFor: opts?.sendAt ?? null,
          settledAt: opts?.sendAt ? null : new Date().toISOString(),
        });
        return { ok: true };
      }
      const result = await post(
        `/api/approvals/${encodeURIComponent(approval.effectId)}`,
        { decision, proposalHash: approval.proposalHash, sendAt: opts?.sendAt ?? null },
      );
      void refresh();
      return result;
    },
    [refresh, settleMock],
  );

  const revise = useCallback<AugustStore["revise"]>(
    async (approval, edit) => {
      if (mockRef.current) {
        settleMock(approval.effectId, {
          state: edit.sendAt ? "scheduled" : "sent",
          scheduledFor: edit.sendAt ?? null,
          settledAt: edit.sendAt ? null : new Date().toISOString(),
          email: approval.email && { ...approval.email, to: edit.to, subject: edit.subject, body: edit.body },
        });
        return { ok: true };
      }
      const result = await post(
        `/api/approvals/${encodeURIComponent(approval.effectId)}/revise`,
        {
          shownProposalHash: approval.proposalHash,
          to: edit.to,
          subject: edit.subject,
          body: edit.body,
          sendAt: edit.sendAt ?? null,
        },
      );
      void refresh();
      return result;
    },
    [refresh, settleMock],
  );

  const cancelSchedule = useCallback<AugustStore["cancelSchedule"]>(
    async (approval) => {
      if (mockRef.current) {
        settleMock(approval.effectId, { state: "declined" });
        return { ok: true };
      }
      const result = await post(
        `/api/approvals/${encodeURIComponent(approval.effectId)}/cancel-schedule`,
      );
      void refresh();
      return result;
    },
    [refresh, settleMock],
  );

  const sendNow = useCallback<AugustStore["sendNow"]>(
    async (approval) => {
      if (mockRef.current) {
        settleMock(approval.effectId, { state: "sent", settledAt: new Date().toISOString() });
        return { ok: true };
      }
      const result = await post(
        `/api/approvals/${encodeURIComponent(approval.effectId)}/send-now`,
      );
      void refresh();
      return result;
    },
    [refresh, settleMock],
  );

  const cancel = useCallback<AugustStore["cancel"]>(
    async (id) => {
      if (mockRef.current) return { ok: true };
      const result = await post(
        `/api/responsibilities/${encodeURIComponent(id)}/cancel`,
      );
      void refresh();
      return result;
    },
    [refresh],
  );

  const loadDetail = useCallback<AugustStore["loadDetail"]>(async (id) => {
    // Read the flag directly too: a deep-linked drawer can load before the ref syncs.
    if (mockRef.current || readMockFlag()) return mockDetail(id);
    try {
      const res = await fetch(
        `/api/responsibilities/${encodeURIComponent(id)}`,
        { cache: "no-store" },
      );
      if (!res.ok) return null;
      return (await res.json()) as ResponsibilityDetail;
    } catch {
      return null;
    }
  }, []);

  const wake = useCallback<AugustStore["wake"]>(
    async (id) => {
      if (mockRef.current) return { ok: true };
      const result = await post(`/api/demo/wake/${encodeURIComponent(id)}`);
      void refresh();
      return result;
    },
    [refresh],
  );

  const resetDemo = useCallback<AugustStore["resetDemo"]>(async () => {
    if (mockRef.current) return { ok: true };
    const result = await post("/api/demo/reset");
    void refresh();
    return result;
  }, [refresh]);

  return useMemo(
    () => ({
      state,
      connection,
      mock,
      refresh,
      decide,
      revise,
      cancelSchedule,
      sendNow,
      cancel,
      loadDetail,
      wake,
      resetDemo,
    }),
    [state, connection, mock, refresh, decide, revise, cancelSchedule, sendNow, cancel, loadDetail, wake, resetDemo],
  );
}

export function AugustProvider({ children }: { children: ReactNode }) {
  const store = useAugustState();
  return createElement(AugustContext.Provider, { value: store }, children);
}

/* ------------------------------------------------------------------------- */
/* Fixtures for ?mock=1 only.                                                 */
/* ------------------------------------------------------------------------- */

function minutesFromNow(m: number): string {
  return new Date(Date.now() + m * 60_000).toISOString();
}

function mockState(): AugustState {
  return {
    viewer: { name: "Charlie Conner", email: "charlieconner04@gmail.com" },
    serverTime: new Date().toISOString(),
    demoControls: true,
    latestMessageId: null,
    timelineVersion: "mock",
    liveBrowsers: [
      { sessionId: "run-refund", responsibilityId: "r-refund", liveViewUrl: "about:blank" },
    ],
    responsibilities: [
      {
        id: "r-dinner",
        title: "Dinner for two tonight",
        status: "waiting_user",
        humanStatus: "Needs you",
        nextWakeAt: null,
        waitingOn: null,
        active: false,
        liveViewUrl: null,
        updatedAt: minutesFromNow(-2),
      },
      {
        id: "r-refund",
        title: "Airline refund",
        status: "running",
        humanStatus: "Working on it",
        nextWakeAt: null,
        waitingOn: null,
        active: true,
        liveViewUrl: "about:blank",
        updatedAt: minutesFromNow(-1),
      },
      {
        id: "r-landlord",
        title: "Landlord about the leak",
        status: "waiting_external",
        humanStatus: "Waiting for reply",
        nextWakeAt: minutesFromNow(95),
        waitingOn: "Reply from Dana (landlord)",
        active: false,
        liveViewUrl: null,
        updatedAt: minutesFromNow(-40),
      },
      {
        id: "r-passport",
        title: "Passport renewal appointment",
        status: "scheduled",
        humanStatus: "Checking again later",
        nextWakeAt: minutesFromNow(60 * 20),
        waitingOn: null,
        active: false,
        liveViewUrl: null,
        updatedAt: minutesFromNow(-180),
      },
      {
        id: "r-gift",
        title: "Mom's birthday gift",
        status: "completed",
        humanStatus: "Done",
        nextWakeAt: null,
        waitingOn: null,
        active: false,
        liveViewUrl: null,
        updatedAt: minutesFromNow(-300),
      },
    ],
    approvals: [
      {
        effectId: "e-1",
        responsibilityId: "r-dinner",
        responsibilityTitle: "Dinner for two tonight",
        kind: "email",
        title: "Email: Table for two tonight",
        effectClass: "consequential",
        fields: [
          { label: "From", value: "august@agentmail.to" },
          { label: "To", value: "reservations@lula.example.com" },
          { label: "Subject", value: "Table for two tonight" },
        ],
        body:
          "Hi,\n\nDo you have any cancellations for two around 7 PM tonight? We're flexible between 6:30 and 8.\n\nThanks,\nCharlie",
        email: {
          from: "august@agentmail.to",
          to: ["reservations@lula.example.com"],
          cc: [],
          subject: "Table for two tonight",
          body:
            "Hi,\n\nDo you have any cancellations for two around 7 PM tonight? We're flexible between 6:30 and 8.\n\nThanks,\nCharlie",
          isReply: false,
        },
        editable: true,
        proposalHash: "mock-hash-1",
        question: null,
        createdAt: minutesFromNow(-2),
        state: "pending",
        scheduledFor: null,
        decidedAt: null,
        settledAt: null,
        supersededBy: null,
        supersedes: null,
      },
    ],
    activity: [
      { id: "a1", at: minutesFromNow(-14), responsibilityId: "r-dinner", text: "Read your calendar: free after 6 PM", browserSessionId: null },
      { id: "a2", at: minutesFromNow(-12), responsibilityId: "r-dinner", text: "Checked 5 restaurants near you", browserSessionId: null },
      { id: "a3", at: minutesFromNow(-9), responsibilityId: "r-dinner", text: "No open tables between 6:30 and 8 yet", browserSessionId: null },
      { id: "a4", at: minutesFromNow(-2), responsibilityId: "r-dinner", text: "Drafted a note to Lula asking about cancellations", browserSessionId: null },
      { id: "a5", at: minutesFromNow(-1), responsibilityId: "r-refund", text: "Checking the refund status on the airline site", browserSessionId: null },
    ],
  };
}

function mockDetail(id: string): ResponsibilityDetail | null {
  const base = mockState().responsibilities.find((r) => r.id === id);
  if (!base) return null;
  return {
    ...base,
    goal:
      id === "r-dinner"
        ? "Get a table for two tonight around 7 PM, somewhere walkable."
        : `Keep ${base.title.toLowerCase()} moving until it's resolved.`,
    successCriteria: [
      "A confirmed reservation between 6:30 and 8 PM",
      "Within a 15 minute walk",
    ],
    standing:
      "Lula is fully booked between 6:30 and 8:30, so I asked them about cancellations. I'll check again at 4 PM.",
    standingAt: minutesFromNow(-2),
    facts: ["Tonight", "7:00 PM", "Party of 2", "Under $120"],
    nextAction: "Wait for Lula to reply, then check again at 4 PM.",
    moments: [
      { id: "t1", at: minutesFromNow(-15), text: "Took on: Dinner for two tonight", key: true, count: 1 },
      { id: "t2", at: minutesFromNow(-12), text: "Searched the web", key: false, count: 3 },
      { id: "t3", at: minutesFromNow(-2), text: "Needs your approval", key: true, count: 1 },
    ],
    sources: [
      {
        key: "lula.example.com",
        label: "lula.example.com",
        items: [
          {
            id: "ev1",
            title: "Lula Osteria: reservations",
            url: "https://lula.example.com/reserve",
            summary: "Fully booked 6 to 8:30 PM; cancellations by email.",
            observedAt: minutesFromNow(-12),
          },
        ],
      },
    ],
  };
}

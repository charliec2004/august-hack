import "server-only";

import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { query } from "@/server/db/client";
import { trace } from "@/server/db/traces";
import { setLiveView } from "@/server/db/workers";
import { executeEffect } from "@/server/effects/execute";
import { prepareEffect } from "@/server/effects/prepare";
import type { EffectDraft } from "@/server/effects/types";
import { researchWeb } from "@/server/providers/exa";
import { calendarFreeBusy, executorRead } from "@/server/providers/executor";
import { browserPrepareCommit, browserRead } from "@/server/providers/kernel";
import { mailPrepareSend, mailReadThread } from "@/server/providers/agentmail";
import { prepareEnvironmentChange, getActiveEnvironment } from "@/server/computers/environment";
import {
  acquireComputer,
  prepareComputerExternal,
  releaseComputer,
  runOnComputer,
} from "@/server/computers/runtime";
import type { CapabilityName, WorkerReport } from "@/server/types/domain";

export type WorkerToolContext = {
  userId: string;
  responsibilityId: string;
  workerSessionId: string;
  runId: string;
  timezone: string;
  capabilities: CapabilityName[];
  maxToolCalls: number;
  onReport: (r: WorkerReport) => void;
};

/**
 * The Worker's semantic tool surface (spec 41.6). Capability-scoped per
 * assignment; mutations only via propose_* -> prepareEffect (one gateway).
 */
export function workerTools(ctx: WorkerToolContext) {
  let calls = 0;
  const has = (c: CapabilityName) => ctx.capabilities.includes(c);
  const budget = () => {
    calls += 1;
    if (calls > ctx.maxToolCalls) {
      throw new Error("Tool budget exhausted. Call report now with what you have.");
    }
  };

  /** Freeze -> review -> (execute now if authorized). */
  async function propose(draft: EffectDraft, purpose: string) {
    const prepared = await prepareEffect({
      userId: ctx.userId,
      responsibilityId: ctx.responsibilityId,
      workerSessionId: ctx.workerSessionId,
      draft,
    });
    if (prepared.status === "authorized") {
      const result = await executeEffect(ctx.userId, prepared.effectId);
      return {
        effectId: prepared.effectId,
        state: result ? result.outcome : "already_dispatched",
        summary: result?.safeSummary ?? "This exact action was already executed.",
        evidenceRefs: result?.evidenceRefs ?? [],
        note:
          result?.outcome === "uncertain"
            ? "Outcome uncertain. Do NOT retry; report waiting so it can be reconciled."
            : undefined,
      };
    }
    if (prepared.status === "waiting_approval") {
      return {
        effectId: prepared.effectId,
        state: "waiting_for_user_approval",
        summary: `The user must approve this ${purpose} first. Stop and report "waiting"; do not retry or work around it.`,
      };
    }
    return {
      effectId: prepared.effectId,
      state: "denied",
      summary: `Not allowed (${prepared.decision.reasonCode}). Do not attempt this again; choose another path or report.`,
    };
  }

  const tools: Record<string, ReturnType<typeof createTool>> = {};

  tools.report = createTool({
    id: "report",
    description: "Finish this run with a structured report for August. Call exactly once, last.",
    inputSchema: z.object({
      status: z.enum(["completed", "blocked", "waiting", "failed"]),
      summary: z.string().min(1).max(2000),
      evidenceRefs: z.array(z.string()).default([]),
      proposedEffectIds: z.array(z.string()).default([]),
      nextSuggestedAction: z.string().nullable().default(null),
      shouldWakeAt: z.string().nullable().default(null).describe("ISO time for the next check when waiting"),
      blocker: z.string().nullable().default(null).describe("One-line question for the user when blocked"),
    }),
    execute: async (r) => {
      ctx.onReport(r as WorkerReport);
      return { ok: true, note: "Report recorded. Stop now." };
    },
  });

  if (has("exa.search")) {
    tools.web_search = createTool({
      id: "web_search",
      description: "Search the open web (Exa). Returns compact highlights with evidence ids.",
      inputSchema: z.object({
        query: z.string().min(3).describe("Natural-language query including constraints (place, time, price)"),
        numResults: z.number().int().min(1).max(8).optional(),
      }),
      execute: async ({ query: q, numResults }) => {
        budget();
        return researchWeb({ userId: ctx.userId, responsibilityId: ctx.responsibilityId, query: q, numResults });
      },
    });
  }

  if (has("executor.read")) {
    tools.calendar_read = createTool({
      id: "calendar_read",
      description: "Read the user's own calendar for a day: events and free windows (local time).",
      inputSchema: z.object({ date: z.string().optional().describe("YYYY-MM-DD; default today") }),
      execute: async ({ date }) => {
        budget();
        return calendarFreeBusy({
          userId: ctx.userId,
          responsibilityId: ctx.responsibilityId,
          date,
          timezone: ctx.timezone,
        });
      },
    });
    tools.connected_app_read = createTool({
      id: "connected_app_read",
      description:
        "Read-only question to the user's connected apps (e.g. Google Calendar). Describe what to read; never use for changes.",
      inputSchema: z.object({ intent: z.string().min(5) }),
      execute: async ({ intent }) => {
        budget();
        return executorRead({
          userId: ctx.userId,
          responsibilityId: ctx.responsibilityId,
          intent,
          activityText: "Checked your apps",
        } as Parameters<typeof executorRead>[0]);
      },
    });
  }

  if (has("kernel.read")) {
    tools.browser_inspect = createTool({
      id: "browser_inspect",
      description:
        "Open a real browser on a URL and read the page (availability, prices, details). Read-only; never clicks commit buttons.",
      inputSchema: z.object({
        url: z.string().url(),
        instruction: z.string().optional().describe("What to look for on the page"),
      }),
      execute: async ({ url, instruction }) => {
        budget();
        return browserRead({
          userId: ctx.userId,
          responsibilityId: ctx.responsibilityId,
          url,
          instruction,
          onLiveView: async (liveUrl: string | null) => {
            await setLiveView(ctx.runId, liveUrl);
          },
        });
      },
    });
  }

  if (has("kernel.commit")) {
    tools.propose_browser_action = createTool({
      id: "propose_browser_action",
      description:
        "Propose a consequential website action (book, reserve, submit). Observes the material facts first; executes only if authorized.",
      inputSchema: z.object({
        url: z.string().url(),
        action: z.enum(["book", "submit_form"]),
        instruction: z.string().describe("Exactly what to fill and which final button to press"),
        expectedFacts: z
          .record(z.string(), z.unknown())
          .describe("Material facts you expect: business, date/time, party size, price, terms"),
      }),
      execute: async (args) => {
        budget();
        const draft = await browserPrepareCommit({
          userId: ctx.userId,
          responsibilityId: ctx.responsibilityId,
          ...args,
        } as Parameters<typeof browserPrepareCommit>[0]);
        if (!("provider" in draft)) return draft;
        return propose(draft, "booking");
      },
    });
  }

  if (has("agentmail.send")) {
    tools.propose_email = createTool({
      id: "propose_email",
      description:
        "Propose sending an email from August's own inbox to an outside party (business, landlord, vendor). Executes only if authorized.",
      inputSchema: z.object({
        to: z.array(z.string().email()).min(1),
        subject: z.string().min(1),
        text: z.string().min(1).describe("Complete plain-text body, signed as the user's assistant"),
        replyToMessageId: z.string().optional(),
      }),
      execute: async (args) => {
        budget();
        const draft = await mailPrepareSend(args);
        const res = await propose(draft, "email");
        if (res.state === "succeeded") await linkMailThread(ctx, res.effectId);
        return res;
      },
    });
  }

  if (has("agentmail.read")) {
    tools.email_read_thread = createTool({
      id: "email_read_thread",
      description: "Read an email thread in August's inbox linked to this responsibility.",
      inputSchema: z.object({ threadId: z.string() }),
      execute: async ({ threadId }) => {
        budget();
        const linked = await query(
          `select 1 from mail_threads where user_id = $1 and responsibility_id = $2 and provider_thread_id = $3`,
          [ctx.userId, ctx.responsibilityId, threadId],
        );
        if (!linked.rowCount) return { status: "blocked", safeSummary: "That thread isn't linked to this task." };
        return mailReadThread(threadId);
      },
    });
  }

  if (has("sprite.exec")) {
    tools.computer_run = createTool({
      id: "computer_run",
      description:
        "Run a shell command on your own isolated Linux computer for this task (files, scripts, CLIs the user has installed). Task-local only: never for ordering, sending, booking, or paying.",
      inputSchema: z.object({
        command: z.string().min(1),
        timeoutMs: z.number().int().min(1000).max(300_000).optional(),
      }),
      execute: async ({ command, timeoutMs }) => {
        budget();
        const lease = await acquireComputer({
          userId: ctx.userId,
          responsibilityId: ctx.responsibilityId,
          workerSessionId: ctx.workerSessionId,
        });
        if (!("leaseRef" in lease || "computerId" in lease)) return lease;
        return runOnComputer({ lease: lease as never, command, timeoutMs });
      },
    });
    tools.computer_environment = createTool({
      id: "computer_environment",
      description: "List the persistent tools installed for the user's computers.",
      inputSchema: z.object({}),
      execute: async () => {
        budget();
        const env = await getActiveEnvironment(ctx.userId);
        return { generation: env.generation, tools: env.manifest.tools };
      },
    });
    tools.computer_install_tool = createTool({
      id: "computer_install_tool",
      description:
        "Propose installing a tool persistently on all of the user's computers (npm package, or a setup command for a CLI). Requires review.",
      inputSchema: z.object({
        toolKey: z.string().regex(/^[a-z0-9][a-z0-9-]{0,40}$/),
        packageName: z.string().describe("npm package name, or '-' for a non-npm tool installed by setup"),
        packageVersion: z.string().describe("Exact version (e.g. 1.2.3), or a pinned version label for setup tools"),
        setup: z.string().optional().describe("Shell command that installs a non-npm tool into $PREFIX/bin"),
      }),
      execute: async (tool) => {
        budget();
        const draft = await prepareEnvironmentChange({ userId: ctx.userId, operation: "install", tool } as Parameters<
          typeof prepareEnvironmentChange
        >[0]);
        return propose(draft, "software install");
      },
    });
    tools.propose_computer_action = createTool({
      id: "propose_computer_action",
      description:
        "Propose a command on your computer that affects the outside world (e.g. a CLI that places an order or sends something). Executes the exact command only if authorized.",
      inputSchema: z.object({
        command: z.string().min(1),
        materialFacts: z
          .record(z.string(), z.unknown())
          .describe("What it will do in plain terms: merchant, items, total price, address, recipient"),
      }),
      execute: async ({ command, materialFacts }) => {
        budget();
        const lease = await acquireComputer({
          userId: ctx.userId,
          responsibilityId: ctx.responsibilityId,
          workerSessionId: ctx.workerSessionId,
        });
        if (!("leaseRef" in lease || "computerId" in lease)) return lease;
        const draft = await prepareComputerExternal({ lease: lease as never, command, materialFacts });
        return propose(draft, "computer action");
      },
    });
    tools.computer_release = createTool({
      id: "computer_release",
      description: "Release your computer when the task no longer needs it.",
      inputSchema: z.object({}),
      execute: async () => {
        const lease = await acquireComputer({
          userId: ctx.userId,
          responsibilityId: ctx.responsibilityId,
          workerSessionId: ctx.workerSessionId,
        });
        if (!("leaseRef" in lease || "computerId" in lease)) return lease;
        return releaseComputer(lease as never);
      },
    });
  }

  return tools;
}

/** After a successful send, map the provider thread to this responsibility. */
async function linkMailThread(ctx: WorkerToolContext, effectId: string) {
  const { rows } = await query<{ canonical_args: { fromInbox?: string }; provider_receipt_ref: string | null; payload: { threadId?: string } | null }>(
    `select e.canonical_args, r.provider_receipt_ref, ev.payload
       from effect_proposals e
       join effect_receipts r on r.effect_proposal_id = e.id
       left join evidence_records ev on ev.id::text = any(select jsonb_array_elements_text(r.evidence_refs))
      where e.id = $1 and e.user_id = $2
      order by r.created_at desc limit 1`,
    [effectId, ctx.userId],
  );
  const row = rows[0];
  const threadId = row?.payload?.threadId;
  const inbox = row?.canonical_args?.fromInbox ?? process.env.AGENTMAIL_INBOX_ID;
  if (!threadId || !inbox) return;
  await query(
    `insert into mail_threads (user_id, responsibility_id, inbox_id, provider_thread_id)
     values ($1, $2, $3, $4) on conflict (inbox_id, provider_thread_id) do nothing`,
    [ctx.userId, ctx.responsibilityId, inbox, threadId],
  );
  await query(
    `update responsibilities set waiting_on = 'mail:' || $3, updated_at = now() where user_id = $1 and id = $2`,
    [ctx.userId, ctx.responsibilityId, threadId],
  );
  await trace({
    userId: ctx.userId,
    responsibilityId: ctx.responsibilityId,
    kind: "tool.succeeded",
    detail: { text: "Waiting for a reply" },
  });
}

import "server-only";

import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { query } from "@/server/db/client";
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
        "Read-only TypeScript program run against the user's connected apps in Executor's sandbox. Use `tools.search({query})` and `tools.describe.tool({path})` to discover, then call read tools, e.g. `return await tools.google_calendar.user.personalGoogleCalendarApi.calendar.events.list({calendarId:'primary', timeMin, timeMax, singleEvents:true, orderBy:'startTime'})`. Never mutate.",
      inputSchema: z.object({ program: z.string().min(10).describe("Async function body; must `return` the result") }),
      execute: async ({ program }) => {
        budget();
        return executorRead({
          userId: ctx.userId,
          responsibilityId: ctx.responsibilityId,
          program,
          activityText: "Checked your apps",
        });
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
          onLiveView: async (liveUrl: string) => {
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
        "Propose a consequential website action (book, reserve, submit). The browser fills non-committing fields, reads the material facts from the page, and freezes them; the final click happens only if authorized and the facts are unchanged. Selectors are Playwright selectors (e.g. 'text=Reserve', 'button:has-text(\"Book\")', '#party-size').",
      inputSchema: z.object({
        url: z.string().url(),
        action: z.enum(["book", "submit_form"]),
        steps: z
          .array(z.union([z.object({ selector: z.string(), value: z.string() }), z.object({ click: z.string() })]))
          .default([])
          .describe("Non-committing steps: fill fields, open dialogs, pick a time"),
        commitSelector: z.string().optional().describe("The final committing control, if known"),
        commitText: z.string().optional().describe("Visible text of the final button, e.g. 'Reserve'"),
        factSelectors: z
          .record(z.string(), z.string())
          .optional()
          .describe("Named selectors whose text is a material fact: business, time, partySize, price, terms"),
        expectedFacts: z
          .record(z.string(), z.string())
          .optional()
          .describe("Material facts you expect to see on the page (used when selectors are unknown)"),
        confirmationSelector: z.string().optional(),
      }),
      execute: async (args) => {
        budget();
        const res = await browserPrepareCommit({
          userId: ctx.userId,
          responsibilityId: ctx.responsibilityId,
          ...args,
          onLiveView: async (liveUrl: string) => {
            await setLiveView(ctx.runId, liveUrl);
          },
        });
        if (res.status !== "succeeded" || !res.data) return res;
        return propose(res.data, "booking");
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
        return propose(draft, "email");
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
        return mailReadThread({ userId: ctx.userId, responsibilityId: ctx.responsibilityId, threadId });
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
        if (lease.status !== "succeeded" || !lease.data) return lease;
        return runOnComputer({ lease: lease.data, command, timeoutMs });
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
        if (lease.status !== "succeeded" || !lease.data) return lease;
        const draft = prepareComputerExternal({ lease: lease.data, command, materialFacts });
        return propose(draft, "computer action");
      },
    });
    tools.computer_release = createTool({
      id: "computer_release",
      description: "Release your computer when the task no longer needs it.",
      inputSchema: z.object({}),
      execute: async () => {
        const { rows } = await query<{ id: string; provider_ref: string; pinned_generation: number }>(
          `select id, provider_ref, pinned_generation from computers
            where user_id = $1 and worker_session_id = $2 and lifecycle in ('provisioning','running','dormant')
            limit 1`,
          [ctx.userId, ctx.workerSessionId],
        );
        const c = rows[0];
        if (!c) return { status: "succeeded", safeSummary: "No computer to release." };
        return releaseComputer({
          computerId: c.id,
          userId: ctx.userId,
          responsibilityId: ctx.responsibilityId,
          workerSessionId: ctx.workerSessionId,
          spriteName: c.provider_ref,
          pinnedGeneration: c.pinned_generation,
          reused: true,
        });
      },
    });
  }

  return tools;
}

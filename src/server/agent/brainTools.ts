import "server-only";

import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { tx } from "@/server/db/client";
import {
  createResponsibility,
  getResponsibility,
  listResponsibilities,
  transition,
  appendEvent,
} from "@/server/db/responsibilities";
import { trace } from "@/server/db/traces";
import { cancelResponsibility } from "@/server/orchestration/cancel";
import { kickResponsibility } from "@/server/orchestration/wakes";
import { uiTools } from "./uiTools";

export type BrainContext = {
  userId: string;
  threadId: string;
  /** The persisted authenticated user message that started this turn. */
  sourceMessageId: string;
};

/**
 * Brain Core's narrow internal tools (spec 6) plus generative UI tools. No
 * provider access here.
 */
export function brainTools(ctx: BrainContext) {
  const responsibility_create = createTool({
    id: "responsibility_create",
    description:
      "Take durable ownership of an outcome the user wants handled (research, booking, contacting someone, watching for something, checking again later). Starts background work immediately.",
    inputSchema: z.object({
      title: z.string().min(2).max(60).describe("Short label, e.g. 'Dinner tonight'"),
      goal: z.string().min(5).describe("The outcome in the user's terms"),
      successCriteria: z.array(z.string()).min(1).describe("Concrete, checkable conditions for done"),
      constraints: z
        .record(z.string(), z.unknown())
        .describe("Every constraint the user gave: budget, time, place, party size, approval requirements, people"),
      priority: z.enum(["low", "normal", "high"]).optional(),
    }),
    execute: async (input) => {
      const r = await createResponsibility({
        userId: ctx.userId,
        threadId: ctx.threadId,
        sourceMessageId: ctx.sourceMessageId,
        title: input.title,
        goal: input.goal,
        successCriteria: input.successCriteria,
        constraints: input.constraints,
        priority: input.priority,
        nextAction: "Start working on it",
      });
      await trace({
        userId: ctx.userId,
        responsibilityId: r.id,
        kind: "responsibility.created",
        detail: { text: `Took on: ${r.title}` },
      });
      await kickResponsibility({
        userId: ctx.userId,
        responsibilityId: r.id,
        source: "user",
        causeRef: `delegation:${ctx.sourceMessageId}`,
      });
      return { responsibilityId: r.id, status: "working" };
    },
  });

  const responsibility_update = createTool({
    id: "responsibility_update",
    description:
      "Add the user's new details, corrections, or answers to something August already owns. Resumes the work with the new information.",
    inputSchema: z.object({
      responsibilityId: z.string().uuid(),
      note: z.string().describe("What changed, in the user's terms"),
      constraints: z.record(z.string(), z.unknown()).optional().describe("Updated constraints to merge"),
    }),
    execute: async ({ responsibilityId, note, constraints }) => {
      const r = await getResponsibility(ctx.userId, responsibilityId);
      if (!r) return { ok: false, error: "not_found" };
      if (["completed", "failed", "cancelled"].includes(r.status)) return { ok: false, error: "already_closed" };
      await tx(async (c) => {
        if (constraints) {
          await c.query(
            `update responsibilities set constraints = constraints || $3::jsonb, updated_at = now()
              where user_id = $1 and id = $2`,
            [ctx.userId, responsibilityId, JSON.stringify(constraints)],
          );
        }
        await appendEvent(c, {
          userId: ctx.userId,
          responsibilityId,
          kind: "user_update",
          detail: { text: "You added details", note, messageId: ctx.sourceMessageId },
        });
        if (r.status === "waiting_user" && !r.waiting_on?.startsWith("approval:")) {
          await transition(c, { userId: ctx.userId, responsibilityId, to: "active", waitingOn: null, eventText: "Picking it back up" });
        }
      });
      await kickResponsibility({
        userId: ctx.userId,
        responsibilityId,
        source: "user",
        causeRef: `user_update:${ctx.sourceMessageId}`,
      });
      return { ok: true };
    },
  });

  const responsibility_list = createTool({
    id: "responsibility_list",
    description: "See what August currently owns for the user and each item's state.",
    inputSchema: z.object({}),
    execute: async () => {
      const rows = await listResponsibilities(ctx.userId);
      return rows.map((r) => ({
        id: r.id,
        title: r.title,
        status: r.status,
        waitingOn: r.waiting_on,
        nextCheck: r.next_wake_at?.toISOString() ?? null,
        nextAction: r.next_action,
      }));
    },
  });

  const responsibility_cancel = createTool({
    id: "responsibility_cancel",
    description: "Stop owning something because the user cancelled it or it no longer matters.",
    inputSchema: z.object({ responsibilityId: z.string().uuid(), reason: z.string() }),
    execute: async ({ responsibilityId, reason }) => ({
      ok: await cancelResponsibility(ctx.userId, responsibilityId, reason),
    }),
  });

  return {
    responsibility_create,
    responsibility_update,
    responsibility_list,
    responsibility_cancel,
    ...uiTools(),
  };
}

import "server-only";

import { generateText, Output } from "ai";
import { nanoid } from "nanoid";
import { z } from "zod";
import { query } from "@/server/db/client";
import { listEvidence } from "@/server/db/evidence";
import { ensurePrimaryThread, insertMessage } from "@/server/db/messages";
import { getResponsibility } from "@/server/db/responsibilities";
import { trace } from "@/server/db/traces";
import { gatewayProviderOptions, modelFor } from "@/server/agent/model";
import { BRAIN_DELIVERY_PROMPT } from "@/server/agent/prompts/brain";
import type { WorkerReport } from "@/server/types/domain";
import { describeUi, MINI_APP_MAX_HTML, type AskUser, type ShowChart } from "@/lib/genui";
import { vetGeneratedHtml } from "@/server/genui/vetHtml";

export type DeliveryKind = "completed" | "needs_approval" | "needs_input" | "failed" | "waiting";

/**
 * Brain Core owns final wording (spec 6). Workers never speak to the user; this
 * turns a worker report into at most one short message, and only when it is
 * worth interrupting for (spec 16 notification restraint).
 */
export async function deliverUpdate(input: {
  userId: string;
  responsibilityId: string;
  kind: DeliveryKind;
  report: WorkerReport;
}) {
  const { userId, responsibilityId, kind, report } = input;
  const last = await query<{ kind: string; summary: string }>(
    `select safe_detail->>'deliveryKind' as kind, safe_detail->>'summary' as summary
       from trace_events
      where user_id = $1 and responsibility_id = $2 and event_kind = 'brain.delivered'
      order by created_at desc limit 1`,
    [userId, responsibilityId],
  );
  const prev = last.rows[0];
  // Repeated identical waiting/failure is not new information.
  if (prev && prev.kind === kind && (kind === "waiting" || kind === "failed")) return;

  const resp = await getResponsibility(userId, responsibilityId);
  if (!resp) return;
  const { rows: u } = await query<{ timezone: string }>(`select timezone from app_users where id = $1`, [userId]);
  const tz = u[0]?.timezone ?? "UTC";
  const nextCheck = resp.next_wake_at
    ? resp.next_wake_at.toLocaleTimeString("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" })
    : null;

  const evidence = (await listEvidence(userId, responsibilityId)).slice(0, 12).map((e) => ({
    url: e.source_url,
    summary: e.safe_summary.slice(0, 600),
  }));
  const prompt = JSON.stringify({
    deliveryKind: kind,
    responsibility: { title: resp.title, goal: resp.goal, constraints: resp.constraints },
    workerReport: { status: report.status, summary: report.summary, blocker: report.blocker },
    evidence,
    nextCheckLocalTime: nextCheck,
  });
  // URLs the user may be shown: only ones that literally appear in what was found.
  const seen = [report.summary, ...evidence.map((e) => `${e.url ?? ""} ${e.summary}`)].join("\n");

  let text = "";
  let ui: DeliveryUi | null = null;
  try {
    const out = await generateText({
      model: modelFor("brain"),
      system: BRAIN_DELIVERY_PROMPT,
      prompt,
      output: Output.object({ schema: deliverySchema }),
      abortSignal: AbortSignal.timeout(45_000),
      providerOptions: gatewayProviderOptions,
    });
    text = out.output.text.trim();
    ui = await sanitizeUi(userId, out.output.ui, seen);
  } catch {
    try {
      const out = await generateText({
        model: modelFor("brain"),
        system: `${BRAIN_DELIVERY_PROMPT}\n\nOutput only the message text, with no ui.`,
        prompt,
        abortSignal: AbortSignal.timeout(30_000),
        providerOptions: gatewayProviderOptions,
      });
      text = out.text.trim();
    } catch {
      text = fallbackText(kind, resp.title, report, nextCheck);
    }
  }
  if (!text) return;

  const threadId = await ensurePrimaryThread(userId);
  const msg = await insertMessage({
    threadId,
    userId,
    role: "assistant",
    // The model's history sees what the cards showed (so "I choose: X" resolves).
    content: ui ? `${text}\n\n${describeUi(ui.kind === "html" ? { html: { ...ui.data, height: null } } : { [ui.kind]: ui.data })}` : text,
    // Interactive cards get a stable id so only a submission of this card resolves it.
    parts: [{ type: "text", text }, ...(ui ? [{ type: `data-${ui.kind}`, data: { id: `card_${nanoid(12)}`, ...ui.data } }] : [])],
    responsibilityId,
  });
  await trace({
    userId,
    responsibilityId,
    kind: "brain.delivered",
    detail: { deliveryKind: kind, messageId: msg.id, summary: report.summary.slice(0, 200) },
  });
}

function fallbackText(kind: DeliveryKind, title: string, report: WorkerReport, nextCheck: string | null) {
  switch (kind) {
    case "completed":
      return `${title}: done. ${report.summary}`;
    case "needs_approval":
      return `${title}: I have something ready. It needs your OK before I go ahead.`;
    case "needs_input":
      return report.blocker ?? `${title}: I need a quick answer from you to keep going.`;
    case "failed":
      return `${title}: I couldn't find a safe way to finish this. ${report.summary}`;
    case "waiting":
      return nextCheck
        ? `Nothing good for ${title.toLowerCase()} yet. I'll check again around ${nextCheck}.`
        : `Nothing good for ${title.toLowerCase()} yet. I'll keep checking.`;
  }
}

/* Structured delivery output. Strict JSON schema: nullable, never optional. */

const deliverySchema = z.object({
  text: z.string(),
  ui: z
    .object({
      html: z
        .object({
          title: z.string(),
          html: z.string(),
        })
        .nullable(),
      question: z
        .object({
          title: z.string().nullable(),
          questions: z
            .array(
              z.object({
                prompt: z.string(),
                kind: z.enum(["single", "multi", "text", "scale"]),
                choices: z.array(z.object({ label: z.string(), detail: z.string().nullable() })).max(8),
                allowOther: z.boolean(),
                placeholder: z.string().nullable(),
                scale: z
                  .object({
                    min: z.number(),
                    max: z.number(),
                    minLabel: z.string().nullable(),
                    maxLabel: z.string().nullable(),
                  })
                  .nullable(),
              }),
            )
            .max(6),
        })
        .nullable(),
      chart: z
        .object({
          title: z.string(),
          kind: z.enum(["bar", "line", "pie", "scatter"]),
          unit: z.string().nullable(),
          series: z
            .array(
              z.object({
                name: z.string(),
                points: z.array(z.object({ x: z.string(), y: z.number() })).max(60),
              }),
            )
            .max(8),
          note: z.string().nullable(),
        })
        .nullable(),
    })
    .nullable(),
});

type DeliveryUi =
  | { kind: "html"; data: { title: string; html: string; images: string[] } }
  | { kind: "question"; data: AskUser }
  | { kind: "chart"; data: ShowChart };

type RawUi = NonNullable<z.infer<typeof deliverySchema>["ui"]>;

/** Vet generated HTML against evidence; drop anything malformed. */
async function sanitizeUi(
  userId: string,
  ui: z.infer<typeof deliverySchema>["ui"],
  seen: string,
): Promise<DeliveryUi | null> {
  if (!ui) return null;
  if (ui.html && ui.html.html.trim() && ui.html.html.length <= MINI_APP_MAX_HTML) {
    const vetted = await vetGeneratedHtml(userId, ui.html.html, seen);
    return { kind: "html", data: { title: ui.html.title, ...vetted } };
  }
  const question = sanitizeQuestion(ui.question);
  if (question) return { kind: "question", data: question };
  const chart = sanitizeChart(ui.chart);
  if (chart) return { kind: "chart", data: chart };
  return null;
}

/** A form keeps only questions it can render: choice questions need two choices, scales a range. */
function sanitizeQuestion(q: RawUi["question"]): AskUser | null {
  if (!q) return null;
  const questions = q.questions
    .filter((x) => x.prompt.trim())
    .map((x, i) => {
      const choice = x.kind === "single" || x.kind === "multi";
      const scale =
        x.kind === "scale" && x.scale && Number.isFinite(x.scale.min) && Number.isFinite(x.scale.max)
          ? {
              min: Math.round(Math.min(x.scale.min, x.scale.max)),
              max: Math.round(Math.max(x.scale.min, x.scale.max)),
              minLabel: x.scale.minLabel,
              maxLabel: x.scale.maxLabel,
            }
          : null;
      return {
        id: `q${i + 1}`,
        prompt: x.prompt,
        kind: x.kind,
        choices: choice ? x.choices.map((c, j) => ({ id: String(j + 1), label: c.label, detail: c.detail })) : [],
        allowOther: choice && x.allowOther,
        placeholder: x.placeholder,
        scale,
      };
    })
    .filter((x) => (x.kind === "single" || x.kind === "multi" ? x.choices.length >= 2 : x.kind !== "scale" || x.scale));
  return questions.length > 0 ? { title: q.title, questions, submitLabel: null } : null;
}

/** Numeric points only; a chart with nothing plottable is dropped. */
function sanitizeChart(c: RawUi["chart"]): ShowChart | null {
  if (!c) return null;
  const series = c.series
    .map((s) => ({ name: s.name, points: s.points.filter((p) => Number.isFinite(p.y)).slice(0, 60) }))
    .filter((s) => s.name.trim() && s.points.length > 0);
  if (series.length === 0) return null;
  return { title: c.title, kind: c.kind, unit: c.unit, series, note: c.note };
}

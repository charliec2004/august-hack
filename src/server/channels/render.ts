/**
 * Email-safe rendering: generative UI and approval cards downgraded to plain
 * text for channels without rich UI. Pure (no I/O) so it is easy to test.
 */
import {
  describeUi,
  normalizeForm,
  safeUrl,
  type AskUser,
  type LegacyAskUser,
  type ShowChart,
  type ShowComparison,
  type ShowOptions,
  type ShowPoll,
} from "@/lib/genui";

export type TextUi =
  | { kind: "options"; data: ShowOptions }
  | { kind: "question"; data: Partial<AskUser> & LegacyAskUser }
  | { kind: "chart"; data: ShowChart }
  | { kind: "poll"; data: ShowPoll }
  | { kind: "comparison"; data: ShowComparison };

/** Deep link to a responsibility in the app (where approvals happen). */
export function responsibilityLink(responsibilityId: string, baseUrl = process.env.APP_BASE_URL ?? ""): string {
  return `${baseUrl.replace(/\/$/, "")}/?responsibility=${encodeURIComponent(responsibilityId)}`;
}

export function approvalLinkLine(responsibilityId: string, baseUrl?: string): string {
  return `I've drafted it. Review and send it here: ${responsibilityLink(responsibilityId, baseUrl)}`;
}

/** Markdown down to plain text: links become "text (url)", emphasis and headings are dropped. */
export function plainText(markdown: string): string {
  return markdown
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, "$1 ($2)")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, text: string, url: string) => (text === url ? url : `${text} (${url})`))
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/(^|[^*\w])\*(?!\s)([^*\n]+?)\*(?!\w)/g, "$1$2")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^\s*[-*+]\s+/gm, "- ")
    .replace(/^\|?\s*:?-{3,}.*$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function link(u: string | null | undefined): string {
  const url = safeUrl(u);
  return url ? ` ${url}` : "";
}

/** One component as plain lines a person can read and reply to. */
export function renderUiAsText(ui: TextUi): string {
  switch (ui.kind) {
    case "options":
      return [
        ui.data.title,
        ...ui.data.options.map((o, i) => {
          const facts = o.facts.map((f) => `${f.label}: ${f.value}`).join(", ");
          const head = [o.name, o.subtitle].filter(Boolean).join(", ");
          return `${i + 1}. ${head}${facts ? `. ${facts}` : ""}.${link(o.url)}`;
        }),
      ].join("\n");
    case "question": {
      const form = normalizeForm(ui.data);
      const lines = form.questions.map((q, i) => {
        const choices = q.choices.length ? ` (${q.choices.map((c) => c.label).join(" / ")})` : "";
        const scale = q.scale ? ` (${q.scale.min} to ${q.scale.max})` : "";
        return `${i + 1}. ${q.prompt}${choices}${scale}`;
      });
      return [form.title, ...lines, "Just reply with your answers."].filter(Boolean).join("\n");
    }
    case "poll":
      return [ui.data.question, ...ui.data.options.map((o, i) => `${i + 1}. ${o.label}`)].join("\n");
    case "chart": {
      const unit = ui.data.unit ? ` ${ui.data.unit}` : "";
      const series = ui.data.series.map((s) => {
        const points = s.points.map((p) => `${p.x}: ${p.y}${unit}`).join(", ");
        return ui.data.series.length > 1 ? `${s.name}: ${points}` : points;
      });
      return [ui.data.title, ...series, ui.data.note ?? ""].filter(Boolean).join("\n");
    }
    case "comparison":
      return [
        ui.data.title ?? "",
        ...ui.data.rows.map(
          (r) => `- ${r.name}: ${r.values.map((v, i) => `${ui.data.columns[i] ?? ""} ${v}`.trim()).join(", ")}${link(r.url)}`,
        ),
      ]
        .filter(Boolean)
        .join("\n");
  }
}

const TEXT_KINDS = new Set<string>(["options", "question", "chart", "poll", "comparison"]);

/**
 * Any component as text: the ones with a real text form above; anything else
 * (images, generated HTML) as its one-line description, unwrapped.
 */
export function renderAnyUiAsText(ui: { kind: string; data: unknown }): string {
  if (TEXT_KINDS.has(ui.kind)) return renderUiAsText(ui as TextUi);
  return describeUi({ [ui.kind]: ui.data } as Parameters<typeof describeUi>[0]).replace(/^\(([\s\S]*)\)$/, "$1");
}

/**
 * A whole outgoing email body: the message text, any component as text, and
 * an approval link when something is waiting for the user's OK in the app.
 */
export function renderEmailBody(input: {
  text: string;
  ui?: { kind: string; data: unknown } | null;
  approvalResponsibilityId?: string | null;
  baseUrl?: string;
}): string {
  const parts = [plainText(input.text)];
  if (input.ui) parts.push(renderAnyUiAsText(input.ui));
  if (input.approvalResponsibilityId) parts.push(approvalLinkLine(input.approvalResponsibilityId, input.baseUrl));
  return parts.filter((p) => p.trim()).join("\n\n");
}


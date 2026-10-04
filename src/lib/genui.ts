/**
 * Generative UI contracts shared by the server (Brain tools, async delivery)
 * and the client renderers. The UI renders from these shapes only; a component
 * never trusts a URL it can't parse.
 */
import { z } from "zod";

const fact = z.object({
  label: z.string().describe("Short label, e.g. 'Price', 'Time', 'Rating', 'Distance'"),
  value: z.string().describe("Short value, e.g. '$$', '7:30 PM', '4.6', '0.4 mi'"),
});

export const optionSchema = z.object({
  id: z.string(),
  name: z.string(),
  subtitle: z.string().nullish().describe("One short line, e.g. cuisine and neighborhood"),
  imageUrl: z
    .string()
    .optional()
    .describe("Only an image URL that appeared in evidence (e.g. og:image). Never invent one."),
  url: z.string().nullish().describe("Link to the source page"),
  facts: z.array(fact).max(4).describe("2 to 3 key facts"),
  badge: z.string().nullish().describe("Optional short tag, e.g. 'Best fit'"),
});

export const showOptionsSchema = z.object({
  title: z.string().describe("Short heading, e.g. 'Dinner near Hayes Valley'"),
  options: z.array(optionSchema).min(1).max(8),
});

/* Question form (ask_user). Strict-schema compatible: nullable, never optional. */

const formChoice = z.object({
  id: z.string(),
  label: z.string(),
  detail: z.string().nullable().describe("Optional short clarification under the label"),
});

export const formQuestionSchema = z.object({
  id: z.string(),
  prompt: z.string().describe("Short question, e.g. 'How many guests?' or 'Cuisine'"),
  kind: z
    .enum(["single", "multi", "text", "scale"])
    .describe("single: pick one. multi: pick any that apply. text: open-ended answer. scale: a number from min to max"),
  choices: z.array(formChoice).max(8).describe("2 to 8 choices for single/multi; empty for text and scale"),
  allowOther: z.boolean().describe("Offer an 'Other' answer the person can type (single/multi only)"),
  placeholder: z.string().nullable().describe("Hint text for a text answer or the 'Other' input"),
  scale: z
    .object({
      min: z.number().int(),
      max: z.number().int(),
      minLabel: z.string().nullable(),
      maxLabel: z.string().nullable(),
    })
    .nullable()
    .describe("Required for kind 'scale', e.g. 1 to 5; null otherwise"),
});

export const askUserSchema = z.object({
  title: z.string().nullable().describe("Optional one-line heading for the form; null if the question says it all"),
  questions: z.array(formQuestionSchema).min(1).max(6),
  submitLabel: z.string().nullable().describe("Optional button text; defaults to 'Send'"),
});

/** The pre-form ask_user shape, still present in persisted history. */
export type LegacyAskUser = {
  question?: string;
  choices?: { id?: string; label?: string; detail?: string | null }[];
  allowOther?: boolean | null;
  multi?: boolean | null;
};

export const showPollSchema = z.object({
  question: z.string(),
  options: z.array(z.object({ id: z.string(), label: z.string() })).min(2).max(6),
  multi: z.boolean().describe("true when the person may pick more than one"),
});

export const showImageSchema = z.object({
  url: z.string().describe("Image URL from evidence. Never invent one."),
  caption: z.string().nullish(),
  sourceUrl: z.string().nullish(),
});

export const showComparisonSchema = z.object({
  title: z.string().nullish(),
  columns: z.array(z.string()).min(1).max(6).describe("Fact column headers, e.g. ['Price','Time','Rating']"),
  rows: z
    .array(
      z.object({
        name: z.string(),
        url: z.string().nullish(),
        values: z.array(z.string()).describe("One value per column, in column order"),
      }),
    )
    .min(2)
    .max(8),
});

export const chartSchema = z.object({
  title: z.string().describe("What is plotted, e.g. 'Monthly rent, 2026'"),
  kind: z
    .enum(["bar", "line", "pie", "scatter"])
    .describe("bar: compare categories. line: change over time. pie: parts of one whole (few slices). scatter: two numeric measures"),
  unit: z.string().nullable().describe("Unit of y values, e.g. '$', '°F', 'min'; null if none"),
  series: z
    .array(
      z.object({
        name: z.string(),
        points: z
          .array(z.object({ x: z.union([z.string(), z.number()]), y: z.number() }))
          .min(1)
          .max(60),
      }),
    )
    .min(1)
    .max(8)
    .describe("One series per line/bar group; pie uses only the first series"),
  note: z.string().nullable().describe("Source or caveat, e.g. 'Approximate, from general knowledge'"),
});

/** Mini app html cap. Big enough for a real calculator, small enough to stay a widget. */
export const MINI_APP_MAX_HTML = 60_000;

export const showAppSchema = z.object({
  title: z.string().describe("Short name, e.g. 'Tip calculator'"),
  html: z
    .string()
    .max(MINI_APP_MAX_HTML)
    .describe(
      "A complete, self-contained HTML document with inline <style> and <script>. No external URLs, fonts, images, or network requests.",
    ),
  height: z.number().int().nullable().describe("Initial height hint in px, or null; the frame sizes itself to the content"),
});

export type OptionCard = z.infer<typeof optionSchema>;
export type ShowOptions = z.infer<typeof showOptionsSchema>;
export type AskUser = z.infer<typeof askUserSchema>;
export type FormQuestion = z.infer<typeof formQuestionSchema>;
export type ShowPoll = z.infer<typeof showPollSchema>;
export type ShowImage = z.infer<typeof showImageSchema>;
export type ShowComparison = z.infer<typeof showComparisonSchema>;
export type ShowChart = z.infer<typeof chartSchema>;
export type ShowApp = z.infer<typeof showAppSchema>;

/** Brain tool names whose calls render as components. */
export const GENUI_TOOLS = [
  "show_options",
  "ask_user",
  "show_image",
  "show_comparison",
  "show_poll",
  "show_chart",
  "show_app",
] as const;
export type GenUiToolName = (typeof GENUI_TOOLS)[number];

export function isGenUiTool(name: string): name is GenUiToolName {
  return (GENUI_TOOLS as readonly string[]).includes(name);
}

/** http(s) URLs only; anything else is treated as absent. */
export function safeUrl(u: string | null | undefined): string | null {
  if (!u) return null;
  try {
    const parsed = new URL(u);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.toString() : null;
  } catch {
    return null;
  }
}

/**
 * Any ask_user payload (current form, legacy single question, or a partial
 * streaming one) as a list of renderable questions.
 */
export function normalizeForm(data: Partial<AskUser> & LegacyAskUser): {
  title: string | null;
  questions: FormQuestion[];
  submitLabel: string | null;
} {
  if (Array.isArray(data.questions)) {
    const questions = data.questions
      .filter((q): q is FormQuestion => Boolean(q?.id && q?.prompt && q?.kind))
      .map((q) => ({
        ...q,
        choices: (q.choices ?? []).filter((c) => Boolean(c?.id && c?.label)),
        allowOther: Boolean(q.allowOther),
        placeholder: q.placeholder ?? null,
        scale: q.scale ?? null,
      }));
    return { title: data.title ?? null, questions, submitLabel: data.submitLabel ?? null };
  }
  if (data.question) {
    const choices = (data.choices ?? [])
      .filter((c) => Boolean(c?.label))
      .map((c, i) => ({ id: c.id ?? String(i + 1), label: c.label!, detail: c.detail ?? null }));
    return {
      title: null,
      submitLabel: null,
      questions: [
        {
          id: "q1",
          prompt: data.question,
          kind: data.multi ? "multi" : "single",
          choices,
          allowOther: Boolean(data.allowOther),
          placeholder: null,
          scale: null,
        },
      ],
    };
  }
  return { title: null, questions: [], submitLabel: null };
}

type UiRecord = {
  options?: ShowOptions;
  question?: Partial<AskUser> & LegacyAskUser;
  comparison?: ShowComparison;
  image?: ShowImage;
  poll?: ShowPoll;
  chart?: ShowChart;
  app?: ShowApp;
};

/** Which `describeUi` key each tool's input goes under. */
export const UI_RECORD_KEY: Record<GenUiToolName, keyof UiRecord> = {
  show_options: "options",
  ask_user: "question",
  show_comparison: "comparison",
  show_image: "image",
  show_poll: "poll",
  show_chart: "chart",
  show_app: "app",
};

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** One plain line recording what a component showed, for the model's history. */
export function describeUi(ui: UiRecord): string {
  if (ui.options) {
    return `(Options shown: ${ui.options.options
      .map((o) => [o.name, ...o.facts.map((f) => f.value)].join(", "))
      .join("; ")})`;
  }
  if (ui.question) {
    const form = normalizeForm(ui.question);
    const qs = form.questions.map((q) =>
      q.choices.length ? `${q.prompt} [${q.choices.map((c) => c.label).join("; ")}]` : q.prompt,
    );
    return `(Asked: ${[form.title, ...qs].filter(Boolean).join(" | ")})`;
  }
  if (ui.comparison) return `(Comparison shown: ${ui.comparison.rows.map((r) => r.name).join("; ")})`;
  if (ui.image) return `(Image shown${ui.image.caption ? `: ${ui.image.caption}` : ""})`;
  if (ui.poll) return `(Poll shown: ${ui.poll.question} [${ui.poll.options.map((o) => o.label).join("; ")}])`;
  if (ui.chart) {
    const unit = ui.chart.unit ? ` (${ui.chart.unit})` : "";
    const data = ui.chart.series
      .map((s) => `${s.name}: ${s.points.map((p) => `${p.x}=${p.y}`).join(", ")}`)
      .join("; ");
    return `(Chart shown: ${ui.chart.title}${unit}. ${clip(data, 600)})`;
  }
  if (ui.app) return `(Mini app shown: ${ui.app.title})`;
  return "";
}

/** Matches the history-only lines `describeUi` writes. They never render. */
const HISTORY_LINE =
  /^\((?:Options shown|Asked|Comparison shown|Image shown|Poll shown|Chart shown|Mini app shown)\b.*\)\s*$/gm;

/** Remove history-only component descriptions from user-visible text. */
export function stripHistoryLines(text: string): string {
  return text.replace(HISTORY_LINE, "").replace(/\n{3,}/g, "\n\n").trim();
}

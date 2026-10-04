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

export const askUserSchema = z.object({
  question: z.string(),
  choices: z
    .array(z.object({ id: z.string(), label: z.string(), detail: z.string().nullish() }))
    .min(2)
    .max(6),
  allowOther: z.boolean().nullish(),
  multi: z.boolean().nullish(),
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

export type OptionCard = z.infer<typeof optionSchema>;
export type ShowOptions = z.infer<typeof showOptionsSchema>;
export type AskUser = z.infer<typeof askUserSchema>;
export type ShowImage = z.infer<typeof showImageSchema>;
export type ShowComparison = z.infer<typeof showComparisonSchema>;

/** Brain tool names whose calls render as components. */
export const GENUI_TOOLS = ["show_options", "ask_user", "show_image", "show_comparison"] as const;
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

/** One plain line recording what a component showed, for the model's history. */
export function describeUi(ui: { options?: ShowOptions; question?: AskUser; comparison?: ShowComparison; image?: ShowImage }): string {
  if (ui.options) {
    return `(Options shown: ${ui.options.options
      .map((o) => [o.name, ...o.facts.map((f) => f.value)].join(", "))
      .join("; ")})`;
  }
  if (ui.question) return `(Asked: ${ui.question.question} Choices: ${ui.question.choices.map((c) => c.label).join("; ")})`;
  if (ui.comparison) return `(Comparison shown: ${ui.comparison.rows.map((r) => r.name).join("; ")})`;
  if (ui.image) return `(Image shown${ui.image.caption ? `: ${ui.image.caption}` : ""})`;
  return "";
}

/** Matches the history-only lines `describeUi` writes. They never render. */
const HISTORY_LINE = /^\((?:Options shown|Asked|Comparison shown|Image shown)\b.*\)\s*$/gm;

/** Remove history-only component descriptions from user-visible text. */
export function stripHistoryLines(text: string): string {
  return text.replace(HISTORY_LINE, "").replace(/\n{3,}/g, "\n\n").trim();
}

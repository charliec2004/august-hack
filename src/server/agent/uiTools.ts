import "server-only";

import { createTool } from "@mastra/core/tools";
import { askUserSchema, chartSchema, showHtmlSchema, showPollSchema, type ShownHtml } from "@/lib/genui";
import { vetGeneratedHtml } from "@/server/genui/vetHtml";

/**
 * Generative UI tools. Forms and polls are structured because their answers
 * come back to August; charts are a small primitive; everything else visual is
 * generated HTML. None of them can approve an external action; the approval
 * card is the only place that happens.
 */
const shown = async () => ({ shown: true });

export function uiTools(ctx: { userId: string }) {
  const ask_user = createTool({
    id: "ask_user",
    description:
      "Ask the user for one or more details or decisions in a single form: single choice, multi-select, short text, or a 1-to-N scale per question. They answer everything and press one button; their answers arrive as one message. Prefer one form with several questions over several messages. Never use it to approve sending, booking, buying, or submitting anything.",
    inputSchema: askUserSchema,
    execute: shown,
  });

  const show_poll = createTool({
    id: "show_poll",
    description:
      "A quick tappable poll for a light preference pick between a few short ideas. Their vote arrives as their reply.",
    inputSchema: showPollSchema,
    execute: shown,
  });

  const show_chart = createTool({
    id: "show_chart",
    description:
      "Draw a chart (bar, line, pie, scatter) from numbers you actually have: from evidence, from the user, or well-established figures labeled as approximate in `note`. Never invent data. Pass raw values with a simple unit (15000 with unit 'steps', not 15 'thousand steps'); the chart formats large numbers compactly.",
    inputSchema: chartSchema,
    execute: shown,
  });

  const show_html = createTool({
    id: "show_html",
    description: `Show anything visual as generated HTML in the chat: option cards, comparisons, image galleries, itineraries, timelines, checklists, small interactive tools.
Write one self-contained document with inline <style> and <script>. It runs sandboxed: no fetch, no external scripts, fonts, frames, or forms. Remote images only with exact https URLs that appeared in evidence or the user's messages; any other remote URL is removed.
Style it like the app: system font; colors from the provided CSS variables (--bg --fg --muted --muted-fg --border --accent), which follow light and dark; 12px rounded cards with a 1px var(--border) border and no heavy shadows; generous spacing; 14px body text; fluid widths that fit a 640px chat column and shrink on phones. No headline banners or uppercase labels. Native-looking defaults for text, inputs, buttons, and tables are already applied.
To hand a choice or result back (e.g. a "Choose" button), call august.reply("I choose: X"); the user confirms before it is sent.`,
    inputSchema: showHtmlSchema,
    execute: async ({ html }): Promise<ShownHtml> => ({ shown: true, ...(await vetGeneratedHtml(ctx.userId, html)) }),
  });

  return { ask_user, show_poll, show_chart, show_html };
}

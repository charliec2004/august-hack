import "server-only";

import { createTool } from "@mastra/core/tools";
import {
  askUserSchema,
  chartSchema,
  showAppSchema,
  showComparisonSchema,
  showImageSchema,
  showOptionsSchema,
  showPollSchema,
} from "@/lib/genui";

/**
 * Generative UI tools. They change nothing: the interface renders each call
 * from its arguments, so `execute` only acknowledges. None of them can approve
 * an external action; the approval card is the only place that happens.
 */
const shown = async () => ({ shown: true });

export function uiTools() {
  const show_options = createTool({
    id: "show_options",
    description:
      "Show the user several concrete options (restaurants, flights, products, times) as a swipeable row of cards with key facts and a 'Choose this' button. Use whenever you present two or more candidates.",
    inputSchema: showOptionsSchema,
    execute: shown,
  });

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
      "A quick tappable poll for a light preference pick between a few short ideas (no facts needed). Their vote arrives as their reply.",
    inputSchema: showPollSchema,
    execute: shown,
  });

  const show_chart = createTool({
    id: "show_chart",
    description:
      "Draw a chart (bar, line, pie, scatter) from numbers you actually have: from evidence, from the user, or well-established figures labeled as approximate in `note`. Never invent data.",
    inputSchema: chartSchema,
    execute: shown,
  });

  const show_app = createTool({
    id: "show_app",
    description:
      "Render a small interactive mini app in the chat (calculator, planner, checklist, timeline, converter) from a self-contained HTML document with inline CSS and JS. It runs sandboxed with no network: no external scripts, fonts, images, or fetch. It gets native-looking defaults for body text, inputs, buttons and tables, plus CSS variables --bg --fg --muted --muted-fg --border --accent that match the app's theme; use them instead of hard-coded colors. Keep it compact (under ~400px tall) and the code short. To hand a result back, call august.reply('text'); the user confirms before it is sent.",
    inputSchema: showAppSchema,
    execute: shown,
  });

  const show_image = createTool({
    id: "show_image",
    description: "Show one image (a photo, map, screenshot) whose URL you actually have from evidence. Never invent URLs.",
    inputSchema: showImageSchema,
    execute: shown,
  });

  const show_comparison = createTool({
    id: "show_comparison",
    description:
      "Show a compact side-by-side table: one row per option, one column per fact. Use when the user wants to compare options on the same dimensions.",
    inputSchema: showComparisonSchema,
    execute: shown,
  });

  return { show_options, ask_user, show_poll, show_chart, show_app, show_image, show_comparison };
}

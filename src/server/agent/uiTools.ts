import "server-only";

import { createTool } from "@mastra/core/tools";
import {
  askUserSchema,
  showComparisonSchema,
  showImageSchema,
  showOptionsSchema,
} from "@/lib/genui";

/**
 * Generative UI tools. They change nothing: the interface renders each call
 * from its arguments, so `execute` only acknowledges.
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
      "Ask the user a question with a few tappable answers. Use when you need them to pick between clear alternatives.",
    inputSchema: askUserSchema,
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

  return { show_options, ask_user, show_image, show_comparison };
}

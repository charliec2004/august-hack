import "server-only";

import { executorListConnections } from "@/server/providers/executor";
import type { ConnectionsResponse } from "@/server/types/api";
import { cached } from "./cache";

const TTL_MS = 60_000;

const KNOWN: Record<string, string> = {
  google_calendar: "Google Calendar",
  google_drive: "Google Drive",
  google_sheets: "Google Sheets",
  google_docs: "Google Docs",
  gmail: "Gmail",
  github: "GitHub",
  gitlab: "GitLab",
  slack: "Slack",
  notion: "Notion",
  linear: "Linear",
  hubspot: "HubSpot",
  openai: "OpenAI",
};

/** "google_calendar" -> "Google Calendar"; unknown keys are title-cased. */
export function integrationLabel(key: string): string {
  if (KNOWN[key]) return KNOWN[key];
  return key
    .split(/[_\-.]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/** The user's connected apps via Executor. Failures become a calm message, not an error. */
export async function listConnections(userId: string): Promise<ConnectionsResponse> {
  try {
    return await cached(`connections:${userId}`, TTL_MS, async () => {
      const rows = await executorListConnections();
      return {
        message: null,
        connections: rows.map((c) => ({
          name: integrationLabel(c.integration || c.name),
          integration: c.integration,
          status: "Connected",
          scope: c.owner === "org" ? "Shared" : "Personal",
        })),
      };
    });
  } catch {
    return { connections: [], message: "Couldn't load your connected apps right now." };
  }
}

import { toAISdkStream } from "@mastra/ai-sdk";
import {
  createUIMessageStream,
  createUIMessageStreamResponse,
  type ModelMessage,
  type UIMessage,
} from "ai";
import { after } from "next/server";
import { brainAgent } from "@/server/agent/brain";
import { gatewayProviderOptions, modelConfigured } from "@/server/agent/model";
import { currentUser } from "@/server/auth/currentUser";
import { ensurePrimaryThread, insertMessage, recentMessages } from "@/server/db/messages";
import { captureMemories } from "@/server/memory/memories";
import { updateThreadSummary, VERBATIM_TAIL } from "@/server/memory/summary";
import { trace } from "@/server/db/traces";
import { describeUi, isGenUiTool, stripHistoryLines, UI_RECORD_KEY, type ShowApp, type ShownHtml } from "@/lib/genui";

export const maxDuration = 300;

function textOf(m: UIMessage | undefined): string {
  if (!m) return "";
  return m.parts
    .map((p) => (p.type === "text" ? p.text : ""))
    .join("")
    .trim();
}

function staticReply(text: string) {
  const stream = createUIMessageStream({
    execute: ({ writer }) => {
      writer.write({ type: "text-start", id: "t" });
      writer.write({ type: "text-delta", id: "t", delta: text });
      writer.write({ type: "text-end", id: "t" });
    },
  });
  return createUIMessageStreamResponse({ stream });
}

type BrainStream = Awaited<ReturnType<Awaited<ReturnType<typeof brainAgent>>["stream"]>>;

/**
 * What the turn said and showed, for the conversation of record. Generative UI
 * tool calls are kept as AI SDK tool parts so the cards survive a reload; other
 * tool calls are machinery and are dropped. `content` (what the model's history
 * sees) gets one plain line per component shown.
 */
async function turnRecord(stream: BrainStream): Promise<{ content: string; parts: unknown[] }> {
  const parts: unknown[] = [];
  const shown: string[] = [];
  for (const step of await stream.steps) {
    // The model may imitate history-only lines; they never reach the UI.
    const text = stripHistoryLines(step.text);
    if (text) parts.push({ type: "text", text });
    for (const call of step.toolCalls) {
      const { toolCallId, toolName, args } = call.payload;
      if (!isGenUiTool(toolName)) continue;
      const input = { ...(args as Record<string, unknown>) };
      delete input.__mastraMetadata;
      let output: unknown = { shown: true };
      if (toolName === "show_html") {
        // Only the server-vetted document is kept; the model's raw html never is.
        const vetted = step.toolResults.find((r) => r.payload.toolCallId === toolCallId)?.payload.result as
          | ShownHtml
          | undefined;
        if (!vetted?.html) continue;
        delete input.html;
        output = vetted;
        shown.push(describeUi({ html: { ...(input as ShowApp), html: vetted.html } }));
      } else {
        shown.push(describeUi({ [UI_RECORD_KEY[toolName]]: input }));
      }
      parts.push({ type: `tool-${toolName}`, toolCallId, state: "output-available", input, output });
    }
  }
  const text = parts
    .filter((p): p is { type: "text"; text: string } => (p as { type: string }).type === "text")
    .map((p) => p.text)
    .join("\n\n");
  return { content: [text, ...shown].filter(Boolean).join("\n\n"), parts };
}

/** Authenticated streaming Brain Core turn (spec 9). */
export async function POST(req: Request) {
  const { messages }: { messages: UIMessage[] } = await req.json();
  const user = await currentUser();
  const threadId = await ensurePrimaryThread(user.id);

  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  const text = textOf(lastUser);
  if (!text) return new Response("empty message", { status: 400 });

  // Persist before model dispatch.
  const msg = await insertMessage({
    threadId,
    userId: user.id,
    role: "user",
    content: text,
    parts: lastUser?.parts ?? null,
  });

  if (!modelConfigured()) {
    const reply =
      "I can't think right now: my model access isn't switched on yet. Your message is saved, and I'll be able to pick it up once it is.";
    await insertMessage({ threadId, userId: user.id, role: "assistant", content: reply });
    return staticReply(reply);
  }

  const agent = await brainAgent({ userId: user.id, threadId, sourceMessageId: msg.id }, text);
  // Postgres is the conversation of record (includes updates August delivered
  // asynchronously); only the recent tail goes to the model (spec 15).
  const history = await recentMessages(user.id, threadId, VERBATIM_TAIL);
  const stream = await agent.stream(
    history
      .filter((m) => m.role !== "system")
      .map((m): ModelMessage =>
        m.role === "user" ? { role: "user", content: m.content } : { role: "assistant", content: m.content },
      ),
    { maxSteps: 6, providerOptions: gatewayProviderOptions },
  );

  after(async () => {
    try {
      const { content, parts } = await turnRecord(stream);
      if (content) {
        await insertMessage({ threadId, userId: user.id, role: "assistant", content, parts });
        await trace({ userId: user.id, kind: "brain.delivered", detail: { deliveryKind: "turn" } });
      }
      // Forever chat: remember durable facts, and fold old messages into the running summary.
      await captureMemories({ userId: user.id, sourceMessageId: msg.id, userText: text, assistantText: content });
      await updateThreadSummary(user.id, threadId);
    } catch (e) {
      console.error("persist assistant turn failed:", (e as Error).message);
    }
  });

  return createUIMessageStreamResponse({
    stream: toAISdkStream(stream, {
      from: "agent",
      version: "v7",
      // Never send provider errors or stacks to the browser.
      onError: (err) => {
        console.error("brain turn failed:", (err as Error)?.message ?? err);
        return "I hit a problem thinking about that. Your message is saved; please try again in a moment.";
      },
    }),
  });
}

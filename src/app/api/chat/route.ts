import { toAISdkStream } from "@mastra/ai-sdk";
import {
  createUIMessageStream,
  createUIMessageStreamResponse,
  type ModelMessage,
  type UIMessage,
} from "ai";
import { after } from "next/server";
import { brainAgent } from "@/server/agent/brain";
import { modelConfigured } from "@/server/agent/model";
import { currentUser } from "@/server/auth/currentUser";
import { ensurePrimaryThread, insertMessage, recentMessages } from "@/server/db/messages";
import { trace } from "@/server/db/traces";

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

  const agent = await brainAgent({ userId: user.id, threadId, sourceMessageId: msg.id });
  // Postgres is the conversation of record (includes updates August delivered
  // asynchronously); only the recent tail goes to the model (spec 15).
  const history = await recentMessages(user.id, threadId, 24);
  const stream = await agent.stream(
    history
      .filter((m) => m.role !== "system")
      .map((m): ModelMessage =>
        m.role === "user" ? { role: "user", content: m.content } : { role: "assistant", content: m.content },
      ),
    { maxSteps: 6 },
  );

  after(async () => {
    try {
      const out = (await stream.text).trim();
      if (out) {
        await insertMessage({ threadId, userId: user.id, role: "assistant", content: out });
        await trace({ userId: user.id, kind: "brain.delivered", detail: { deliveryKind: "turn" } });
      }
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

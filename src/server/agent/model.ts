import "server-only";

import { createOpenAI } from "@ai-sdk/openai";

/**
 * The single model adapter (spec 40.5). Everything else asks for a purpose;
 * only this file knows the Neon AI Gateway URL. The gateway's chat-completions
 * endpoint is OpenAI-compatible and serves every catalog model.
 */
export type AugustModelPurpose = "brain" | "worker" | "reviewer" | "memory" | "embedding";

const DEFAULTS: Record<AugustModelPurpose, string> = {
  brain: "gpt-5-6-sol",
  worker: "gpt-5-6-sol",
  reviewer: "gpt-5-6-luna",
  memory: "gpt-5-6-luna",
  embedding: "qwen3-embedding-0-6b",
};

const ENV_KEYS: Record<AugustModelPurpose, string> = {
  brain: "BRAIN_MODEL",
  worker: "WORKER_MODEL",
  reviewer: "REVIEW_MODEL",
  memory: "MEMORY_MODEL",
  embedding: "EMBEDDING_MODEL",
};

export function modelIdFor(purpose: AugustModelPurpose): string {
  return process.env[ENV_KEYS[purpose]] || DEFAULTS[purpose];
}

function gateway() {
  const base = process.env.NEON_AI_GATEWAY_BASE_URL;
  const token = process.env.NEON_AI_GATEWAY_TOKEN;
  if (!base || !token) {
    throw new ModelUnavailableError(
      "Neon AI Gateway is not configured (NEON_AI_GATEWAY_BASE_URL / NEON_AI_GATEWAY_TOKEN).",
    );
  }
  return createOpenAI({ baseURL: `${base.replace(/\/$/, "")}/v1`, apiKey: token });
}

export class ModelUnavailableError extends Error {}

/** Chat model for a purpose, routed through Neon AI Gateway chat completions. */
export function modelFor(purpose: Exclude<AugustModelPurpose, "embedding">) {
  return gateway().chat(modelIdFor(purpose));
}

export function embeddingModel() {
  return gateway().embedding(modelIdFor("embedding"));
}

export function modelConfigured(): boolean {
  return Boolean(process.env.NEON_AI_GATEWAY_BASE_URL && process.env.NEON_AI_GATEWAY_TOKEN);
}

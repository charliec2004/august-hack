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

/**
 * `dialect` picks the gateway path: "/v1" is the unified chat-completions
 * endpoint; "/openai/v1" serves the OpenAI Responses API, which GPT-5.x
 * reasoning models require when tools are present.
 */
function gateway(dialect: "/v1" | "/openai/v1" = "/v1") {
  const base = process.env.NEON_AI_GATEWAY_BASE_URL;
  const token = process.env.NEON_AI_GATEWAY_TOKEN;
  if (!base || !token) {
    throw new ModelUnavailableError(
      "Neon AI Gateway is not configured (NEON_AI_GATEWAY_BASE_URL / NEON_AI_GATEWAY_TOKEN).",
    );
  }
  return createOpenAI({ baseURL: `${base.replace(/\/$/, "")}${dialect}`, apiKey: token });
}

export class ModelUnavailableError extends Error {}

type ChatModel = ReturnType<ReturnType<typeof createOpenAI>["chat"]> | ReturnType<ReturnType<typeof createOpenAI>["responses"]>;
let override: ((purpose: AugustModelPurpose) => ChatModel) | null = null;

/**
 * Scripted-model hook for offline end-to-end tests only (scripts/e2e-scripted.ts).
 * Not reachable from any route.
 */
export function setModelOverrideForTesting(fn: ((purpose: AugustModelPurpose) => ChatModel) | null) {
  override = fn;
}

/** Chat model for a purpose, routed through Neon AI Gateway chat completions. */
export function modelFor(purpose: Exclude<AugustModelPurpose, "embedding">): ChatModel {
  if (override) return override(purpose);
  const id = modelIdFor(purpose);
  return id.startsWith("gpt-") ? gateway("/openai/v1").responses(id) : gateway().chat(id);
}

/**
 * The gateway doesn't persist Responses-API state, so reasoning must travel
 * inline (encrypted) instead of as references to stored items. Pass this on
 * every agent/model call.
 */
export const gatewayProviderOptions = {
  openai: { store: false, include: ["reasoning.encrypted_content" as const] },
};

export function embeddingModel() {
  return gateway().embedding(modelIdFor("embedding"));
}

export function modelConfigured(): boolean {
  if (override) return true;
  return Boolean(process.env.NEON_AI_GATEWAY_BASE_URL && process.env.NEON_AI_GATEWAY_TOKEN);
}

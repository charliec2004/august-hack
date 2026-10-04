/**
 * Live Fly Sprites smoke test (DECISIONS D1).
 *
 *   npm run smoke:sprites
 *
 * 1. token check via list
 * 2. create a uniquely named Sprite
 * 3. exec `node --version` (WebSocket exec, collected into a blocking result)
 * 4. destroy, then confirm absence via inspect (404)
 *
 * Exit codes: 0 ok, 2 blocked (provider_billing_restricted / not configured), 1 failure.
 * Never prints the token.
 */
import { createSpritesProvider, type SpriteError } from "../src/server/providers/sprites";

function blocked(e: SpriteError): never {
  console.log(`BLOCKED code=${e.code}${e.status ? ` status=${e.status}` : ""}: ${e.message}`);
  process.exit(2);
}

async function main() {
  const token = process.env.SPRITES_TOKEN;
  if (!token) blocked({ code: "not_configured", message: "SPRITES_TOKEN is not set" });
  const sprites = createSpritesProvider(token, { baseURL: process.env.SPRITES_API_URL || undefined });

  const list = await sprites.list("aug-");
  if (!list.ok) {
    if (list.error.code === "provider_billing_restricted") blocked(list.error);
    throw new Error(`list failed: ${list.error.code} ${list.error.message}`);
  }
  console.log(`token ok: ${list.value.length} existing aug-* sprites`);

  const name = `aug-smoke-${Date.now().toString(36)}`;
  const created = await sprites.create(name);
  if (!created.ok) {
    if (created.error.code === "provider_billing_restricted") blocked(created.error);
    throw new Error(`create failed: ${created.error.code} ${created.error.message}`);
  }
  console.log(`created ${name} status=${created.value.status} lifecycle=${created.value.lifecycle}`);

  let failure: Error | null = null;
  try {
    const t0 = Date.now();
    const r = await sprites.exec(name, { command: "node --version", timeoutMs: 120_000 });
    if (!r.ok) throw new Error(`exec failed: ${r.error.code} ${r.error.message}`);
    console.log(`exec exit=${r.value.exitCode} stdout=${JSON.stringify(r.value.stdout.trim())} in ${Date.now() - t0}ms`);
    if (r.value.exitCode !== 0 || !/^v\d+/.test(r.value.stdout.trim())) throw new Error("unexpected node --version output");
  } catch (err) {
    failure = err as Error;
  } finally {
    const d = await sprites.destroy(name);
    if (!d.ok) console.log(`destroy failed: ${d.error.code}`);
    const check = await sprites.inspect(name);
    if (check.ok && check.value === null) console.log(`destroyed ${name}; absence confirmed (404)`);
    else {
      console.log(`WARNING: could not confirm ${name} is gone`);
      failure ??= new Error("negative readback failed");
    }
  }
  if (failure) throw failure;
  console.log("SMOKE OK");
}

main().catch((err) => {
  console.error(`SMOKE FAILED: ${(err as Error).message}`);
  process.exit(1);
});

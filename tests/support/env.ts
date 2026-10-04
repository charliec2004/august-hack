import { existsSync, readFileSync } from "node:fs";

// Integration tests run against the Neon `test` branch only, never production.
if (existsSync(".env.test.local")) {
  for (const line of readFileSync(".env.test.local", "utf8").split("\n")) {
    const i = line.indexOf("=");
    if (i > 0) process.env[line.slice(0, i)] ??= line.slice(i + 1);
  }
}
if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
else delete process.env.DATABASE_URL;
// The reviewer must fail closed in tests: no model access.
delete process.env.NEON_AI_GATEWAY_BASE_URL;
delete process.env.NEON_AI_GATEWAY_TOKEN;

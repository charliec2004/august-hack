import { defineConfig } from "@neon/config/v1";

// Declarative Neon backend for August. Postgres owns all durable state;
// Functions host backend-owned async work (wake scanning, webhooks).
export default defineConfig({
  auth: true,
  aiGateway: process.env.NEON_PLAN_PAID === "true", // D2: Free plan rejects the gateway
  functions: {
    wakescan: {
      name: "Wake scanner",
      source: "./functions/wakescan.ts",
      env: {
        APP_BASE_URL: "https://august-hack.vercel.app",
        CRON_SECRET: process.env.CRON_SECRET ?? "",
      },
    },
  },
  triggers: {
    "wake-scan": { type: "schedule", function: "wakescan", cron: "* * * * *" },
  },
  buckets: {
    "august-artifacts": { access: "private" },
  },
  branch: (branch) => {
    if (branch.isDefault) return {};
    if (!branch.exists) return { ttl: "7d" };
    return {};
  },
});

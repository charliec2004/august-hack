import { defineConfig } from "@neon/config/v1";

// Declarative Neon backend for August. Postgres owns all durable state;
// Functions host backend-owned async work (wake scanning, webhooks).
export default defineConfig({
  auth: true,
  aiGateway: true,
  buckets: {
    "august-artifacts": { access: "private" },
  },
  branch: (branch) => {
    if (branch.isDefault) return {};
    if (!branch.exists) return { ttl: "7d" };
    return {};
  },
});

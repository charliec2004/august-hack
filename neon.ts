import { defineConfig } from "@neon/config/v1";

// Declarative Neon backend for August. Postgres owns all durable state;
// Functions host backend-owned async work (wake scanning, webhooks).
export default defineConfig({
  auth: true,
  // aiGateway: true,  // re-enable once the Neon org is on a paid plan (D2)
  buckets: {
    "august-artifacts": { access: "private" },
  },
  branch: (branch) => {
    if (branch.isDefault) return {};
    if (!branch.exists) return { ttl: "7d" };
    return {};
  },
});

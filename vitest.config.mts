import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
      "server-only": path.resolve(__dirname, "tests/support/empty.ts"),
      "next/server": path.resolve(__dirname, "tests/support/next-server.ts"),
    },
  },
  test: {
    setupFiles: ["tests/support/env.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});

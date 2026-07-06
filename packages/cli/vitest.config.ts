import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts"],
    testTimeout: process.env.RUN_INTEGRATION === "true" ? 120000 : 10000,
  },
});

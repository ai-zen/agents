import { defineConfig } from "vitest/config";
import { config } from "dotenv";

config({ path: [".env.local", ".env"] });

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});

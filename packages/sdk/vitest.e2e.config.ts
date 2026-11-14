import { defineConfig } from "vitest/config";
import dotenv from "dotenv";

dotenv.config({ path: ".env.local" });

export default defineConfig({
  test: {
    isolate: false,
    include: ["test/e2e-*.test.ts"],
  },
});

import { defineConfig } from "vitest/config";
import dotenv from "dotenv";

dotenv.config({ path: ".env.local" });

export default defineConfig({
  test: {
    include: ["test/e2e-chat.test.ts", "test/e2e-real-paths.test.ts"],
  },
});

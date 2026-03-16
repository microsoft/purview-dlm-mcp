import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["tests/evals/**/*.test.ts"],
    testTimeout: 60_000,
  },
});

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["starters/**/*.test.ts"],
    expect: { requireAssertions: true },
    fileParallelism: false,
    testTimeout: 30 * 60 * 1000,
  },
});

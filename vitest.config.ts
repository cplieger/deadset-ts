import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "scripts/**/*.test.ts"],
    setupFiles: ["./__test-helpers__/fc-strict-setup.ts"],
    expect: { requireAssertions: true },
  },
});

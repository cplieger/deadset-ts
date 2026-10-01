import { defineConfig } from "./define.ts";

export default defineConfig({
  test: {
    setupFiles: ["./setup.ts"],
  },
});

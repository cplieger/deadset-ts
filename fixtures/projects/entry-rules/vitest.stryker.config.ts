import base from "./vitest.config.ts";
import { mergeConfig } from "./define.ts";

export default mergeConfig(base, { test: { exclude: ["e2e/**"] } });

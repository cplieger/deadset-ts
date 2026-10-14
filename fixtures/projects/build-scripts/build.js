import { build as bundle } from "esbuild";

bundle({ entryPoints: ["src/browser.ts", { in: "src/worker-entry.ts", out: "w" }] });

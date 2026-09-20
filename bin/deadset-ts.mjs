#!/usr/bin/env node
// Node refuses to strip types from a .ts file under node_modules, so the
// TypeScript entry cannot start from an install. A load hook scoped to this
// package's own files supplies the stripped source instead.
// https://nodejs.org/api/typescript.html#type-stripping-in-dependencies
import { readFileSync } from "node:fs";
import { registerHooks, stripTypeScriptTypes } from "node:module";

const packageRoot = new URL("../", import.meta.url).href;

registerHooks({
  load(url, context, nextLoad) {
    if (!url.startsWith(packageRoot) || !url.endsWith(".ts")) {
      return nextLoad(url, context);
    }
    return {
      format: "module",
      source: stripTypeScriptTypes(readFileSync(new URL(url), "utf8")),
      shortCircuit: true,
    };
  },
});

await import("./deadset-ts.ts");

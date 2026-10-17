import { rmSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { nodeHost } from "../../bin/node-host.ts";
import { TSCONFIG, writeProject } from "../../__test-helpers__/projects.ts";
import { resolve } from "../resolve.ts";
import { scopeForDir } from "../scope.ts";
import { openEngine, type Engine } from "../session.ts";
import { loadRun } from "./load.ts";

/** The bound on one case, which opens the compiler over a written tree. */
const LOAD_TIMEOUT = 60_000;

function counting(): { readonly engine: Engine; readonly parsed: Map<string, number> } {
  const real = openEngine({ collectTiming: false });
  const parsed = new Map<string, number>();
  return {
    parsed,
    engine: {
      ...real,
      parseConfigFile: (configFile) => {
        const path = typeof configFile === "string" ? configFile : configFile.uri;
        parsed.set(path, (parsed.get(path) ?? 0) + 1);
        return real.parseConfigFile(configFile);
      },
    },
  };
}

describe("the load phase", () => {
  it(
    "parses each configuration of a run once, however many steps read it",
    () => {
      const root = writeProject({
        "tsconfig.json": TSCONFIG,
        "src/main.ts": 'import { helper } from "./helper.js";\n\nconsole.log(helper);\n',
        "src/helper.ts": "export const helper = 1;\n",
        "tools/tsconfig.json": TSCONFIG,
        "tools/tool.ts": "export const tool = 2;\n",
      });
      onTestFinished(() => {
        rmSync(root, { recursive: true, force: true });
      });
      const host = nodeHost();
      const { config } = resolve({
        repository: { text: '{ "target": { "kind": "application" } }', label: "deadset.json" },
      });
      const { engine, parsed } = counting();

      const loaded = loadRun(engine, host, scopeForDir(host, root), config, ({ classified }) =>
        classified.analyzed.map(({ plan }) => plan.configFile),
      );

      expect(loaded.result).toEqual([
        join(root, "tools", "tsconfig.json"),
        join(root, "tsconfig.json"),
      ]);
      expect(Object.fromEntries(parsed)).toEqual({
        [join(root, "tsconfig.json")]: 1,
        [join(root, "tools", "tsconfig.json")]: 1,
      });
    },
    LOAD_TIMEOUT,
  );
});

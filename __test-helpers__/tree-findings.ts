import { rmSync } from "node:fs";
import { emitterInputOf, findingsOf } from "./emitter-input.ts";
import { writeProject } from "./projects.ts";
import { resolve } from "../src/resolve.ts";

/** The compiler configuration of a tree whose source reads the DOM and worker libraries. */
const TSCONFIG = `${JSON.stringify({
  compilerOptions: {
    strict: true,
    target: "ESNext",
    module: "NodeNext",
    moduleResolution: "nodenext",
    lib: ["ESNext", "DOM", "WebWorker"],
    noEmit: true,
  },
  include: ["**/*.ts"],
})}\n`;

/**
 * Each finding of an application tree written from `files`, entered at `main.ts`, as
 * `<code> <subject name>`, at the lowest minimum confidence, the tree removed afterwards.
 */
export function treeFindings(files: Readonly<Record<string, string>>): readonly string[] {
  const root = writeProject({
    "tsconfig.json": TSCONFIG,
    "package.json": JSON.stringify({ name: "@example/tree", private: true, type: "module" }),
    ...files,
  });
  try {
    const { config } = resolve({
      repository: JSON.stringify({
        target: { kind: "application" },
        analysis: { min_confidence: "possible" },
        ts: { entry_files: ["main.ts"] },
      }),
      repositoryLabel: "deadset.json",
    });
    return findingsOf(emitterInputOf(root, config)).map(
      (finding) => `${finding.code} ${finding.symbol.name}`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

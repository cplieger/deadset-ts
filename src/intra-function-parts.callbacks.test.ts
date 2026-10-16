import { rmSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { emitterInputOf, findingsOf } from "../__test-helpers__/emitter-input.ts";
import { LOAD_TIMEOUT } from "../__test-helpers__/intra-function-parts.ts";
import { writeProject } from "../__test-helpers__/projects.ts";
import { resolve } from "./resolve.ts";

const CALLEES = [
  "export function apply(fn: (a: number, b: number, c: number) => number): number {",
  "  return fn(1, 2, 3);",
  "}",
  "export function infer<T>(fn: (value: T, index: number) => void): T[] {",
  "  fn(undefined as T, 0);",
  "  return [];",
  "}",
  "export function wrap<T extends (...args: never[]) => unknown>(fn: T): T {",
  "  return fn;",
  "}",
  "export function mock<T extends (...args: never[]) => unknown>(fn?: T): T | undefined {",
  "  return fn;",
  "}",
  "",
].join("\n");

/** Each DS1401 finding of `main` at the lowest minimum confidence, as `<name> <line> <confidence>: <message>`. */
function parameters(main: readonly string[]): string[] {
  const root = writeProject({
    "package.json": '{ "name": "@example/calls", "private": true, "type": "module" }\n',
    "src/calls.ts": CALLEES,
    "src/main.ts": `${main.join("\n")}\n`,
  });
  try {
    const { config } = resolve({
      repository: {
        text: JSON.stringify({
          target: { kind: "application" },
          analysis: { min_confidence: "possible" },
          ts: { entry_files: ["src/main.ts"] },
        }),
        label: "deadset.json",
      },
    });
    return findingsOf(emitterInputOf(root, config))
      .filter((finding) => finding.code === "DS1401")
      .map(
        (finding) =>
          `${finding.symbol.name} ${String(finding.position.line)} ${finding.confidence}: ${finding.message.split(";")[0] ?? ""}`,
      );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("an unread parameter of a function used as a value", () => {
  it(
    "is a rename to an underscore name where a read parameter follows it, and none once it has one",
    () => {
      expect(
        parameters([
          'import { apply } from "./calls.js";',
          "console.log(",
          "  apply((first, second, third) => second),",
          "  apply((_first, second) => second),",
          "  apply((first: number, second: number) => second),",
          "  apply(({ toFixed }: number, second) => second),",
          ");",
        ]),
      ).toEqual([
        "first 3 certain: parameter first is never read in the body, and a read parameter follows it, so rename it to _first",
        "third 3 certain: parameter third is never read in the body",
        "first 5 certain: parameter first is never read in the body, and a read parameter follows it, so rename it to _first",
        "toFixed 6 probable: parameter toFixed is never read in the body",
      ]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "is reported at probable where it carries an annotation no type parameter of the callee reads, and trails",
    () => {
      expect(
        parameters([
          'import { apply, infer, mock, wrap } from "./calls.js";',
          "console.log(",
          "  apply((a: number, b: number, unread: number) => a + b),",
          "  infer((value: string, index: number) => console.log(index)),",
          "  infer((value: string, unused: number) => console.log(value)),",
          "  wrap((label: string) => 1),",
          "  mock((label: string) => 1),",
          ");",
        ]),
      ).toEqual([
        "unread 3 probable: parameter unread is never read in the body",
        "value 4 certain: parameter value is never read in the body, and a read parameter follows it, so rename it to _value",
        "unused 5 probable: parameter unused is never read in the body",
      ]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "is never reported where its name starts with an underscore, a binding pattern's names included",
    () => {
      expect(
        parameters([
          'import { apply } from "./calls.js";',
          "function trailing(value: number, _unused: number): number {",
          "  return value;",
          "}",
          "function picked([_skip, kept]: [number, number]): number {",
          "  return kept;",
          "}",
          "console.log(",
          "  apply((a: number, b: number, _c: number) => a + b),",
          "  apply((a, _b) => a),",
          "  trailing(1, 2),",
          "  picked([1, 2]),",
          ");",
        ]),
      ).toEqual([]);
    },
    LOAD_TIMEOUT,
  );
});

describe("a name an object pattern binds in a parameter of a contextually typed function", () => {
  it(
    "is reported at probable where the body never reads it, whether or not it reads another name of the pattern",
    () => {
      expect(
        parameters([
          'import { infer } from "./calls.js";',
          "console.log(",
          "  infer<{ field: number; fieldState: number }>(({ field, fieldState }) => {",
          "    console.log(field);",
          "  }),",
          "  infer<{ signal: string }>(({ signal }) => undefined),",
          "  infer<{ read: number }>(({ read }) => {",
          "    console.log(read);",
          "  }),",
          ");",
        ]),
      ).toEqual([
        "fieldState 3 probable: parameter fieldState is never read in the body",
        "signal 6 probable: parameter signal is never read in the body",
      ]);
    },
    LOAD_TIMEOUT,
  );
});

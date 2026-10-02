import {
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { emitterInputOf } from "../../__test-helpers__/emitter-input.ts";
import { contractDocument, fixture, ROOT } from "../../__test-helpers__/fixtures.ts";
import type { CompletedFinding } from "../finding.ts";
import { resolve } from "../resolve.ts";
import { findingsOf } from "./emitters.ts";

/** One schema of the finding schema's closure: an object, or `true` or `false`. */
type Schema = boolean | Readonly<Record<string, unknown>>;

/** The keywords that carry no assertion, and the container of the named definitions. */
const ANNOTATIONS: ReadonlySet<string> = new Set(["$schema", "title", "description", "$defs"]);

function isObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function typeOf(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "array";
  }
  return typeof value === "number" && Number.isInteger(value) ? "integer" : typeof value;
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * A validator for the JSON Schema 2020-12 keywords the finding schema uses, with every
 * `$ref` local to the document. A keyword it does not implement is an error, so a
 * schema that grows one fails here rather than passing unread.
 */
function validator(document: Readonly<Record<string, unknown>>): (value: unknown) => string[] {
  const definitions = (document["$defs"] ?? {}) as Readonly<Record<string, Schema>>;

  const check = (schema: Schema, value: unknown, at: string): string[] => {
    if (schema === true) {
      return [];
    }
    if (schema === false) {
      return [`${at}: no value is admitted`];
    }
    const errors: string[] = [];
    const fail = (message: string): void => {
      errors.push(`${at}: ${message}`);
    };
    for (const [keyword, argument] of Object.entries(schema)) {
      if (ANNOTATIONS.has(keyword) || keyword === "then" || keyword === "else") {
        continue;
      }
      switch (keyword) {
        case "$ref": {
          const name = String(argument).replace(/^#\/\$defs\//u, "");
          const target = definitions[name];
          if (target === undefined) {
            fail(`unresolved reference ${String(argument)}`);
            break;
          }
          errors.push(...check(target, value, at));
          break;
        }
        case "type":
          if (
            !(Array.isArray(argument) ? argument : [argument]).some(
              (type) =>
                type === typeOf(value) || (type === "number" && typeOf(value) === "integer"),
            )
          ) {
            fail(`is ${typeOf(value)}, not ${JSON.stringify(argument)}`);
          }
          break;
        case "enum":
          if (!(argument as unknown[]).some((one) => same(one, value))) {
            fail(`${JSON.stringify(value)} is not one of ${JSON.stringify(argument)}`);
          }
          break;
        case "const":
          if (!same(argument, value)) {
            fail(`${JSON.stringify(value)} is not ${JSON.stringify(argument)}`);
          }
          break;
        case "pattern":
          if (typeof value === "string" && !new RegExp(String(argument), "u").test(value)) {
            fail(`${JSON.stringify(value)} does not match ${String(argument)}`);
          }
          break;
        case "minLength":
          if (typeof value === "string" && [...value].length < Number(argument)) {
            fail(`is shorter than ${String(argument)}`);
          }
          break;
        case "minimum":
          if (typeof value === "number" && value < Number(argument)) {
            fail(`is below ${String(argument)}`);
          }
          break;
        case "required":
          if (isObject(value)) {
            for (const member of argument as string[]) {
              if (!Object.hasOwn(value, member)) {
                fail(`lacks ${member}`);
              }
            }
          }
          break;
        case "properties":
          if (isObject(value)) {
            for (const [member, sub] of Object.entries(argument as Record<string, Schema>)) {
              if (Object.hasOwn(value, member)) {
                errors.push(...check(sub, value[member], `${at}/${member}`));
              }
            }
          }
          break;
        case "additionalProperties":
          if (isObject(value)) {
            const declared = (schema["properties"] ?? {}) as Readonly<Record<string, unknown>>;
            for (const member of Object.keys(value)) {
              if (!Object.hasOwn(declared, member)) {
                errors.push(...check(argument as Schema, value[member], `${at}/${member}`));
              }
            }
          }
          break;
        case "items":
          if (Array.isArray(value)) {
            value.forEach((item: unknown, index) => {
              errors.push(...check(argument as Schema, item, `${at}/${String(index)}`));
            });
          }
          break;
        case "minItems":
          if (Array.isArray(value) && value.length < Number(argument)) {
            fail(`holds fewer than ${String(argument)} items`);
          }
          break;
        case "uniqueItems":
          if (
            argument === true &&
            Array.isArray(value) &&
            new Set(value.map((item: unknown) => JSON.stringify(item))).size !== value.length
          ) {
            fail("holds an item twice");
          }
          break;
        case "allOf":
          for (const sub of argument as Schema[]) {
            errors.push(...check(sub, value, at));
          }
          break;
        case "anyOf":
          if (!(argument as Schema[]).some((sub) => check(sub, value, at).length === 0)) {
            fail("meets no branch of anyOf");
          }
          break;
        case "not":
          if (check(argument as Schema, value, at).length === 0) {
            fail(`meets ${JSON.stringify(argument)}, which it must not`);
          }
          break;
        case "if": {
          const branch = check(argument as Schema, value, at).length === 0 ? "then" : "else";
          const sub = schema[branch];
          if (sub !== undefined) {
            errors.push(...check(sub as Schema, value, at));
          }
          break;
        }
        default:
          fail(`the keyword ${keyword} is not implemented`);
      }
    }
    return errors;
  };

  return (value) => check(document, value, "");
}

const validate = validator(contractDocument("finding.schema.json"));

/** A member name in the case the finding schema spells it. */
function snake(name: string): string {
  return name.replace(/[A-Z]/gu, (letter) => `_${letter.toLowerCase()}`);
}

/** One finding as the finding schema spells it: every member name in snake case. */
function wire(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(wire);
  }
  if (isObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([name, one]) => [snake(name), wire(one)]));
  }
  return value;
}

/** A finding of the minimal shape the finding schema admits, for the validator's own cases. */
const ADMITTED = {
  code: "DS1002",
  kind: "unused-unexported",
  language: "ts",
  position: { path: "src/a.ts", line: 1, column: 1, end_line: 1 },
  symbol: { ref: "ts://@example/app/src/a.ts#a", kind: "function", name: "a", size_lines: 1 },
  reachability_class: "certain",
  confidence: "certain",
  liveness_relation: "reference-counting",
  test_only: false,
  generated: false,
  component: { id: "deadset-ts/c-1", root: true, symbol_count: 1, deletable_lines: 1 },
  retained_by: [],
  configurations: ["tsconfig.json"],
  consumers_loaded: [],
  fixability: "deletable",
  severity: "deny",
  message: "unexported function has no reference in the target",
  details: {},
};

describe("the finding schema's validator", () => {
  it("admits a finding the schema admits", () => {
    expect(validate(ADMITTED)).toEqual([]);
  });

  it.each([
    ["a required member is missing", { ...ADMITTED, severity: undefined }],
    ["a live subject's code carries a relation", { ...ADMITTED, code: "DS1104" }],
    [
      "a code carries a details member another code owns",
      { ...ADMITTED, details: { write_positions: [ADMITTED.position] } },
    ],
    [
      "a member the schema does not declare is present",
      { ...ADMITTED, component: { ...ADMITTED.component, size: 1 } },
    ],
  ])("refuses a finding in which %s", (_what, finding) => {
    expect(validate(JSON.parse(JSON.stringify(finding)))).not.toEqual([]);
  });
});

/** The bound on one case, which loads one whole target, the repository among them. */
const LOAD_TIMEOUT = 60_000;

/** Every target the suite analyzes: the repository and every fixture with a TypeScript rendering. */
function targets(): [string, string][] {
  const projects = readdirSync(fixture("projects"))
    .filter((name) => !["dependencies-unresolved", "semantic-error"].includes(name))
    .map((name): [string, string] => [`projects/${name}`, fixture("projects", name)]);
  const corpus = readdirSync(fixture("corpus")).map((name): [string, string] => [
    `corpus/${name}`,
    fixture("corpus", name, "ts", "target"),
  ]);
  return [["the repository", ROOT], ...projects, ...corpus];
}

describe("every finding the table reports", () => {
  const copies: string[] = [];
  afterAll(() => {
    for (const copy of copies) {
      rmSync(copy, { recursive: true, force: true });
    }
  });

  /**
   * The target as the analysis reads it. A fixture keeping its dependency directory under
   * `installed/` is copied with that directory moved where the package manager puts it.
   */
  const readable = (target: string): string => {
    if (!existsSync(join(target, "installed"))) {
      return target;
    }
    const copy = mkdtempSync(join(tmpdir(), "deadset-ts-schema-"));
    copies.push(copy);
    cpSync(target, copy, { recursive: true });
    renameSync(join(copy, "installed"), join(copy, "node_modules"));
    return copy;
  };

  it.each(targets())(
    "over %s meets the finding schema",
    { timeout: LOAD_TIMEOUT },
    (_label, target) => {
      const root = readable(target);
      const path = join(root, "deadset.json");
      const document = existsSync(path)
        ? readFileSync(path, "utf8")
        : JSON.stringify({ target: { kind: "application" } });
      const findings: readonly CompletedFinding[] = findingsOf(
        emitterInputOf(root, resolve({ repository: document, repositoryLabel: path }).config),
      );

      expect(
        findings.flatMap((finding) =>
          validate(wire(finding)).map((error) => `${finding.code} ${finding.symbol.name} ${error}`),
        ),
      ).toEqual([]);
    },
  );
});

import { CONTRACT_VERSION } from "./contract/contract.generated.ts";
import { describe, expect, it } from "vitest";
import {
  configVectorCases,
  contractDocument,
  corpusLock,
  digestOf,
  fixture,
  vectorFile,
} from "../__test-helpers__/fixtures.ts";
import { refusedPlace } from "../__test-helpers__/refusal.ts";
import type { Inputs } from "./config.ts";
import { SETTINGS, type SettingRow } from "./contract/config.generated.ts";
import { isRecord } from "./json-document.ts";
import { printConfig } from "./print.ts";
import { LANGUAGE, PRODUCT } from "./product.ts";
import { resolve } from "./resolve.ts";
import { UsageError } from "./usage.ts";

/** The exit code every refusal configuration resolution makes maps to. */
const USAGE_EXIT_CODE = 2;

const ROWS: ReadonlyMap<string, SettingRow> = new Map(SETTINGS.map((row) => [row.key, row]));

/** Whether a case applies to this analyzer: it lists no products, or lists this one. */
function applies(name: string): boolean {
  const products = (JSON.parse(vectorFile(name, "case.json") ?? "{}") as { products?: string[] })
    .products;
  return products === undefined || products.includes(PRODUCT);
}

function inputsFor(name: string): Inputs {
  const flags = vectorFile(name, "flags.json");
  const repository = vectorFile(name, "repository.json");
  const central = vectorFile(name, "central.json");
  const supplied = Object.entries(JSON.parse(flags ?? "{}") as Record<string, unknown>);
  return {
    flags: new Map(supplied.map(([key, value]) => [key, String(value)])),
    ...(repository === undefined
      ? {}
      : { repository: { text: repository, label: "repository.json" } }),
    ...(central === undefined ? {} : { central: { text: central, label: "central.json" } }),
  };
}

/** Whether this analyzer reads a dotted key: its row's, or a keyed section member's. */
function reads(key: string): boolean {
  const row = ROWS.get(key) ?? ROWS.get(key.slice(0, key.lastIndexOf(".")));
  return row?.read === true && row.role !== "ignored";
}

/**
 * A published resolved configuration as this analyzer resolves it: the keys its language
 * reads, a key written per language narrowed to this language's member, and their
 * provenance entries.
 */
function narrowed(value: Record<string, unknown>, at = ""): Record<string, unknown> {
  const held: Record<string, unknown> = {};
  for (const [name, member] of Object.entries(value)) {
    const key = at === "" ? name : `${at}.${name}`;
    if (key === "provenance") {
      const entries = Object.entries(member as Record<string, string>);
      held[name] = Object.fromEntries(entries.filter(([path]) => reads(path)));
    } else if (reads(key)) {
      const row = ROWS.get(key);
      if (row?.role === "section") {
        held[name] = narrowed(member as Record<string, unknown>, key);
      } else if (row?.perLanguage !== undefined && isRecord(member)) {
        held[name] = { [LANGUAGE]: member[LANGUAGE] };
      } else {
        held[name] = member;
      }
    }
  }
  return held;
}

describe("the committed copy of the Contract", () => {
  it("matches the digest corpus.lock.json records for each tree", () => {
    const lock = corpusLock();

    for (const [tree, digest] of Object.entries(lock.digests)) {
      expect(digestOf(fixture(tree.replace(/^fixtures\//u, "")))).toBe(digest);
    }
  });

  it("carries the Contract version this analyzer implements", () => {
    const lock = corpusLock();

    expect(contractDocument("contract.json")["contract_version"]).toBe(CONTRACT_VERSION);
    expect(lock.contract_version).toBe(CONTRACT_VERSION);
  });

  it("names the usage code for every refusal configuration resolution makes", () => {
    const codes = contractDocument("exit-codes.json")["exit_codes"] as {
      code: number;
      name: string;
    }[];

    expect(codes.find((entry) => entry.name === "usage")?.code).toBe(USAGE_EXIT_CODE);
  });
});

describe("the published configuration vectors", () => {
  it("holds a case set this suite runs whole", () => {
    expect(configVectorCases()).toEqual([
      "array-spanning-lines",
      "component-extension-without-a-full-stop",
      "component-extensions-configured",
      "duplicated-key",
      "integer-written-with-a-fraction",
      "member-written-as-null",
      "missing-target-kind",
      "provenance-on-input",
      "provider-claims-schema-language-refused",
      "provider-name-duplicated",
      "provider-named-like-in-process-reader-refused",
      "quoted-key-with-a-dot",
      "resolved-configuration-round-trip",
      "severity-key-names-no-kind",
      "target-kind-empty-object",
      "target-kind-language-missing",
      "target-kind-language-undeclared",
      "target-kind-language-value-refused",
      "target-kind-member-null",
      "target-kind-missing-before-a-refused-value",
      "target-kind-object-over-a-string",
      "target-kind-of-another-type",
      "target-kind-per-language",
      "target-kind-replaced-whole",
      "target-kind-undeclared-before-missing",
      "template-delimiters-configured",
      "template-delimiters-half",
      "typescript-matrix-declared",
      "unimplemented-key",
    ]);
  });

  it("runs a case listing products only where it lists this analyzer", () => {
    expect(configVectorCases().filter((name) => !applies(name))).toEqual([
      "provider-claims-schema-language-refused",
      "provider-name-duplicated",
      "provider-named-like-in-process-reader-refused",
      "target-kind-empty-object",
      "target-kind-member-null",
      "target-kind-missing-before-a-refused-value",
    ]);
  });

  it.each(
    configVectorCases()
      .filter(applies)
      .map((name) => ({ name })),
  )("$name", ({ name }) => {
    const expected = vectorFile(name, "expected.json");
    const refused = vectorFile(name, "expected-error.json");
    expect(
      (expected === undefined) !== (refused === undefined),
      `case ${name} carries exactly one of expected.json and expected-error.json`,
    ).toBe(true);

    if (refused !== undefined) {
      const want = JSON.parse(refused) as { exit_code: number; names: string };
      expect(want.exit_code, `case ${name} maps to the usage code`).toBe(USAGE_EXIT_CODE);
      let thrown: unknown;
      try {
        resolve(inputsFor(name));
      } catch (error: unknown) {
        thrown = error;
      }
      expect(thrown, `resolve(${name}) refused the case`).toBeInstanceOf(UsageError);
      if (!(thrown instanceof UsageError)) {
        return;
      }
      expect(refusedPlace(thrown.message), `resolve(${name}) named the key the case names`).toBe(
        want.names,
      );
      return;
    }

    const { config, provenance } = resolve(inputsFor(name));
    const printed = printConfig(config, provenance);
    expect(
      JSON.parse(printed),
      `resolve(${name}) printed the case's resolved configuration`,
    ).toEqual(narrowed(JSON.parse(expected ?? "") as Record<string, unknown>));

    const back = resolve({ repository: { text: printed, label: "printed.json" } });
    expect(
      back.config,
      `the printed configuration of ${name} resolves to what it was printed from`,
    ).toEqual(config);
  });
});

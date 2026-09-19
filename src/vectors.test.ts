import { describe, expect, it } from "vitest";
import {
  configVectorCases,
  contractDocument,
  corpusLock,
  digestOf,
  fixture,
  vectorFile,
} from "../__test-helpers__/fixtures.ts";
import { ConfigError, type Inputs } from "./config.ts";
import { printConfig } from "./print.ts";
import { resolve } from "./resolve.ts";
import { CONTRACT_VERSION } from "./version.ts";

/** The exit code every refusal configuration resolution makes maps to. */
const USAGE_EXIT_CODE = 2;

/**
 * The flag each case's flag document was supplied through, as that case's expected
 * provenance spells it.
 */
function caseFlagLabels(name: string): ReadonlyMap<string, string> {
  if (name === "array-spanning-lines") {
    return new Map([["analysis.min_confidence", "--min-confidence"]]);
  }
  return new Map();
}

function inputsFor(name: string): Inputs {
  const flags = vectorFile(name, "flags.json");
  const repository = vectorFile(name, "repository.json");
  const central = vectorFile(name, "central.json");
  return {
    ...(flags === undefined ? {} : { flags }),
    ...(repository === undefined ? {} : { repository, repositoryLabel: "repository.json" }),
    ...(central === undefined ? {} : { central, centralLabel: "central.json" }),
    flagLabels: caseFlagLabels(name),
  };
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
      "duplicated-key",
      "missing-target-kind",
      "provenance-on-input",
      "quoted-key-with-a-dot",
      "resolved-configuration-round-trip",
      "template-delimiters-configured",
      "template-delimiters-half",
      "unimplemented-key",
    ]);
  });

  it.each(configVectorCases().map((name) => ({ name })))("$name", ({ name }) => {
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
      expect(thrown, `resolve(${name}) refused the case`).toBeInstanceOf(ConfigError);
      if (!(thrown instanceof ConfigError)) {
        return;
      }
      expect(thrown.key, `resolve(${name}) named the key the case names`).toBe(want.names);
      expect(thrown.message, `resolve(${name}) message names ${want.names}`).toContain(want.names);
      return;
    }

    const { config, provenance } = resolve(inputsFor(name));
    const printed = printConfig(config, provenance);
    expect(
      JSON.parse(printed),
      `resolve(${name}) printed the case's resolved configuration`,
    ).toEqual(JSON.parse(expected ?? ""));

    const back = resolve({ repository: printed, repositoryLabel: "printed.json" });
    expect(
      back.config,
      `the printed configuration of ${name} resolves to what it was printed from`,
    ).toEqual(config);
  });
});

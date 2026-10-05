import { describe, expect, it } from "vitest";
import { nodeHost } from "../../bin/node-host.ts";
import { contractDocument } from "../../__test-helpers__/fixtures.ts";
import { schemaValidator } from "../../__test-helpers__/json-schema.ts";
import type { Host } from "../host.ts";
import { run, type Writer } from "../run.ts";
import { CONFORMANCE } from "../conformance.ts";
import { describeDocument } from "./describe.ts";

class MemoryWriter implements Writer {
  text = "";
  write(text: string): void {
    this.text += text;
  }
}

function invoke(args: readonly string[], host: Host): { code: number; out: string; err: string } {
  const out = new MemoryWriter();
  const err = new MemoryWriter();
  const code = run(args, out, err, host);
  return { code, out: out.text, err: err.text };
}

const validateDescribe = schemaValidator(
  { "describe.schema.json": contractDocument("describe.schema.json") },
  "describe.schema.json",
);

const VERSIONED: Host = { ...nodeHost(), analyzerVersion: () => "1.2.3" };

describe("describe", () => {
  it("writes the analyzer's description, with its conformance record, to the output stream alone and exits 0", () => {
    const got = invoke(["describe"], VERSIONED);

    expect(got).toEqual({
      code: 0,
      out:
        "{\n" +
        '  "name": "deadset-ts",\n' +
        '  "version": "1.2.3",\n' +
        '  "contract_version": "5.3.0",\n' +
        '  "schema_versions_accepted": [\n    "7.0.0"\n  ],\n' +
        '  "languages": [\n    "ts"\n  ],\n' +
        '  "conformance": {\n' +
        `    "corpus_version": "${CONFORMANCE.corpusVersion}",\n` +
        `    "result": "${CONFORMANCE.result}",\n` +
        `    "digest": "${CONFORMANCE.digest}"\n` +
        "  }\n" +
        "}\n",
      err: "",
    });
  });

  it("names the Contract version and the report schema versions the Contract copy carries", () => {
    const described = JSON.parse(invoke(["describe"], VERSIONED).out) as Record<string, unknown>;
    const contract = contractDocument("contract.json");

    expect(described["contract_version"]).toBe(contract["contract_version"]);
    expect(described["schema_versions_accepted"]).toEqual(contract["schema_versions"]);
  });

  it("states a recorded conformance run as the report's analyzer object spells it", () => {
    const recorded = {
      corpusVersion: "1.9.0",
      result: "pass" as const,
      digest: `sha256:${"a".repeat(64)}`,
    };

    expect(JSON.parse(describeDocument("1.2.3", recorded))).toMatchObject({
      conformance: { corpus_version: "1.9.0", result: "pass", digest: `sha256:${"a".repeat(64)}` },
    });
  });

  it("omits the conformance member where no run is recorded, as the describe schema admits", () => {
    const written = JSON.parse(describeDocument("1.2.3", undefined)) as Record<string, unknown>;

    expect(Object.keys(written)).toEqual([
      "name",
      "version",
      "contract_version",
      "schema_versions_accepted",
      "languages",
    ]);
    expect(validateDescribe(written)).toEqual([]);
  });

  it("meets the describe schema with its own record", () => {
    expect(validateDescribe(JSON.parse(invoke(["describe"], VERSIONED).out))).toEqual([]);
  });

  it("exits 2 for an argument, and writes nothing to the output stream", () => {
    expect(invoke(["describe", "--target=."], VERSIONED)).toEqual({
      code: 2,
      out: "",
      err: 'deadset-ts: describe takes no argument, got "--target=."\n',
    });
  });

  it("exits 3 when it cannot know its own version", () => {
    const unversioned: Host = {
      ...nodeHost(),
      analyzerVersion: () => {
        throw new Error("no package.json above the command");
      },
    };

    expect(invoke(["describe"], unversioned)).toEqual({
      code: 3,
      out: "",
      err: "deadset-ts: describe: no package.json above the command\n",
    });
  });
});

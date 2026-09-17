import { describe, expect, it } from "vitest";
import { run, type Writer } from "./run.ts";

class MemoryWriter implements Writer {
  text = "";
  write(text: string): void {
    this.text += text;
  }
}

const USAGE =
  "usage: deadset-ts <verb> [options]\n" +
  "verbs: analyze, explain, print-config, print-roots, print-retained, describe, version\n";

describe("run", () => {
  it.each([
    {
      name: "version prints the build and Contract versions on stdout and exits 0",
      args: ["version"],
      code: 0,
      out: "deadset-ts 0.1.0-dev\ncontract 0.1.0\n",
      err: "",
    },
    {
      name: "no verb prints the usage naming every verb on stderr and exits 2",
      args: [],
      code: 2,
      out: "",
      err: USAGE,
    },
    {
      name: "--fix is refused by name before the verb is read and exits 2",
      args: ["analyze", "--fix"],
      code: 2,
      out: "",
      err: "deadset-ts: --fix is not supported: deadset-ts is report-only and never edits source\n",
    },
  ])("$name", ({ args, code, out, err }) => {
    const stdout = new MemoryWriter();
    const stderr = new MemoryWriter();

    expect(run(args, stdout, stderr)).toBe(code);
    expect(stdout.text).toBe(out);
    expect(stderr.text).toBe(err);
  });
});

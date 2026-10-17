import { expect, it, vi } from "vitest";
import { nodeHost } from "../bin/node-host.ts";
import { ROOT } from "../__test-helpers__/fixtures.ts";
import { run } from "./run.ts";

vi.mock("./verbs/print-config.ts", () => ({
  printConfigVerb: () => {
    throw new TypeError("planted");
  },
}));

it("is 3 with the run failure product-fault for an error no class names, its stack printed first", () => {
  let err = "";
  const code = run(
    ["print-config"],
    { write: () => undefined },
    { write: (text) => (err += text) },
    { ...nodeHost(), workingDirectory: () => ROOT },
  );

  const lines = err.trimEnd().split("\n");
  expect({ code, first: lines[0], last: lines.at(-1) }).toEqual({
    code: 3,
    first: "TypeError: planted",
    last: "run failure: product-fault: deadset-ts meets an error none of its classes names: planted: reinstall deadset-ts, and report the fault to its maintainers if a reinstalled deadset-ts fails the same way",
  });
});

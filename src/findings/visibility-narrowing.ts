import { CODE } from "../contract/contract.generated.ts";
import type { Finding } from "../finding.ts";
import { codesOf } from "./codes.ts";
import { draft, named } from "./draft.ts";
import type { Emitter } from "./emitter.ts";
import { subjectsOf } from "./subjects.ts";

/** The visibility each narrowing code names, which only the narrowing codes carry. */
const NARROWER: ReadonlyMap<string, "file" | "package"> = new Map([
  [CODE.redundantExportKeyword, "file"],
  [CODE.unnecessaryExport, "package"],
]);

/**
 * The visibility-narrowing kinds over one run: `DS1501`, `DS1101` and `DS1503`. A finding
 * about a symbol a declared cross-language edge names is reported here like any other, and
 * the edge's evaluation then holds it pending, because the edge stands for a reference from
 * outside the file and the package whose use is decided in the other language. A
 * declaration of a generated file is reported only where generated files are included.
 */
export const visibilityNarrowing: Emitter = (input) => {
  const codes = codesOf(input);
  const s = subjectsOf(input);
  const generated =
    input.config.analysis.generated_files === "include" ? undefined : input.files.generated;
  return s.union.symbols.flatMap((symbol): Finding[] => {
    if (generated?.has(symbol.position.path) === true) {
      return [];
    }
    const subject = named(symbol);
    if (codes.dead.get(symbol.id) === CODE.unreachableExport) {
      const found =
        s.candidate(symbol.id)?.relation === "reachability"
          ? "is referenced only from declarations that are themselves dead"
          : "has no reference in the target";
      return [
        draft(
          CODE.unreachableExport,
          symbol,
          `exported ${subject} ${found}, and nothing outside can import the file that declares it`,
          {},
        ),
      ];
    }
    const code = codes.live.get(symbol.id);
    const narrower = code === undefined ? undefined : NARROWER.get(code);
    if (code === undefined || narrower === undefined) {
      return [];
    }
    return [
      draft(
        code,
        symbol,
        `exported ${subject} is referenced only inside the ${narrower} that declares it`,
        { narrowerVisibility: narrower },
      ),
    ];
  });
};

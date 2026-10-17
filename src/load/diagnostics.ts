import { DiagnosticCategory } from "@typescript/native/sync";
import type { Diagnostic } from "@typescript/native/sync";
import type { ProjectDiagnostics } from "../session.ts";

/** What one error diagnostic of an opened project does to the run. */
type DiagnosticClass =
  /** The project did not load, whatever its files say. */
  | "load"
  /** A library the configuration names that the compiler cannot find; the project loads. */
  | "unfound-library"
  /** An import of a module the compiler cannot find, a setup failure where the project expects it. */
  | "module-not-found"
  /** A type error: the unit holding it is skipped. */
  | "type-error"
  /** No error of the program's: the compiler checks the whole program all the same. */
  | "ignored";

/** One row of the diagnostic table: the codes it covers, for errors placed in a file or in none. */
interface DiagnosticRow {
  readonly placed: boolean;
  readonly codes: ReadonlySet<number> | { readonly from: number; readonly below: number };
  readonly class: DiagnosticClass;
}

/** The code of a global type the checker finds in no library the program holds. */
export const MISSING_GLOBAL_TYPE = 2318;

/**
 * What each error diagnostic does, first matching row first. In no file: an unfound type library
 * or lib (https://github.com/microsoft/typescript-go/blob/89d5d5b2849a0db0957065889ca58536fa6d2e4a/internal/compiler/processingDiagnostic.go),
 * then the semantic band from 2000; the option band from 5000 leaves the program whole
 * (https://github.com/microsoft/TypeScript/wiki/Coding-guidelines#diagnostic-message-codes).
 * In a file: an unfound module, and where the configuration places the file (5055, 5056, 6059,
 * 6307), which changes no type a statement carries.
 */
const DIAGNOSTIC_TABLE: readonly DiagnosticRow[] = [
  {
    placed: false,
    codes: new Set([MISSING_GLOBAL_TYPE, 2688, 2726, 2727]),
    class: "unfound-library",
  },
  { placed: false, codes: { from: 2000, below: 3000 }, class: "load" },
  { placed: true, codes: new Set([2307, 2792]), class: "module-not-found" },
  { placed: true, codes: new Set([5055, 5056, 6059, 6307]), class: "ignored" },
];

/** The category an error diagnostic carries, which the protocol sends as a number. */
const ERROR_CATEGORY: number = DiagnosticCategory.Error;

function isError(diagnostic: Diagnostic): boolean {
  return diagnostic.category === ERROR_CATEGORY;
}

/**
 * What one diagnostic does, placed in one of the project's own files or in none. A diagnostic
 * the compiler marks as reporting unnecessary code in a file is no error of the program's.
 */
export function classOf(diagnostic: Diagnostic, placed: boolean): DiagnosticClass {
  if (!isError(diagnostic) || (placed && diagnostic.reportsUnnecessary === true)) {
    return "ignored";
  }
  const row = DIAGNOSTIC_TABLE.find(
    ({ placed: where, codes }) =>
      where === placed &&
      ("has" in codes
        ? codes.has(diagnostic.code)
        : diagnostic.code >= codes.from && diagnostic.code < codes.below),
  );
  return row?.class ?? (placed ? "type-error" : "ignored");
}

/** One diagnostic, with the line and column its offset falls on where it names a file. */
export interface LocatedDiagnostic {
  readonly diagnostic: Diagnostic;
  /** Where the diagnostic starts, counted from one; absent where it names no position. */
  readonly at?: { readonly line: number; readonly column: number } | undefined;
}

/**
 * One diagnostic as `path:line:column: TScode: message`, the position left out where it names
 * none and the file where it names none. `display` spells the file's path.
 */
export function renderDiagnostic(
  located: LocatedDiagnostic,
  display: (path: string) => string = (path) => path,
): string {
  const { diagnostic, at } = located;
  const message = `TS${String(diagnostic.code)}: ${diagnostic.text}`;
  if (diagnostic.fileName === undefined) {
    return message;
  }
  const where = display(diagnostic.fileName);
  return at === undefined
    ? `${where}: ${message}`
    : `${where}:${String(at.line)}:${String(at.column)}: ${message}`;
}

function locatedIn(
  diagnostics: readonly Diagnostic[],
  locate: ProjectDiagnostics["locate"],
): readonly LocatedDiagnostic[] {
  return diagnostics.map((diagnostic) => ({
    diagnostic,
    at: diagnostic.fileName === undefined ? undefined : locate(diagnostic.fileName, diagnostic.pos),
  }));
}

/**
 * Every error a project's three diagnostic sets carry, in the order the compiler reported
 * them. A resolved configuration carries no diagnostics of its own, so a configuration written
 * with an unreadable option resolves and is refused here, once its project is open.
 */
export function diagnosticErrors(sets: {
  readonly syntactic: readonly Diagnostic[];
  readonly semantic: readonly Diagnostic[];
  readonly configParsing: readonly Diagnostic[];
}): readonly Diagnostic[] {
  return [...sets.configParsing, ...sets.syntactic, ...sets.semantic].filter(isError);
}

/** Why one open project cannot be analyzed as it stands, split by whether it loaded at all. */
interface ProjectErrors {
  /** The configuration's own errors and the errors in no file the table reads as a load failure. */
  readonly load: readonly LocatedDiagnostic[];
  /** The errors in the files of a project that loaded. */
  readonly check: readonly LocatedDiagnostic[];
  /** The libraries the configuration names that the compiler cannot find, of a project that loaded. */
  readonly unfound: readonly LocatedDiagnostic[];
}

/** The errors one open project carries, each located in the file it names. */
export function projectErrors(sets: ProjectDiagnostics): ProjectErrors {
  const unplaced = (kind: DiagnosticClass): readonly Diagnostic[] =>
    sets.unplaced.filter((diagnostic) => classOf(diagnostic, false) === kind);
  const load = [...sets.configParsing.filter(isError), ...unplaced("load")];
  return {
    load: locatedIn(load, sets.locate),
    check: load.length > 0 ? [] : locatedIn(diagnosticErrors(sets), sets.locate),
    unfound: load.length > 0 ? [] : locatedIn(unplaced("unfound-library"), sets.locate),
  };
}

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { Finding } from "./finding.ts";
import type { Host } from "./host.ts";
import type { InventorySymbol } from "./inventory.ts";
import { joinPath } from "./paths.ts";
import { ledgerOf, UNSCOPED_ENTRY, type Dials } from "./suppress.ts";
import { IGNORE_FILE, readIgnoreFile } from "./suppress-file.ts";

const ROOT = "/target";

/** A target root holding one ignore file and nothing else. */
function hostWith(document: string): Host {
  const held = (path: string): boolean => path === joinPath(ROOT, IGNORE_FILE);
  return {
    workingDirectory: () => ROOT,
    readFile: (path) => (held(path) ? document : ""),
    readDirectory: () => [],
    kindOf: (path) => (held(path) ? "file" : "absent"),
    realPath: (path) => path,
    analyzerVersion: () => "0.0.0-devel",
    temporaryDirectory: () => {
      throw new Error("no temporary directory");
    },
    componentMapperCommand: () => [],
    writeDocument: (path) => {
      throw new Error(`${path}: this host writes nothing`);
    },
  };
}

/** The packages of the drawn target, each in its own directory below the root. */
const PACKAGES = [
  { name: "@example/app", dir: "packages/app" },
  { name: "@example/lib", dir: "packages/lib" },
  { name: "tool", dir: "tools/tool" },
] as const;

const FILES = ["src/index.ts", "src/helper.ts", "lib/helper.ts"] as const;

const NAMES = ["helper", "Box", "Box.open"] as const;

/** One drawn declaration: which package, which of its files, and its name there. */
interface Drawn {
  readonly pkg: number;
  readonly file: number;
  readonly name: number;
}

/** A declaration of the run, with the finding the run holds about it. */
interface Declared {
  readonly symbol: InventorySymbol;
  readonly finding: Finding;
}

/** The declarations a draw places, each on its own line of its file. */
function declarationsOf(drawn: readonly Drawn[]): Declared[] {
  return drawn.map(({ pkg, file, name }, line) => {
    const { name: packageName, dir } = PACKAGES[pkg] ?? PACKAGES[0];
    const source = FILES[file] ?? FILES[0];
    const display = NAMES[name] ?? NAMES[0];
    const path = `${dir}/${source}`;
    const ref = `ts://${packageName}/${source}#${display}`;
    const position = { path, line: line + 1, column: 1 };
    return {
      symbol: {
        id: `${path}:${String(line + 1)}:1`,
        ref,
        name: display,
        kind: "function",
        position,
        endLine: line + 1,
        parent: "",
        exported: false,
        visibility: "public",
        static: false,
      },
      finding: {
        code: "DS1002",
        position: { ...position, endLine: line + 1 },
        symbol: { ref, kind: "function", name: display, sizeLines: 1 },
        message: `${display} is never used`,
      },
    };
  });
}

/** Same-named declarations across packages and files, no two at one reference and path. */
const declarations = fc
  .uniqueArray(
    fc.record({
      pkg: fc.integer({ min: 0, max: PACKAGES.length - 1 }),
      file: fc.integer({ min: 0, max: FILES.length - 1 }),
      name: fc.integer({ min: 0, max: NAMES.length - 1 }),
    }),
    {
      minLength: 2,
      maxLength: 12,
      selector: (one) => `${String(one.pkg)}/${String(one.file)}/${String(one.name)}`,
    },
  )
  .map(declarationsOf);

const OPEN: Dials = { withholdsCode: () => false, withholds: () => false };

/** The findings the ignore file given withholds over the drawn run. */
function withheldBy(
  entry: Readonly<Record<string, string>>,
  declared: readonly Declared[],
): Finding[] {
  const read = readIgnoreFile(
    hostWith(JSON.stringify({ ignore: [entry] })),
    ROOT,
    declared.map((one) => one.symbol),
  );
  const findings = declared.map((one) => one.finding);
  const ledger = ledgerOf(read.records, findings, OPEN);
  return findings.filter((finding) => ledger.withheld(finding));
}

/**
 * Property dead-code-suite/P16: for any set of same-named declarations across files and
 * packages, an ignore entry naming one code, symbol and path withholds that declaration's
 * finding and no other, and an entry naming a symbol with no path matches nothing and is
 * reported.
 */
describe("an ignore entry over same-named declarations", () => {
  const reason = "Reached through a generated table.";

  it("naming one code, symbol and path withholds that finding alone", () => {
    fc.assert(
      fc.property(
        declarations.chain((declared) =>
          fc.tuple(fc.constant(declared), fc.integer({ min: 0, max: declared.length - 1 })),
        ),
        ([declared, at]) => {
          const target = declared[at]?.finding;
          const entry = {
            code: "DS1002",
            symbol: target?.symbol.ref ?? "",
            path: target?.position.path ?? "",
            reason,
          };

          expect(withheldBy(entry, declared)).toEqual([target]);
        },
      ),
    );
  });

  it("naming its symbol under another declaration's path withholds nothing", () => {
    fc.assert(
      fc.property(
        declarations.chain((declared) =>
          fc.tuple(
            fc.constant(declared),
            fc.integer({ min: 0, max: declared.length - 1 }),
            fc.integer({ min: 0, max: declared.length - 1 }),
          ),
        ),
        ([declared, named, placed]) => {
          const symbol = declared[named]?.finding.symbol.ref ?? "";
          const path = declared[placed]?.finding.position.path ?? "";
          fc.pre(
            !declared.some((one) => one.symbol.ref === symbol && one.symbol.position.path === path),
          );

          expect(withheldBy({ code: "DS1002", symbol, path, reason }, declared)).toEqual([]);
        },
      ),
    );
  });

  it("naming a symbol with no path is reported and withholds nothing", () => {
    fc.assert(
      fc.property(
        declarations.chain((declared) =>
          fc.tuple(fc.constant(declared), fc.integer({ min: 0, max: declared.length - 1 })),
        ),
        fc.constantFrom<Readonly<Record<string, string>>>({}, { path: "" }),
        ([declared, at], unscoped) => {
          const symbol = declared[at]?.finding.symbol.ref ?? "";
          const entry = { code: "DS1002", symbol, reason, ...unscoped };
          const read = readIgnoreFile(
            hostWith(JSON.stringify({ ignore: [entry] })),
            ROOT,
            declared.map((one) => one.symbol),
          );

          expect(read.refusals.map((one) => `${one.reported} ${one.symbol}`)).toEqual([
            `${UNSCOPED_ENTRY} ${symbol}`,
          ]);
          expect(withheldBy(entry, declared)).toEqual([]);
        },
      ),
    );
  });
});

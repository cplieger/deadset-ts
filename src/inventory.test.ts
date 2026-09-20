import { describe, expect, it } from "vitest";
import { contractDocument, fixture } from "../__test-helpers__/fixtures.ts";
import { analyzeProject, analyzeRoot } from "../__test-helpers__/projects.ts";
import type { InventorySymbol, Visibility } from "./inventory.ts";
import { positionKey } from "./position.ts";
import { isRef } from "./ref.ts";

/**
 * The fixture holding one instance of every declaration form, enumerated once for
 * every case in this file: opening a compiler client and a snapshot is the expensive
 * part of a run, and every case here reads the same inventory.
 */
const EVERY_DECLARATION = analyzeRoot(fixture("projects", "every-declaration"));
const INVENTORY = EVERY_DECLARATION.inventories[0];
const SYMBOLS: readonly InventorySymbol[] = INVENTORY?.symbols ?? [];

/** The golden table: one symbol per line, so a diff names the declarations that moved. */
function goldenText(symbols: readonly InventorySymbol[]): string {
  const rows = symbols.map((symbol) =>
    JSON.stringify({
      id: symbol.id,
      kind: symbol.kind,
      name: symbol.name,
      ref: symbol.ref,
      parent: symbol.parent,
      endLine: symbol.endLine,
      exported: symbol.exported,
      visibility: symbol.visibility,
      static: symbol.static,
    }),
  );
  return `[\n${rows.map((row) => `  ${row}`).join(",\n")}\n]\n`;
}

function named(name: string): InventorySymbol | undefined {
  return SYMBOLS.find((symbol) => symbol.name === name);
}

/** The symbols whose table was read a second time, which must be none of them. */
function readTwice(names: readonly string[]): string[] {
  return names.filter((name, index) => names.indexOf(name) !== index);
}

describe("the symbol table of every declaration form", () => {
  it("is the committed golden table, symbol for symbol", async () => {
    await expect(
      goldenText(SYMBOLS),
      "the table is produced by the production path; to record a reviewed change run " +
        "`npx vitest --run -u src/inventory.test.ts` and read the diff as production code",
    ).toMatchFileSnapshot(fixture("golden", "every-declaration.symbols.json"));
  });

  it("names every declaration form the analyzer enumerates", () => {
    expect([...new Set(SYMBOLS.map((symbol) => symbol.kind))].sort()).toEqual([
      "class",
      "class-member",
      "enum",
      "enum-member",
      "export-alias",
      "file",
      "function",
      "interface",
      "interface-method",
      "method",
      "namespace",
      "type",
      "type-member",
      "type-parameter",
      "variable",
    ]);
  });

  it("holds each declaration form exported and not exported", () => {
    const forms = new Map<string, Set<boolean>>();
    for (const symbol of SYMBOLS) {
      if (symbol.parent === "" || symbol.kind === "type-parameter") {
        continue;
      }
      const held = forms.get(symbol.kind) ?? new Set<boolean>();
      held.add(symbol.exported);
      forms.set(symbol.kind, held);
    }

    for (const kind of [
      "function",
      "class",
      "interface",
      "type",
      "enum",
      "namespace",
      "variable",
    ]) {
      expect([...(forms.get(kind) ?? [])].sort(), `${kind} in both visibilities`).toEqual([
        false,
        true,
      ]);
    }
  });

  it("keys each declaration by its own position, one declaration per source site", () => {
    expect(SYMBOLS.map((symbol) => symbol.id)).toEqual(
      SYMBOLS.map((symbol) => positionKey(symbol.position)),
    );
    expect(new Set(SYMBOLS.map((symbol) => symbol.id)).size).toBe(SYMBOLS.length);
  });

  it("renders every reference in the grammar's canonical spelling", () => {
    expect(SYMBOLS.filter((symbol) => !isRef(symbol.ref)).map((symbol) => symbol.ref)).toEqual([]);
  });

  it("names the container of every declaration but a file", () => {
    const ids = new Set(SYMBOLS.map((symbol) => symbol.id));
    const files = new Set(SYMBOLS.filter((symbol) => symbol.kind === "file").map((s) => s.id));

    expect(SYMBOLS.filter((symbol) => symbol.parent === "").map((symbol) => symbol.id)).toEqual([
      ...files,
    ]);
    expect(
      SYMBOLS.filter((symbol) => symbol.parent !== "" && !ids.has(symbol.parent)),
      "a parent names a symbol of this inventory",
    ).toEqual([]);
  });

  it("reads one table per container, measured where the read crosses the boundary", () => {
    const members = SYMBOLS.filter((symbol) =>
      ["class-member", "method", "type-member", "interface-method", "enum-member"].includes(
        symbol.kind,
      ),
    );

    // A type alias is absent because it has no symbol table of its own: its members
    // belong to the object type its declaration writes, so the declaration is what
    // carries them and no read is made for it. The class a module exports as its
    // default is named for the export, which is the name the binder holds it under.
    expect([...EVERY_DECLARATION.tableReads.members].sort()).toEqual([
      "Event",
      "ExportedClass",
      "ExportedInterface",
      "UnexportedClass",
      "UnexportedInterface",
      "default",
    ]);
    // Three modules, three namespaces, two enums, and three classes for the static
    // members a class keeps in a second table.
    expect(EVERY_DECLARATION.tableReads.exports.length).toBe(11);
    expect(readTwice(EVERY_DECLARATION.tableReads.members), "one members table each").toEqual([]);
    expect(readTwice(EVERY_DECLARATION.tableReads.exports), "one exports table each").toEqual([]);
    expect(members.length, "far more members than tables read").toBeGreaterThan(20);
  });

  it("reports the reads it made, which is one batch and the tables measured above", () => {
    const { members, exports } = EVERY_DECLARATION.tableReads;

    expect(INVENTORY?.cost).toEqual({ batches: 1, exportTables: 6, memberTables: 11 });
    expect(
      (INVENTORY?.cost.memberTables ?? 0) + (INVENTORY?.cost.exportTables ?? 0),
      "the reported cost is the number of table reads the client boundary saw",
    ).toBe(members.length + exports.length);
  });

  it("records the module a bare star re-export names, and enumerates none of its names", () => {
    expect(INVENTORY?.starReExports).toEqual(["./more.ts"]);
    expect(
      SYMBOLS.filter(
        (symbol) => symbol.position.path === "src/index.ts" && symbol.name === "alsoExported",
      ),
      "a name a star re-export carries forward is the other module's declaration",
    ).toEqual([]);
  });

  it("leaves no declaration out because its file is another program's", () => {
    expect(INVENTORY?.outsideOwnFiles).toBe(0);
  });
});

describe("a class member", () => {
  it.each([
    { member: "ExportedClass.count", visibility: "public", isStatic: true },
    { member: "ExportedClass.plain", visibility: "public", isStatic: false },
    { member: "ExportedClass.guarded", visibility: "protected", isStatic: false },
    { member: "ExportedClass.hidden", visibility: "private", isStatic: false },
    { member: "ExportedClass.tracked", visibility: "public", isStatic: false },
    { member: "ExportedClass.#frame", visibility: "private-name", isStatic: false },
    { member: "ExportedClass.size", visibility: "public", isStatic: false },
  ])("enumerates $member as $visibility", ({ member, visibility, isStatic }) => {
    const found = named(member);

    expect(found?.visibility, member).toBe(visibility);
    expect(found?.static, member).toBe(isStatic);
  });

  it("enumerates a member whose key is computed, which no symbol table holds", () => {
    const found = named("ExportedClass.[Symbol.toStringTag]");

    expect(found?.kind).toBe("class-member");
    expect(found?.ref).toBe(
      "ts://@example/every-declaration/src/declarations.ts#ExportedClass.[Symbol.toStringTag]",
    );
  });

  it("makes one symbol of a getter and a setter of one name, spanning both", () => {
    const found = named("ExportedClass.size");

    expect(SYMBOLS.filter((symbol) => symbol.name === "ExportedClass.size").length).toBe(1);
    expect(found?.position.line).toBe(41);
    expect(found?.endLine, "the record spans the setter too").toBe(47);
  });

  it("marks a static member in its reference and an instance member not at all", () => {
    expect(named("ExportedClass.count")?.ref).toBe(
      "ts://@example/every-declaration/src/declarations.ts#ExportedClass.count:static",
    );
    expect(named("ExportedClass.plain")?.ref).toBe(
      "ts://@example/every-declaration/src/declarations.ts#ExportedClass.plain",
    );
  });

  it("carries no export of its own, because a member is not a module export", () => {
    expect(
      SYMBOLS.filter((symbol) => symbol.kind === "class-member" || symbol.kind === "method").every(
        (symbol) => !symbol.exported,
      ),
      "a class member's reach outside its module is its visibility and its container's",
    ).toBe(true);
  });
});

describe("the two private facts", () => {
  it("records a private modifier and a private name as two different visibilities", () => {
    const visibilities = new Set<Visibility>([
      named("ExportedClass.hidden")?.visibility ?? "public",
      named("ExportedClass.#frame")?.visibility ?? "public",
    ]);

    expect([...visibilities].sort()).toEqual(["private", "private-name"]);
  });

  it("is the distinction the Contract's exemption classes need, class by class", () => {
    const exemptions = contractDocument("exemptions.json")["exemptions"] as {
      class: string;
      typescript_visibility?: { private: boolean; private_name: boolean };
    }[];
    const reaching = exemptions.filter((entry) => entry.typescript_visibility !== undefined);

    expect(reaching.length, "the Contract states the reach of every TypeScript class").toBe(8);
    expect(
      reaching.filter((entry) => entry.typescript_visibility?.private_name === true),
      "no class reaches a private name, so the two facts can never be collapsed",
    ).toEqual([]);
    expect(
      reaching
        .filter((entry) => entry.typescript_visibility?.private === true)
        .map((entry) => entry.class)
        .sort(),
      "the classes that reach a member by name reach a private modifier",
    ).toEqual([
      "decorator",
      "framework-lifecycle",
      "injection-container",
      "reflective-lookup",
      "serialization-contract",
      "template-field",
    ]);
  });
});

describe("a type alias that writes more than one object type", () => {
  it("enumerates each constituent's members, and no name two constituents share", () => {
    const analyzed = analyzeProject({
      "src/unit.ts":
        "export type Union = { only: number; shared: string } | { other: boolean; shared: string };\n" +
        "export type Crossed = { left: number } & { right: number };\n" +
        "export type Named = Union & { own: number };\n",
    });

    expect(
      (analyzed.inventories[0]?.symbols ?? [])
        .filter((symbol) => symbol.kind === "type-member")
        .map((symbol) => symbol.name)
        .sort(),
      "a name both constituents of Union declare is the alias's, so neither is named",
    ).toEqual(["Crossed.left", "Crossed.right", "Named.own", "Union.only", "Union.other"]);
  });
});

describe("the files the inventory reads", () => {
  it("names no compiler library file and no file of a dependency directory", () => {
    const analyzed = analyzeProject({
      "package.json":
        '{\n  "name": "@example/holder",\n  "private": true,\n  "version": "1.0.0"\n}\n',
      "node_modules/@example/dep/package.json":
        '{\n  "name": "@example/dep",\n  "version": "1.0.0",\n  "types": "./index.d.ts"\n}\n',
      "node_modules/@example/dep/index.d.ts": "export interface Dependency {\n  seq: number;\n}\n",
      "src/unit.ts":
        'import type { Dependency } from "@example/dep";\n\nexport const held: Dependency = { seq: 0 };\n',
    });
    const held = analyzed.inventories[0];

    expect(
      analyzed.programFiles.some((file) => /lib\..*\.d\.ts$/u.test(file)),
      "the program holds the compiler's own library files",
    ).toBe(true);
    expect(
      analyzed.programFiles.some((file) => file.includes("/node_modules/")),
      "the program holds the dependency the source imports",
    ).toBe(true);
    expect([...new Set(held?.symbols.map((symbol) => symbol.position.path))]).toEqual([
      "src/unit.ts",
    ]);
    expect(held?.symbols.map((symbol) => symbol.name)).toEqual(["src/unit.ts", "held"]);
  });

  it("scopes each file by the nearest manifest that names a package", () => {
    const analyzed = analyzeProject({
      "package.json":
        '{\n  "name": "@example/outer",\n  "private": true,\n  "version": "1.0.0"\n}\n',
      "src/outer.ts": "export const outer = 0;\n",
      "inner/package.json":
        '{\n  "name": "@example/inner",\n  "private": true,\n  "version": "1.0.0"\n}\n',
      "inner/src/inner.ts": "export const inner = 0;\n",
    });

    expect(analyzed.inventories[0]?.symbols.map((symbol) => symbol.ref).sort()).toEqual([
      "ts://@example/inner/src/inner.ts#",
      "ts://@example/inner/src/inner.ts#inner",
      "ts://@example/outer/src/outer.ts#",
      "ts://@example/outer/src/outer.ts#outer",
    ]);
  });

  it("scopes a file by the target root where no manifest above it names a package", () => {
    const analyzed = analyzeProject({ "src/unit.ts": "export const held = 0;\n" });

    expect(analyzed.inventories[0]?.symbols.map((symbol) => symbol.ref)).toEqual([
      "ts://./src/unit.ts#",
      "ts://./src/unit.ts#held",
    ]);
  });
});

/**
 * Two records of one run, declared and never constructed: the function below is
 * never called, and the compiler is where its assertion is made.
 */
declare const oneProject: InventorySymbol;
declare const anotherProject: InventorySymbol;

/**
 * A record carries the rendered position and no handle, so a comparison across two
 * projects has nothing of either project's program to key on. Giving a record a
 * handle, or keying the comparison on one, is an error of its own here.
 */
function crossProjectComparison(): boolean {
  // @ts-expect-error a declaration of the inventory carries no handle to compare
  return oneProject.handle === anotherProject.handle;
}

describe("one declaration in two projects", () => {
  it("is compared on the rendered position, which is the only identifier it carries", () => {
    expect(typeof crossProjectComparison).toBe("function");
  });

  it("is one key, because the comparison is on the rendered position", () => {
    const analyzed = analyzeRoot(fixture("projects", "two-projects"));
    const [app, core] = analyzed.inventories;
    const shared = (inventory: (typeof analyzed.inventories)[number] | undefined): string[] =>
      (inventory?.symbols ?? [])
        .filter((symbol) => symbol.position.path === "core/catalog.ts")
        .map((symbol) => `${symbol.id} ${symbol.ref}`);

    expect(analyzed.inventories.length, "the fixture holds two projects").toBe(2);
    expect(shared(app).length, "the referencing project builds the shared file too").toBe(3);
    expect(shared(app)).toEqual(shared(core));
  });
});

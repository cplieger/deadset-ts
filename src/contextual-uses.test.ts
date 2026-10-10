import { rmSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { emitterInputOf, findingsOf } from "../__test-helpers__/emitter-input.ts";
import { writeProject } from "../__test-helpers__/projects.ts";
import { resolve } from "./resolve.ts";

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true });
  }
});

/** Each finding of an application rooted at `src/main.ts`, as its code, subject, line and message. */
function findings(files: Readonly<Record<string, string>>): string[] {
  const root = writeProject({
    "package.json": '{ "name": "@example/app", "type": "module", "main": "./src/main.ts" }\n',
    ...files,
  });
  roots.push(root);
  const { config } = resolve({
    repository: '{ "target": { "kind": "application" } }',
    repositoryLabel: "deadset.json",
  });
  return findingsOf(emitterInputOf(root, config)).map(
    ({ code, symbol, position, message }) =>
      `${code} ${symbol.name} ${String(position.line)}: ${message}`,
  );
}

describe("the uses a contextual type makes", () => {
  it("writes the member of the contextual type each object-literal property names", () => {
    expect(
      findings({
        "src/main.ts":
          'interface Row {\n  label: string;\n  note: string;\n}\nconst row: Row = { label: "a", note: "" };\nconsole.log(row.label);\n',
      }),
    ).toEqual(["DS1301 Row.note 3: type member Row.note is written once and never read"]);
  });

  it("writes the member of every union constituent that declares the property", () => {
    expect(
      findings({
        "src/main.ts":
          'interface Circle {\n  kind: "circle";\n  size: number;\n}\ninterface Square {\n  kind: "square";\n  size: number;\n}\nconst shape: Circle | Square = { kind: "circle", size: 1 };\nconsole.log(shape.kind);\n',
      }),
    ).toEqual([
      "DS1301 Circle.size 3: type member Circle.size is written once and never read",
      "DS1301 Square.kind 6: type member Square.kind is written once and never read",
      "DS1301 Square.size 7: type member Square.size is written once and never read",
    ]);
  });

  it("reads the member a satisfies target declares wherever the literal property checked against it is read", () => {
    expect(
      findings({
        "src/main.ts":
          'interface Options {\n  name: string;\n  size: number;\n}\nconst options = { name: "a", size: 1 } satisfies Options;\nconsole.log(options.name);\n',
      }),
    ).toEqual(["DS1301 Options.size 3: type member Options.size is written once and never read"]);
  });

  it("reads each member of a value that the object type of the position it reaches declares", () => {
    expect(
      findings({
        "src/main.ts":
          "interface Source {\n  id: number;\n  extra: number;\n}\ninterface Target {\n  id: number;\n}\nfunction take(target: Target): number {\n  return target.id;\n}\nconst source: Source = { id: 1, extra: 2 };\nconsole.log(take(source));\n",
      }),
    ).toEqual(["DS1301 Source.extra 3: type member Source.extra is written once and never read"]);
  });

  it("reads the members a position declares through the elements of an array", () => {
    expect(
      findings({
        "src/main.ts":
          'interface Key {\n  order: number;\n}\ninterface Tab {\n  order: number;\n  title: string;\n}\nfunction first(keys: readonly Key[]): number {\n  return keys[0]?.order ?? 0;\n}\nconst tabs: Tab[] = [{ order: 2, title: "b" }];\nconsole.log(first(tabs));\n',
      }),
    ).toEqual(["DS1301 Tab.title 6: type member Tab.title is written once and never read"]);
  });

  it("reads the members a position declares through array elements nested at any depth", () => {
    expect(
      findings({
        "src/main.ts":
          'interface Key {\n  order: number;\n}\ninterface Tab {\n  order: number;\n  title: string;\n}\nfunction first(keys: readonly (readonly (readonly (readonly Key[])[])[])[]): number {\n  return keys[0]?.[0]?.[0]?.[0]?.order ?? 0;\n}\nconst tabs: Tab[][][][] = [[[[{ order: 2, title: "b" }]]]];\nconsole.log(first(tabs));\n',
      }),
    ).toEqual(["DS1301 Tab.title 6: type member Tab.title is written once and never read"]);
  });

  it("reads the members a function's parameter declares from the values the position passes it", () => {
    expect(
      findings({
        "src/main.ts":
          'interface Key {\n  order: number;\n}\ninterface Tab {\n  order: number;\n  title: string;\n}\nfunction byOrder(a: Key, b: Key): number {\n  return a.order - b.order;\n}\nconst tabs: Tab[] = [{ order: 2, title: "b" }];\nconsole.log([...tabs].sort(byOrder).length);\n',
      }),
    ).toEqual(["DS1301 Tab.title 6: type member Tab.title is written once and never read"]);
  });

  it("reads no member of a value a type assertion names another object type", () => {
    expect(
      findings({
        "src/main.ts":
          "interface Source {\n  id: number;\n  extra: number;\n}\ninterface Target {\n  id: number;\n}\nconst source: Source = { id: 1, extra: 2 };\nconst target = source as Target;\nconsole.log(target.id);\n",
      }),
    ).toEqual([
      "DS1301 Source.id 2: type member Source.id is written once and never read",
      "DS1301 Source.extra 3: type member Source.extra is written once and never read",
    ]);
  });

  it("reads no member of a value whose type is itself one of the position's object types", () => {
    expect(
      findings({
        "src/main.ts":
          "interface Wide {\n  shared: number;\n  label?: string;\n}\ninterface Narrow {\n  shared: number;\n  label?: string;\n}\nfunction size(options: Wide | Narrow): number {\n  return options.shared;\n}\nconst wide: Wide = { shared: 1 };\nconsole.log(size(wide));\n",
      }),
    ).toEqual([
      "DS1003 Wide.label 3: type member has no reference in the target",
      "DS1003 Narrow.label 7: type member has no reference in the target",
    ]);
  });

  it("reads each member of a target type that a value of a type declared outside the target declares", () => {
    expect(
      findings({
        "src/main.ts":
          'interface Problem {\n  message: string;\n  code?: number;\n}\nconst problem: Problem = new Error("failed");\nproblem.message = "failed again";\nproblem.code = 1;\n',
      }),
    ).toEqual(["DS1301 Problem.code 3: type member Problem.code is written once and never read"]);
  });

  it("names an import only the written values use as deleted with the member", () => {
    expect(
      findings({
        "src/seed.ts": 'export const seed = "s";\n',
        "src/main.ts":
          'import { seed } from "./seed.ts";\n\ninterface Row {\n  label: string;\n  note: string;\n}\nconst row: Row = { label: "a", note: seed };\nconsole.log(row.label);\n',
      }),
    ).toEqual([
      "DS1301 Row.note 5: type member Row.note is written once and never read, and deleting it with its writes deletes import seed too",
    ]);
  });
});

describe("a constructor reaching a constructor type", () => {
  it("reaches through its construct signature, so an outside class reads the members of the target's instance type", () => {
    expect(
      findings({
        "node_modules/@example/platform/package.json":
          '{ "name": "@example/platform", "version": "1.0.0", "types": "./index.d.ts" }\n',
        "node_modules/@example/platform/index.d.ts":
          "export declare class Toast {\n  constructor(title: string);\n  onclick: (() => void) | null;\n  close(): void;\n}\n",
        "src/main.ts":
          'import { Toast } from "@example/platform";\n\ninterface ToastLike {\n  onclick: (() => void) | null;\n  close: () => void;\n}\n\nconst ctor: new (title: string) => ToastLike = Toast;\nconst shown = new ctor("hello");\nshown.onclick = (): void => {};\nshown.close();\n',
      }),
    ).toEqual([]);
  });
});

describe("an object spread", () => {
  it("reads a member a later property overwrites, since the copy gets it first", () => {
    expect(
      findings({
        "src/main.ts":
          'interface Row {\n  readonly value: string;\n}\nconst row: Row = {\n  get value(): string {\n    return "x";\n  },\n};\nconst copy = { ...row, value: "y" };\nconsole.log(copy.value);\n',
      }),
    ).toEqual([]);
  });

  it("reads a member it copies into the same declaration of the literal's contextual type", () => {
    expect(
      findings({
        "src/main.ts":
          'interface Row {\n  readonly value: string;\n}\nconst row: Row = {\n  get value(): string {\n    return "x";\n  },\n};\nconst copy: Row = { ...row };\nconsole.log(copy === row);\n',
      }),
    ).toEqual([]);
  });

  it("reads a class instance's fields, and neither its methods, its accessors nor its private names", () => {
    expect(
      findings({
        "src/main.ts":
          'class Counter {\n  count = 1;\n  #hidden = 2;\n  get stale(): number {\n    return 3;\n  }\n  reset(): number {\n    return 0;\n  }\n}\nconst copied = { kind: "ok", ...new Counter() };\nconsole.log(copied.kind);\n',
      }),
    ).toEqual([
      "DS1003 Counter.#hidden 3: private class member has no reference in the target",
      "DS1003 Counter.stale 4: class member has no reference in the target",
      "DS1003 Counter.reset 7: method has no reference in the target",
    ]);
  });

  it("reads every member of an interface value it spreads", () => {
    expect(
      findings({
        "src/main.ts":
          'interface Position {\n  readonly epoch: string;\n  readonly head: string;\n}\nfunction position(): Position {\n  return { epoch: "1", head: "2" };\n}\nconst copied = { kind: "ok", ...position() };\nconsole.log(copied.kind);\n',
      }),
    ).toEqual([]);
  });
});

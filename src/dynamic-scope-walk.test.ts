import { describe, expect, it } from "vitest";
import { SyntaxKind, type Node } from "@typescript/native/ast";
import { sitesOf } from "./index/sites.ts";
import { descendants } from "./namespace-objects.ts";
import { openEngine } from "./session.ts";

const engine = openEngine({ collectTiming: false });

const DEC = "function dec(...args: unknown[]): any {\n  return () => args;\n}\n";

/**
 * A file that holds each kind of syntax a scope can hold code in, a direct eval in every place
 * that evaluates an expression: decorators of every member and parameter, computed names,
 * parameter defaults, field initializers, static blocks, type positions and the statement and
 * expression grammar.
 */
const MODULE = `${DEC}import type { T0 } from "./t.js";
import * as ns from "./ns.js";
import def, { a as b } from "./d.js";
import eq = require("./eq.js");
export * from "./all.js";
export * as star from "./star.js";
export { b as c };
declare module "./ambient.js" {
  export const x: number;
}
declare global {
  var g: number;
}
namespace N {
  export const n = eval("1");
}
enum E {
  A = 1,
  B = A << 1,
}
const enum CE {
  X,
}
type U = keyof typeof ns | (typeof eq)["x"] | \`t\${string}\` | [first: string, ...rest: number[]];
type C<V> = V extends Promise<infer W> ? W : never;
type M<V> = { readonly [K in keyof V]?: V[K] };
type F = new (a: string) => void;
interface I<V extends object = {}> extends Partial<V> {
  (x: number): string;
  new (x: string): I;
  [key: string]: unknown;
  method?(this: I): asserts this is I;
  readonly p: unique symbol;
}
abstract class Base {
  abstract m(): void;
}
@dec(eval("1"))
class K<V> extends Base implements Partial<I> {
  @dec(eval("2")) field = eval("3");
  static s = eval("4");
  #hidden = 1;
  declare d: number;
  accessor auto = 1;
  [eval("5")] = 6;
  static {
    eval("7");
  }
  constructor(@dec(eval("8")) private readonly v: V, w = eval("9")) {
    super();
    console.log(this.#hidden, w, new.target, import.meta);
  }
  @dec(eval("10")) get x(): number {
    return 1;
  }
  set x(value: number) {}
  @dec(eval("11")) m(@dec(eval("12")) p = eval("13")): void {}
  *gen(): Generator<number> {
    yield 1;
    yield* [2];
  }
  async run(): Promise<void> {
    await eval("14");
    for await (const one of [] as AsyncIterable<number>[]) {
      console.log(one);
    }
  }
}
function over(a: string): void;
function over(a: number): void;
function over(a: unknown, { q = eval("15") }: { q?: unknown } = {}, ...rest: unknown[]): void {
  label: for (let i = 0; i < 1; i++) {
    if (i) continue label;
    else break label;
  }
  for (const k in {}) {}
  for (const v of []) {}
  do {} while (false);
  while (false) {}
  switch (a) {
    case 1:
      break;
    default:
  }
  try {
    throw new Error();
  } catch ({ message }) {
    console.log(message);
  } finally {
    debugger;
  }
  using u = null;
  const tagged = String.raw\`x\${eval("16")}\`;
  const re = /x/g;
  const big = 1n;
  const o = { a, ...rest, [eval("17")]: 1, get g() { return 1; }, set g(v) {}, m() {} };
  const [p0 = eval("18"), , ...ps] = [1];
  const cls = class {};
  const arrow = async (z = eval("19")) => z;
  void (typeof o, delete o.a, a in o, a instanceof Object, (0, a), a ? a : a, a ?? a, o?.a, o!.a);
  const asserted = (a as number) satisfies number;
  console.log(tagged, re, big, p0, ps, cls, arrow, asserted, eval("20"));
}
export default K;
export = over;
`;

/** A script that holds a `with` statement, a direct eval in its object and its body. */
const SCRIPT = `var o = {};
with (eval("o")) {
  eval("1");
}
`;

/** A component file that holds the markup grammar, a direct eval in attributes and children. */
const COMPONENT = `const props = { a: 1 };
export const view = (
  <>
    <div id={eval("1")} {...props}>
      {eval("2")}
      <span />
    </div>
  </>
);
`;

/** Every node below one node, by a plain recursive `forEachChild`. */
function plain(root: Node): readonly Node[] {
  const found: Node[] = [];
  const visit = (node: Node): void => {
    found.push(node);
    node.forEachChild(visit);
  };
  root.forEachChild(visit);
  return found;
}

const FILES = [
  ["/project/m.ts", MODULE],
  ["/project/s.js", SCRIPT],
  ["/project/c.tsx", COMPONENT],
] as const;

describe("the dynamic-scope scans", () => {
  it("hold every kind of syntax a scope can evaluate code in", () => {
    const kinds = new Set(
      FILES.flatMap(([name, text]) => plain(engine.parseSourceFile(name, text))).map(
        (node) => node.kind,
      ),
    );
    for (const kind of [
      SyntaxKind.Decorator,
      SyntaxKind.ComputedPropertyName,
      SyntaxKind.Parameter,
      SyntaxKind.PropertyDeclaration,
      SyntaxKind.ClassStaticBlockDeclaration,
      SyntaxKind.Constructor,
      SyntaxKind.GetAccessor,
      SyntaxKind.SetAccessor,
      SyntaxKind.MethodDeclaration,
      SyntaxKind.TypeQuery,
      SyntaxKind.IndexedAccessType,
      SyntaxKind.ConditionalType,
      SyntaxKind.MappedType,
      SyntaxKind.TemplateLiteralType,
      SyntaxKind.ModuleDeclaration,
      SyntaxKind.EnumDeclaration,
      SyntaxKind.WithStatement,
      SyntaxKind.LabeledStatement,
      SyntaxKind.TryStatement,
      SyntaxKind.TaggedTemplateExpression,
      SyntaxKind.ObjectBindingPattern,
      SyntaxKind.ArrayBindingPattern,
      SyntaxKind.JsxAttribute,
      SyntaxKind.JsxSpreadAttribute,
      SyntaxKind.JsxExpression,
      SyntaxKind.JsxFragment,
    ]) {
      expect(kinds.has(kind), SyntaxKind[kind]).toBe(true);
    }
  });

  it("visit exactly the nodes a plain recursive forEachChild visits, in its order", () => {
    for (const [name, text] of FILES) {
      const file = engine.parseSourceFile(name, text);
      expect(descendants(file), name).toEqual(plain(file));
      for (const node of plain(file)) {
        expect(descendants(node), `${name} ${SyntaxKind[node.kind]}`).toEqual(plain(node));
      }
    }
  });

  it("find each direct eval of a file, one in a subtree the walk reads no use from included", () => {
    for (const [name, text] of FILES) {
      const file = engine.parseSourceFile(name, text);
      const offered: Node[] = [];
      const unread = plain(file).filter((node) =>
        [SyntaxKind.ClassDeclaration, SyntaxKind.WithStatement, SyntaxKind.JsxElement].includes(
          node.kind,
        ),
      );
      expect(unread.length, name).toBeGreaterThan(0);
      const sites = sitesOf(file, new Map(), "file", new Set(unread), (node) => {
        offered.push(node);
      });
      expect(offered, name).toEqual(plain(file));
      expect(sites.dynamics.length, name).toBe(text.split('eval("').length - 1);
    }
  });
});

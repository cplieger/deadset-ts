/**
 * The reflective-lookup class: a member is held back, at the lowest confidence, when
 * a string literal equal to its name is the key of an element access or the property
 * key of a `Reflect.get`, `Reflect.set` or `Reflect.has` call, because the member is
 * then read by a name the program computes nowhere the reference pass can follow.
 *
 * The evidence is a string beside a lookup rather than a type relation, so the
 * string reaches every member of that name on any type, static members included,
 * and every record names the string's own position. A key that is not literal text
 * holds nothing back: a computed name is the case no exact rule serves. `Reflect` is
 * the global one only: a local declaration of that name is a different object.
 */

import {
  isCallExpression,
  isElementAccessExpression,
  isIdentifier,
  isNoSubstitutionTemplateLiteral,
  isPropertyAccessExpression,
  isStringLiteral,
  type Node,
  type SourceFile,
} from "@typescript/native/unstable/ast";
import type { DetectorInput, Evidence } from "./exempt.ts";
import { memberNames } from "./member-names.ts";
import { renderPosition } from "./position.ts";

/** The `Reflect` methods whose second argument is a property key. */
const REFLECT_KEYED: ReadonlySet<string> = new Set(["get", "set", "has"]);

/** One literal key at one lookup, and how the lookup is spelled in a record. */
interface Lookup {
  readonly key: Node;
  readonly name: string;
  readonly callee: string;
  /** The `Reflect` the call names, where the lookup is a `Reflect` call. */
  readonly reflect: Node | undefined;
}

/** The text one key denotes, where it is literal text. */
function literalText(node: Node | undefined): string | undefined {
  if (node !== undefined && (isStringLiteral(node) || isNoSubstitutionTemplateLiteral(node))) {
    return node.text;
  }
  return undefined;
}

/** Every lookup one file writes with a literal key, in source order. */
function lookupsOf(file: SourceFile): readonly Lookup[] {
  const found: Lookup[] = [];
  const visit = (node: Node): void => {
    if (isElementAccessExpression(node)) {
      const name = literalText(node.argumentExpression);
      if (name !== undefined) {
        found.push({
          key: node.argumentExpression,
          name,
          callee: `[${JSON.stringify(name)}]`,
          reflect: undefined,
        });
      }
    } else if (isCallExpression(node) && isPropertyAccessExpression(node.expression)) {
      const target = node.expression.expression;
      const method = node.expression.name;
      const key = node.arguments[1];
      const name = literalText(key);
      if (
        isIdentifier(target) &&
        target.text === "Reflect" &&
        isIdentifier(method) &&
        REFLECT_KEYED.has(method.text) &&
        key !== undefined &&
        name !== undefined
      ) {
        found.push({ key, name, callee: `Reflect.${method.text}`, reflect: target });
      }
    }
    node.forEachChild(visit);
  };
  file.forEachChild(visit);
  return found;
}

/**
 * The reflective-lookup detector: every member whose name a literal key of a lookup
 * spells, recorded at the key.
 */
export function reflectiveLookup<Brand>(input: DetectorInput<Brand>): readonly Evidence[] {
  const { project, held, targetRoot } = input;
  const files = project.ownSourceFiles();
  const lookups = files.flatMap(lookupsOf);
  if (lookups.length === 0) {
    return [];
  }

  // Whether each written `Reflect` is the global one, asked in one batch: a
  // declaration of that name in one of the project's own files shadows it.
  const ownFiles = new Set(files.map((file) => file.fileName));
  const reflects = lookups.flatMap((lookup) =>
    lookup.reflect === undefined ? [] : [lookup.reflect],
  );
  const global = new Set<Node>();
  if (reflects.length > 0) {
    project.symbolsAt(reflects.map((node) => project.handle(node))).forEach((symbol, index) => {
      const node = reflects[index];
      const declaredHere = symbol?.declarations.some((declaration) =>
        ownFiles.has(declaration.path),
      );
      if (node !== undefined && declaredHere === false) {
        global.add(node);
      }
    });
  }

  const members = memberNames(files, held);
  const found: Evidence[] = [];
  for (const lookup of lookups) {
    if (lookup.reflect !== undefined && !global.has(lookup.reflect)) {
      continue;
    }
    const site = renderPosition(lookup.key.getSourceFile(), targetRoot, lookup.key.getStart());
    for (const member of members.get(lookup.name) ?? []) {
      found.push({ id: member.id, detail: `looked up by ${lookup.callee}`, site });
    }
  }
  return found;
}

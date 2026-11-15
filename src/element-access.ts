/**
 * The members an element access reads by the literal type of its index (`references-ts.25`):
 * `o[k]` with `k` typed `"a" | "b"` reads `a` and `b` of the type of `o`, an index typed
 * `keyof T` reads every member of `T`, and an index typed as a type parameter reads what its
 * constraint admits. Where the index is a parameter of a function every call of which the
 * target holds, the members are read at each call, by the type of the argument it passes.
 */

import {
  isArrowFunction,
  isBinaryExpression,
  isCallExpression,
  isElementAccessExpression,
  isFunctionDeclaration,
  isFunctionExpression,
  isIdentifier,
  isNoSubstitutionTemplateLiteral,
  isNumericLiteral,
  isParenthesizedExpression,
  isPostfixUnaryExpression,
  isPrefixUnaryExpression,
  isStringLiteral,
  isVariableDeclaration,
  isVariableDeclarationList,
  isVariableStatement,
  NodeFlags,
  SyntaxKind,
  type CallExpression,
  type ElementAccessExpression,
  type Expression,
  type Identifier,
  type Node,
  type ParameterDeclaration,
  type SourceFile,
} from "@typescript/native/ast";
import { TypeFlags, type Type } from "@typescript/native/sync";
import { isAnswered, UNANSWERED, type Answer, type Queries } from "./query.ts";
import type { Read, ReadRule } from "./references/read-rule.ts";
import { assigns, COMPOUND, parenthesesRemoved } from "./unwrap.ts";

type Use = "read" | "write" | "both";

/** How an expression is used where it is written: read, written, or both. */
function useOf(node: Node): Use {
  let at = node;
  while (isParenthesizedExpression(at.parent)) {
    at = at.parent;
  }
  const parent = at.parent;
  if (isBinaryExpression(parent) && parent.left === at) {
    if (parent.operatorToken.kind === SyntaxKind.EqualsToken) {
      return "write";
    }
    if (COMPOUND.has(parent.operatorToken.kind)) {
      return "both";
    }
  }
  if (
    (isPrefixUnaryExpression(parent) || isPostfixUnaryExpression(parent)) &&
    (parent.operator === SyntaxKind.PlusPlusToken || parent.operator === SyntaxKind.MinusMinusToken)
  ) {
    return "both";
  }
  return "read";
}

/** Whether an index is a literal the checker resolves to a member by its own text. */
function isLiteralIndex(node: Expression): boolean {
  const at = parenthesesRemoved(node);
  return isStringLiteral(at) || isNumericLiteral(at) || isNoSubstitutionTemplateLiteral(at);
}

/** Whether an index is string literal text. */
function isStringIndex(node: Expression): boolean {
  const at = parenthesesRemoved(node);
  return isStringLiteral(at) || isNoSubstitutionTemplateLiteral(at);
}

/**
 * Whether a receiver's type is not `any` and declares a string index signature: there a
 * string literal index reads the signature, so this rule reads the member it names and
 * reflective-lookup holds nothing back. A type whose index signatures the checker did not
 * answer for declares none. Both sides call this one predicate, so no lookup falls between.
 */
export function readsAMapping(queries: Queries, type: Type): boolean {
  if ((type.flags & TypeFlags.Any) !== 0) {
    return false;
  }
  const infos = queries.indexInfosOf(type);
  return isAnswered(infos) && infos.some((info) => (info.keyType.flags & TypeFlags.String) !== 0);
}

/** A function whose calls may decide an access, by the name its calls spell. */
interface Callable {
  readonly name: Identifier;
  readonly parameters: readonly ParameterDeclaration[];
  readonly body: Node | undefined;
}

/**
 * The function `node` is, where every call of it is written in its own file under its own
 * name: a function declaration or a `const` initialized with an arrow function or a function
 * expression, neither exported. A method may be dispatched to through a base class or an
 * interface, so it is none.
 */
function callableOf(node: Node): Callable | undefined {
  const exported = (holder: Node): boolean =>
    ((holder as { readonly modifiers?: readonly Node[] }).modifiers ?? []).some(
      (modifier) =>
        modifier.kind === SyntaxKind.ExportKeyword || modifier.kind === SyntaxKind.DefaultKeyword,
    );
  if (isFunctionDeclaration(node)) {
    return node.name === undefined || exported(node)
      ? undefined
      : { name: node.name, parameters: node.parameters, body: node.body };
  }
  if (!isArrowFunction(node) && !isFunctionExpression(node)) {
    return undefined;
  }
  const declaration = node.parent;
  const list = declaration.parent;
  if (
    !isVariableDeclaration(declaration) ||
    declaration.initializer !== node ||
    !isIdentifier(declaration.name) ||
    !isVariableDeclarationList(list) ||
    (list.flags & NodeFlags.Const) === 0 ||
    !isVariableStatement(list.parent) ||
    exported(list.parent)
  ) {
    return undefined;
  }
  return { name: declaration.name, parameters: node.parameters, body: node.body };
}

/** The innermost function enclosing a node, or none. */
function enclosingFunction(node: Node): Node | undefined {
  for (let at = node.parent as Node | undefined; at !== undefined; at = at.parent) {
    if (
      isFunctionDeclaration(at) ||
      isArrowFunction(at) ||
      isFunctionExpression(at) ||
      at.kind === SyntaxKind.MethodDeclaration ||
      at.kind === SyntaxKind.Constructor ||
      at.kind === SyntaxKind.GetAccessor ||
      at.kind === SyntaxKind.SetAccessor
    ) {
      return at;
    }
  }
  return undefined;
}

/** One lookup: the index whose literal type names members of the object's type, read where and by whom. */
interface Lookup {
  readonly file: SourceFile;
  readonly from: string;
  readonly at: Node;
  readonly object: Expression;
  readonly index: Expression;
  readonly use: Use;
  /**
   * A string literal index, read here only on a receiver that declares a string index
   * signature: elsewhere reflective-lookup retains what it names, and on such a receiver
   * it holds nothing back, so a member the literal names would have no reference.
   */
  readonly mapped?: true;
}

/** One access whose index may be a parameter decided at the function's calls. */
interface Candidate {
  readonly file: SourceFile;
  readonly from: string;
  readonly access: ElementAccessExpression;
  readonly use: Use;
  readonly mapped?: true;
}

/**
 * The reads the element accesses of a side's files make of the members their index's literal
 * type names, each made by the declaration holding the access or the call. A type the checker
 * leaves unanswered holds what its answer could have read.
 */
export const elementAccess: ReadRule = {
  start() {
    const candidates: Candidate[] = [];
    const calls = new Map<Node, { readonly file: SourceFile; readonly from: string }>();
    const names: Identifier[] = [];
    return {
      visit(node, { file, from }) {
        if (isElementAccessExpression(node) && !isLiteralIndex(node.argumentExpression)) {
          candidates.push({ file, from, access: node, use: useOf(node) });
        } else if (isElementAccessExpression(node) && isStringIndex(node.argumentExpression)) {
          candidates.push({ file, from, access: node, use: useOf(node), mapped: true });
        }
        if (isCallExpression(node)) {
          calls.set(node, { file, from });
        }
        if (isIdentifier(node)) {
          names.push(node);
        }
      },
      reads({ project, chains }) {
        const found: Read[] = [];
        if (candidates.length === 0) {
          return found;
        }
        const queries = project.queries;
        // A parameter index is decided at the calls only where the function is a callable every
        // use of which is a call, so the symbols of the parameters and of every name are read.
        const parameterOf = new Map<Candidate, { callable: Callable; at: number }>();
        const byCallable = new Map<Identifier, Candidate[]>();
        for (const candidate of candidates) {
          const index = parenthesesRemoved(candidate.access.argumentExpression);
          const fn = isIdentifier(index) ? enclosingFunction(candidate.access) : undefined;
          const callable = fn === undefined ? undefined : callableOf(fn);
          if (callable === undefined || !isIdentifier(index)) {
            continue;
          }
          const at = callable.parameters.findIndex(
            (parameter) => isIdentifier(parameter.name) && parameter.name.text === index.text,
          );
          if (at < 0 || assigns(callable.body, index.text)) {
            continue;
          }
          parameterOf.set(candidate, { callable, at });
          byCallable.set(callable.name, [...(byCallable.get(callable.name) ?? []), candidate]);
        }
        const callableNames = [...byCallable.keys()];
        const spelled = new Set(callableNames.map((name) => name.text));
        const sameName = names.filter((name) => spelled.has(name.text));
        const asked = [...callableNames, ...sameName];
        const symbols = queries.symbolsAt(asked);
        const symbolOf = new Map<Node, unknown>();
        asked.forEach((node, at) => {
          const symbol = symbols[at];
          if (symbol !== undefined) {
            symbolOf.set(node, symbol);
          }
        });
        const callsOf = new Map<Node, CallExpression[] | undefined>();
        for (const name of callableNames) {
          const symbol = symbolOf.get(name);
          let sites: CallExpression[] | undefined =
            symbol === undefined || symbol === UNANSWERED ? undefined : [];
          for (const use of sameName) {
            if (sites === undefined) {
              break;
            }
            const other = symbolOf.get(use);
            if (use === name || (other !== symbol && other !== UNANSWERED)) {
              continue;
            }
            // A use the checker could not resolve may be the function's, read where it is not called.
            const parent = use.parent;
            sites =
              other !== UNANSWERED && isCallExpression(parent) && parent.expression === use
                ? [...sites, parent]
                : undefined;
          }
          callsOf.set(name, sites);
        }

        const lookups: Lookup[] = [];
        for (const candidate of candidates) {
          const deferred = parameterOf.get(candidate);
          const sites = deferred === undefined ? undefined : callsOf.get(deferred.callable.name);
          if (deferred === undefined || sites === undefined) {
            lookups.push({
              file: candidate.file,
              from: candidate.from,
              at: candidate.access.argumentExpression,
              object: candidate.access.expression,
              index: candidate.access.argumentExpression,
              use: candidate.use,
              ...(candidate.mapped === true ? { mapped: true as const } : {}),
            });
            continue;
          }
          // An object that is a parameter too is read as the argument each call passes there.
          const object = parenthesesRemoved(candidate.access.expression);
          const objectAt = isIdentifier(object)
            ? deferred.callable.parameters.findIndex(
                (parameter) => isIdentifier(parameter.name) && parameter.name.text === object.text,
              )
            : -1;
          for (const call of sites) {
            const parameter = deferred.callable.parameters[deferred.at];
            const index = call.arguments[deferred.at] ?? parameter?.initializer;
            const site = calls.get(call);
            if (index === undefined || site === undefined) {
              continue;
            }
            lookups.push({
              file: site.file,
              from: site.from,
              at: call,
              object:
                (objectAt < 0 ? undefined : call.arguments[objectAt]) ??
                candidate.access.expression,
              index,
              use: candidate.use,
            });
          }
        }

        const nodes = lookups.flatMap((one) => [one.index, one.object]);
        const types = queries.typesAt(nodes);
        const partsOf = (type: Type): readonly Type[] => {
          const parts = queries.constituents(type);
          return parts === UNANSWERED ? [type] : parts;
        };
        lookups.forEach((lookup, at) => {
          const indexType = types[2 * at];
          const objectType = types[2 * at + 1];
          const admitted =
            indexType === undefined || indexType === UNANSWERED
              ? indexType
              : admittedKeyNames(queries, indexType);
          const literals = admitted instanceof Set ? admitted : undefined;
          if (admitted === UNANSWERED || objectType === UNANSWERED) {
            found.push({
              kind: "held",
              from: lookup.from,
              ...(literals === undefined ? {} : { names: [...literals] }),
              ...(objectType === UNANSWERED || objectType === undefined
                ? literals === undefined
                  ? { members: true as const }
                  : {}
                : { types: partsOf(objectType) }),
            });
            return;
          }
          if (objectType === undefined || admitted === undefined) {
            return;
          }
          if (lookup.mapped === true && !readsAMapping(queries, objectType)) {
            return;
          }
          for (const part of partsOf(objectType)) {
            const properties = queries.propertiesOf(part);
            if (properties === UNANSWERED) {
              found.push({
                kind: "held",
                from: lookup.from,
                ...(literals === undefined ? { members: true as const } : { names: [...literals] }),
              });
              continue;
            }
            for (const property of properties) {
              if (literals !== undefined && !literals.has(property.escapedName)) {
                continue;
              }
              for (const to of chains.declarationsOf(property)) {
                for (const use of lookup.use === "both"
                  ? (["read", "write"] as const)
                  : [lookup.use]) {
                  found.push({
                    kind: "named",
                    from: lookup.from,
                    to,
                    file: lookup.file,
                    at: lookup.at,
                    use,
                    via: "keyed",
                  });
                }
              }
            }
          }
        });
        return found;
      },
    };
  },
};

/** The member name a string or number literal type spells, or undefined for another type. */
function literalName(type: Type): string | undefined {
  return type.isStringLiteralType() || type.isNumberLiteralType() ? String(type.value) : undefined;
}

/**
 * The member names an index the compiler types as `type` reads (`references-ts.25`): each
 * string and number literal of the union it is, and for a type parameter, whose body serves
 * every instantiation, those of its base constraint, or `"every"` where that constraint is not
 * literal names or there is none. Undefined where a constituent is neither, which reads no
 * member under the rule; `UNANSWERED` where the checker did not answer, read as every member.
 */
export function admittedKeyNames(
  queries: Pick<Queries, "constituents" | "baseConstraintOf">,
  type: Type,
): Answer<ReadonlySet<string> | "every" | undefined> {
  const partsOf = (of: Type): Answer<readonly Type[]> =>
    of.isUnionType() ? queries.constituents(of) : [of];
  const parts = partsOf(type);
  if (!isAnswered(parts)) {
    return UNANSWERED;
  }
  const names = new Set<string>();
  let every = false;
  let other = false;
  for (const part of parts) {
    const name = literalName(part);
    if (name !== undefined) {
      names.add(name);
      continue;
    }
    if (!part.isTypeParameter()) {
      other = true;
      continue;
    }
    const constraint = queries.baseConstraintOf(part);
    const admitted =
      constraint === undefined || !isAnswered(constraint) ? constraint : partsOf(constraint);
    if (!isAnswered(admitted)) {
      return UNANSWERED;
    }
    const spelled = (admitted ?? [part]).map(literalName);
    every ||= spelled.includes(undefined);
    for (const one of spelled) {
      if (one !== undefined) {
        names.add(one);
      }
    }
  }
  return other ? undefined : every ? "every" : names;
}

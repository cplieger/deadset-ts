import {
  isArrayBindingPattern,
  isBindingElement,
  isClassDeclaration,
  isConstructorDeclaration,
  isEnumDeclaration,
  isExportAssignment,
  isExportDeclaration,
  isFunctionDeclaration,
  isIdentifier,
  isInterfaceDeclaration,
  isIntersectionTypeNode,
  isModuleBlock,
  isModuleDeclaration,
  isNamespaceExport,
  isObjectBindingPattern,
  isParenthesizedTypeNode,
  isStringLiteral,
  isTypeAliasDeclaration,
  isTypeLiteralNode,
  isUnionTypeNode,
  isVariableStatement,
  SyntaxKind,
  type BindingElement,
  type ClassDeclaration,
  type Identifier,
  type Node,
  type SourceFile,
} from "@typescript/native/ast";
import {
  componentOf,
  exportedAs,
  isParameterProperty,
  memberKey,
  nameNodeOf,
  type Builder,
  type Building,
  type Container,
  type DeclarationSource,
  type SymbolKind,
} from "../inventory.ts";
import { writtenLength } from "../position.ts";

/** What one statement form declares under `owner`; `walk` reads a statement it holds. */
type Arm = (node: Node, owner: Building, into: Builder, walk: Walk) => void;
type Walk = (statement: Node, owner: Building) => void;

/** An arm for one statement form, which reads only a node the guard admits. */
function arm<T extends Node>(
  guard: (node: Node) => node is T,
  declare: (node: T, owner: Building, into: Builder, walk: Walk) => void,
): Arm {
  return (node, owner, into, walk) => {
    if (guard(node)) {
      declare(node, owner, into, walk);
    }
  };
}

/** The members a named declaration's container holds, where it holds any. */
type Members<T> = (node: T) => Omit<Container, "owner" | "declaration"> | undefined;

/** A declaration named by its own name, or `default` as a default export, and its members. */
function named<T extends Node>(
  guard: (node: Node) => node is T,
  kind: SymbolKind,
  members?: Members<T>,
): Arm {
  return arm(guard, (node, owner, into) => {
    const name = nameNodeOf(node);
    const { component, localName } = exportedAs(node, name);
    if (component === undefined) {
      return;
    }
    const record = into.declare(node, owner, kind, name, { component, localName });
    const held = members?.(node);
    if (held !== undefined) {
      into.container({ owner: record, declaration: node, ...held });
    }
  });
}

/** The parameter properties every constructor of one class declares. */
function parameterPropertiesOf(node: ClassDeclaration): readonly Node[] {
  return node.members.flatMap((member) =>
    isConstructorDeclaration(member) ? member.parameters.filter(isParameterProperty) : [],
  );
}

// A type alias keeps no member table of its own: the members belong to the object types
// its declaration writes, so the declaration is what carries them.
const TYPE_ALIAS = named(isTypeAliasDeclaration, "type", (node) => {
  const members = aliasMembers(node.type);
  return members.length === 0
    ? undefined
    : {
        nameNode: undefined,
        members,
        memberKind: "type-member",
      };
});

/** The statement forms that declare, each with what it declares. */
const ARMS: ReadonlyMap<SyntaxKind, Arm> = new Map([
  [SyntaxKind.FunctionDeclaration, named(isFunctionDeclaration, "function")],
  [
    SyntaxKind.ClassDeclaration,
    named(isClassDeclaration, "class", (node) => ({
      nameNode: node.name,
      members: [...node.members, ...parameterPropertiesOf(node)],
      memberKind: "class-member",
    })),
  ],
  [
    SyntaxKind.InterfaceDeclaration,
    named(isInterfaceDeclaration, "interface", (node) => ({
      nameNode: node.name,
      members: node.members,
      memberKind: "interface-method",
    })),
  ],
  [SyntaxKind.TypeAliasDeclaration, TYPE_ALIAS],
  // A JavaScript file's `@typedef` is reparsed into this declaration.
  [SyntaxKind.JSTypeAliasDeclaration, TYPE_ALIAS],
  [
    SyntaxKind.EnumDeclaration,
    named(isEnumDeclaration, "enum", (node) => ({
      nameNode: node.name,
      members: node.members,
      memberKind: "enum-member",
    })),
  ],
  [
    SyntaxKind.ModuleDeclaration,
    arm(isModuleDeclaration, (node, owner, into, walk) => {
      const component = componentOf(node.name);
      if (component === undefined) {
        return;
      }
      const record = into.declare(node, owner, "namespace", node.name, {
        component,
        localName: undefined,
      });
      into.exportScope(record, node.name);
      if (isStringLiteral(node.name)) {
        into.module(record, node.name.text);
      }
      const body = node.body;
      if (body === undefined) {
        return;
      }
      for (const statement of isModuleBlock(body) ? body.statements : [body]) {
        walk(statement, record);
      }
    }),
  ],
  [
    SyntaxKind.VariableStatement,
    arm(isVariableStatement, (node, owner, into) => {
      for (const declaration of node.declarationList.declarations) {
        const component = componentOf(declaration.name);
        if (component !== undefined) {
          into.declare(declaration, owner, "variable", declaration.name, {
            component,
            localName: undefined,
          });
          continue;
        }
        for (const { element, name } of patternElements(declaration.name)) {
          into.declare(element, owner, "variable", name, {
            component: { text: name.text, computed: false },
            localName: undefined,
          });
        }
      }
    }),
  ],
  [
    SyntaxKind.ExportDeclaration,
    arm(isExportDeclaration, (node, owner, into) => {
      const clause = node.exportClause;
      // A bare star re-export declares nothing: the names it carries are the named module's.
      if (clause === undefined) {
        return;
      }
      const specifiers = isNamespaceExport(clause) ? [clause] : clause.elements;
      for (const specifier of specifiers) {
        const component = componentOf(specifier.name);
        if (component !== undefined) {
          into.declare(specifier, owner, "export-alias", specifier.name, {
            component,
            localName: undefined,
          });
        }
      }
    }),
  ],
  [
    SyntaxKind.ExportAssignment,
    arm(isExportAssignment, (node, owner, into) => {
      if (!node.isExportEquals) {
        into.declare(node, owner, "export-alias", undefined, {
          component: { text: "default", computed: false },
          localName: undefined,
        });
      }
    }),
  ],
]);

/** The declarations a module, a namespace or a container body writes. */
export const SYNTAX: DeclarationSource = {
  declare(file: SourceFile, owner: Building, into: Builder): void {
    const walk: Walk = (statement, holder) => {
      ARMS.get(statement.kind)?.(statement, holder, into, walk);
    };
    // A statement a component file's module appends is not written in the file.
    const written = writtenLength(file);
    for (const statement of file.statements) {
      if (statement.end <= written) {
        walk(statement, owner);
      }
    }
  },
};

/** The type one node is, through however many parentheses are written around it. */
function unparenthesizedType(type: Node): Node {
  let held = type;
  while (isParenthesizedTypeNode(held)) {
    held = held.type;
  }
  return held;
}

/**
 * The direct constituents of one type. Parentheses are syntax and are not a constituent, so
 * the constituents of `(A | B) & C` are `A`, `B` and `C`; a union or an intersection written
 * without them stays one constituent.
 */
function constituentsOf(type: Node): readonly Node[] {
  const held = unparenthesizedType(type);
  if (!isUnionTypeNode(held) && !isIntersectionTypeNode(held)) {
    return [held];
  }
  return held.types.flatMap((member) =>
    isParenthesizedTypeNode(member) ? constituentsOf(member) : [member],
  );
}

/**
 * The members one type alias declares: those of each object type that is the alias or a
 * direct constituent of it. A name two constituents both declare is left out of all of
 * them: the alias stands for it, and neither declaration is the one a reference names.
 */
function aliasMembers(type: Node): readonly Node[] {
  const literals = constituentsOf(type).filter(isTypeLiteralNode);
  if (literals.length < 2) {
    return literals[0]?.members ?? [];
  }
  const declaring = new Map<string, number>();
  for (const literal of literals) {
    for (const key of new Set(literal.members.map(keyOf))) {
      if (key !== undefined) {
        declaring.set(key, (declaring.get(key) ?? 0) + 1);
      }
    }
  }
  return literals.flatMap((literal) =>
    literal.members.filter((member) => {
      const key = keyOf(member);
      return key !== undefined && declaring.get(key) === 1;
    }),
  );
}

/** One type member's identity, and undefined for a member the grammar cannot name. */
function keyOf(member: Node): string | undefined {
  const component = componentOf(nameNodeOf(member));
  return component === undefined ? undefined : memberKey(component, false);
}

/**
 * The binding elements of a destructuring declaration that each declare a name of their
 * own, at any depth, but one with a default, whose removal skips the default's evaluation,
 * and one beside a rest element of its object pattern, whose removal changes the rest.
 */
function patternElements(
  name: Node,
): readonly { readonly element: BindingElement; readonly name: Identifier }[] {
  if (!isObjectBindingPattern(name) && !isArrayBindingPattern(name)) {
    return [];
  }
  const rest =
    isObjectBindingPattern(name) &&
    name.elements.some((element) => element.dotDotDotToken !== undefined);
  return name.elements.flatMap((element) => {
    if (
      !isBindingElement(element) ||
      element.initializer !== undefined ||
      (rest && element.dotDotDotToken === undefined)
    ) {
      return [];
    }
    const bound = element.name;
    if (bound === undefined) {
      return [];
    }
    return isIdentifier(bound) ? [{ element, name: bound }] : patternElements(bound);
  });
}

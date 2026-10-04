/**
 * The ambient globals a declaration file declares as an alias of a module's export:
 * a variable whose type is `typeof import("<module>")["<name>"]` or
 * `typeof import("<module>").<name>`. A use of the global is a use of the export,
 * and the type query that says so is no use of its own.
 */

import {
  isIdentifier,
  isImportTypeNode,
  isIndexedAccessTypeNode,
  isLiteralTypeNode,
  isModuleBlock,
  isModuleDeclaration,
  isStringLiteral,
  isVariableStatement,
  SyntaxKind,
  type Node,
  type SourceFile,
} from "@typescript/native/unstable/ast";

/** One global that aliases a module's export. */
interface TypeQueryAlias {
  /** The variable declaration of the global. */
  readonly declaration: Node;
  /** The type query, which names the export and is no reference. */
  readonly type: Node;
  /** The node whose symbol is the export: the index's string, or the qualifier's name. */
  readonly exported: Node;
  /** The name the module exports the declaration under. */
  readonly name: string;
  /**
   * The `declare global` block the global is written in and every module declaration
   * around it, outermost first; none at a script's top level.
   */
  readonly containers: readonly Node[];
}

/** Whether one type is `typeof import("<string>")`, with no type argument. */
function typeOfImport(node: Node): boolean {
  if (!isImportTypeNode(node) || !node.isTypeOf || node.typeArguments !== undefined) {
    return false;
  }
  const argument = node.argument;
  return isLiteralTypeNode(argument) && isStringLiteral(argument.literal);
}

/** The node naming the export one alias type selects, or undefined where the type is no alias. */
function exportedBy(type: Node): Node | undefined {
  if (isIndexedAccessTypeNode(type)) {
    const index = type.indexType;
    const object = type.objectType;
    if (
      typeOfImport(object) &&
      isImportTypeNode(object) &&
      object.qualifier === undefined &&
      isLiteralTypeNode(index) &&
      isStringLiteral(index.literal)
    ) {
      return index.literal;
    }
    return undefined;
  }
  if (typeOfImport(type) && isImportTypeNode(type) && type.qualifier !== undefined) {
    return isIdentifier(type.qualifier) ? type.qualifier : undefined;
  }
  return undefined;
}

/** Whether one module declaration is a `declare global` block. */
function isGlobalBlock(node: Node): boolean {
  return (
    isModuleDeclaration(node) &&
    node.keyword !== SyntaxKind.NamespaceKeyword &&
    isIdentifier(node.name) &&
    node.name.text === "global"
  );
}

/** The aliases one list of statements declares as globals. */
function aliasesIn(statements: readonly Node[], containers: readonly Node[]): TypeQueryAlias[] {
  const found: TypeQueryAlias[] = [];
  for (const statement of statements) {
    if (!isVariableStatement(statement)) {
      continue;
    }
    for (const declaration of statement.declarationList.declarations) {
      const type = declaration.type;
      const exported = type === undefined ? undefined : exportedBy(type);
      if (
        type === undefined ||
        exported === undefined ||
        !isIdentifier(declaration.name) ||
        !(isIdentifier(exported) || isStringLiteral(exported))
      ) {
        continue;
      }
      found.push({ declaration, type, exported, name: exported.text, containers });
    }
  }
  return found;
}

/**
 * Every global one file declares as an alias of a module's export: at the top level of
 * a declaration file that is no module, and in a `declare global` block written at the
 * top level of a declaration file or of an ambient module it declares.
 */
export function typeQueryAliases(file: SourceFile): readonly TypeQueryAlias[] {
  if (!file.isDeclarationFile) {
    return [];
  }
  const found: TypeQueryAlias[] =
    file.externalModuleIndicator === undefined ? aliasesIn(file.statements, []) : [];
  const blocks = (statements: readonly Node[], outer: readonly Node[]): void => {
    for (const statement of statements) {
      if (!isModuleDeclaration(statement) || statement.body === undefined) {
        continue;
      }
      const body = statement.body;
      if (!isModuleBlock(body)) {
        continue;
      }
      if (isGlobalBlock(statement)) {
        found.push(...aliasesIn(body.statements, [...outer, statement]));
      } else if (!isIdentifier(statement.name)) {
        blocks(body.statements, [statement]);
      }
    }
  };
  blocks(file.statements, []);
  return found;
}

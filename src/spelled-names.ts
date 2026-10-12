import {
  isBindingElement,
  isBreakStatement,
  isClassDeclaration,
  isClassExpression,
  isContinueStatement,
  isEnumDeclaration,
  isEnumMember,
  isExportDeclaration,
  isExportSpecifier,
  isFunctionDeclaration,
  isFunctionExpression,
  isGetAccessorDeclaration,
  isImportClause,
  isImportEqualsDeclaration,
  isImportSpecifier,
  isInterfaceDeclaration,
  isJsxAttribute,
  isLabeledStatement,
  isMetaProperty,
  isMethodDeclaration,
  isMethodSignatureDeclaration,
  isModuleDeclaration,
  isNamespaceExport,
  isNamespaceExportDeclaration,
  isNamespaceImport,
  isParameterDeclaration,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isPropertyDeclaration,
  isPropertySignatureDeclaration,
  isQualifiedName,
  isSetAccessorDeclaration,
  isTypeAliasDeclaration,
  isTypeParameterDeclaration,
  isVariableDeclaration,
  type Identifier,
} from "@typescript/native/ast";

/**
 * Whether one identifier spells a name without referring to a binding of it: a member's
 * name after a dot, a property or member an object literal, a class, a type or an enum
 * declares, the name a declaration binds, the property a binding element destructures,
 * an import or export specifier's name in another module or under a rename, a JSX
 * attribute's name, a statement label, or the name of a meta-property. A shorthand
 * property and an unrenamed local export are no such spelling: each reads the binding.
 */
export function spellsNoBinding(node: Identifier): boolean {
  const parent = node.parent;
  if (isPropertyAccessExpression(parent) || isMetaProperty(parent)) {
    return parent.name === node;
  }
  if (isQualifiedName(parent)) {
    return parent.right === node;
  }
  if (isBindingElement(parent)) {
    return parent.propertyName === node || parent.name === node;
  }
  if (isImportSpecifier(parent)) {
    return true;
  }
  if (isExportSpecifier(parent)) {
    return (
      (isExportDeclaration(parent.parent.parent) &&
        parent.parent.parent.moduleSpecifier !== undefined) ||
      (parent.propertyName !== undefined && parent.name === node)
    );
  }
  if (
    isPropertyAssignment(parent) ||
    isPropertyDeclaration(parent) ||
    isMethodDeclaration(parent) ||
    isPropertySignatureDeclaration(parent) ||
    isMethodSignatureDeclaration(parent) ||
    isGetAccessorDeclaration(parent) ||
    isSetAccessorDeclaration(parent) ||
    isEnumMember(parent) ||
    isJsxAttribute(parent) ||
    isVariableDeclaration(parent) ||
    isParameterDeclaration(parent) ||
    isFunctionDeclaration(parent) ||
    isFunctionExpression(parent) ||
    isClassDeclaration(parent) ||
    isClassExpression(parent) ||
    isInterfaceDeclaration(parent) ||
    isTypeAliasDeclaration(parent) ||
    isEnumDeclaration(parent) ||
    isModuleDeclaration(parent) ||
    isTypeParameterDeclaration(parent) ||
    isImportClause(parent) ||
    isNamespaceImport(parent) ||
    isImportEqualsDeclaration(parent) ||
    isNamespaceExport(parent) ||
    isNamespaceExportDeclaration(parent)
  ) {
    return parent.name === node;
  }
  return (
    (isLabeledStatement(parent) || isBreakStatement(parent) || isContinueStatement(parent)) &&
    parent.label === node
  );
}

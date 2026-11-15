/**
 * The binding identities of the facts document, `bindings.6` and `bindings.7`: the consumer
 * records a generator row's output names, read from the syntax its plugin writes, and the
 * fallback records of the rows that bind a file only as a whole.
 */

import {
  isArrayLiteralExpression,
  isArrowFunction,
  isAsExpression,
  isBinaryExpression,
  isCallExpression,
  isCaseClause,
  isClassDeclaration,
  isEnumDeclaration,
  isEnumMember,
  isExpressionStatement,
  isExpressionWithTypeArguments,
  isIdentifier,
  isInterfaceDeclaration,
  isIntersectionTypeNode,
  isJSDocText,
  isLiteralTypeNode,
  isMethodDeclaration,
  isMethodSignatureDeclaration,
  isNumericLiteral,
  isObjectLiteralExpression,
  isParenthesizedTypeNode,
  isPrefixUnaryExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isPropertyDeclaration,
  isPropertySignatureDeclaration,
  isSatisfiesExpression,
  isStringLiteralLikeNode,
  isSwitchStatement,
  isTypeAliasDeclaration,
  isTypeLiteralNode,
  isTypeReferenceNode,
  isUnionTypeNode,
  isVariableStatement,
  ModifierFlags,
  SyntaxKind,
  type Node,
  type SourceFile,
  type SwitchStatement,
  type VariableDeclaration,
} from "@typescript/native/ast";
import { GENERATORS } from "./contract/contract.generated.ts";
import type { GeneratedFact } from "./exemptions/generated-file.ts";
import { failureExit } from "./failure.ts";
import type { Cap } from "./schema-reads.ts";
import { componentOf, modifiersOf, nameNodeOf, nodeKey } from "./inventory.ts";
import { PRODUCT } from "./product.ts";
import { tokenStart } from "./position.ts";
import { nameComponent, spell } from "./ref.ts";
import { bytewise } from "./text/compare.ts";

/** One binding record of the facts document, as `facts.schema.json` spells it. */
export interface BindingRecord {
  readonly role: "consumer" | "fallback";
  readonly symbol: string;
  readonly schema_file: string;
  readonly schema?: string;
  readonly generated_file: string;
  readonly scope?: "all" | "types";
  readonly state?: "live" | "unreferenced";
  readonly cap?: Cap;
}

/** What a schema declaration is, as the carrier sweep and the schema reads tell its records apart. */
type SchemaKind = "message" | "field" | "enum" | "value" | "service" | "rpc";

/**
 * A oneof constituent's discriminant: the property that tells it apart and the literal it
 * holds, with the key (`nodeKey`) and name of the oneof's own property, whose read as a
 * whole reads every constituent (`bindings.14`).
 */
interface Discriminant {
  readonly property: string;
  readonly literal: string;
  readonly holder: string;
  readonly holderName: string;
}

/**
 * A consumer one output names: the generated declaration's fragment, the schema
 * declaration's dotted name and kind, and the declarations standing for it, which a
 * reach of any of them reaches.
 */
interface Named {
  readonly fragment: string;
  readonly name: string;
  readonly kind: SchemaKind;
  readonly nodes: readonly Node[];
  readonly oneof?: Discriminant;
}

/** A line and a column, each counted from one, as a reference's position spells them. */
interface LineColumn {
  readonly line: number;
  readonly column: number;
}

/**
 * A generated declaration no inventory symbol is, a oneof constituent's type literal or a
 * service type's method member, which only a resolved use names. The references written
 * inside its span are its own, though the inventory declaration enclosing it makes them.
 */
export interface Member {
  readonly key: string;
  readonly within: string;
  readonly path: string;
  readonly start: LineColumn;
  readonly end: LineColumn;
}

/** Whether one reference is written inside a member's span, so the member makes it. */
export function writtenIn(
  member: Member,
  reference: { readonly from: string; readonly position: LineColumn & { readonly path: string } },
): boolean {
  const { position } = reference;
  const before = (a: LineColumn, b: LineColumn): boolean =>
    a.line < b.line || (a.line === b.line && a.column < b.column);
  return (
    reference.from === member.within &&
    position.path === member.path &&
    !before(position, member.start) &&
    before(position, member.end)
  );
}

/** One consumer record as the carrier sweep and the schema reads read it. */
export interface Bound {
  readonly symbol: string;
  /** The schema declaration's full name, `<package>.<Name>`. */
  readonly name: string;
  readonly kind: SchemaKind;
  /** The inventory declarations standing for it. */
  readonly ids: readonly string[];
  /** The declarations standing for it that no inventory symbol is. */
  readonly members: readonly Member[];
  /** The property names a use of those members is written with. */
  readonly spelled: readonly string[];
  /** The generated file, below the target root, the record was read from. */
  readonly path: string;
  readonly oneof?: Discriminant;
}

/** What one project's generated files publish and what the carrier sweep reads of them. */
export interface Bindings {
  readonly records: readonly BindingRecord[];
  readonly bound: readonly Bound[];
  /**
   * The generated declarations the carrier sweep follows no reference of: a ts-proto
   * message's serializer object and the client, definition and client constructor its
   * service writes (`references-ts.33`).
   */
  readonly opaque: readonly string[];
  /** Each generated file descriptor constant, by identifier. */
  readonly descriptors: ReadonlyMap<string, Descriptor>;
}

/**
 * How hand code exposes the descriptors of a generated file through a constant holding
 * them (`references-ts.34`): by any value use of a protobuf-es `GenFile` export, or by
 * encoding a ts-proto `protoMetadata` descriptor.
 */
type Exposure = "value" | "encoding";

/** A generated file descriptor constant: its name, its file's path and how hand code exposes it. */
export interface Descriptor {
  readonly name: string;
  readonly path: string;
  readonly exposedBy: Exposure;
}

/** What one row's reader reads of one file. */
interface Read {
  readonly named: readonly Named[];
  readonly opaque: readonly Node[];
  /** The constants holding the file's own descriptor. */
  readonly descriptors: readonly {
    readonly declaration: VariableDeclaration;
    readonly exposedBy: Exposure;
  }[];
}

/** The `@generated from <kind> <rest>` tags of one node's own documentation, in order. */
function generatedTags(node: Node): readonly { readonly kind: string; readonly rest: string }[] {
  const docs = (node as { readonly jsDoc?: readonly Node[] }).jsDoc ?? [];
  return docs.flatMap((doc) =>
    ((doc as { readonly tags?: readonly Node[] }).tags ?? []).flatMap((tag) => {
      const { tagName, comment } = tag as {
        readonly tagName?: Node;
        readonly comment?: readonly Node[];
      };
      if (tagName === undefined || !isIdentifier(tagName) || tagName.text !== "generated") {
        return [];
      }
      const text = (comment ?? [])
        .map((part) => (isJSDocText(part) ? part.text : ""))
        .join("")
        .trim();
      const found = /^from (\w+(?: value)?):? (.+)$/u.exec(text);
      return found === null ? [] : [{ kind: found[1] ?? "", rest: (found[2] ?? "").trim() }];
    }),
  );
}

/** The tag of one kind a node carries, its text after the kind. */
function tagged(node: Node, kind: string): string | undefined {
  return generatedTags(node).find((one) => one.kind === kind)?.rest;
}

/**
 * The name a field or an enum value tag declares: the word before ` = <number>`, read
 * before an optional bracketed option list (`= 7 [json_name = "sync"];`).
 */
function declaredName(rest: string): string | undefined {
  return /(\w+) = \d+(?: \[.*\])?;$/u.exec(rest)?.[1];
}

/** The spelled component of one declaration's name, or undefined for a name the grammar cannot spell. */
function spelledName(node: Node): string | undefined {
  const component = componentOf(nameNodeOf(node));
  return component === undefined ? undefined : spell(component);
}

/** The object type literals one type is or holds as a direct constituent of a union or an intersection. */
function literalsOf(type: Node | undefined): readonly Node[] {
  if (type === undefined) {
    return [];
  }
  if (isParenthesizedTypeNode(type)) {
    return literalsOf(type.type);
  }
  if (isUnionTypeNode(type) || isIntersectionTypeNode(type)) {
    return type.types.flatMap((one) => literalsOf(one));
  }
  return isTypeLiteralNode(type) ? [type] : [];
}

/** The string literal type one type literal declares for its discriminant property `name`. */
function discriminantOf(literal: Node, name: string): string | undefined {
  if (!isTypeLiteralNode(literal)) {
    return undefined;
  }
  for (const member of literal.members) {
    if (
      isPropertySignatureDeclaration(member) &&
      nameText(member.name) === name &&
      isLiteralTypeNode(member.type) &&
      isStringLiteralLikeNode(member.type.literal)
    ) {
      return member.type.literal.text;
    }
  }
  return undefined;
}

/** The `case` a protobuf-es oneof constituent declares. */
function caseOf(literal: Node): string | undefined {
  return discriminantOf(literal, "case");
}

/** The case-constituent fragment of one oneof member, below its property's fragment. */
function caseFragment(property: string, discriminant: string): string {
  return `${property}.'${discriminant.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}':case`;
}

/** The discriminant of one constituent of the oneof property `holder` declares. */
function oneofOf(holder: Node, property: string, literal: string): Discriminant {
  return {
    property,
    literal,
    holder: nodeKey(holder.getSourceFile(), holder),
    holderName: nameText(nameNodeOf(holder)) ?? "",
  };
}

/** An output whose identity the reader of its row cannot decode (`bindings.4`). */
class Undecodable extends Error {}

/** The name the field or enum value tag of one member declares, or undefined where it carries neither. */
function memberTagName(member: Node, at: string): string | undefined {
  const field = tagged(member, "field") ?? tagged(member, "enum value");
  if (field === undefined) {
    return undefined;
  }
  const declared = declaredName(field);
  if (declared === undefined) {
    throw new Undecodable(`the tag of ${at} names no field or value`);
  }
  return declared;
}

/**
 * The fields, enum values and oneof constituents of one tagged message or enum, below its
 * fragment. A constituent's name is the proto name its member's field tag declares, which
 * its `case`, the field's local name, need not spell.
 */
function membersOf(
  members: readonly Node[],
  fragment: string,
  name: string,
  kind: "field" | "value",
): readonly Named[] {
  return members.flatMap((member): Named[] => {
    const spelled = spelledName(member);
    if (spelled === undefined) {
      return [];
    }
    const at = `${fragment}.${spelled}`;
    const declared = memberTagName(member, at);
    if (declared !== undefined) {
      return [{ fragment: at, name: `${name}.${declared}`, kind, nodes: [member] }];
    }
    if (tagged(member, "oneof") === undefined || !isPropertySignatureDeclaration(member)) {
      return [];
    }
    return literalsOf(member.type).flatMap((constituent): Named[] => {
      const discriminant = caseOf(constituent);
      if (discriminant === undefined || !isTypeLiteralNode(constituent)) {
        return [];
      }
      const fragmentAt = caseFragment(at, discriminant);
      const field = constituent.members
        .map((one) => memberTagName(one, fragmentAt))
        .find((one) => one !== undefined);
      if (field === undefined) {
        throw new Undecodable(`the constituent ${fragmentAt} carries no field tag`);
      }
      return [
        {
          fragment: fragmentAt,
          name: `${name}.${field}`,
          kind: "field",
          nodes: [constituent],
          oneof: oneofOf(member, "case", discriminant),
        },
      ];
    });
  });
}

/** The full name `@generated from <kind> <pkg.Name>` gives, without a trailing comment. */
function fullName(rest: string): string {
  return rest.split(/\s/u)[0] ?? rest;
}

/** The consumers a protoc-gen-es file of row `protoc-gen-es-2` names, as `references-ts.28` reads them. */
function protobufEsConsumers(file: SourceFile): Read {
  const found: Named[] = [];
  const typed = new Map<string, { readonly name: string; readonly kind: "message" | "enum" }>();
  const constants: { readonly fragment: string; readonly type: Node; readonly node: Node }[] = [];
  const descriptors: { readonly declaration: VariableDeclaration; readonly exposedBy: Exposure }[] =
    [];
  for (const statement of file.statements) {
    if (isTypeAliasDeclaration(statement) || isInterfaceDeclaration(statement)) {
      const fragment = spelledName(statement);
      const message = tagged(statement, "message");
      if (fragment === undefined || message === undefined) {
        continue;
      }
      const name = fullName(message);
      typed.set(statement.name.text, { name, kind: "message" });
      found.push({ fragment, name, kind: "message", nodes: [statement] });
      const members = isInterfaceDeclaration(statement)
        ? statement.members
        : literalsOf(statement.type).flatMap((one) => (isTypeLiteralNode(one) ? one.members : []));
      found.push(...membersOf(members, fragment, name, "field"));
    } else if (isEnumDeclaration(statement)) {
      const fragment = spelledName(statement);
      const enumName = tagged(statement, "enum");
      if (fragment === undefined || enumName === undefined) {
        continue;
      }
      const name = fullName(enumName);
      typed.set(statement.name.text, { name, kind: "enum" });
      found.push(
        { fragment, name, kind: "enum", nodes: [statement] },
        ...membersOf(statement.members, fragment, name, "value"),
      );
    } else if (isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        const fragment = spelledName(declaration);
        if (fragment === undefined) {
          continue;
        }
        const tags = [...generatedTags(statement), ...generatedTags(declaration)];
        const enumName = tags.find((one) => one.kind === "enum")?.rest;
        const service = tags.find((one) => one.kind === "service")?.rest;
        const initializer = declaration.initializer;
        const object = initializer === undefined ? undefined : asConst(initializer);
        if (enumName !== undefined && object !== undefined && isObjectLiteralExpression(object)) {
          const name = fullName(enumName);
          typed.set(fragment, { name, kind: "enum" });
          found.push(
            { fragment, name, kind: "enum", nodes: [declaration] },
            ...membersOf(object.properties, fragment, name, "value"),
          );
        } else if (service !== undefined) {
          found.push({ fragment, name: fullName(service), kind: "service", nodes: [declaration] });
          const [methods] = typeArguments(declaration.type);
          for (const literal of literalsOf(methods)) {
            for (const member of isTypeLiteralNode(literal) ? literal.members : []) {
              const spelled = spelledName(member);
              const rpc = tagged(member, "rpc");
              if (spelled !== undefined && rpc !== undefined) {
                found.push({
                  fragment: `${fragment}.${spelled}`,
                  name: fullName(rpc),
                  kind: "rpc",
                  nodes: [member],
                });
              }
            }
          }
        } else if (annotatedAs(declaration, "GenFile")) {
          descriptors.push({ declaration, exposedBy: "value" });
        } else if (declaration.type !== undefined) {
          constants.push({ fragment, type: declaration.type, node: declaration });
        }
      }
    }
  }
  for (const constant of constants) {
    const type = constant.type;
    if (!isTypeReferenceNode(type) || !isIdentifier(type.typeName)) {
      continue;
    }
    if (type.typeName.text !== "GenMessage" && type.typeName.text !== "GenEnum") {
      continue;
    }
    const [argument] = typeArguments(type);
    const named =
      argument !== undefined && isTypeReferenceNode(argument) && isIdentifier(argument.typeName)
        ? typed.get(argument.typeName.text)
        : undefined;
    if (named === undefined) {
      throw new Undecodable(`${constant.fragment} names no type the file tags`);
    }
    found.push({ fragment: constant.fragment, ...named, nodes: [constant.node] });
  }
  return { named: found, opaque: [], descriptors };
}

/** The expression an `as const` or `satisfies` clause holds, or the expression itself. */
function asConst(node: Node): Node {
  return isAsExpression(node) || isSatisfiesExpression(node) ? asConst(node.expression) : node;
}

/** The type arguments one type reference writes. */
function typeArguments(type: Node | undefined): readonly Node[] {
  return type !== undefined && isTypeReferenceNode(type) ? (type.typeArguments ?? []) : [];
}

/** The text a property name or a string literal writes, or undefined for any other node. */
function nameText(node: Node | undefined): string | undefined {
  return node !== undefined && (isIdentifier(node) || isStringLiteralLikeNode(node))
    ? node.text
    : undefined;
}

/** The initializer of the property named `name` an object literal assigns, `as const` removed. */
function property(object: Node | undefined, name: string): Node | undefined {
  if (object === undefined || !isObjectLiteralExpression(object)) {
    return undefined;
  }
  const found = object.properties.find(
    (one) => isPropertyAssignment(one) && nameText(one.name) === name,
  );
  return found !== undefined && isPropertyAssignment(found)
    ? asConst(found.initializer)
    : undefined;
}

/** The value a numeric literal, or a negated one, writes. */
function numberOf(node: Node | undefined): number | undefined {
  if (node === undefined) {
    return undefined;
  }
  if (isPrefixUnaryExpression(node) && node.operator === SyntaxKind.MinusToken) {
    const value = numberOf(node.operand);
    return value === undefined ? undefined : -value;
  }
  return isNumericLiteral(node) ? Number(node.text) : undefined;
}

/** The elements an array literal writes, `as const` removed, or none for any other node. */
function elementsOf(node: Node | undefined): readonly Node[] {
  return node !== undefined && isArrayLiteralExpression(node)
    ? node.elements.map((one) => asConst(one))
    : [];
}

/**
 * A field name as protobuf-es v1 names its property: camel case, with `$` after a name the
 * runtime or JavaScript reserves, which a oneof member, being a `case` value, keeps
 * (`@bufbuild/protobuf` v1 `localFieldName`).
 */
function localFieldName(name: string, inOneof: boolean): string {
  const camel = name.replace(/_+(\D)?/gu, (_match, next?: string) => next?.toUpperCase() ?? "");
  return inOneof || !V1_RESERVED.has(camel) ? camel : `${camel}$`;
}

/** The property names protobuf-es v1 escapes in a message class. */
const V1_RESERVED: ReadonlySet<string> = new Set([
  "constructor",
  "toString",
  "toJSON",
  "valueOf",
  "getType",
  "clone",
  "equals",
  "fromBinary",
  "fromJson",
  "fromJsonString",
  "toBinary",
  "toJson",
  "toJsonString",
  "toObject",
]);

/** The value a class declares for one static property. */
function staticValue(members: readonly Node[], name: string): Node | undefined {
  for (const member of members) {
    if (
      isPropertyDeclaration(member) &&
      nameText(member.name) === name &&
      member.initializer !== undefined
    ) {
      return asConst(member.initializer);
    }
  }
  return undefined;
}

/**
 * The consumers a protoc-gen-es v1 or protoc-gen-connect-es v1 file names, as
 * `references-ts.29` reads them: a message class by its `typeName`, each field by its
 * `{ no, name }` entry of the class's `fields` list, an enum by its `setEnumType` call, and a
 * service literal by its `typeName` and the `name` of each of its `methods`.
 */
function protobufEsV1Consumers(file: SourceFile): Read {
  const found: Named[] = [];
  const enums = new Map<string, Node>();
  for (const statement of file.statements) {
    if (isEnumDeclaration(statement)) {
      enums.set(statement.name.text, statement);
    }
  }
  for (const statement of file.statements) {
    if (isClassDeclaration(statement) && statement.name !== undefined) {
      const name = nameText(staticValue(statement.members, "typeName"));
      const fragment = spelledName(statement);
      if (name === undefined || fragment === undefined) {
        continue;
      }
      found.push({ fragment, name, kind: "message", nodes: [statement] });
      const declared = new Map(
        statement.members.flatMap((member) => {
          const text =
            isPropertyDeclaration(member) && (modifiersOf(member) & ModifierFlags.Static) === 0
              ? nameText(member.name)
              : undefined;
          return text === undefined ? [] : [[text, member] as const];
        }),
      );
      const list = staticValue(statement.members, "fields");
      const [factory] = list !== undefined && isCallExpression(list) ? list.arguments : [];
      const body = factory !== undefined && isArrowFunction(factory) ? factory.body : undefined;
      for (const entry of elementsOf(body === undefined ? undefined : asConst(body))) {
        const field = nameText(property(entry, "name"));
        const oneof = nameText(property(entry, "oneof"));
        if (field === undefined || numberOf(property(entry, "no")) === undefined) {
          throw new Undecodable(`a fields entry of ${fragment} names no field`);
        }
        const local =
          nameText(property(entry, "localName")) ?? localFieldName(field, oneof !== undefined);
        const holder = oneof === undefined ? local : localFieldName(oneof, false);
        const member = declared.get(holder);
        if (member === undefined) {
          throw new Undecodable(`${fragment} declares no property ${holder}`);
        }
        const at = `${fragment}.${nameComponent(holder)}`;
        if (oneof === undefined) {
          found.push({ fragment: at, name: `${name}.${field}`, kind: "field", nodes: [member] });
          continue;
        }
        const type = isPropertyDeclaration(member) ? member.type : undefined;
        const constituent = literalsOf(type).find((one) => caseOf(one) === local);
        if (constituent === undefined) {
          throw new Undecodable(`${at} declares no constituent of case ${local}`);
        }
        found.push({
          fragment: caseFragment(at, local),
          name: `${name}.${field}`,
          kind: "field",
          nodes: [constituent],
          oneof: oneofOf(member, "case", local),
        });
      }
    } else if (isExpressionStatement(statement)) {
      found.push(...v1Enum(statement.expression, enums));
    } else if (isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        found.push(...v1Service(declaration));
      }
    }
  }
  return { named: found, opaque: [], descriptors: [] };
}

/** The consumers one `setEnumType(<Enum>, "<pkg>.<Enum>", [{ no, name }])` call names. */
function v1Enum(expression: Node, enums: ReadonlyMap<string, Node>): readonly Named[] {
  if (
    !isCallExpression(expression) ||
    !isPropertyAccessExpression(expression.expression) ||
    expression.expression.name.text !== "setEnumType"
  ) {
    return [];
  }
  const [target, typeName, values] = expression.arguments;
  const name = nameText(typeName);
  const declaration =
    target !== undefined && isIdentifier(target) ? enums.get(target.text) : undefined;
  if (
    name === undefined ||
    declaration === undefined ||
    !isEnumDeclaration(declaration) ||
    target === undefined ||
    !isIdentifier(target)
  ) {
    throw new Undecodable("a setEnumType call names no enum the file declares");
  }
  const fragment = nameComponent(target.text);
  const found: Named[] = [{ fragment, name, kind: "enum", nodes: [declaration] }];
  for (const entry of elementsOf(values)) {
    const value = nameText(property(entry, "name"));
    const no = numberOf(property(entry, "no"));
    const member = declaration.members.find(
      (one) => isEnumMember(one) && numberOf(one.initializer) === no,
    );
    const spelled = member === undefined ? undefined : spelledName(member);
    if (value === undefined || member === undefined || spelled === undefined) {
      throw new Undecodable(`${fragment} declares no member for a value setEnumType names`);
    }
    found.push({
      fragment: `${fragment}.${spelled}`,
      name: `${name}.${value}`,
      kind: "value",
      nodes: [member],
    });
  }
  return found;
}

/** The consumers one service literal `{ typeName, methods: { <m>: { name } } }` names. */
function v1Service(declaration: VariableDeclaration): readonly Named[] {
  const object =
    declaration.initializer === undefined ? undefined : asConst(declaration.initializer);
  const service = nameText(property(object, "typeName"));
  const methods = property(object, "methods");
  const fragment = spelledName(declaration);
  if (service === undefined || methods === undefined || fragment === undefined) {
    return [];
  }
  const found: Named[] = [{ fragment, name: service, kind: "service", nodes: [declaration] }];
  for (const method of isObjectLiteralExpression(methods) ? methods.properties : []) {
    const spelled = spelledName(method);
    const rpc = isPropertyAssignment(method)
      ? nameText(property(asConst(method.initializer), "name"))
      : undefined;
    if (spelled === undefined || rpc === undefined) {
      throw new Undecodable(`a method of ${fragment} names no RPC`);
    }
    found.push({
      fragment: `${fragment}.methods.${spelled}`,
      name: `${service}.${rpc}`,
      kind: "rpc",
      nodes: [method],
    });
  }
  return found;
}

/** One message or enum a ts-proto descriptor declares, by its full name. */
interface Described {
  readonly fields: ReadonlyMap<number, string>;
  readonly enum: boolean;
}

/** The messages and enums one descriptor literal's `messageType` and `enumType` declare, map entries left out. */
function describedIn(scope: string, holder: Node, into: Map<string, Described>): void {
  for (const message of elementsOf(
    property(holder, "messageType") ?? property(holder, "nestedType"),
  )) {
    const name = nameText(property(message, "name"));
    if (name === undefined) {
      throw new Undecodable("the descriptor names a message without a name");
    }
    if (property(property(message, "options"), "mapEntry")?.kind === SyntaxKind.TrueKeyword) {
      continue;
    }
    const full = `${scope}${name}`;
    const fields = new Map<number, string>();
    for (const field of elementsOf(property(message, "field"))) {
      const number = numberOf(property(field, "number"));
      const fieldName = nameText(property(field, "name"));
      if (number === undefined || fieldName === undefined) {
        throw new Undecodable(`the descriptor names a field of ${full} without a number`);
      }
      fields.set(number, fieldName);
    }
    into.set(full, { fields, enum: false });
    describedIn(`${full}.`, message, into);
  }
  for (const enumType of elementsOf(property(holder, "enumType"))) {
    const name = nameText(property(enumType, "name"));
    if (name === undefined) {
      throw new Undecodable("the descriptor names an enum without a name");
    }
    const values = new Map<number, string>();
    for (const value of elementsOf(property(enumType, "value"))) {
      const number = numberOf(property(value, "number"));
      const valueName = nameText(property(value, "name"));
      if (number === undefined || valueName === undefined) {
        throw new Undecodable(`the descriptor names a value of ${scope}${name} without a number`);
      }
      values.set(number, valueName);
    }
    into.set(`${scope}${name}`, { fields: values, enum: true });
  }
}

/** The property each `case <number>:` of a ts-proto `decode`'s {@link tagSwitch} assigns, and the `$case` a oneof=unions member writes. */
function decodedFields(
  decode: Node | undefined,
): ReadonlyMap<number, { readonly property: string; readonly union?: string }> {
  const found = new Map<number, { readonly property: string; readonly union?: string }>();
  for (const clause of tagSwitch(decode)?.caseBlock.clauses ?? []) {
    const number = isCaseClause(clause) ? numberOf(clause.expression) : undefined;
    const assigned = number === undefined ? undefined : assignedIn(clause);
    if (number !== undefined && assigned !== undefined) {
      found.set(number, assigned);
    }
  }
  return found;
}

/** The first `message.<property>` one case clause writes, with the `$case` of a union literal it assigns. */
function assignedIn(
  clause: Node,
): { readonly property: string; readonly union?: string } | undefined {
  let found: { readonly property: string; readonly union?: string } | undefined;
  const visit = (node: Node): void => {
    if (found !== undefined) {
      return;
    }
    if (
      isPropertyAccessExpression(node) &&
      isIdentifier(node.expression) &&
      node.expression.text === "message"
    ) {
      const parent = node.parent;
      const union =
        isBinaryExpression(parent) &&
        parent.left === node &&
        parent.operatorToken.kind === SyntaxKind.EqualsToken
          ? nameText(property(asConst(parent.right), "$case"))
          : undefined;
      found = { property: node.name.text, ...(union === undefined ? {} : { union }) };
      return;
    }
    node.forEachChild(visit);
  };
  clause.forEachChild(visit);
  return found;
}

/**
 * A ts-proto file's `protoMetadata` constant: the descriptor literal it holds, its
 * `references` map by full name, and the file's top-level interfaces, enums and
 * constants by name.
 */
interface TsProtoMetadata {
  readonly declaration: VariableDeclaration;
  readonly descriptor: Node;
  readonly references: ReadonlyMap<string, Node>;
  readonly types: ReadonlyMap<string, Node>;
  readonly values: ReadonlyMap<string, VariableDeclaration>;
}

/** The `protoMetadata` one ts-proto file declares, or undefined where none holds a descriptor literal and a `references` map. */
function tsProtoMetadata(file: SourceFile): TsProtoMetadata | undefined {
  const types = new Map<string, Node>();
  const values = new Map<string, VariableDeclaration>();
  let metadata: Node | undefined;
  let declaration: VariableDeclaration | undefined;
  for (const statement of file.statements) {
    if (isInterfaceDeclaration(statement) || isEnumDeclaration(statement)) {
      types.set(statement.name.text, statement);
    } else if (isVariableStatement(statement)) {
      for (const one of statement.declarationList.declarations) {
        const object = one.initializer === undefined ? undefined : asConst(one.initializer);
        if (isIdentifier(one.name) && object !== undefined) {
          values.set(one.name.text, one);
          if (property(object, "fileDescriptor") !== undefined) {
            metadata = object;
            declaration = one;
          }
        }
      }
    }
  }
  const held = property(metadata, "fileDescriptor");
  const [partial] = held !== undefined && isCallExpression(held) ? held.arguments : [];
  const descriptor = partial === undefined ? held : asConst(partial);
  const map = property(metadata, "references");
  if (
    declaration === undefined ||
    descriptor === undefined ||
    !isObjectLiteralExpression(descriptor) ||
    map === undefined ||
    !isObjectLiteralExpression(map)
  ) {
    return undefined;
  }
  const references = new Map<string, Node>();
  for (const entry of map.properties) {
    const key = isPropertyAssignment(entry) ? nameText(entry.name) : undefined;
    if (key !== undefined && isPropertyAssignment(entry)) {
      references.set(key.replace(/^\./u, ""), asConst(entry.initializer));
    }
  }
  return { declaration, descriptor, references, types, values };
}

/** The messages and enums one ts-proto descriptor literal declares, map entries left out. */
function describedBy(descriptor: Node): ReadonlyMap<string, Described> {
  const pkg = nameText(property(descriptor, "package")) ?? "";
  const described = new Map<string, Described>();
  describedIn(pkg === "" ? "" : `${pkg}.`, descriptor, described);
  return described;
}

/** The `decode` method of the constant one `references` entry names, or undefined where it names none. */
function decoderOf(metadata: TsProtoMetadata, name: string): Node | undefined {
  const value = metadata.references.get(name);
  const constant =
    value !== undefined && isIdentifier(value) ? metadata.values.get(value.text) : undefined;
  const object = constant?.initializer === undefined ? undefined : asConst(constant.initializer);
  return object !== undefined && isObjectLiteralExpression(object)
    ? object.properties.find((one) => isMethodDeclaration(one) && nameText(one.name) === "decode")
    : undefined;
}

/** Whether one expression is `tag >>> 3`, the field number ts-proto's `decode` switches on. */
function readsFieldNumber(expression: Node): boolean {
  return (
    isBinaryExpression(expression) &&
    expression.operatorToken.kind === SyntaxKind.GreaterThanGreaterThanGreaterThanToken &&
    isIdentifier(expression.left) &&
    expression.left.text === "tag" &&
    numberOf(expression.right) === 3
  );
}

/** The `switch (tag >>> 3)` on the field number a ts-proto `decode` holds, or undefined where it holds none. */
function tagSwitch(decode: Node | undefined): SwitchStatement | undefined {
  let found: SwitchStatement | undefined;
  const visit = (at: Node): void => {
    if (found !== undefined) {
      return;
    }
    if (isSwitchStatement(at) && readsFieldNumber(at.expression)) {
      found = at;
      return;
    }
    at.forEachChild(visit);
  };
  decode?.forEachChild(visit);
  return found;
}

/**
 * Whether one ts-proto file meets the option set of row `ts-proto-2-output-schema`
 * (`references-ts.36`): a `protoMetadata` descriptor, and for every message it declares a
 * `references` entry whose constant's `decode` holds a {@link tagSwitch}, which other
 * ts-proto options leave out (ts-proto `src/schema.ts`, `src/main.ts`). A descriptor the
 * reader cannot read is the row's, so it fails as `bindings.4` states.
 */
export function writesWholeSchema(file: SourceFile): boolean {
  const metadata = tsProtoMetadata(file);
  if (metadata === undefined) {
    return false;
  }
  let described: ReadonlyMap<string, Described>;
  try {
    described = describedBy(metadata.descriptor);
  } catch (error: unknown) {
    if (error instanceof Undecodable) {
      return true;
    }
    throw error;
  }
  return [...described].every(([name, one]) => {
    const decode = one.enum ? undefined : decoderOf(metadata, name);
    return one.enum || tagSwitch(decode) !== undefined;
  });
}

/**
 * The message, field, oneof member and enum consumers a ts-proto file of row
 * `ts-proto-2-output-schema` names, as `references-ts.30` reads them: each declaration its
 * `protoMetadata` descriptor declares, named in TypeScript by the descriptor's `references`
 * map, a field by the property the message's `decode` assigns under its number, and an enum
 * value by its number, the synthetic `UNRECOGNIZED` member binding nothing.
 */
function tsProtoSchemaConsumers(file: SourceFile): Read {
  const metadata = tsProtoMetadata(file);
  if (metadata === undefined) {
    throw new Error(
      "the ts-proto-2-output-schema option set admitted a file with no protoMetadata",
    );
  }
  const { types, values } = metadata;
  const described = describedBy(metadata.descriptor);
  const found: Named[] = [];
  for (const [name, value] of metadata.references) {
    const one = described.get(name);
    if (one === undefined) {
      continue;
    }
    const tsName = isIdentifier(value) ? value.text : undefined;
    const declaration = tsName === undefined ? undefined : types.get(tsName);
    if (tsName === undefined || declaration === undefined) {
      throw new Undecodable(`the descriptor's references name no declaration for ${name}`);
    }
    const fragment = nameComponent(tsName);
    const fns = values.get(tsName);
    found.push({
      fragment,
      name,
      kind: one.enum ? "enum" : "message",
      nodes: fns === undefined ? [declaration] : [declaration, fns],
    });
    if (one.enum) {
      for (const member of isEnumDeclaration(declaration) ? declaration.members : []) {
        const spelled = spelledName(member);
        const number = isEnumMember(member) ? numberOf(member.initializer) : undefined;
        const valueName = number === undefined ? undefined : one.fields.get(number);
        if (spelled === UNRECOGNIZED) {
          continue;
        }
        if (spelled === undefined || valueName === undefined) {
          throw new Undecodable(`${fragment} declares a member no descriptor value numbers`);
        }
        found.push({
          fragment: `${fragment}.${spelled}`,
          name: `${name}.${valueName}`,
          kind: "value",
          nodes: [member],
        });
      }
      continue;
    }
    const decoded = decodedFields(decoderOf(metadata, name));
    const members = isInterfaceDeclaration(declaration) ? declaration.members : [];
    for (const [number, field] of one.fields) {
      const assigned = decoded.get(number);
      const member = members.find(
        (candidate) =>
          isPropertySignatureDeclaration(candidate) &&
          nameText(candidate.name) === assigned?.property,
      );
      if (assigned === undefined || member === undefined) {
        throw new Undecodable(
          `the decode of ${fragment} assigns no property ${fragment} declares for field ${String(number)}`,
        );
      }
      const at = `${fragment}.${nameComponent(assigned.property)}`;
      if (assigned.union === undefined) {
        found.push({ fragment: at, name: `${name}.${field}`, kind: "field", nodes: [member] });
        continue;
      }
      const type = isPropertySignatureDeclaration(member) ? member.type : undefined;
      const constituent = literalsOf(type).find(
        (candidate) => discriminantOf(candidate, UNION_CASE) === assigned.union,
      );
      if (constituent === undefined) {
        throw new Undecodable(`${at} declares no constituent of $case ${assigned.union}`);
      }
      found.push({
        fragment: caseFragment(at, assigned.union),
        name: `${name}.${field}`,
        kind: "field",
        nodes: [constituent],
        oneof: oneofOf(member, UNION_CASE, assigned.union),
      });
    }
  }
  return {
    named: found,
    opaque: [],
    descriptors: [{ declaration: metadata.declaration, exposedBy: "encoding" }],
  };
}

/** The discriminant property of a ts-proto `oneof=unions` constituent. */
const UNION_CASE = "$case";

/** The enum member ts-proto adds for a value no descriptor declares, which binds nothing. */
const UNRECOGNIZED = "UNRECOGNIZED";

/** A ts-proto service path literal, split into its service and its method. */
const SERVICE_PATH = /^\/((?:\w+\.)*\w+)\/(\w+)$/u;

/** Whether one declaration's type annotation is a reference to the type `name`. */
function annotatedAs(declaration: VariableDeclaration, name: string): boolean {
  const type = declaration.type;
  return (
    type !== undefined &&
    isTypeReferenceNode(type) &&
    isIdentifier(type.typeName) &&
    type.typeName.text === name
  );
}

/** The interfaces one class declaration names in its `implements` clause. */
function implemented(declaration: Node): readonly string[] {
  if (!isClassDeclaration(declaration)) {
    return [];
  }
  return (declaration.heritageClauses ?? []).flatMap((clause) =>
    clause.token === SyntaxKind.ImplementsKeyword
      ? clause.types.flatMap((one) => {
          const name = isExpressionWithTypeArguments(one) ? one.expression : one.typeName;
          return isIdentifier(name) ? [name.text] : [];
        })
      : [],
  );
}

/** Whether one node is `this.<name>`. */
function thisMember(node: Node, name: string): boolean {
  return (
    isPropertyAccessExpression(node) &&
    node.expression.kind === SyntaxKind.ThisKeyword &&
    node.name.text === name
  );
}

/**
 * The proto name of the RPC one ts-proto client class method calls: the string literal
 * after the service argument of a `this.rpc.<call>(…)` in its body, that argument being
 * `this.service` or the literal service name. ts-proto writes the method's proto name
 * there whatever `lowerCaseServiceMethods` makes of the method's own name (ts-proto
 * `src/generate-services.ts`, `generateRegularRpcMethod`, `generateCachingRpcMethod`).
 */
function rpcNamedIn(method: Node, service: string): string | undefined {
  let found: string | undefined;
  const visit = (node: Node): void => {
    if (found !== undefined) {
      return;
    }
    if (
      isCallExpression(node) &&
      isPropertyAccessExpression(node.expression) &&
      thisMember(node.expression.expression, "rpc")
    ) {
      const { arguments: given } = node;
      const at = given.findIndex(
        (one) =>
          thisMember(one, "service") || (isStringLiteralLikeNode(one) && one.text === service),
      );
      const name = at < 0 ? undefined : given[at + 1];
      if (name !== undefined && isStringLiteralLikeNode(name)) {
        found = name.text;
        return;
      }
    }
    node.forEachChild(visit);
  };
  method.forEachChild(visit);
  return found;
}

/**
 * The service and RPC consumers a ts-proto file of row `ts-proto-2` names (`references-ts.31`):
 * the methods of the interface a `<Svc>ServiceName` constant names whose client class method
 * names the RPC it calls, that method standing for it too, and each member of a definition
 * object writing a service `path`, the
 * object and its `<Svc>Client` standing for the service. Every message's serializer
 * object, client class, definition object and client constant is opaque (`references-ts.33`).
 */
function tsProtoConsumers(file: SourceFile): Read {
  const found: Named[] = [];
  const opaque: Node[] = [];
  const interfaces = new Map<string, Node>();
  const variables = new Map<string, VariableDeclaration>();
  const implementing = new Map<string, Node[]>();
  for (const statement of file.statements) {
    if (isInterfaceDeclaration(statement)) {
      interfaces.set(statement.name.text, statement);
    }
    for (const name of implemented(statement)) {
      implementing.set(name, [...(implementing.get(name) ?? []), statement]);
    }
    if (isVariableStatement(statement)) {
      for (const one of statement.declarationList.declarations) {
        if (isIdentifier(one.name)) {
          variables.set(one.name.text, one);
        }
        if (annotatedAs(one, "MessageFns")) {
          opaque.push(one);
        }
      }
    }
  }
  const membersNamed = (holders: readonly Node[], spelled: string): readonly Node[] =>
    holders.flatMap((holder) =>
      (isInterfaceDeclaration(holder) || isClassDeclaration(holder) ? holder.members : []).filter(
        (member) => spelledName(member) === spelled,
      ),
    );
  for (const declaration of variables.values()) {
    const { name, initializer } = declaration;
    if (!isIdentifier(name) || initializer === undefined) {
      continue;
    }
    if (name.text.endsWith("ServiceName") && isStringLiteralLikeNode(initializer)) {
      const service = name.text.slice(0, -"ServiceName".length);
      const declared = interfaces.get(service);
      const classes = implementing.get(service) ?? [];
      opaque.push(...classes);
      for (const member of declared !== undefined && isInterfaceDeclaration(declared)
        ? declared.members
        : []) {
        const spelled = spelledName(member);
        const methods = spelled === undefined ? [] : membersNamed(classes, spelled);
        const rpc = methods
          .map((one) => rpcNamedIn(one, initializer.text))
          .find((one) => one !== undefined);
        if (spelled !== undefined && rpc !== undefined && isMethodSignatureDeclaration(member)) {
          found.push({
            fragment: `${nameComponent(service)}.${spelled}`,
            name: `${initializer.text}.${rpc}`,
            kind: "rpc",
            nodes: [member, ...methods],
          });
        }
      }
      continue;
    }
    const object = asConst(initializer);
    if (!isObjectLiteralExpression(object)) {
      continue;
    }
    let service: string | undefined;
    const clientName = `${name.text.replace(/Service$/u, "")}Client`;
    const clientInterface = interfaces.get(clientName);
    const clientConstant = variables.get(clientName);
    for (const property of object.properties) {
      const spelled = spelledName(property);
      const value = isPropertyAssignment(property) ? asConst(property.initializer) : undefined;
      const path =
        value !== undefined && isObjectLiteralExpression(value)
          ? value.properties.find(
              (one) =>
                isPropertyAssignment(one) &&
                spelledName(one) === "path" &&
                isStringLiteralLikeNode(one.initializer),
            )
          : undefined;
      const matched =
        path !== undefined &&
        isPropertyAssignment(path) &&
        isStringLiteralLikeNode(path.initializer)
          ? SERVICE_PATH.exec(path.initializer.text)
          : null;
      if (spelled === undefined || matched === null) {
        continue;
      }
      service = matched[1];
      const rpc = `${matched[1] ?? ""}.${matched[2] ?? ""}`;
      found.push({
        fragment: `${nameComponent(name.text)}.${spelled}`,
        name: rpc,
        kind: "rpc",
        nodes: [property],
      });
      const overloads =
        clientInterface === undefined ? [] : membersNamed([clientInterface], spelled);
      if (overloads.length > 0) {
        found.push({
          fragment: `${nameComponent(clientName)}.${spelled}`,
          name: rpc,
          kind: "rpc",
          nodes: overloads,
        });
      }
    }
    if (service !== undefined) {
      opaque.push(declaration, ...(clientConstant === undefined ? [] : [clientConstant]));
      found.push({
        fragment: nameComponent(name.text),
        name: service,
        kind: "service",
        nodes: [declaration],
      });
      const client = [clientInterface, clientConstant].filter((one) => one !== undefined);
      if (client.length > 0) {
        found.push({
          fragment: nameComponent(clientName),
          name: service,
          kind: "service",
          nodes: client,
        });
      }
    }
  }
  return { named: found, opaque, descriptors: [] };
}

/** The package `// @generated from file <path> (package <pkg>, ...)` or `protobufPackage` names, `.` for none. */
function packageOf(file: SourceFile): string {
  const header = /^\/\/ @generated from file \S+ \(package ([\w.]+)/mu.exec(file.text)?.[1];
  if (header !== undefined) {
    return header;
  }
  for (const statement of file.statements) {
    if (!isVariableStatement(statement)) {
      continue;
    }
    for (const one of statement.declarationList.declarations) {
      if (
        isIdentifier(one.name) &&
        one.name.text === "protobufPackage" &&
        one.initializer !== undefined &&
        isStringLiteralLikeNode(one.initializer) &&
        one.initializer.text !== ""
      ) {
        return one.initializer.text;
      }
    }
  }
  return ".";
}

/** The `proto://` reference of a schema declaration a full name written in package `pkg` names. */
function schemaRef(pkg: string, name: string): string {
  const local = pkg !== "." && name.startsWith(`${pkg}.`) ? name.slice(pkg.length + 1) : name;
  return `proto://${pkg}#${local}`;
}

/** The consumer reader of each row whose output the analyzer decodes. */
const CONSUMERS: Readonly<Record<string, (file: SourceFile) => Read>> = {
  "protoc-gen-es-2": protobufEsConsumers,
  "protoc-gen-es-1": protobufEsV1Consumers,
  "protoc-gen-connect-es-1": protobufEsV1Consumers,
  "ts-proto-2-output-schema": (file) => {
    const schema = tsProtoSchemaConsumers(file);
    const services = tsProtoConsumers(file);
    return {
      named: [...schema.named, ...services.named],
      opaque: services.opaque,
      descriptors: schema.descriptors,
    };
  },
  "ts-proto-2": tsProtoConsumers,
};

/**
 * What one generated file's row reader reads, or, where the reader cannot decode it, the
 * failure `bindings.4` ends the run with for a row with a version interval, and `undefined`
 * for any other row, whose file then binds as a fallback of scope `all`.
 */
function decodedBy(
  read: (file: SourceFile) => Read,
  file: SourceFile,
  path: string,
  row: (typeof GENERATORS)[number],
): Read | undefined {
  try {
    return read(file);
  } catch (error: unknown) {
    if (!(error instanceof Undecodable)) {
      throw error;
    }
    if ("versions" in row) {
      throw failureExit(
        "binding-undecodable",
        `${path}: ${error.message}, so it does not decode as generator row ${row.id} states: regenerate the file, or report it to the ${PRODUCT} maintainers where freshly generated output fails the same way`,
      );
    }
    return undefined;
  }
}

/** The scope of the fallback record each fallback cell publishes. */
const FALLBACK_SCOPE: Readonly<Record<string, "all" | "types">> = {
  fallback: "all",
  "rpc-types-fallback": "types",
};

/** The line and column of one offset of one file. */
function lineColumn(file: SourceFile, offset: number): LineColumn {
  const { line, character } = file.getLineAndCharacterOfPosition(offset);
  return { line: line + 1, column: character + 1 };
}

/**
 * The declarations standing for one consumer: those the inventory holds by identifier, and
 * the others as members of the inventory declarations enclosing them.
 */
function standing(
  file: SourceFile,
  path: string,
  nodes: readonly Node[],
  declarations: ReadonlyMap<string, string>,
): Pick<Bound, "ids" | "members" | "spelled"> {
  const ids: string[] = [];
  const members: Member[] = [];
  const spelled: string[] = [];
  for (const node of nodes) {
    const id = declarations.get(nodeKey(file, node));
    if (id !== undefined) {
      ids.push(id);
      continue;
    }
    const named = isTypeLiteralNode(node) ? node.members : [node];
    spelled.push(...named.flatMap((one) => nameText(nameNodeOf(one)) ?? []));
    for (let up = node.parent as Node | undefined; up !== undefined; up = up.parent) {
      const within = declarations.get(nodeKey(file, up));
      if (within !== undefined) {
        members.push({
          key: nodeKey(file, node),
          within,
          path,
          start: lineColumn(file, tokenStart(file.text, node.pos)),
          end: lineColumn(file, node.end),
        });
        break;
      }
    }
  }
  return { ids, members, spelled };
}

/**
 * The binding records one project's generated files publish, each file read once, and what
 * the carrier sweep reads of them: `files` by path below the target root, `moduleRefs`
 * each file's own reference, `declarations` the inventory's declaring nodes.
 */
export function bindingsOf(
  files: ReadonlyMap<string, SourceFile>,
  generated: ReadonlyMap<string, GeneratedFact>,
  moduleRefs: ReadonlyMap<string, string>,
  declarations: ReadonlyMap<string, string>,
): Bindings {
  const records: BindingRecord[] = [];
  const bound = new Map<string, Bound>();
  const opaque: string[] = [];
  const descriptors = new Map<string, Descriptor>();
  for (const [path, fact] of generated) {
    const file = files.get(path);
    const moduleRef = moduleRefs.get(path);
    const generator = fact.generator;
    if (file === undefined || moduleRef === undefined || generator === undefined) {
      continue;
    }
    const [schemaFile] = generator.schemaFiles;
    const row = GENERATORS.find((one) => one.id === generator.row);
    const reader = CONSUMERS[generator.row];
    const read =
      reader === undefined || row === undefined
        ? { named: [], opaque: [], descriptors: [] }
        : decodedBy(reader, file, path, row);
    const scope = read === undefined ? "all" : FALLBACK_SCOPE[row?.cell ?? ""];
    if (scope !== undefined) {
      for (const one of generator.schemaFiles) {
        records.push({
          role: "fallback",
          symbol: moduleRef,
          schema_file: one,
          generated_file: path,
          scope,
          state: "live",
        });
      }
    }
    if (read === undefined || schemaFile === undefined) {
      continue;
    }
    opaque.push(...standing(file, path, read.opaque, declarations).ids);
    for (const { declaration, exposedBy } of read.descriptors) {
      const id = declarations.get(nodeKey(file, declaration));
      const name = nameText(declaration.name);
      if (id !== undefined && name !== undefined) {
        descriptors.set(id, { name, path, exposedBy });
      }
    }
    const pkg = packageOf(file);
    for (const one of read.named) {
      const symbol = `${moduleRef}${one.fragment}`;
      const stands = standing(file, path, one.nodes, declarations);
      const known = bound.get(symbol);
      if (known !== undefined) {
        bound.set(symbol, {
          ...known,
          ids: [...known.ids, ...stands.ids],
          members: [...known.members, ...stands.members],
          spelled: [...known.spelled, ...stands.spelled],
        });
        continue;
      }
      bound.set(symbol, {
        symbol,
        name: one.name,
        kind: one.kind,
        ...stands,
        path,
        ...(one.oneof === undefined ? {} : { oneof: one.oneof }),
      });
      records.push({
        role: "consumer",
        symbol,
        schema_file: schemaFile,
        schema: schemaRef(pkg, one.name),
        generated_file: path,
      });
    }
  }
  return { records, bound: [...bound.values()], opaque, descriptors };
}

/**
 * The records of a run's projects, each once, in the order the facts schema states: by
 * schema file, schema, role and symbol. A generated file two projects hold publishes its
 * records in each.
 */
export function distinctBindings(records: readonly BindingRecord[]): readonly BindingRecord[] {
  const byKey = new Map(records.map((one) => [JSON.stringify(one), one]));
  return [...byKey.values()].sort(
    (a, b) =>
      bytewise(a.schema_file, b.schema_file) ||
      bytewise(a.schema ?? "", b.schema ?? "") ||
      bytewise(a.role, b.role) ||
      bytewise(a.symbol, b.symbol),
  );
}

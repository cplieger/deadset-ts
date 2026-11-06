/**
 * The binding identities of the facts document, `bindings.6` and `bindings.7`: the consumer
 * records a generator row's output names, read from the syntax its plugin writes, and the
 * fallback records of the rows that bind a file only as a whole. The run publishes no state,
 * so every record is an identity (`bindings.10`).
 */

import {
  isAsExpression,
  isEnumDeclaration,
  isIdentifier,
  isInterfaceDeclaration,
  isIntersectionTypeNode,
  isJSDocText,
  isLiteralTypeNode,
  isMethodSignatureDeclaration,
  isObjectLiteralExpression,
  isParenthesizedTypeNode,
  isPropertyAssignment,
  isPropertySignatureDeclaration,
  isSatisfiesExpression,
  isStringLiteralLikeNode,
  isTypeAliasDeclaration,
  isTypeLiteralNode,
  isTypeReferenceNode,
  isUnionTypeNode,
  isVariableStatement,
  type Node,
  type SourceFile,
} from "@typescript/native/ast";
import { GENERATORS } from "./contract/contract.generated.ts";
import type { GeneratedFact } from "./generated-file.ts";
import { componentOf, nameNodeOf } from "./inventory.ts";
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
  readonly state?: "live";
}

/** A consumer one output names: the generated declaration's fragment and the schema declaration's dotted name. */
interface Named {
  readonly fragment: string;
  readonly name: string;
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

/** The string literal type one type literal declares for its `case` property, the oneof discriminant. */
function caseOf(literal: Node): string | undefined {
  if (!isTypeLiteralNode(literal)) {
    return undefined;
  }
  for (const member of literal.members) {
    if (
      isPropertySignatureDeclaration(member) &&
      spelledName(member) === "case" &&
      isLiteralTypeNode(member.type) &&
      isStringLiteralLikeNode(member.type.literal)
    ) {
      return member.type.literal.text;
    }
  }
  return undefined;
}

/** The fields, enum values and oneof constituents of one tagged message or enum, below its fragment. */
function membersOf(members: readonly Node[], fragment: string, name: string): readonly Named[] {
  return members.flatMap((member): Named[] => {
    const spelled = spelledName(member);
    if (spelled === undefined) {
      return [];
    }
    const at = `${fragment}.${spelled}`;
    const field = tagged(member, "field") ?? tagged(member, "enum value");
    const declared = field === undefined ? undefined : declaredName(field);
    if (declared !== undefined) {
      return [{ fragment: at, name: `${name}.${declared}` }];
    }
    if (tagged(member, "oneof") === undefined || !isPropertySignatureDeclaration(member)) {
      return [];
    }
    return literalsOf(member.type).flatMap((constituent): Named[] => {
      const discriminant = caseOf(constituent);
      return discriminant === undefined
        ? []
        : [
            {
              fragment: `${at}.'${discriminant.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}':case`,
              name: `${name}.${discriminant}`,
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
function protobufEsConsumers(file: SourceFile): readonly Named[] {
  const found: Named[] = [];
  const typed = new Map<string, string>();
  const constants: { readonly fragment: string; readonly type: Node; readonly node: Node }[] = [];
  for (const statement of file.statements) {
    if (isTypeAliasDeclaration(statement) || isInterfaceDeclaration(statement)) {
      const fragment = spelledName(statement);
      const message = tagged(statement, "message");
      if (fragment === undefined || message === undefined) {
        continue;
      }
      const name = fullName(message);
      typed.set(statement.name.text, name);
      found.push({ fragment, name });
      const members = isInterfaceDeclaration(statement)
        ? statement.members
        : literalsOf(statement.type).flatMap((one) => (isTypeLiteralNode(one) ? one.members : []));
      found.push(...membersOf(members, fragment, name));
    } else if (isEnumDeclaration(statement)) {
      const fragment = spelledName(statement);
      const enumName = tagged(statement, "enum");
      if (fragment === undefined || enumName === undefined) {
        continue;
      }
      const name = fullName(enumName);
      typed.set(statement.name.text, name);
      found.push({ fragment, name }, ...membersOf(statement.members, fragment, name));
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
          typed.set(fragment, name);
          found.push({ fragment, name }, ...membersOf(object.properties, fragment, name));
        } else if (service !== undefined) {
          found.push({ fragment, name: fullName(service) });
          const [methods] = typeArguments(declaration.type);
          for (const literal of literalsOf(methods)) {
            for (const member of isTypeLiteralNode(literal) ? literal.members : []) {
              const spelled = spelledName(member);
              const rpc = tagged(member, "rpc");
              if (spelled !== undefined && rpc !== undefined) {
                found.push({ fragment: `${fragment}.${spelled}`, name: fullName(rpc) });
              }
            }
          }
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
    if (named !== undefined) {
      found.push({ fragment: constant.fragment, name: named });
    }
  }
  return found;
}

/** The expression an `as const` or `satisfies` clause holds, or the expression itself. */
function asConst(node: Node): Node {
  return isAsExpression(node) || isSatisfiesExpression(node) ? asConst(node.expression) : node;
}

/** The type arguments one type reference writes. */
function typeArguments(type: Node | undefined): readonly Node[] {
  return type !== undefined && isTypeReferenceNode(type) ? (type.typeArguments ?? []) : [];
}

/** A ts-proto service path literal, split into its service and its method. */
const SERVICE_PATH = /^\/((?:\w+\.)*\w+)\/(\w+)$/u;

/**
 * The service and RPC consumers a ts-proto file of row `ts-proto-2` names, as
 * `references-ts.31` reads them: the methods of the interface a `<Svc>ServiceName`
 * constant names, and a definition object whose members write a service `path`, with each
 * member the consumer of its RPC and the object, and the `<Svc>Client` that the same
 * file declares beside it, consumers of the service.
 */
function tsProtoConsumers(file: SourceFile): readonly Named[] {
  const found: Named[] = [];
  const interfaces = new Map<string, readonly Node[]>();
  const clients = new Set<string>();
  for (const statement of file.statements) {
    if (isInterfaceDeclaration(statement)) {
      interfaces.set(statement.name.text, statement.members);
    }
    if (isVariableStatement(statement)) {
      for (const one of statement.declarationList.declarations) {
        if (isIdentifier(one.name)) {
          clients.add(one.name.text);
        }
      }
    }
  }
  for (const statement of file.statements) {
    if (!isVariableStatement(statement)) {
      continue;
    }
    for (const declaration of statement.declarationList.declarations) {
      const { name, initializer } = declaration;
      if (!isIdentifier(name) || initializer === undefined) {
        continue;
      }
      if (name.text.endsWith("ServiceName") && isStringLiteralLikeNode(initializer)) {
        const service = name.text.slice(0, -"ServiceName".length);
        for (const member of interfaces.get(service) ?? []) {
          const spelled = spelledName(member);
          if (spelled !== undefined && isMethodSignatureDeclaration(member)) {
            found.push({
              fragment: `${nameComponent(service)}.${spelled}`,
              name: `${initializer.text}.${spelled}`,
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
        found.push({ fragment: `${nameComponent(name.text)}.${spelled}`, name: rpc });
        const client = `${name.text.replace(/Service$/u, "")}Client`;
        if (interfaces.get(client)?.some((member) => spelledName(member) === spelled) === true) {
          found.push({ fragment: `${nameComponent(client)}.${spelled}`, name: rpc });
        }
      }
      if (service !== undefined) {
        found.push({ fragment: nameComponent(name.text), name: service });
        const client = `${name.text.replace(/Service$/u, "")}Client`;
        if (interfaces.has(client) || clients.has(client)) {
          found.push({ fragment: nameComponent(client), name: service });
        }
      }
    }
  }
  return found;
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
const CONSUMERS: Readonly<Record<string, (file: SourceFile) => readonly Named[]>> = {
  "protoc-gen-es-2": protobufEsConsumers,
  "ts-proto-2": tsProtoConsumers,
};

/** The scope of the fallback record each fallback cell publishes. */
const FALLBACK_SCOPE: Readonly<Record<string, "all" | "types">> = {
  fallback: "all",
  "rpc-types-fallback": "types",
};

/**
 * The binding records one project's generated files publish, each file read once:
 * `files` by path below the target root, `moduleRefs` each file's own reference.
 */
export function bindingsOf(
  files: ReadonlyMap<string, SourceFile>,
  generated: ReadonlyMap<string, GeneratedFact>,
  moduleRefs: ReadonlyMap<string, string>,
): readonly BindingRecord[] {
  const records: BindingRecord[] = [];
  for (const [path, fact] of generated) {
    const file = files.get(path);
    const moduleRef = moduleRefs.get(path);
    const generator = fact.generator;
    if (file === undefined || moduleRef === undefined || generator === undefined) {
      continue;
    }
    const [schemaFile] = generator.schemaFiles;
    const cell = GENERATORS.find((row) => row.id === generator.row)?.cell;
    const scope = cell === undefined ? undefined : FALLBACK_SCOPE[cell];
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
    const read = CONSUMERS[generator.row];
    if (read === undefined || schemaFile === undefined) {
      continue;
    }
    const pkg = packageOf(file);
    const seen = new Set<string>();
    for (const named of read(file)) {
      const symbol = `${moduleRef}${named.fragment}`;
      if (seen.has(symbol)) {
        continue;
      }
      seen.add(symbol);
      records.push({
        role: "consumer",
        symbol,
        schema_file: schemaFile,
        schema: schemaRef(pkg, named.name),
        generated_file: path,
      });
    }
  }
  return records;
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

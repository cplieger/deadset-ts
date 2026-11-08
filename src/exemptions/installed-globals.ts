/**
 * The classes a program installs as globals: a class value written into a property of
 * the global object, which code outside the analysis that names the global constructs.
 * The checker finds each write: the receiver's type is the global object's, the callee is
 * the standard library's `Object.defineProperty` or a test runner's stub, and the
 * property is the one of the key's name that `typeof globalThis` declares.
 */

import {
  isIdentifier,
  isNoSubstitutionTemplateLiteral,
  isObjectLiteralExpression,
  isPropertyAssignment,
  isShorthandPropertyAssignment,
  isStringLiteral,
  type Expression,
  type Node,
} from "@typescript/native/ast";
import {
  SignatureKind,
  SymbolFlags,
  type Symbol as TSSymbol,
  type Type,
} from "@typescript/native/sync";
import type { AliasChains } from "../alias-chain.ts";
import { typesAt } from "../class-members.ts";
import { packageOfPath } from "../dependencies.ts";
import type { Inventory } from "../inventory.ts";
import { must } from "../query.ts";
import type { ProjectView } from "../session.ts";
import { parenthesesRemoved, unwrapped } from "../unwrap.ts";
import { spansOf } from "./argument-places.ts";
import { classesCarried } from "./calls.ts";
import type { ProjectSites } from "./sites.ts";

/** A call that writes a value into a property of an object, by the places of its arguments. */
interface Writer {
  /** The object's place, none where the object is the global one. */
  readonly object: number | undefined;
  readonly key: number;
  readonly value: number;
  /** Whether the value is the `value` member of a property descriptor. */
  readonly described: boolean;
}

/**
 * The test runners' stubs of a global, by method name and the packages that declare it:
 * `vi.stubGlobal` of vitest, and `jest.replaceProperty`, which `@jest/environment` types
 * for `@jest/globals` and `@types/jest` declares for the `jest` global.
 */
const STUBS: ReadonlyMap<string, Writer & { readonly packages: ReadonlySet<string> }> = new Map([
  [
    "stubGlobal",
    { packages: new Set(["vitest"]), object: undefined, key: 0, value: 1, described: false },
  ],
  [
    "replaceProperty",
    {
      packages: new Set(["@jest/environment", "@jest/globals", "@types/jest"]),
      object: 0,
      key: 1,
      value: 2,
      described: false,
    },
  ],
]);

/** `Object.defineProperty(object, key, descriptor)`. */
const DEFINE: Writer = { object: 0, key: 1, value: 2, described: true };

/** One write of a value into a property a written key names. */
interface Write {
  readonly site: Node;
  /** The object written to, none where it is the global one. */
  readonly receiver: Expression | undefined;
  readonly key: string;
  readonly value: Expression;
}

/** One class a write installs as a global, and the instance types the global constructs. */
interface Installed {
  readonly id: string;
  readonly site: Node;
  readonly global: string;
  readonly instances: readonly Type[];
}

/** The text of a key written as a string literal. */
function keyText(node: Expression | undefined): string | undefined {
  const key = node === undefined ? undefined : parenthesesRemoved(node);
  return key !== undefined && (isStringLiteral(key) || isNoSubstitutionTemplateLiteral(key))
    ? key.text
    : undefined;
}

/** Whether a property's name is `value`. */
function named(name: Node): boolean {
  return (isIdentifier(name) || isStringLiteral(name)) && name.text === "value";
}

/** The value a property descriptor written as an object literal gives. */
function describedValue(node: Expression | undefined): Expression | undefined {
  const descriptor = node === undefined ? undefined : parenthesesRemoved(node);
  if (descriptor === undefined || !isObjectLiteralExpression(descriptor)) {
    return undefined;
  }
  for (const property of descriptor.properties) {
    if (isPropertyAssignment(property) && named(property.name)) {
      return property.initializer;
    }
    if (
      isShorthandPropertyAssignment(property) &&
      isIdentifier(property.name) &&
      named(property.name)
    ) {
      return property.name;
    }
  }
  return undefined;
}

/** How a call's callee writes a property: the standard library's `Object.defineProperty` or a runner's stub. */
function writerOf<Brand>(project: ProjectView<Brand>, method: TSSymbol): Writer | undefined {
  if (method.name === "defineProperty") {
    const standard = method.declarations.some(
      (handle) => project.program.getSourceFileMetadata(handle.path)?.isDefaultLibrary === true,
    );
    return standard && must(project.queries.parentOf(method))?.name === "ObjectConstructor"
      ? DEFINE
      : undefined;
  }
  const stub = STUBS.get(method.name);
  return stub !== undefined &&
    method.declarations.some((handle) => stub.packages.has(packageOfPath(handle.path) ?? ""))
    ? stub
    : undefined;
}

/** Each write of one project's own files that may install a value as a global, read from syntax and the callee. */
function writesOf<Brand>(project: ProjectView<Brand>, sites: ProjectSites): readonly Write[] {
  const found: Write[] = sites.stores.map((store) => ({
    site: store.store,
    receiver: store.receiver,
    key: store.key,
    value: store.value,
  }));
  for (const { call } of sites.calls) {
    const method = sites.invocations.callee(call);
    const writer = method === undefined ? undefined : writerOf(project, method);
    if (writer === undefined) {
      continue;
    }
    const invoked = sites.invocations.of(call);
    // With no types asked, a spread has no known length, so only a place no spread
    // comes at or before is read.
    const spans = spansOf(project, invoked.arguments, invoked.listed, []);
    const at = (place: number): Expression | undefined => {
      const span = spans.find((one) => !one.open && one.first === place);
      return span === undefined ? undefined : invoked.arguments[span.argument];
    };
    const key = keyText(at(writer.key));
    const receiver = writer.object === undefined ? undefined : at(writer.object);
    const value = writer.described ? describedValue(at(writer.value)) : at(writer.value);
    if (
      key !== undefined &&
      value !== undefined &&
      (writer.object === undefined || receiver !== undefined)
    ) {
      found.push({ site: call, receiver, key, value });
    }
  }
  return found;
}

/**
 * The classes one project installs as globals. A write installs one where its object is
 * the global object, as the checker types it (`window` and `self` are intersections that
 * hold `typeof globalThis`, and an object asserted to `any` is read inside the
 * assertion), and where the global object declares a property of the key's name with a
 * construct signature, whose instances code outside the analysis makes.
 */
export function installedGlobals<Brand>(
  project: ProjectView<Brand>,
  held: Inventory,
  chains: AliasChains,
  sites: ProjectSites,
): readonly Installed[] {
  const { queries } = project;
  const writes = writesOf(project, sites);
  if (writes.length === 0) {
    return [];
  }
  const global = must(queries.resolveName("globalThis", SymbolFlags.Value, undefined, false));
  const globalType = global === undefined ? undefined : must(queries.typeOfSymbol(global));
  if (global === undefined || globalType === undefined) {
    return [];
  }
  const properties = new Map(
    must(queries.propertiesOf(globalType)).map((property) => [property.name, property]),
  );
  const keyed = writes.filter((write) => properties.has(write.key));
  const objects = keyed.flatMap((write) =>
    write.receiver === undefined ? [] : [unwrapped(write.receiver)],
  );
  const objectTypes = new Map(
    typesAt(project, objects).map((type, at) => [objects[at], type] as const),
  );
  const globals = new Map<number, boolean>();
  const isGlobal = (type: Type | undefined): boolean => {
    if (type === undefined) {
      return false;
    }
    let known = globals.get(type.id);
    if (known === undefined) {
      const parts =
        type.isUnionType() || type.isIntersectionType() ? must(queries.constituents(type)) : [type];
      known = parts.some((part) => must(queries.symbolOfType(part))?.id === global.id);
      globals.set(type.id, known);
    }
    return known;
  };
  const installs = keyed.filter(
    (write) => write.receiver === undefined || isGlobal(objectTypes.get(unwrapped(write.receiver))),
  );
  if (installs.length === 0) {
    return [];
  }
  const instances = new Map<string, readonly Type[]>();
  const instancesOf = (key: string): readonly Type[] => {
    let made = instances.get(key);
    if (made === undefined) {
      const property = properties.get(key);
      const type = property === undefined ? undefined : must(queries.typeOfSymbol(property));
      made = (
        type === undefined ? [] : must(queries.signaturesOf(type, SignatureKind.Construct))
      ).flatMap((signature) => must(queries.returnTypeOf(signature)) ?? []);
      instances.set(key, made);
    }
    return made;
  };
  const carried = classesCarried(
    project,
    held,
    chains,
    sites,
    installs.map((write) => [write.value]),
  );
  return installs.flatMap((write, at) => {
    const uses = carried[at] ?? [];
    const made = uses.length === 0 ? [] : instancesOf(write.key);
    return made.length === 0
      ? []
      : uses.map((use) => ({ id: use.id, site: write.site, global: write.key, instances: made }));
  });
}

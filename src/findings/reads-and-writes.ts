import { CODE } from "../contract/contract.generated.ts";
import type { Finding } from "../finding.ts";
import type { InventorySymbol } from "../inventory.ts";
import { bytewise } from "../text/compare.ts";
import { codesOf } from "./codes.ts";
import { draft, named, visibilityWord } from "./draft.ts";
import type { Emitter } from "./emitter.ts";
import { subjectsOf, type Subjects, type WrittenSubject } from "./subjects.ts";

/**
 * The type parameters of one member's declaring type that only the member names, which
 * deleting the member leaves unused.
 */
function parametersOnlyNamedBy(s: Subjects, member: InventorySymbol): readonly string[] {
  const namedBy = s.namedBy();
  return s.union.symbols
    .filter((symbol) => {
      const from = namedBy.get(symbol.id);
      return (
        symbol.kind === "type-parameter" &&
        symbol.parent === member.parent &&
        from?.size === 1 &&
        from.has(member.id)
      );
    })
    .map((symbol) => symbol.name);
}

/** What one write-only finding says, the declarations its deletion takes with it included. */
function writeOnlyMessage(s: Subjects, subject: WrittenSubject): string {
  const { symbol, held } = subject;
  const writes = held.writes.length === 1 ? "once" : `at ${String(held.writes.length)} positions`;
  const read = s.input.stores.readInTests.has(symbol.id)
    ? "read only from test files"
    : "never read";
  const cascade = [
    ...parametersOnlyNamedBy(s, symbol).map((name) => `type parameter ${name}`),
    ...[...held.alone].sort(bytewise).map((name) => `import ${name}`),
    ...(s.written().named.get(symbol.id) ?? []).flatMap((id) => {
      const fallen = s.symbol(id);
      return fallen === undefined ? [] : [named(fallen)];
    }),
  ];
  const message = `${visibilityWord(symbol)}${named(symbol)} is written ${writes} and ${read}`;
  return cascade.length === 0
    ? message
    : `${message}, and deleting it with its writes deletes ${cascade.join(" and ")} too`;
}

/**
 * The findings of the reads-and-writes kinds, `DS1301`, `DS1005` and `DS1006`, in that
 * order and each code's in site order. `DS1005` is a member of an enum declaration nothing
 * names; `DS1006` a type parameter of a function, a class method or a type alias that
 * neither the declaration's signature nor its body names.
 */
export const readsAndWrites: Emitter = (input) => {
  const s = subjectsOf(input);
  const { dead } = codesOf(input);
  const ofCode = (code: string, message: (symbol: InventorySymbol) => string): Finding[] =>
    input.swept.sweep.candidates.flatMap((candidate) => {
      const symbol = s.symbol(candidate.id);
      return symbol === undefined || dead.get(candidate.id) !== code
        ? []
        : [draft(code, symbol, message(symbol))];
    });
  return [
    ...s.written().subjects.map((subject) =>
      draft(CODE.writeOnlySymbol, subject.symbol, writeOnlyMessage(s, subject), {
        writePositions: subject.held.writes,
      }),
    ),
    ...ofCode(CODE.unusedEnumMember, (symbol) => `enum member ${symbol.name} is named nowhere`),
    ...ofCode(
      CODE.unusedTypeParameter,
      (symbol) => `type parameter ${symbol.name} is named in neither its signature nor its body`,
    ),
  ];
};

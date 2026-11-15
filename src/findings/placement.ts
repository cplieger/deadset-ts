/**
 * Which dead component each finding of a run falls in: the sweep's components with each
 * file a `DS1602` finding reports dead among them, the components a subject that is no
 * declaration falls with joined into one, and a component of its own for every other
 * subject, numbered past the computed ones in finding order.
 */

import { CODE } from "../contract/contract.generated.ts";
import type { RunSweep } from "../analysis.ts";
import type { Cascade } from "../config.ts";
import type { Finding, FindingComponent, PositionedSymbol } from "../finding.ts";
import type { InventorySymbol } from "../inventory.ts";
import { componentId, joined, type Component } from "../liveness/components.ts";
import { deadComponents } from "../liveness/sweep.ts";
import { byPosition } from "../position.ts";

/** The members of a component as the run lists them, positioned and in the canonical order. */
function membersListed(
  swept: RunSweep,
): (members: readonly string[]) => readonly PositionedSymbol[] {
  const symbols = new Map(swept.matrix.union.symbols.map((symbol) => [symbol.id, symbol]));
  return (members) =>
    members
      .flatMap((member) => {
        const symbol = symbols.get(member);
        return symbol === undefined
          ? []
          : [
              {
                ref: symbol.ref,
                name: symbol.name,
                position: {
                  ...symbol.position,
                  endLine: Math.max(symbol.position.line, symbol.endLine),
                },
              },
            ];
      })
      .sort((a, b) => byPosition(a.position, b.position));
}

/** The dead components of one run as its findings place them. */
interface Placement {
  /** The component a dead declaration or file falls in, none for a live one. */
  readonly componentOf: (id: string) => FindingComponent | undefined;
  /** The file symbol each `DS1602` finding reports, by path. */
  readonly files: ReadonlyMap<string, string>;
  /** The ids of the dead components. */
  readonly dead: ReadonlySet<string>;
  /** The members of the components the sweep holds. */
  readonly held: ReadonlySet<string>;
  /** A component of its own for a subject in none, numbered past every one before it. */
  readonly mint: (finding: Finding, symbol: InventorySymbol | undefined) => FindingComponent;
}

/**
 * The run's dead components with each file a `DS1602` finding reports dead among them, so
 * the file's declarations fall with it, and with the components each subject that is no
 * declaration falls with joined into one. A join keeps its first component's identifier,
 * so a minted one counts past every computed one.
 */
export function placementOf(
  swept: RunSweep,
  findings: readonly Finding[],
  cascade: Cascade,
): Placement {
  const union = swept.matrix.union;
  const reported = new Set(
    findings.filter((one) => one.code === CODE.fileNeverImported).map((one) => one.position.path),
  );
  const files = new Map(
    union.symbols.flatMap((symbol, at) =>
      symbol.kind === "file" && reported.has(symbol.position.path) ? [[at, symbol] as const] : [],
    ),
  );
  const computed =
    files.size === 0
      ? swept.sweep.components
      : deadComponents(swept.matrix, swept.sweep, new Set(files.keys()));
  const place = new Map<string, number>();
  computed.forEach((component, at) => {
    for (const member of component.members) {
      place.set(member, at);
    }
  });
  const adjacent: number[][] = computed.map(() => []);
  for (const { fallsWith } of findings) {
    const [first, ...rest] = (fallsWith ?? []).flatMap((id) => place.get(id) ?? []);
    if (first !== undefined) {
      adjacent[first]?.push(...rest);
    }
  }
  const components = joined(adjacent).map((part) =>
    part
      .map((at) => computed[at])
      .filter((one): one is Component => one !== undefined)
      .reduce((into, component) => ({
        id: into.id,
        members: [...into.members, ...component.members],
        roots: [...into.roots, ...component.roots],
        deletableLines: into.deletableLines + component.deletableLines,
        held: into.held && component.held,
      })),
  );

  const byMember = new Map<string, Component>();
  for (const component of components) {
    for (const member of component.members) {
      byMember.set(member, component);
    }
  }
  const listed = membersListed(swept);
  const fallingWith = new Map<string, string[]>();
  for (const { id, heldByTests } of swept.sweep.candidates) {
    if (heldByTests !== undefined) {
      fallingWith.set(heldByTests, [...(fallingWith.get(heldByTests) ?? []), id]);
    }
  }
  let minted = computed.length;
  return {
    componentOf: (id) => {
      const component = byMember.get(id);
      return component === undefined
        ? undefined
        : {
            id: component.id,
            root: component.roots.includes(id),
            symbolCount: component.members.length,
            deletableLines: component.deletableLines,
            ...(cascade === "full" ? { members: listed(component.members) } : {}),
          };
    },
    files: new Map([...files.values()].map((symbol) => [symbol.position.path, symbol.id])),
    dead: new Set(components.map((component) => component.id)),
    held: new Set(components.filter((one) => one.held).flatMap((one) => one.members)),
    mint: (finding, symbol) => {
      minted += 1;
      const falling = symbol?.kind === "interface" ? fallingWith.get(symbol.id) : undefined;
      return {
        id: componentId(minted),
        root: true,
        symbolCount: falling?.length ?? 1,
        deletableLines: 0,
        ...(cascade !== "full"
          ? {}
          : falling === undefined
            ? {
                members: [
                  {
                    ref: finding.symbol.ref,
                    name: finding.symbol.name,
                    position: finding.position,
                  },
                ],
              }
            : { members: listed(falling) }),
      };
    },
  };
}

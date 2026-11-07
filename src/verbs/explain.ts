import { EXIT_CLEAN, EXIT_USAGE } from "../contract/contract.generated.ts";
import { productionMode, runAnalysis, type RunAnalysis } from "../analysis.ts";
import { listing } from "../liveness/components.ts";
import type { Cascade } from "../config.ts";
import type { CompletedFinding } from "../finding.ts";
import { swept as judged, type Edge, type Graph } from "../liveness/graph.ts";
import type { Origin } from "../liveness/sweep.ts";
import type { InventorySymbol } from "../inventory.ts";
import { partialNotes } from "../partial.ts";
import { resolvePath } from "../paths.ts";
import { positionKey } from "../position.ts";
import type { Reference } from "../references.ts";
import { madeByTestCode } from "../tests/file-class.ts";
import { resolve } from "../resolve.ts";
import { type Verb, type VerbOptions } from "./verb.ts";
import { UsageError } from "../usage.ts";
import { bytewise } from "../text/compare.ts";
import { diagnose } from "../product.ts";

/**
 * The three spellings of an explanation request, each naming the symbol to explain. They are
 * one request, because exactly one state holds for a symbol and the answer is that state.
 */
const WHY_OPTIONS = ["why", "why-live", "why-not"] as const;

/** The options `explain` takes beside the ones every verb takes. */
export const EXPLAIN_OPTIONS: VerbOptions = { plain: [...WHY_OPTIONS], repeatable: [] };

/** The most partial matches a refused request prints. */
const MAX_PARTIAL_MATCHES = 20;

/** A count with its noun, so a line reads for one as well as for several. */
function counted(n: number, noun: string): string {
  return `${String(n)} ${noun}${n === 1 ? "" : "s"}`;
}

/** A list for a line a maintainer reads, which says none rather than leaving the field blank. */
function listed(items: readonly string[]): string {
  return items.length === 0 ? "none" : items.join(" ");
}

/** The one symbol a request names, from whichever of the three options names it. */
function namedSymbol(option: (name: string) => string | undefined): string {
  const named = WHY_OPTIONS.flatMap((name) => {
    const value = option(name);
    return value === undefined || value === "" ? [] : [{ name, value }];
  });
  const [only, ...more] = named;
  if (only === undefined) {
    throw new UsageError(
      "explain explains the symbol --why, --why-live or --why-not names, and none was named",
    );
  }
  if (more.length > 0) {
    throw new UsageError(
      `explain explains one symbol, and ${named.map((one) => `--${one.name}`).join(", ")} each name one`,
    );
  }
  return only.value;
}

/** The part of a reference after its separator: the `Type.member` or bare name a maintainer types. */
function fragmentOf(symbol: InventorySymbol): string {
  const at = symbol.ref.indexOf("#");
  return at < 0 ? "" : symbol.ref.slice(at + 1);
}

function described(symbol: InventorySymbol): string {
  return `${symbol.ref}\t${positionKey(symbol.position)}`;
}

/**
 * The one declaration a request names, or the candidates where it names none or several.
 * The reference, the fragment of it a maintainer types and the display name are tried in
 * order, each an exact match; a key several declarations answer is no answer.
 */
function subjectOf(
  symbols: readonly InventorySymbol[],
  named: string,
): { readonly subject?: InventorySymbol; readonly candidates: readonly string[] } {
  const keys: ((symbol: InventorySymbol) => string)[] = [
    (symbol) => symbol.ref,
    fragmentOf,
    (symbol) => symbol.name,
  ];
  for (const key of keys) {
    const matched = symbols.filter((symbol) => key(symbol) === named);
    const [only] = matched;
    if (only !== undefined && matched.length === 1) {
      return { subject: only, candidates: [] };
    }
    if (matched.length > 1) {
      return { candidates: matched.map(described) };
    }
  }
  const folded = named.toLowerCase();
  const partial = symbols
    .filter(
      (symbol) =>
        symbol.ref.toLowerCase().includes(folded) || symbol.name.toLowerCase().includes(folded),
    )
    .map(described)
    .sort(bytewise);
  return { candidates: partial.slice(0, MAX_PARTIAL_MATCHES) };
}

/** Where a path starts, as a line names it. */
function originText(origin: Origin, graph: Graph): string {
  const id = (at: number): string => graph.symbols[at]?.id ?? "";
  switch (origin.k) {
    case "root":
      return `root ${origin.rooted.kind} ${id(origin.rooted.at)}`;
    case "consumed": {
      const reference = graph.references[origin.edge.reference];
      if (reference?.consumer !== undefined) {
        return `consumer ${reference.consumer}`;
      }
      return reference?.unheld === true
        ? `test file no project holds ${reference.from.replace(/#$/u, "")}`
        : `declaration no configuration judges ${reference?.from ?? ""}`;
    }
    case "exemption":
      return `exemption ${origin.record.class} ${positionKey(origin.record.site)}`;
    case "mark":
      return `suppression of ${id(origin.at)}`;
    case "unanswered":
      return `unanswered question about ${id(origin.at)}`;
  }
}

/** What made a reference: a declaration of the target, or a loaded consumer. */
function madeBy(reference: Reference): string {
  return reference.consumer === undefined ? reference.from : `consumer ${reference.consumer}`;
}

/**
 * One reference of an answer, marked where test code made it, a test-support file's included,
 * and naming the configurations that make it where they are not every one of the run.
 */
function referenceLine(
  reference: Reference,
  tail: string,
  support: ReadonlySet<string>,
  configurations: { readonly making: readonly string[]; readonly run: readonly string[] },
): string {
  const partial = configurations.making.length < configurations.run.length;
  return `  reference: ${positionKey(reference.position)}\t${reference.use}\t${tail}${madeByTestCode(reference, support) ? "\tfrom a test file" : ""}${partial ? `\tmade in ${configurations.making.join(" ")}` : ""}\n`;
}

/** Why a declaration no finding names and no exemption held back is live, or how it fell. */
function liveness(analysis: RunAnalysis, subject: InventorySymbol, cascade: Cascade): string {
  const { matrix, sweep } = analysis.swept;
  const graph = matrix.union;
  const candidate = sweep.candidates.find((one) => one.id === subject.id);
  if (candidate === undefined && !judged(subject.kind)) {
    return `answer: unjudged\n  unjudged: neither liveness relation judges a ${subject.kind}\n`;
  }
  let text = `answer: ${candidate === undefined ? "live" : "dead"}\n`;
  text += `  live under: ${listed(sweep.liveUnder.get(subject.id) ?? [])}\n`;
  const at = graph.at(subject.id);
  const seen = new Set<string>();
  for (const root of graph.rooted.filter((one) => one.at === at)) {
    const key = `${root.kind}\u0000${root.source}`;
    if (!seen.has(key)) {
      seen.add(key);
      text += `  root: ${root.kind}${root.source === "" ? "" : `\tnamed by ${root.source}`}\n`;
    }
  }
  const support = new Set(analysis.configured.flatMap((one) => one.supportFiles ?? []));
  const line = (edge: Edge, tail: (reference: Reference) => string): string => {
    const reference = graph.references[edge.reference];
    return reference === undefined
      ? ""
      : referenceLine(reference, tail(reference), support, {
          making: graph.configurations[edge.reference] ?? [],
          run: matrix.configurations,
        });
  };
  const found = sweep.path(subject.id);
  if (found !== undefined && found.hops.length > 0) {
    text += `  reached from: ${originText(found.origin, graph)}\n`;
    for (const hop of found.hops) {
      text += line(hop.edge, (reference) => `${madeBy(reference)} -> ${reference.to}`);
      if (hop.k === "export") {
        const reference = graph.references[hop.edge.reference];
        text += `  export: ${reference?.to ?? ""} -> ${graph.symbols[hop.to]?.id ?? ""}\n`;
      }
    }
  } else if (found === undefined) {
    const references = graph.references.flatMap((one, place) =>
      one.to === subject.id ? [place] : [],
    );
    text +=
      "  unreachable: no path of references reaches it from a root, a loaded consumer or a test file no project holds\n";
    text += `  references: ${String(references.length)}\n`;
    for (const place of references) {
      const reference = graph.references[place];
      if (reference !== undefined) {
        text += referenceLine(reference, `from ${madeBy(reference)}`, support, {
          making: graph.configurations[place] ?? [],
          run: matrix.configurations,
        });
      }
    }
  }
  if (candidate !== undefined) {
    const component = sweep.components.find((one) => one.members.includes(subject.id));
    if (component !== undefined) {
      const listed = listing(component, cascade);
      text += `  component: ${component.id}, ${counted(listed.symbolCount, "symbol")} and ${counted(listed.deletableLines, "deletable line")} fall with it, listed at cascade ${cascade}\n`;
      for (const root of listed.roots) {
        text += `  component root: ${root}\n`;
      }
      for (const member of listed.members) {
        text += `  component member: ${member}\n`;
      }
    }
    text += `  candidate: dead under ${candidate.relation}, with ${String(candidate.productionRefs)} production and ${String(candidate.testRefs)} test references\n`;
  }
  return text;
}

function reported(found: CompletedFinding): string {
  return [
    `answer: reported`,
    `  code: ${found.code} ${found.kind}`,
    `  message: ${found.message}`,
    `  class: ${found.reachabilityClass}`,
    `  confidence: ${found.confidence}`,
    ...(found.livenessRelation === undefined
      ? []
      : [`  liveness relation: ${found.livenessRelation}`]),
    `  configurations: ${listed(found.configurations)}`,
    `  loaded consumers: ${listed(found.consumersLoaded)}`,
    ...found.retainedBy.map((one) => `  retained by: ${one}`),
    "",
  ].join("\n");
}

/**
 * Every finding of the run that names the declaration by its reference and reports at
 * another position: a part of it, or a suppression record naming it. Each is published under
 * the reference asked about, or a parameter's under one it starts, so an explanation leaving
 * it out would disagree with the report.
 */
function namedElsewhere(findings: readonly CompletedFinding[], subject: InventorySymbol): string {
  return findings
    .filter(
      (found) =>
        (found.symbol.holder ?? found.symbol.ref) === subject.ref &&
        positionKey(found.position) !== subject.id,
    )
    .map(
      (found) =>
        `also reported: ${found.code} ${found.kind}\t${positionKey(found.position)}\t${found.symbol.kind} ${found.symbol.name}\n`,
    )
    .join("");
}

/** The one explanation that applies to a declaration, built whole before it is written. */
function explanation(analysis: RunAnalysis, subject: InventorySymbol, cascade: Cascade): string {
  const graph = analysis.swept.matrix.union;
  const at = graph.at(subject.id);
  let text = `symbol: ${subject.ref}\n`;
  text += `declaration: ${subject.kind} ${subject.name}\n`;
  text += `position: ${subject.id}\n`;
  text += `configurations: ${listed(analysis.swept.matrix.heldIn[at] ?? [])}\n`;
  const found = analysis.result.findings.find((one) => positionKey(one.position) === subject.id);
  const retained = analysis.swept.sweep.retained.filter((one) => one.id === subject.id);
  if (found !== undefined) {
    text += reported(found);
  } else if (retained.length > 0) {
    text += `answer: retained\n  held back by: ${counted(retained.length, "exemption class")}\n`;
    for (const one of retained) {
      text += `  class: ${one.class}\t${positionKey(one.site)}\t${one.detail}\n`;
    }
  } else if (analysis.swept.sweep.held.includes(subject.id)) {
    text +=
      "answer: held\n  held by: a question the checker did not answer, which could have kept it live, so no finding names it\n";
  } else {
    text += liveness(analysis, subject, cascade);
  }
  return text + namedElsewhere(analysis.result.findings, subject);
}

/**
 * Explains one symbol from the analysis the report is built from: why a reported symbol is
 * reported, which exemption classes held a retained one back, that an unanswered question held
 * a held one, and for any other declaration the relations that hold it live and the path the
 * sweep's strongest tier reaching it follows, or the references it has where no path reaches
 * it. A request naming no one declaration exits with the usage code and names what partially
 * matches it. Where the analysis was partial, the error stream says so.
 */
export const explainVerb: Verb = ({ out, err, host, inputs, scope, openClient, option }) => {
  const named = namedSymbol(option);
  const { config, provenance } = resolve(inputs());
  const scoped = scope();
  const mode = productionMode(config);
  const analysis = runAnalysis(openClient(config), host, scoped, config, provenance, mode);
  const { subject, candidates } = subjectOf(analysis.swept.matrix.union.symbols, named);
  const notes = partialNotes({
    notBuilt: analysis.run.notBuilt,
    unanswered: analysis.run.unanswered,
    targetRoot: resolvePath(host.workingDirectory(), scoped.target.path),
  });
  if (subject === undefined) {
    diagnose(err, `${JSON.stringify(named)} names no one symbol of the target`);
    for (const candidate of candidates) {
      err.write(`  ${candidate}\n`);
    }
    if (candidates.length === 0) {
      err.write("  no symbol of the target partially matches it either\n");
    }
  } else {
    out.write(explanation(analysis, subject, config.reporters.cascade));
  }
  for (const note of notes) {
    diagnose(err, note);
  }
  return subject === undefined ? EXIT_USAGE : EXIT_CLEAN;
};

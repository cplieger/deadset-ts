import { runAnalysis, type RunAnalysis } from "../analysis.ts";
import { listing } from "../components.ts";
import type { Cascade } from "../config.ts";
import { ConfigError } from "../config.ts";
import type { CompletedFinding } from "../finding.ts";
import { OUTSIDE, swept as judged } from "../graph.ts";
import type { InventorySymbol } from "../inventory.ts";
import { referenceKey, type Configured } from "../matrix.ts";
import { partialNotes } from "../partial.ts";
import { resolvePath } from "../paths.ts";
import { positionKey } from "../position.ts";
import type { Reference } from "../references.ts";
import { resolve } from "../resolve.ts";
import type { Root } from "../roots.ts";
import { EXIT_CLEAN, EXIT_USAGE, type Verb, type VerbOptions } from "./verb.ts";

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
    throw new ConfigError(
      "malformed",
      "",
      "explain explains the symbol --why, --why-live or --why-not names, and none was named",
    );
  }
  if (more.length > 0) {
    throw new ConfigError(
      "malformed",
      "",
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
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return { candidates: partial.slice(0, MAX_PARTIAL_MATCHES) };
}

/** Every reference of the run once, a reference several configurations make counted once. */
function referencesOf(configured: readonly Configured[]): readonly Reference[] {
  const seen = new Set<string>();
  const held: Reference[] = [];
  for (const reference of configured.flatMap((one) => one.references)) {
    const key = referenceKey(reference);
    if (!seen.has(key)) {
      seen.add(key);
      held.push(reference);
    }
  }
  return held;
}

/** Every root of the run once per reason, in the order the projects name them. */
function rootsOf(configured: readonly Configured[]): readonly Root[] {
  const seen = new Set<string>();
  return configured
    .flatMap((one) => one.roots)
    .filter((root) => {
      const key = [root.id, root.kind, root.source].join("\u0000");
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
}

/**
 * One step of a path: a reference, or a reference that reads a module and so reaches a
 * declaration the module exports.
 */
type Hop =
  | { readonly k: "reference"; readonly reference: Reference }
  | { readonly k: "export"; readonly reference: Reference; readonly to: string };

/** Where a path starts: a root of the run, or a reference a loaded consumer makes. */
type Origin =
  | { readonly k: "root"; readonly root: Root }
  | { readonly k: "consumer"; readonly consumer: string };

/**
 * The shortest path from a root or a loaded consumer to one declaration, walked breadth first
 * from every root at once in the order the run names them, a consumer's reference being the
 * first hop of a path of its own, and following the references the sweep follows: a
 * reference that reads a module reaches what the module exports, and an evaluation or a root
 * reaches the module alone. Under `production` no reference a test file made is followed,
 * which is the set the report's sweep counts.
 */
function shortestPath(
  analysis: RunAnalysis,
  to: string,
  production: boolean,
): { readonly origin: Origin; readonly path: readonly Hop[] } | undefined {
  const graph = analysis.swept.matrix.union;
  const out = new Map<string, Reference[]>();
  const consumed: (Reference & { readonly consumer: string })[] = [];
  for (const reference of referencesOf(analysis.configured)) {
    if (production && reference.test) {
      continue;
    }
    const { consumer } = reference;
    if (consumer !== undefined) {
      consumed.push({ ...reference, consumer });
      continue;
    }
    const held = out.get(reference.from);
    if (held === undefined) {
      out.set(reference.from, [reference]);
    } else {
      held.push(reference);
    }
  }
  interface Step {
    readonly at: string;
    readonly hop: Hop | undefined;
    readonly previous: number;
    readonly origin: Origin;
  }
  const steps: Step[] = [];
  const seen = new Set<string>();
  const expanded = new Set<string>();
  const enter = (step: Step): void => {
    if (!seen.has(step.at)) {
      seen.add(step.at);
      steps.push(step);
    }
  };
  const follow = (reference: Reference, previous: number, origin: Origin): void => {
    enter({ at: reference.to, hop: { k: "reference", reference }, previous, origin });
    const target = graph.at(reference.to);
    if (reference.use === "evaluation" || target === OUTSIDE || expanded.has(reference.to)) {
      return;
    }
    expanded.add(reference.to);
    for (const exported of graph.exportsOf[target] ?? []) {
      const id = graph.symbols[exported]?.id;
      if (id !== undefined) {
        enter({ at: id, hop: { k: "export", reference, to: id }, previous, origin });
      }
    }
  };
  for (const root of rootsOf(analysis.configured)) {
    enter({ at: root.id, hop: undefined, previous: -1, origin: { k: "root", root } });
  }
  // A consumer's reference is one hop long, so it joins the walk where the roots' first
  // hops do.
  const firstHops = steps.length;
  for (let head = 0; ; head += 1) {
    if (head === firstHops) {
      for (const reference of consumed) {
        follow(reference, -1, { k: "consumer", consumer: reference.consumer });
      }
    }
    const step = steps[head];
    if (step === undefined) {
      break;
    }
    if (step.at === to) {
      const path: Hop[] = [];
      for (let at: Step | undefined = step; at?.hop !== undefined; at = steps[at.previous]) {
        path.unshift(at.hop);
      }
      return { origin: step.origin, path };
    }
    for (const reference of out.get(step.at) ?? []) {
      follow(reference, head, step.origin);
    }
  }
  return undefined;
}

/** What made a reference: a declaration of the target, or a loaded consumer. */
function madeBy(reference: Reference): string {
  return reference.consumer === undefined ? reference.from : `consumer ${reference.consumer}`;
}

function referenceLine(reference: Reference, tail: string): string {
  return `  reference: ${positionKey(reference.position)}\t${reference.use}\t${tail}${reference.test ? "\tfrom a test file" : ""}\n`;
}

/** Why a declaration no finding names and no exemption held back is live, or how it fell. */
function liveness(analysis: RunAnalysis, subject: InventorySymbol, cascade: Cascade): string {
  const { sweep } = analysis.swept;
  const candidate = sweep.candidates.find((one) => one.id === subject.id);
  if (candidate === undefined && !judged(subject.kind)) {
    return `answer: unjudged\n  unjudged: neither liveness relation judges a ${subject.kind}\n`;
  }
  let text = `answer: ${candidate === undefined ? "live" : "dead"}\n`;
  text += `  live under: ${listed(sweep.liveUnder.get(subject.id) ?? [])}\n`;
  for (const root of rootsOf(analysis.configured).filter((one) => one.id === subject.id)) {
    text += `  root: ${root.kind}${root.source === "" ? "" : `\tnamed by ${root.source}`}\n`;
  }
  const found =
    shortestPath(analysis, subject.id, true) ?? shortestPath(analysis, subject.id, false);
  if (found !== undefined && found.path.length > 0) {
    const { origin } = found;
    text += `  reached from: ${origin.k === "root" ? `root ${origin.root.kind} ${origin.root.id}` : `consumer ${origin.consumer}`}\n`;
    for (const hop of found.path) {
      text += referenceLine(hop.reference, `${madeBy(hop.reference)} -> ${hop.reference.to}`);
      if (hop.k === "export") {
        text += `  export: ${hop.reference.to} -> ${hop.to}\n`;
      }
    }
  } else if (found === undefined) {
    const references = referencesOf(analysis.configured).filter((one) => one.to === subject.id);
    text += "  unreachable: no path of references reaches it from a root or a loaded consumer\n";
    text += `  references: ${String(references.length)}\n`;
    for (const reference of references) {
      text += referenceLine(reference, `from ${madeBy(reference)}`);
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
 * the reference asked about, so an explanation leaving it out would disagree with the report.
 */
function namedElsewhere(findings: readonly CompletedFinding[], subject: InventorySymbol): string {
  return findings
    .filter(
      (found) => found.symbol.ref === subject.ref && positionKey(found.position) !== subject.id,
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
  const retained = analysis.swept.retained.filter((one) => one.id === subject.id);
  if (found !== undefined) {
    text += reported(found);
  } else if (retained.length > 0) {
    text += `answer: retained\n  held back by: ${counted(retained.length, "exemption class")}\n`;
    for (const one of retained) {
      text += `  class: ${one.class}\t${positionKey(one.site)}\t${one.detail}\n`;
    }
  } else if (analysis.swept.heldByUnanswered.includes(subject.id)) {
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
 * a held one, and for any other declaration the relations that hold it live and the shortest
 * path from a root or a loaded consumer, or the references it has where no path reaches it. A
 * request naming no one declaration exits with the usage code and names what partially
 * matches it. Where the analysis was partial, the error stream says so.
 */
export const explainVerb: Verb = ({ out, err, host, inputs, scope, openClient, option }) => {
  const named = namedSymbol(option);
  const { config, provenance } = resolve(inputs());
  const scoped = scope();
  const analysis = runAnalysis(openClient(false), host, scoped, config, provenance, {
    production: true,
  });
  const { subject, candidates } = subjectOf(analysis.swept.matrix.union.symbols, named);
  const notes = partialNotes({
    notBuilt: analysis.run.notBuilt,
    unanswered: analysis.run.unanswered,
    targetRoot: resolvePath(host.workingDirectory(), scoped.target.path),
  });
  if (subject === undefined) {
    err.write(`deadset-ts: ${JSON.stringify(named)} names no one symbol of the target\n`);
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
    err.write(`deadset-ts: ${note}\n`);
  }
  return subject === undefined ? EXIT_USAGE : EXIT_CLEAN;
};

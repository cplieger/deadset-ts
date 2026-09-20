import { readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { nodeHost } from "../bin/node-host.ts";
import { defaultConfig } from "../src/config.ts";
import { diagnosticErrors, discoverProjects, renderDiagnostic } from "../src/discover.ts";
import { inventory, type InventoryCost } from "../src/inventory.ts";
import { references, type ReferenceCost, type ReferenceOptions } from "../src/references.ts";
import { scopeForDir } from "../src/scope.ts";
import { diagnosticsOf, openEngine, runSession, type Engine } from "../src/session.ts";

/**
 * Measures what one batch cap costs the reference pass, so the pass option's
 * default is read off an instrument rather than chosen.
 *
 * It is developer tooling that neither registry publishes: the manifest's file
 * list and the JSR include list both name `bin/` and `src/` and not this
 * directory. Run it from a checkout:
 *
 * ```sh
 * node scripts/calibrate-batch-cap.ts --target ../reactive --caps 256,4096,uncapped
 * ```
 *
 * It writes one JSON document to standard output and its progress to standard
 * error, so the calibration record is produced by the tool and not by hand.
 */

/** A cap value as the sweep names it: a number of name nodes, or no cap at all. */
export type Cap = number | "uncapped";

/**
 * The cap the pass is given for `"uncapped"`. A batch is sliced at the cap, so a
 * value no file's name-node count reaches is one batch per file, which is what an
 * uncapped batch means for a pass that always slices.
 */
const NO_CAP = Number.MAX_SAFE_INTEGER;

/** The cap values the sweep walks when the caller names none. */
const DEFAULT_CAPS: readonly Cap[] = [256, 1024, 4096, 16384, "uncapped"];

/** How many measurements each package-and-cap pair takes when the caller names none. */
const DEFAULT_REPEAT = 3;

/** What the client measured for one pass, and the wall clock around it. */
export interface Sample {
  /** Wall-clock time for discovery, the snapshot and both passes, in milliseconds. */
  readonly wallMs: number;
  /** Requests the client made, which is the round-trip count. */
  readonly requestCount: number;
  /** Sum of the client-measured round-trip latency, in milliseconds. */
  readonly roundTripMs: number;
  /** Request payload bytes sent to the server. */
  readonly bytesSent: number;
  /** Response payload bytes received from the server. */
  readonly bytesReceived: number;
  /** Sum of the server's own processing time, in milliseconds. */
  readonly serverTimeMs: number;
}

/** The three terms that bound a run's round trips. */
interface Bound {
  /** Per file, the name-node count divided by the cap, rounded up, summed. */
  readonly fileBatches: number;
  /** Per-node lookups for the name nodes a batch left unresolved. */
  readonly residueFallbacks: number;
  /**
   * One declared-type read per interface of the conversion set, plus one
   * assignability check per pair in it. It is zero here: the harness runs the
   * inventory and the reference pass, and the calls are made by the
   * interface-satisfaction pass, which this version does not run.
   */
  readonly pairAssignabilityCalls: number;
}

/** What one cap value cost one package. */
interface CapResult {
  readonly cap: Cap;
  /** The measurements, one per repeat, in the order they were taken. */
  readonly samples: readonly Sample[];
  /** The median of each measurement over the repeats. */
  readonly median: Sample;
  readonly bound: Bound;
  /** The reference pass's own accounting, summed over the package's projects. */
  readonly referenceCost: ReferenceCost;
  /** The inventory's accounting, summed over the package's projects. */
  readonly inventoryCost: InventoryCost;
}

/** One package of the sweep, measured or refused. */
type PackageResult =
  | {
      readonly package: string;
      readonly loaded: true;
      /** The compiler configurations the package holds. */
      readonly projects: number;
      readonly results: readonly CapResult[];
    }
  | {
      readonly package: string;
      readonly loaded: false;
      /** Why the fail-closed load refused the package. */
      readonly reason: string;
    };

/** The document the harness writes. */
interface Calibration {
  readonly description: string;
  readonly caps: readonly Cap[];
  readonly repeat: number;
  /** The cap these measurements chose, which is the pass option's default. */
  readonly chosenDefault: number;
  readonly packages: readonly PackageResult[];
}

/**
 * The middle value of `values`, and the lower of the two middles when the count is
 * even, so every number reported is one a run actually measured rather than a mean
 * of two that no run did. An empty list has no middle.
 */
export function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted[Math.floor((sorted.length - 1) / 2)];
  if (middle === undefined) {
    throw new Error("median of no values");
  }
  return middle;
}

/** The median of each measurement of `samples`, field by field. */
export function medianSample(samples: readonly Sample[]): Sample {
  return {
    wallMs: median(samples.map((sample) => sample.wallMs)),
    requestCount: median(samples.map((sample) => sample.requestCount)),
    roundTripMs: median(samples.map((sample) => sample.roundTripMs)),
    bytesSent: median(samples.map((sample) => sample.bytesSent)),
    bytesReceived: median(samples.map((sample) => sample.bytesReceived)),
    serverTimeMs: median(samples.map((sample) => sample.serverTimeMs)),
  };
}

/** A package the fail-closed load refused. */
class Refused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Refused";
  }
}

/** What one pass over one package answered. */
interface Pass {
  readonly sample: Sample;
  readonly referenceCost: ReferenceCost;
  readonly inventoryCost: InventoryCost;
  readonly projects: number;
}

const NO_REFERENCE_COST: ReferenceCost = {
  batched: 0,
  fileBatches: 0,
  residueFallbacks: 0,
  shorthandLookups: 0,
  aliasSteps: 0,
};

const NO_INVENTORY_COST: InventoryCost = { batches: 0, exportTables: 0, memberTables: 0 };

/**
 * Runs the inventory and then the reference pass over every project `dir` holds,
 * inside one client opened with timing collection on, and answers what it cost.
 *
 * The clock starts once the client is open, because opening it costs the same
 * whatever the cap, and stops when the last project has been read.
 */
function onePass(dir: string, cap: Cap): Pass {
  const host = nodeHost();
  const scope = scopeForDir(host, dir);
  const targetRoot = scope.target.path;
  const options: ReferenceOptions = {
    batchCap: cap === "uncapped" ? NO_CAP : cap,
    testFiles: defaultConfig().ts.testFiles,
  };
  const engine: Engine = openEngine({ collectTiming: true });
  const started = process.hrtime.bigint();
  let configFiles: readonly string[];
  try {
    configFiles = discoverProjects(engine, host, scope).configFiles;
  } catch (error: unknown) {
    engine.close();
    throw error;
  }
  const { projects, timing } = runSession(engine, configFiles, (project) => {
    const errors = diagnosticErrors(diagnosticsOf(project));
    const first = errors[0];
    if (first !== undefined) {
      throw new Refused(
        `${project.configFile}: ${String(errors.length)} error(s): ${renderDiagnostic(first)}`,
      );
    }
    const held = inventory(project, host, targetRoot);
    return { reference: references(project, held, targetRoot, options).cost, held: held.cost };
  });
  const wallMs = Number(process.hrtime.bigint() - started) / 1e6;
  return {
    sample: {
      wallMs,
      requestCount: timing.totals.requestCount,
      roundTripMs: timing.totals.roundTripMs,
      bytesSent: timing.totals.bytesSent,
      bytesReceived: timing.totals.bytesReceived,
      serverTimeMs: timing.totals.serverTimeMs,
    },
    referenceCost: projects.reduce<ReferenceCost>(
      (sum, { reference }) => ({
        batched: sum.batched + reference.batched,
        fileBatches: sum.fileBatches + reference.fileBatches,
        residueFallbacks: sum.residueFallbacks + reference.residueFallbacks,
        shorthandLookups: sum.shorthandLookups + reference.shorthandLookups,
        aliasSteps: sum.aliasSteps + reference.aliasSteps,
      }),
      NO_REFERENCE_COST,
    ),
    inventoryCost: projects.reduce<InventoryCost>(
      (sum, { held }) => ({
        batches: sum.batches + held.batches,
        exportTables: sum.exportTables + held.exportTables,
        memberTables: sum.memberTables + held.memberTables,
      }),
      NO_INVENTORY_COST,
    ),
    projects: projects.length,
  };
}

/**
 * Why a package is not in the numbers: the first line of what refused it, with the
 * target's own path taken off the front of every path in it. The first line is what
 * a run records for a configuration it could not build, and a record naming the
 * directory a measurement happened to run in names the machine it ran on.
 */
function reasonOf(error: unknown, dir: string): string {
  const message = error instanceof Error ? error.message : String(error);
  return (message.split("\n")[0] ?? message).replaceAll(`${dir}/`, "").replaceAll(dir, ".");
}

/** The name the record calls one target: its manifest's name, or its directory's. */
function labelOf(dir: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  } catch {
    return basename(dir);
  }
  if (typeof parsed !== "object" || parsed === null) {
    return basename(dir);
  }
  const name = (parsed as Record<string, unknown>)["name"];
  return typeof name === "string" && name.length > 0 ? name : basename(dir);
}

/** Sweeps every cap over one package, `repeat` measurements each. */
export function sweepPackage(dir: string, caps: readonly Cap[], repeat: number): PackageResult {
  const label = labelOf(dir);
  const results: CapResult[] = [];
  let projects = 0;
  for (const cap of caps) {
    const samples: Sample[] = [];
    let referenceCost = NO_REFERENCE_COST;
    let inventoryCost = NO_INVENTORY_COST;
    for (let round = 0; round < repeat; round += 1) {
      process.stderr.write(`${label} cap=${String(cap)} round ${String(round + 1)}\n`);
      let pass: Pass;
      try {
        pass = onePass(dir, cap);
      } catch (error: unknown) {
        return { package: label, loaded: false, reason: reasonOf(error, dir) };
      }
      samples.push(pass.sample);
      projects = pass.projects;
      // Both passes are deterministic, so every repeat at one cap costs the same
      // lookups. A repeat that does not means a number below is not this cap's.
      const measured = JSON.stringify([pass.referenceCost, pass.inventoryCost]);
      if (round === 0) {
        referenceCost = pass.referenceCost;
        inventoryCost = pass.inventoryCost;
      } else if (measured !== JSON.stringify([referenceCost, inventoryCost])) {
        throw new Error(`${label} cap=${String(cap)}: the pass cost differs between repeats`);
      }
    }
    results.push({
      cap,
      samples,
      median: medianSample(samples),
      bound: {
        fileBatches: referenceCost.fileBatches,
        residueFallbacks: referenceCost.residueFallbacks,
        pairAssignabilityCalls: 0,
      },
      referenceCost,
      inventoryCost,
    });
  }
  return { package: label, loaded: true, projects, results };
}

/** One cap value as the command line spells it. */
function capOf(text: string): Cap {
  if (text === "uncapped") {
    return "uncapped";
  }
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`--caps: ${text} is not a cap`);
  }
  return value;
}

/** What the command line asked for. */
interface Options {
  readonly targets: readonly string[];
  readonly caps: readonly Cap[];
  readonly repeat: number;
  readonly chosenDefault: number;
}

/**
 * The options `args` names. `--target` is repeatable and every target is swept;
 * `--chosen-default` is the cap the record reports as chosen, which defaults to
 * the first numeric cap of the sweep so a run that has not read its own numbers
 * yet still writes a document the pin test can read.
 */
export function readOptions(args: readonly string[]): Options {
  const targets: string[] = [];
  let caps = DEFAULT_CAPS;
  let repeat = DEFAULT_REPEAT;
  let chosenDefault: number | undefined;
  for (let at = 0; at < args.length; at += 2) {
    const name = args[at];
    const value = args[at + 1];
    if (value === undefined) {
      throw new Error(`${String(name)} takes a value`);
    }
    switch (name) {
      case "--target":
        targets.push(resolve(process.cwd(), value));
        break;
      case "--caps":
        caps = value.split(",").map(capOf);
        break;
      case "--repeat": {
        const count = Number(value);
        if (!Number.isSafeInteger(count) || count < 1) {
          throw new Error(`--repeat: ${value} is not a count`);
        }
        repeat = count;
        break;
      }
      case "--chosen-default": {
        const cap = capOf(value);
        if (cap === "uncapped") {
          throw new Error("--chosen-default: the pass option's default is a number");
        }
        chosenDefault = cap;
        break;
      }
      default:
        throw new Error(`unknown option ${String(name)}`);
    }
  }
  if (targets.length === 0) {
    throw new Error("--target names a package to sweep and is required");
  }
  const numeric = caps.find((cap): cap is number => cap !== "uncapped");
  if (chosenDefault === undefined && numeric === undefined) {
    throw new Error("--chosen-default: the sweep names no numeric cap to choose");
  }
  return { targets, caps, repeat, chosenDefault: chosenDefault ?? numeric ?? 0 };
}

const DESCRIPTION =
  "What each batch cap cost the reference pass, measured by scripts/calibrate-batch-cap.ts with " +
  'the compiler client\'s timing collection on. caps are the values swept, "uncapped" being one ' +
  "batch per file; repeat is how many measurements each package-and-cap pair took, and median is " +
  "the middle one of each measurement, the lower of two middles. A sample's wallMs covers " +
  "discovery, the snapshot and both passes; requestCount, roundTripMs, bytesSent, bytesReceived " +
  "and serverTimeMs are the client's own totals for the same work. bound holds the three terms " +
  "that bound a run's round trips, of which pairAssignabilityCalls is zero in every row because " +
  "the calls are made by the interface-satisfaction pass, which this version does not run. " +
  "chosenDefault is the cap these numbers chose, which is the reference pass option's default.";

/** Sweeps what `args` names and writes the record to standard output. */
export function main(args: readonly string[]): void {
  const options = readOptions(args);
  const record: Calibration = {
    description: DESCRIPTION,
    caps: options.caps,
    repeat: options.repeat,
    chosenDefault: options.chosenDefault,
    packages: options.targets.map((dir) => sweepPackage(dir, options.caps, options.repeat)),
  };
  process.stdout.write(`${JSON.stringify(record, null, 2)}\n`);
}

const invoked = process.argv[1];
if (invoked !== undefined && resolve(invoked) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}

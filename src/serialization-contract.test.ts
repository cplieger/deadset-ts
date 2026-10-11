import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { nodeHost } from "../bin/node-host.ts";
import { emitterInputOf, findingsOf } from "../__test-helpers__/emitter-input.ts";
import { fixture } from "../__test-helpers__/fixtures.ts";
import { runSweep, type RunSweep } from "./analysis.ts";
import { resolve } from "./resolve.ts";
import { run, type Writer } from "./run.ts";
import { scopeForDir } from "./scope.ts";
import { openEngine } from "./session.ts";

const TARGET = fixture("projects", "serialization-contract");
const CHECKED = fixture("projects", "serialization-checked-and-ambient");

/** The fixture swept for production, under its own configuration or the one given. */
function sweepFixture(document?: string, target = TARGET): RunSweep {
  const path = join(target, "deadset.json");
  const { config } = resolve({
    repository: document ?? readFileSync(path, "utf8"),
    repositoryLabel: path,
  });
  const host = nodeHost();
  return runSweep(openEngine({ collectTiming: false }), host, scopeForDir(host, target), config, {
    marked: [],
    mode: { production: true },
  });
}

/** The display name of one declaration of the run. */
function nameOf(swept: RunSweep, id: string): string {
  return swept.matrix.union.symbols.find((symbol) => symbol.id === id)?.name ?? id;
}

/** Each record of the class on a member of the named classes, with its site and detail. */
function serialized(swept: RunSweep, ...classes: readonly string[]): string[] {
  return swept.retained
    .filter((held) => held.class === "serialization-contract")
    .map(
      (held) =>
        `${nameOf(swept, held.id)} ${held.site.path}:${String(held.site.line)}:${String(held.site.column)} ${held.detail}`,
    )
    .filter((line) => classes.some((name) => line.startsWith(`${name}.`)));
}

/** Each member of the model the sweep reports dead. */
function deadMembers(swept: RunSweep): string[] {
  return swept.sweep.candidates
    .map((candidate) => nameOf(swept, candidate.id))
    .filter((name) => name.includes("."));
}

class MemoryWriter implements Writer {
  text = "";
  write(text: string): void {
    this.text += text;
  }
}

describe("serialization-contract", () => {
  const swept = sweepFixture();

  it("retains the properties of a class whose values reach a serializer, and those its properties carry", () => {
    expect(serialized(swept, "Order", "Item", "Payload", "Frame")).toEqual([
      "Order.id src/main.ts:45:16 passed to JSON.stringify",
      "Order.items src/main.ts:45:16 passed to JSON.stringify",
      "Item.sku src/main.ts:45:16 passed to JSON.stringify",
      "Payload.body src/main.ts:47:28 passed to Schema.parse",
      "Frame.bytes src/main.ts:48:8 passed to encode",
    ]);
  });

  it("retains the conversion methods as well where the value leaves the analysis", () => {
    expect(serialized(swept, "Event")).toEqual([
      "Event.kind src/main.ts:46:13 passed to console.log",
      "Event.toString src/main.ts:46:13 passed to console.log",
      "Event.toJSON src/main.ts:46:13 passed to console.log",
    ]);
  });

  it("holds a function that hands its own unknown parameter on to what it hands it to", () => {
    expect(serialized(swept, "Message", "Relayed", "Traced")).toEqual([
      "Message.text src/main.ts:49:6 passed to send",
      "Relayed.text src/main.ts:50:7 passed to relay",
      "Traced.step src/main.ts:51:7 passed to trace",
      "Traced.toString src/main.ts:51:7 passed to trace",
    ]);
  });

  it("binds a function's arguments past its `this` parameter, which binds none", () => {
    expect(serialized(swept, "Bound")).toEqual(["Bound.id src/main.ts:60:11 passed to sendBound"]);
    expect(deadMembers(swept)).not.toContain("Bound.id");
  });

  it("binds every argument from a rest parameter's position on, past a `this` parameter", () => {
    expect(serialized(swept, "Leading", "Trailing")).toEqual([
      "Leading.id src/main.ts:61:9 passed to sendAll",
      "Trailing.id src/main.ts:61:24 passed to sendAll",
    ]);
    expect(deadMembers(swept)).not.toContain("Leading.id");
  });

  it("binds a method's arguments past its `this` parameter, which binds none", () => {
    expect(serialized(swept, "Posted")).toEqual([
      "Posted.id src/main.ts:62:20 passed to Courier.post",
    ]);
    expect(deadMembers(swept)).not.toContain("Posted.id");
  });

  it("binds a function expression's arguments past its `this` parameter where a variable holds it", () => {
    expect(serialized(swept, "VarBound")).toEqual([
      "VarBound.id src/main.ts:69:9 passed to sendVar",
    ]);
    expect(deadMembers(swept)).not.toContain("VarBound.id");
  });

  it("reads a call through Function.prototype.call, apply or bind as a call of the function", () => {
    expect(serialized(swept, "Called", "Applied", "Rebound", "Prebound")).toEqual([
      "Called.id src/main.ts:63:27 passed to JSON.stringify",
      "Applied.id src/main.ts:64:29 passed to JSON.stringify",
      "Rebound.id src/main.ts:65:27 passed to JSON.stringify",
      "Prebound.id src/main.ts:66:27 passed to JSON.stringify",
    ]);
  });

  it("reads the arguments of a call through Function.prototype.call against the callee's own parameters", () => {
    expect(serialized(swept, "Logged", "Dispatched")).toEqual([
      "Logged.kind src/main.ts:67:27 passed to console.log",
      "Logged.toString src/main.ts:67:27 passed to console.log",
      "Dispatched.text src/main.ts:68:22 passed to send",
    ]);
  });

  it("reads `this` in an instance member as a value of its class", () => {
    expect(serialized(swept, "Snapshot")).toEqual([
      "Snapshot.at src/model.ts:80:27 passed to JSON.stringify",
    ]);
  });

  it("reads `this` in a static member as the class, which holds back no instance member", () => {
    expect(serialized(swept, "Registry")).toEqual([]);
    expect(deadMembers(swept)).toContain("Registry.entries");
  });

  it("reads `this` in a nested function expression as its own, which holds back no instance member", () => {
    expect(serialized(swept, "Deferred")).toEqual([]);
    expect(deadMembers(swept)).toContain("Deferred.value");
  });

  it("reads `this` in a static block as the class, which holds back no instance member", () => {
    expect(serialized(swept, "Census")).toEqual([]);
    expect(deadMembers(swept)).toContain("Census.count");
  });

  it("reads `this` in a function declared in a method as its own, which holds back no instance member", () => {
    expect(serialized(swept, "Journal")).toEqual([]);
    expect(deadMembers(swept)).toContain("Journal.entry");
  });

  it("reads `this` in an object literal's methods and accessors as the object, which holds back no instance member", () => {
    expect(serialized(swept, "Outline")).toEqual([]);
    expect(deadMembers(swept)).toContain("Outline.depth");
  });

  it("reads `this` in an arrow function as the enclosing method's, a value of its class", () => {
    expect(serialized(swept, "Batch")).toEqual([
      "Batch.size src/model.ts:150:43 passed to JSON.stringify",
    ]);
    expect(deadMembers(swept)).not.toContain("Batch.size");
  });

  it("reports methods, accessors and private names, and what reaches no destination", () => {
    expect(deadMembers(swept)).toEqual([
      "Order.#secret",
      "Order.total",
      "Order.label",
      "Event.describe",
      "Shaped.field",
      "Registry.entries",
      "Deferred.value",
      "Census.count",
      "Journal.entry",
      "Outline.depth",
      "Kept.unused",
    ]);
  });

  it("reads JSON.stringify and the unknown parameters of ambient declarations where the configuration names no serializer", () => {
    const unconfigured = sweepFixture(JSON.stringify({ target: { kind: "application" } }));

    expect(serialized(unconfigured, "Order", "Payload", "Frame")).toEqual([
      "Order.id src/main.ts:45:16 passed to JSON.stringify",
      "Order.items src/main.ts:45:16 passed to JSON.stringify",
      'Payload.body src/main.ts:47:28 passed to object({body:""}).parse',
    ]);
    expect(deadMembers(unconfigured)).not.toContain("Payload.body");
    expect(deadMembers(unconfigured)).toContain("Frame.bytes");
  });
});

describe("serialization-contract over checked values and ambient callees", () => {
  const swept = sweepFixture(undefined, CHECKED);

  it("reads the members of a `satisfies` target where the checked literal reaches a destination", () => {
    expect(serialized(swept, "Pushed", "Wrapped", "Asserted", "Annotated")).toEqual([
      "Pushed.kind src/main.ts:73:20 passed to client.postMessage",
      "Pushed.title src/main.ts:73:20 passed to client.postMessage",
      "Wrapped.reason src/main.ts:74:20 passed to client.postMessage",
      "Asserted.cause src/main.ts:75:20 passed to client.postMessage",
      "Annotated.body src/main.ts:77:20 passed to client.postMessage",
    ]);
  });

  it("reads the members of a `satisfies` target where the checked literal is stored in what a destination walks", () => {
    expect(serialized(swept, "Boxed", "Assigned")).toEqual([
      "Boxed.size src/main.ts:82:29 passed to JSON.stringify",
      "Assigned.step src/main.ts:82:56 passed to JSON.stringify",
    ]);
  });

  it("reads the operand's own type and each asserted type where an assertion erases them", () => {
    expect(serialized(swept, "Small", "Never", "AnyCast")).toEqual([
      "Small.tiny src/main.ts:152:20 passed to client.postMessage",
      "Never.ghost src/main.ts:152:20 passed to client.postMessage",
      "AnyCast.erased src/main.ts:154:20 passed to client.postMessage",
    ]);
  });

  it("reads a value passed to an unknown parameter of a callee the project declares only ambiently", () => {
    expect(serialized(swept, "Broadcast", "Relayed", "Forwarded", "Dropped")).toEqual([
      "Broadcast.line src/main.ts:84:21 passed to channel.postMessage",
      "Relayed.hop src/main.ts:86:7 passed to relay",
      "Forwarded.leg src/main.ts:88:9 passed to forward",
    ]);
  });

  it("reports only what reaches no destination, a function or an implemented member of the project included", () => {
    const document = join(CHECKED, "deadset.json");
    const { config } = resolve({
      repository: readFileSync(document, "utf8"),
      repositoryLabel: document,
    });

    expect(
      findingsOf(emitterInputOf(CHECKED, config)).map(
        (finding) =>
          `${finding.code} ${finding.position.path}:${String(finding.position.line)} ${finding.symbol.name}`,
      ),
    ).toEqual([
      "DS1301 src/main.ts:59 Dropped.gone",
      "DS1301 src/main.ts:70 Unsent.note",
      "DS1301 src/main.ts:94 HiddenD.viaDts",
      "DS1301 src/main.ts:109 HiddenP.viaLiteral",
      "DS1301 src/main.ts:122 HiddenT.viaExtends",
      "DS1301 src/main.ts:158 HiddenS.viaSatisfies",
    ]);
  });
});

describe("print-retained over a project whose values reach serializers", () => {
  it("prints each serialized member with the callee its value was passed to, and exits 0", async () => {
    const out = new MemoryWriter();
    const err = new MemoryWriter();

    expect(run(["print-retained", `--target=${TARGET}`], out, err, nodeHost())).toBe(0);
    expect(err.text).toBe("");
    await expect(
      out.text,
      "regenerate with `npx vitest --run -u src/serialization-contract.test.ts` and review the diff",
    ).toMatchFileSnapshot(fixture("golden", "serialization-contract.retained.txt"));
  });
});

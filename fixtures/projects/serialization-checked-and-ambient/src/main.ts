// Each value goes where the comment on its type says.

declare const client: Client;

// Pushed is checked by `satisfies` and structured-cloned by postMessage.
interface Pushed {
  kind: string;
  title: string;
}

// Wrapped is checked by `satisfies` inside parentheses and an assertion to unknown.
interface Wrapped {
  reason: string;
}

// Asserted is checked by `satisfies` inside an angle-bracket assertion to unknown.
interface Asserted {
  cause: string;
}

// Annotated is the declared type of a variable postMessage clones.
interface Annotated {
  body: string;
}

// Boxed is checked by `satisfies` and stored in an unknown property JSON.stringify walks.
interface Boxed {
  size: number;
}

interface Envelope {
  payload: unknown;
}

// Assigned is checked by `satisfies` and assigned to an unknown variable JSON.stringify reads.
interface Assigned {
  step: number;
}

// Broadcast is passed to a method a declaration file merges into the platform interface.
interface Broadcast {
  line: string;
}

// Relayed is passed to a function a declaration file declares.
interface Relayed {
  hop: number;
}

// Forwarded is passed to a function this file declares under `declare`.
interface Forwarded {
  leg: number;
}

declare function forward(message: unknown): void;

// Dropped is passed to a function of the project that reads nothing of it.
interface Dropped {
  gone: string;
}

function drop(message: unknown): void {
  void message;
}

declare const channel: BroadcastChannel;

// Unsent is checked by `satisfies` and reaches no destination.
interface Unsent {
  note: string;
}

client.postMessage({ kind: "push", title: "t" } satisfies Pushed);
client.postMessage(({ reason: "r" } satisfies Wrapped) as unknown);
client.postMessage(<unknown>({ cause: "c" } satisfies Asserted));
const annotated: Annotated = { body: "b" };
client.postMessage(annotated);
const envelope: Envelope = { payload: { size: 1 } satisfies Boxed };
let assigned: unknown;
assigned = { step: 2 } satisfies Assigned;
const unsent = { note: "n" } satisfies Unsent;
console.info(JSON.stringify(envelope) + JSON.stringify(assigned), typeof unsent);
const broadcast: Broadcast = { line: "l" };
channel.postMessage(broadcast);
const relayed: Relayed = { hop: 1 };
relay(relayed);
const forwarded: Forwarded = { leg: 2 };
forward(forwarded);
const dropped: Dropped = { gone: "g" };
drop(dropped);

// HiddenD is passed to a method a declaration file declares and a class of the project implements.
interface HiddenD {
  viaDts: string;
}

class Impl implements Sink {
  put(message: unknown): void {
    void message;
  }
}

const sink: Sink = new Impl();
const hiddenD: HiddenD = { viaDts: "d" };
sink.put(hiddenD);

// HiddenP is passed to a method a declaration file declares and a typed object literal implements.
interface HiddenP {
  viaLiteral: string;
}

const port: Port = {
  send(message: unknown): void {
    void message;
  },
};
const hiddenP: HiddenP = { viaLiteral: "p" };
port.send(hiddenP);

// HiddenT is passed to a method a class implements through an interface extending its owner.
interface HiddenT {
  viaExtends: string;
}

interface Spout extends Tap {}

class Faucet implements Spout {
  pour(message: unknown): void {
    void message;
  }
}

const tap: Tap = new Faucet();
const hiddenT: HiddenT = { viaExtends: "t" };
tap.pour(hiddenT);

// Small is asserted to Never, a type it never had, then to unknown, and cloned.
interface Small {
  tiny: string;
}

interface Never {
  ghost: string;
}

// AnyCast is asserted to any and cloned.
interface AnyCast {
  erased: string;
}

const small: Small = { tiny: "s" };
client.postMessage(small as unknown as Never as unknown);
const anyCast: AnyCast = { erased: "a" };
client.postMessage(anyCast as any);

// HiddenS is passed to a method a declaration file declares and a checked object literal implements.
interface HiddenS {
  viaSatisfies: string;
}

const outlet = {
  drain(message: unknown): void {
    void message;
  },
} satisfies Outlet;
const drained: Outlet = outlet;
const hiddenS: HiddenS = { viaSatisfies: "s" };
drained.drain(hiddenS);

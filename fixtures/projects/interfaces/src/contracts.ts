// The interfaces the classes implement and the entry names as types.

// Named as a type by nothing, and satisfied by one class.
export interface Unused {
  run(): number;
  readonly label: string;
}

// Named as a type only by a function nothing calls.
export interface OnlyDead {
  go(): void;
}

function orphan(target: OnlyDead): void {
  target.go();
}

// Named as a type by the entry, with one implementation whose method the entry calls
// through it.
export interface Seam {
  act(): number;
}

// Named as a type by the entry: one method is called through it, one nothing calls,
// and one whose every implementation has an empty body.
export interface Channel {
  send(): number;
  close(): void;
  ping(): void;
}

// Generic, implemented through an implements clause, with a method nothing calls
// whose one implementation has an empty body.
export interface Box<T> {
  open(): T;
  seal(): void;
}

// Named as a type by the entry, with a method nothing calls that one class implements
// with an empty body and a subclass inherits.
export interface Hook {
  fire(): void;
}

// Named as a type by the entry, with a method nothing calls that one class implements
// with an empty method and another with an arrow function.
export interface Signal {
  raise(): void;
}

// Named as a type by the entry and implemented by nothing.
export interface Listener {
  notify(): void;
}

// Named as a type only by a test.
export interface Probe {
  check(): boolean;
}

// Named as a type by the entry, with a method only a test calls and a method only a
// function nothing calls calls.
export interface Gauge {
  measure(): number;
  reset(): void;
}

function resetAll(gauges: readonly Gauge[]): void {
  for (const gauge of gauges) {
    gauge.reset();
  }
}

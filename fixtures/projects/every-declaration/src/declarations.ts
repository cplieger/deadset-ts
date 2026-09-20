// One instance of every declaration form the inventory enumerates, exported and
// not exported, so a golden symbol table over this file names each form once in
// each visibility. Nothing here is referenced: the file is an input to a dead-code
// analyzer, so the declarations exist to be enumerated rather than to be used.

export function exportedFunction(value: string): string {
  return value;
}

function unexportedFunction(value: number): number {
  return value;
}

export function generic<Item>(value: Item): Item {
  return value;
}

export class ExportedClass {
  static count = 0;

  readonly plain = 1;

  protected guarded = 2;

  private hidden = 3;

  accessor tracked = 4;

  #frame = 5;

  [Symbol.toStringTag] = "ExportedClass";

  method(): number {
    return this.plain;
  }

  identity<Value>(value: Value): Value {
    return value;
  }

  get size(): number {
    return this.#frame;
  }

  set size(value: number) {
    this.#frame = value;
  }

  static of<Item>(value: Item): Item {
    return value;
  }
}

class UnexportedClass {
  value = 0;
}

export interface ExportedInterface {
  readonly seq: number;
  "content-type": string;
  handle(event: string): void;
  decode<Value>(raw: string): Value;
}

interface UnexportedInterface {
  only: boolean;
}

export type ExportedAlias = {
  gap: number;
  measure(): number;
};

type UnexportedAlias = {
  width: number;
};

export enum ExportedEnum {
  Resize = "resize",
  "tab-close" = "tab-close",
}

enum UnexportedEnum {
  Only = 0,
}

export namespace ExportedNamespace {
  export interface Event {
    seq: number;
  }

  export namespace Server {
    export function handle(): void {}
  }

  function unexportedInNamespace(): void {}
}

namespace UnexportedNamespace {
  export const only = 1;
}

export const exportedVariable = "value";

export let exportedMutable = 1;

const unexportedVariable = 0;

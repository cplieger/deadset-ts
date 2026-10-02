// The classes that implement the interfaces, one of them by its shape alone.

import type { Box, Channel, Hook, Seam, Signal } from "./contracts.ts";

export class Worker implements Seam {
  act(): number {
    return 1;
  }
}

export class Wire implements Channel {
  send(): number {
    return 1;
  }

  close(): void {
    throw new Error("the wire is closed");
  }

  ping(): void {}
}

export class Pipe {
  send(): number {
    return 2;
  }

  close(): void {}

  ping(): void {}
}

export class Crate implements Box<number> {
  open(): number {
    return 3;
  }

  seal(): void {}
}

export class Runner {
  readonly label = "runner";

  run(): number {
    return this.label.length;
  }
}

export class Quiet implements Hook {
  fire(): void {}
}

export class Hushed extends Quiet {}

export class Flag implements Signal {
  raise(): void {}
}

export class Arrowed implements Signal {
  readonly raise = (): void => {};
}

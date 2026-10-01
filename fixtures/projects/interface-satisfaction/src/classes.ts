// One class per way a value reaches an interface, each with a member no interface
// requires, and one class whose values reach none.

import type { Named } from "./shapes.ts";

export class Assigned {
  area(): number {
    return 1;
  }

  spare(): number {
    return 0;
  }
}

export class Passed {
  label(): string {
    return "passed";
  }

  spare(): number {
    return 0;
  }
}

export class Returned {
  label(): string {
    return "returned";
  }

  size(): number {
    return 2;
  }

  spare(): number {
    return 0;
  }
}

export class Stored {
  area(): number {
    return 3;
  }

  spare(): number {
    return 0;
  }
}

export class Pushed {
  label(): string {
    return "pushed";
  }

  spare(): number {
    return 0;
  }
}

export class Base {
  label(): string {
    return "base";
  }
}

export class Derived extends Base {
  spare(): number {
    return 0;
  }
}

export class Boxed<T> {
  readonly value: T;

  constructor(value: T) {
    this.value = value;
  }

  label(): string {
    return "boxed";
  }
}

export class Declared implements Named {
  label(): string {
    return "declared";
  }

  spare(): number {
    return 0;
  }
}

export class Unconverted {
  area(): number {
    return 4;
  }

  label(): string {
    return "unconverted";
  }
}

// Classes a container constructs, and one it does not. Nothing reads a member by name.

import { inject } from "@example/container";

// Registered by a call to Container.bind.
export class Mailer {
  @inject("transport")
  transport: unknown;

  helper(): void {}
}

// Listed among the providers of a module decorator.
export class Clock {
  @inject("zone")
  zone: unknown;
}

// Asks the container for a constructor parameter, and is registered nowhere here.
export class Reporter {
  @inject("sink")
  sink: unknown;

  constructor(@inject("format") format: string) {
    if (format === "") {
      throw new Error("no format");
    }
  }
}

// Neither registered nor asking: what holds its decorated property is the decorator.
export class Plain {
  @inject("unused")
  value: unknown;
}

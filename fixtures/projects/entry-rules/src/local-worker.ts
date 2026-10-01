// A constructor of the target's own that happens to be called Worker, so the literal it
// is built with addresses no worker.

class Worker {
  readonly script: string;

  constructor(script: string) {
    this.script = script;
  }
}

export const local = new Worker("./fake.ts");

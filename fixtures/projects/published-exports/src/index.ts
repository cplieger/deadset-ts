// What the manifest's `exports` names for the package's root subpath, so a consumer of
// a library target can name everything this file publishes and the members it reaches
// through them.

export class Published {
  private closed = 1;

  #hidden = 2;

  open(): number {
    return this.closed + this.#hidden;
  }
}

export const value = 4;

class Unexported {
  reachable(): number {
    return 5;
  }
}

export const built = new Unexported().reachable();

export { Reexported } from "./reexported.ts";

export * from "./starred.ts";

// A class and an interface nothing references, each with members.

export class Unused {
  count = 0;

  bump(): number {
    this.count += 1;
    return this.count;
  }
}

export interface Shape {
  readonly name: string;
  area(): number;
}

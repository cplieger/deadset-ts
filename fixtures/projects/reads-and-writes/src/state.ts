// A module-level variable two statements store into and nothing reads.
let written = 0;

// A module-level variable one statement stores into and one reads.
let counted = 0;

// A module-level variable production code stores into and only a test file reads.
export let shared = 0;

export function share(): void {
  shared = 1;
}

export function bump(): number {
  written = 1;
  written += 2;
  counted = 3;
  return counted;
}

export class Gauge {
  // Written by the constructor and by reset, and read nowhere.
  #samples = 0;

  // Written by the constructor and read by value.
  private label: string;

  // Stored into through a setter, which runs code when written.
  set level(value: number) {
    this.#samples = value;
  }

  // Read only through a string index, which retains it.
  private hidden = "";

  constructor(label: string) {
    this.label = label;
    this.#samples = 1;
    this.hidden = label;
  }

  reset(): void {
    this.#samples = 0;
  }

  describe(): string {
    return this.label;
  }
}

// A module-level collection an element access stores into and nothing reads.
const slots: number[] = [];

export function fill(at: number): void {
  slots[at] = at;
}

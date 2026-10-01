// A class with decorated members, a decorated class, and a class with none. Nothing
// references any member by name.

import { component, field, register } from "./register.ts";

export class Handlers {
  @register
  onStart(): void {}

  @field
  label = "";

  undecorated(): void {}
}

@component
export class Widget {
  render(): void {}

  private state = 0;

  #hidden = 0;

  static create(): void {}
}

export class Plain {
  run(): void {}
}

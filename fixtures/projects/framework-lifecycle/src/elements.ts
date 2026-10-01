// Custom elements. The browser calls their callbacks by name; nothing else does.

// Registered by define, and an element by its base as well.
export class Counter extends HTMLElement {
  static observedAttributes = ["count"];

  connectedCallback(): void {}

  attributeChangedCallback(): void {}

  increment(): void {}
}

// An element by its base alone, registered nowhere.
export class Base extends HTMLElement {
  disconnectedCallback(): void {}
}

// An element through the chain: it extends Base, which extends HTMLElement.
export class Fancy extends Base {
  connectedCallback(): void {}

  render(): void {}
}

// Not an element: a member named like a callback is not one here.
export class Plain {
  connectedCallback(): void {}
}

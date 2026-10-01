// Views of the project's own framework.

import { register, view } from "./framework.ts";

// A view by its decorator.
@view
export class Panel {
  mount(): void {}

  unmount(): void {}

  hidden(): void {}
}

// A view by its registration.
export class Dialog {
  mount(): void {}

  close(): void {}
}

register(Dialog);

// A view of neither kind.
export class Loose {
  mount(): void {}
}

// The entry. It builds each class, so each class is live and its members are judged
// on their own.

import { Handlers, Plain, Widget } from "./handlers.ts";

const built = [new Handlers(), new Widget(), new Plain()];

if (built.length === 0) {
  throw new Error("nothing was built");
}

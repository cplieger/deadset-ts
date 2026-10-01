// The entry: it defines one element and builds every class, so each class is live and
// its members are judged on their own.

import { Base, Counter, Fancy, Plain } from "./elements.ts";
import { Dialog, Loose, Panel } from "./views.ts";

customElements.define("x-counter", Counter);

export const all = [Counter, Base, Fancy, Plain, Panel, Dialog, Loose];

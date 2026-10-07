import { production } from "./catalog.js";
import { show } from "./state.js";

export const total = production() + show();

import { onlyTested, production } from "./catalog.js";
import { bump } from "./state.js";

bump();
export const total = production() + onlyTested();

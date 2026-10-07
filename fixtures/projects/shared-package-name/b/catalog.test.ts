import { onlyTested } from "./catalog.js";

if (onlyTested() !== 1) {
  throw new Error("onlyTested() is not 1");
}

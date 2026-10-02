import { tested } from "./tested.ts";

if (tested() !== 4) {
  throw new Error("tested");
}

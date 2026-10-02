/// <reference path="./referenced.ts" />
import "./side.ts";
import { used } from "./used.ts";

export function start(): number {
  return used();
}

import { fixtureDir } from "./support.js";

export function testLoaded(): Record<string, string> {
  return import.meta.fixtures(fixtureDir);
}

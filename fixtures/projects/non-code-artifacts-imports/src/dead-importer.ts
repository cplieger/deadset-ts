import { imported } from "./imported-by-dead.ts";

export function deadImporter(): number {
  return imported();
}

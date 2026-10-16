import { renderOrigin, type Provenance, type ResolvedConfig } from "./config.ts";
import { bytewise } from "./text/compare.ts";

/**
 * The resolved configuration and its provenance as one JSON object, indented, ending
 * in a newline: the configuration in the order resolution gives it, then the provenance
 * object in ascending key order. Read back as a repository configuration it resolves to
 * the same configuration, because resolution checks the provenance object and then
 * ignores it.
 */
export function printConfig(config: ResolvedConfig, provenance: Provenance): string {
  const origins = [...provenance]
    .sort(([a], [b]) => bytewise(a, b))
    .map(([path, origin]): [string, string] => [path, renderOrigin(origin)]);
  return `${JSON.stringify({ ...config, provenance: Object.fromEntries(origins) }, undefined, 2)}\n`;
}

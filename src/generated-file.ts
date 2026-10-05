/**
 * The generated-file class on TypeScript: every declaration in a file below a directory
 * an applied convention row names as generated is retained, because the framework owns
 * the file and a deletion there is undone at the next generation.
 */

import type { DetectorInput, Evidence } from "./exempt.ts";

/** The generated-file detector, recording each file's first line. */
export function generatedFile<Brand>(input: DetectorInput<Brand>): readonly Evidence[] {
  const generated = input.generated;
  if (generated === undefined || generated.size === 0) {
    return [];
  }
  return input.held.symbols.flatMap((symbol): Evidence[] => {
    const row = generated.get(symbol.position.path);
    return symbol.kind === "file" || row === undefined
      ? []
      : [
          {
            id: symbol.id,
            detail: `generated below a directory the convention row ${row} names`,
            site: { path: symbol.position.path, line: 1, column: 1 },
          },
        ];
  });
}

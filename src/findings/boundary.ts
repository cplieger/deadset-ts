import type { Finding } from "../finding.ts";

/** Which side of a declared cross-language edge, as the edges document spells it. */
export type EdgeSideName = "provides" | "used_by";

/** One side of a declared cross-language edge that names a symbol of this analyzer's language. */
export interface EdgeSide {
  /** The edge's identifier, as the edges document spells it. */
  readonly edge: string;
  readonly side: EdgeSideName;
  /** The stable symbol reference the side names. */
  readonly symbol: string;
}

/**
 * One finding a declared edge holds back: the finding the analyzer would report about
 * the symbol one side of the edge names, which a report carries only inside that side's
 * evaluation, because the code that may use the symbol is in the other language.
 */
export interface PendingFinding extends EdgeSide {
  readonly finding: Finding;
}

/** What the run knows about the code outside the target that can reach its declarations. */
export interface Boundary {
  readonly consumers: {
    /** The identifier of every consumer the scope declares. */
    readonly declared: readonly string[];
    /** The identifier of every declared consumer the run loaded. */
    readonly loaded: readonly string[];
  };
  /**
   * Whether the target's manifest declares `exports`, so code outside the target can
   * import no file the manifest does not name.
   */
  readonly encapsulated: boolean;
  /** Every side of a declared cross-language edge that names a symbol of this language. */
  readonly edges: readonly EdgeSide[];
}

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

import type { Node, SourceFile } from "@typescript/native/ast";
import type { Type } from "@typescript/native/sync";
import type { AliasChains } from "../alias-chain.ts";
import type { Inventory } from "../inventory.ts";
import type { Position } from "../position.ts";
import type { Resolution } from "../references.ts";
import type { ProjectView } from "../session.ts";

/** Where the walk offered a read rule one node: the file, and the declaration enclosing the node. */
interface ReadSite {
  readonly file: SourceFile;
  readonly from: string;
}

/** What a read rule reads its answers through, after the walk of every file of the side. */
export interface ReadContext<Brand> {
  readonly project: ProjectView<Brand>;
  readonly held: Inventory;
  readonly chains: AliasChains;
}

/**
 * One read a rule makes: a use of the declaration `to` by `from` at a node of a walked file,
 * or, where a question the read needed went unanswered, a hold. A hold names what the answer
 * could have made live (program.33): the declarations `ids`, each declaration bearing one of
 * `names`, each member of one of `types`, or with `members` every member the inventory holds;
 * the declaration making the read is held as well. A named read sits at a node of `file`, or
 * at a declaration's own position in it.
 */
export type Read =
  | {
      readonly kind: "named";
      readonly from: string;
      readonly to: string;
      readonly file: SourceFile;
      readonly at: Node | Position;
      readonly use: "read" | "write";
      readonly via: Resolution;
      /** A read a rule counts as production code's whoever writes it. */
      readonly production?: true;
    }
  | {
      readonly kind: "held";
      readonly from: string;
      readonly ids?: readonly string[];
      readonly names?: readonly string[];
      readonly types?: readonly Type[];
      readonly members?: true;
    };

/** One pass of one read rule over the files of one side: it collects while the walk offers nodes, then reads. */
interface ReadRuleRun {
  visit(node: Node, site: ReadSite): void;
  reads<Brand>(context: ReadContext<Brand>): readonly Read[];
}

/** One rule of the references pages that reads declarations no name node names. */
export interface ReadRule {
  start(): ReadRuleRun;
}

import type { NotBuilt } from "./discover.ts";
import { relativePath } from "./paths.ts";
import type { UnansweredQuestion } from "./query.ts";

/** What a run read only in part. */
interface Partial {
  /** The derived configurations the run dropped. */
  readonly notBuilt: readonly NotBuilt[];
  /** Every question the checker could not answer, each once. */
  readonly unanswered: readonly UnansweredQuestion[];
  /** The target root, absolute, which every configuration file is named below. */
  readonly targetRoot: string;
}

/** A count with its noun, so a line reads for one as well as for several. */
function counted(n: number, one: string, many: string): string {
  return `${String(n)} ${n === 1 ? one : many}`;
}

/**
 * One line per configuration the run dropped, and one counting the questions the checker
 * left unanswered by project, so a reader of the error stream sees where the analysis was
 * partial. The lines carry no prefix; the caller writes them as its own diagnostics.
 */
export function partialNotes(partial: Partial): readonly string[] {
  const notes = [...partial.notBuilt]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map(
      (one) =>
        `the derived configuration ${one.id} was not built and is not analyzed: ${one.error}`,
    );
  if (partial.unanswered.length > 0) {
    const byProject = new Map<string, number>();
    for (const question of partial.unanswered) {
      const configFile =
        relativePath(partial.targetRoot, question.configFile) ?? question.configFile;
      byProject.set(configFile, (byProject.get(configFile) ?? 0) + 1);
    }
    const where = [...byProject].map(([configFile, n]) => `${configFile}: ${String(n)}`).join(", ");
    notes.push(
      `the checker answered ${counted(partial.unanswered.length, "question", "questions")} with a failure (${where}), so every declaration an answer could have kept live is kept live and reported by nothing`,
    );
  }
  return notes;
}

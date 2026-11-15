/**
 * The production files below `src/`, and the enclosing chain of a line, for the tests that
 * scan the source for a form only one function may write.
 */

import { readdirSync } from "node:fs";
import { join } from "node:path";

/** Every production source file below `src/`. */
export function sources(directory: string): readonly string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      return sources(path);
    }
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [path] : [];
  });
}

/** The name a line declares: a function, a binding, or an object member holding a function. */
function declared(text: string): string | undefined {
  return (
    /^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/u.exec(text)?.[1] ??
    /^\s*(?:export\s+)?(?:const|let)\s+([A-Za-z_$][\w$]*)/u.exec(text)?.[1] ??
    /^\s*([A-Za-z_$][\w$]*):\s*(?:\(|async\b|function\b|[A-Za-z_$][\w$]*\s*=>)/u.exec(text)?.[1]
  );
}

/**
 * The functions, bindings and object members around one line, outermost first: each
 * nearest earlier line indented less, as formatted code nests, that declares a name, and
 * the line's own declaration.
 */
export function enclosing(lines: readonly string[], at: number): string {
  const chain: string[] = [];
  const line = lines[at] ?? "";
  let indent = line.search(/\S/u);
  for (let above = at - 1; above >= 0 && indent > 0; above -= 1) {
    const text = lines[above] ?? "";
    const own = text.search(/\S/u);
    if (own < 0 || own >= indent) {
      continue;
    }
    // A line that closes a bracket, as a signature written over several lines does, sits
    // under the line that opens it, at its own indentation.
    indent = /^[)\]}]/u.test(text.trim()) ? own + 1 : own;
    const name = declared(text);
    if (name !== undefined) {
      chain.unshift(name);
    }
  }
  const own = declared(line);
  return [...chain, ...(own === undefined ? [] : [own])].join(".");
}

/**
 * A read of a strict JSON document beside its parse: what a parse into a value cannot
 * report, the offset of each record of one array and a member written twice.
 */

import type { Position } from "./position.ts";

/** The token walk over a document `JSON.parse` accepted, so every token is well formed. */
class Walk {
  readonly opened: number[] = [];
  /** The member written twice, where one is, as the offset of its name. */
  twice: { readonly name: string; readonly offset: number } | undefined;
  private readonly text: string;
  private readonly array: string;
  private at = 0;

  constructor(text: string, array: string) {
    this.text = text;
    this.array = array;
  }

  run(): void {
    this.value("document");
  }

  private skip(): void {
    while (/[ \t\r\n]/u.test(this.text[this.at] ?? "")) {
      this.at += 1;
    }
  }

  private string(): string {
    const start = this.at;
    this.at += 1;
    while (this.text[this.at] !== '"') {
      this.at += this.text[this.at] === "\\" ? 2 : 1;
    }
    this.at += 1;
    return JSON.parse(this.text.slice(start, this.at)) as string;
  }

  private value(role: "document" | "array" | "record" | "other"): void {
    this.skip();
    const char = this.text[this.at];
    if (char === "{") {
      if (role === "record") {
        this.opened.push(this.at);
      }
      this.object(role);
    } else if (char === "[") {
      this.list(role === "array" ? "record" : "other");
    } else if (char === '"') {
      this.string();
    } else {
      while (this.at < this.text.length && !/[,\]} \t\r\n]/u.test(this.text[this.at] ?? "")) {
        this.at += 1;
      }
    }
  }

  private object(role: string): void {
    const seen = new Set<string>();
    this.at += 1;
    for (;;) {
      this.skip();
      if (this.text[this.at] === "}") {
        this.at += 1;
        return;
      }
      if (this.text[this.at] === ",") {
        this.at += 1;
        this.skip();
      }
      const offset = this.at;
      const name = this.string();
      if (seen.has(name) && this.twice === undefined) {
        this.twice = { name, offset };
      }
      seen.add(name);
      this.skip();
      this.at += 1;
      this.value(role === "document" && name === this.array ? "array" : "other");
    }
  }

  private list(element: "record" | "other"): void {
    this.at += 1;
    for (;;) {
      this.skip();
      if (this.text[this.at] === "]") {
        this.at += 1;
        return;
      }
      if (this.text[this.at] === ",") {
        this.at += 1;
      }
      this.value(element);
    }
  }
}

/** What a walk of one document found. */
export interface DocumentWalk {
  /** The offset of the brace opening each object of the document's array member, in order. */
  readonly opened: readonly number[];
  /** The first member one object writes twice, at any depth, as the offset of its name. */
  readonly twice: { readonly name: string; readonly offset: number } | undefined;
}

/**
 * Walks a document `JSON.parse` accepted, whose top-level member `array` holds the
 * records. A member one object writes twice reads as though it were written once, its
 * later value silently replacing the earlier one, so a document holding one is one a
 * reader names rather than reads.
 */
export function walkDocument(text: string, array: string): DocumentWalk {
  const walk = new Walk(text, array);
  walk.run();
  return { opened: walk.opened, twice: walk.twice };
}

/**
 * One offset of a document as a finding carries it: the line counted from one, and the
 * column counted from one in UTF-16 code units.
 */
export function positionAt(text: string, file: string, offset: number): Position {
  const before = text.slice(0, offset);
  const lineStart = before.lastIndexOf("\n") + 1;
  return { path: file, line: before.split("\n").length, column: offset - lineStart + 1 };
}

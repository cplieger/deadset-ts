/** The extension lists the analysis reads files by, each written once. */

/**
 * The extensions tried, in order, after a path written without one: a relative specifier
 * of a configuration file (`roots.5`) and a path a command runs or loads (`roots.13`).
 */
export const APPENDED_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
] as const;

/** The extensions of a module a tool runs or loads as its configuration (`roots.2`). */
export const MODULE_EXTENSIONS = [".js", ".mjs", ".cjs", ".ts", ".mts", ".cts"] as const;

/** The extensions of a file a build writes from a source file. */
export const OUTPUT_EXTENSIONS = [
  ".js",
  ".mjs",
  ".cjs",
  ".jsx",
  ".d.ts",
  ".d.mts",
  ".d.cts",
] as const;

/** One list as a glob's brace list, its dots dropped: `{js,mjs}`. */
export function braced(extensions: readonly string[]): string {
  return `{${extensions.map((one) => one.slice(1)).join(",")}}`;
}

/** The extension of one list a name ends with, the longest where several do. */
export function extensionOf(name: string, extensions: readonly string[]): string | undefined {
  return extensions
    .filter((one) => name.endsWith(one))
    .reduce<string | undefined>(
      (longest, one) => (one.length > (longest?.length ?? 0) ? one : longest),
      undefined,
    );
}

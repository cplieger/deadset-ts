import { resolvePath } from "./paths.ts";
import type { Engine } from "./session.ts";

type CompilerOptions = ReturnType<Engine["parseConfigFile"]>["options"];

/**
 * The `paths` one configuration's resolved options map under the compilers before version
 * 7, each target absolute: a target is read against the effective `baseUrl`, and a specifier
 * no other pattern maps is looked up below it. Undefined where no `baseUrl` is set, so the
 * options' own `paths` stand. Version 7 reads no `baseUrl`:
 * https://github.com/microsoft/TypeScript/issues/62207
 */
export function baseUrlPaths(options: CompilerOptions): Record<string, string[]> | undefined {
  const baseUrl: unknown = Reflect.get(options, "baseUrl");
  if (typeof baseUrl !== "string") {
    return undefined;
  }
  return Object.fromEntries(
    Object.entries({ "*": ["*"], ...options.paths }).map(([key, targets]) => [
      key,
      targets.map((target) => resolvePath(baseUrl, target)),
    ]),
  );
}

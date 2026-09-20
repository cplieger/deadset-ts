// The export forms: a re-export, a renamed re-export, a type-only re-export, a
// namespace re-export, a bare star re-export that declares nothing here, and a
// default export written on the declaration.

export { exportedFunction } from "./declarations.ts";
export { ExportedClass as RenamedClass } from "./declarations.ts";
export type { ExportedInterface } from "./declarations.ts";
export * as namespaced from "./declarations.ts";
export * from "./more.ts";

export default class DefaultExported {
  only = 0;
}

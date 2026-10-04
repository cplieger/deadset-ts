export {};

declare global {
  const useIndexed: typeof import("./counter.ts")["useIndexed"];
  const useQualified: typeof import("./counter.ts").useQualified;
  const viaReexport: typeof import("./reexport.ts")["viaReexport"];
  const unusedIndexed: typeof import("./counter.ts")["unusedIndexed"];
  const unusedQualified: typeof import("./counter.ts").unusedQualified;
}

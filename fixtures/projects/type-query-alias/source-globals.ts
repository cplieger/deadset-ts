export {};

declare global {
  const useInSource: typeof import("./counter.ts")["useInSource"];
}

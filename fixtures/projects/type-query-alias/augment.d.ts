declare module "example-ambient" {
  global {
    const useAugmented: typeof import("./counter.ts")["useAugmented"];
  }
}

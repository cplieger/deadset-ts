declare global {
  interface ImportMeta {
    fixtures(pattern: string): Record<string, string>;
  }
}

export const fixtureDir = "./fixtures/*.json";

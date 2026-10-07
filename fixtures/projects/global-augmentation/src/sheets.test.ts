declare global {
  interface ImportMeta {
    sheets(pattern: string): Record<string, string>;
  }
}

export const sheets = import.meta.sheets("./*.css");

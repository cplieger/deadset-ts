declare global {
  interface ImportMeta {
    sheets(pattern: string): Record<string, string>;
  }
}

export function sheets(): Record<string, string> {
  return import.meta.sheets("./*.css");
}

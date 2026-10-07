declare global {
  interface ImportMeta {
    glob(pattern: string): Record<string, unknown>;
    readonly hot: { accept(): void } | undefined;
    readonly unread: string;
  }
  var buildId: string;
}

export const pages = import.meta.glob("./pages/*.ts");

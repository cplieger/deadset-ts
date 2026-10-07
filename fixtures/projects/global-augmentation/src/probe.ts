declare global {
  interface Probe {
    readonly probe: string;
    readonly next: Probe | undefined;
  }
}

export const probed = true;

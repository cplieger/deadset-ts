// A declaration the root subpath publishes by re-exporting it, with a member of each
// visibility.

export class Reexported {
  open(): number {
    return this.guarded() + this.hidden();
  }

  protected guarded(): number {
    return 11;
  }

  private hidden(): number {
    return 12;
  }
}

// One member of each visibility, none of which anything references.

export class Held {
  visible(): number {
    return 1;
  }

  private hidden(): number {
    return 2;
  }

  #named(): number {
    return 3;
  }
}

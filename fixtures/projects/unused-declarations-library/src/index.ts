// The published entry point: what it exports has callers outside the target.

export class Published {
  visible?: number;

  #secret?: string;

  private hidden?: number;
}

export function makePublished(): Published {
  return new Published();
}

export function each(items: readonly { x: number }[], expect: (x: number) => void): void {
  items.forEach((it) => {
    expect(it.x);
  });
}

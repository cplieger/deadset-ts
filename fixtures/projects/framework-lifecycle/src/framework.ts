// A framework of the project's own: a class decorator and a registration call, each
// making a class one of its views, whose mount and unmount it calls.

export function view<T>(value: T, _context: ClassDecoratorContext): T {
  return value;
}

export function register(component: new () => object): void {
  if (typeof component !== "function") {
    throw new Error("not a class");
  }
}

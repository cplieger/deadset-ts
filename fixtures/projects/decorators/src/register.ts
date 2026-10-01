// The decorators. Each hands back what it was given.

export function register<T>(value: T, _context: ClassMethodDecoratorContext): T {
  return value;
}

export function field(_value: undefined, _context: ClassFieldDecoratorContext): void {}

export function component<T>(value: T, _context: ClassDecoratorContext): T {
  return value;
}

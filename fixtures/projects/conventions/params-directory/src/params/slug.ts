export function match(param: string): boolean {
  return /^[a-z-]+$/u.test(param);
}

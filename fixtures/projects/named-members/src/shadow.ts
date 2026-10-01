// A local Reflect, which is not the global one.

const Reflect = {
  get: (_target: object, _key: string): unknown => undefined,
};

export function shadowed(target: object): unknown {
  return Reflect.get(target, "restart");
}

// The project's own functions and methods that serialize what they are given.

export function encode(frame: object): string {
  return String(frame);
}

export function send(value: unknown): string {
  return JSON.stringify(value);
}

export function relay(value: unknown): string {
  return send(value);
}

export function trace(value: unknown): void {
  console.log(value);
}

export function shape(value: { readonly field: string }): void {
  console.log(value);
}

export function sendBound(this: unknown, value: unknown): string {
  return JSON.stringify(value);
}

export function sendAll(this: unknown, ...values: unknown[]): string {
  return JSON.stringify(values);
}

export const sendVar = function (this: unknown, value: unknown): string {
  return JSON.stringify(value);
};

export class Courier {
  post(this: Courier, value: unknown): string {
    return JSON.stringify(value);
  }
}

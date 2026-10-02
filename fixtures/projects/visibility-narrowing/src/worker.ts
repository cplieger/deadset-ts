// A file a worker runs, which reads none of its exports.

export function workerLocal(): string {
  return "worker";
}

console.info(workerLocal());

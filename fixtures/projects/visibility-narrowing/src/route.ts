// A file `ts.entry_files` names, whose exports a framework reads by name.

export function routeLocal(): string {
  return "route";
}

export default function handler(): string {
  void new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
  return routeLocal();
}

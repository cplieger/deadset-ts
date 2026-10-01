// The application's entry point: it registers a service worker and starts a worker by
// literal paths, and starts one more by a path it computes.

void navigator.serviceWorker.register("./sw.ts");

export const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });

const name = "computed";

export const computedWorker = new Worker(new URL(`./${name}.ts`, import.meta.url), {
  type: "module",
});

import { build } from "esbuild";

function never() {
  build({ entryPoints: ["src/uncalled.ts"] });
}

function wrap(build) {
  build({ entryPoints: ["src/shadowed.ts"] });
}

let options = { entryPoints: ["src/reassigned.ts"] };
options = { entryPoints: [] };
build(options);

async function main() {
  await build({ entryPoints: ["src/ran.ts"] });
}

main().catch(() => {
  wrap(() => undefined);
});

(async () => {
  await build({ entryPoints: ["src/iife.ts"] });
})();

Promise.resolve().then(() => build({ entryPoints: ["src/callback.ts"] }));

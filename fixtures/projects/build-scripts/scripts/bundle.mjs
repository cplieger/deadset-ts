import * as rollup from "rollup";

const name = "computed";
await rollup.rollup({ input: { main: "src/rolled.ts", other: `src/${name}.ts` } });

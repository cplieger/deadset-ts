const path = require("node:path");
const esbuild = require("esbuild");
const webpack = require("webpack");

const options = { entryPoints: ["src/pages/*.ts"], bundle: true };
esbuild.context(options);
webpack({ entry: { app: "./src/app.ts", lib: { import: path.resolve(__dirname, "../src/lib.ts") } } });
webpack({ entry: "src/request.ts" });

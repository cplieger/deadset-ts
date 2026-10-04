const substituted = "substituted";

export default {
  plugins: ["dep-exact", "dep-subpath/sub/path", "dep-prefix-other", "@scope/dep-scoped"],
  nested: { deep: [{ file: "./src/named.ts" }] },
  bare: "./src/bare",
  emitted: "./src/emitted.js",
  template: `./src/template.ts`,
  templateDependency: `dep-template`,
  substitutedFile: `./src/${substituted}.ts`,
  substitutedDependency: `dep-${substituted}`,
  unprefixed: "src/unprefixed.ts",
  pattern: "./src/pattern*.ts",
};

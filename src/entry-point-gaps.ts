/**
 * Every entry-point convention this analyzer declines, each with the tool it belongs
 * to and why. A file only a declined convention enters is reported as never
 * imported, so a project that relies on one names the file in `ts.entry_files` or
 * `roots.patterns`, and this list is what tells it to.
 *
 * Every row carries a reason, because the list is read where the rows are shown
 * one at a time: beside a finding, or in a report's declared gaps.
 */

/** One declined entry-point convention. */
export interface DeclinedConvention {
  /** The tool the convention belongs to, by the name of the package or service. */
  readonly tool: string;
  /** What is declined: one convention of a tool whose others are entered, or all of them. */
  readonly convention: string;
  readonly reason: string;
}

/** What is declined for a tool whose own conventions are entered only through its configuration files. */
const EVERY_CONVENTION = "every file it loads by its own convention beyond its configuration files";

/** Why a tool whose own conventions are not read declines them. */
const UNREAD =
  "No rule reads it beyond a configuration file the file-name form or a string enters, so a " +
  "file only it loads is reported as never imported unless ts.entry_files or roots.patterns " +
  "names it.";

/** Why a configuration's file names that are not literals are declined. */
const NOT_LITERAL =
  "A string of a configuration file names a file only where it is a literal, so a file a " +
  "computed value names is reported as never imported.";

/** The tools whose own conventions are not read. */
const UNREAD_TOOLS: readonly string[] = [
  "angular",
  "astro-db",
  "astro-markdoc",
  "astro-og-canvas",
  "ava",
  "babel",
  "biome",
  "borp",
  "bumpp",
  "bun",
  "c8",
  "capacitor",
  "catalyst",
  "changelogen",
  "changelogithub",
  "changesets",
  "commitizen",
  "commitlint",
  "convex",
  "create-typescript-app",
  "cspell",
  "cucumber",
  "cypress",
  "danger",
  "dependency-cruiser",
  "docusaurus",
  "dotenv",
  "drizzle",
  "electron-vite",
  "eleventy",
  "esbuild",
  "eve",
  "execa",
  "expressive-code",
  "fast",
  "fumadocs",
  "gatsby",
  "github-action",
  "github-actions",
  "glob",
  "graphql-codegen",
  "hardhat",
  "husky",
  "i18next-parser",
  "jest",
  "karma",
  "knex",
  "ladle",
  "laravel-vite-plugin",
  "lefthook",
  "lint-staged",
  "linthtml",
  "lit",
  "lockfile-lint",
  "lost-pixel",
  "lunaria",
  "markdownlint",
  "marko",
  "mdx",
  "mdxlint",
  "metro",
  "mise",
  "mocha",
  "moonrepo",
  "msw",
  "nano-spawn",
  "nano-staged",
  "nest",
  "netlify",
  "next-intl",
  "next-mdx",
  "nitro",
  "node",
  "node-modules-inspector",
  "nodemon",
  "npm-package-json-lint",
  "nuxtjs-i18n",
  "nx",
  "nyc",
  "oclif",
  "openapi-ts",
  "openclaw",
  "orval",
  "oxfmt",
  "oxlint",
  "panda-css",
  "parcel",
  "payload",
  "pino",
  "playwright-ct",
  "playwright-test",
  "plop",
  "pm2",
  "pnpm",
  "postcss",
  "pre-commit",
  "preconstruct",
  "prettier",
  "prisma",
  "quasar",
  "railway",
  "raycast",
  "react-cosmos",
  "react-email",
  "react-native",
  "relay",
  "release-it",
  "remark",
  "rolldown",
  "rollup",
  "rsbuild",
  "rslib",
  "rspack",
  "rstest",
  "sanity",
  "semantic-release",
  "sentry",
  "serverless-framework",
  "simple-git-hooks",
  "size-limit",
  "sst",
  "starlight",
  "stencil",
  "stylelint",
  "svelte",
  "sveltejs-package",
  "svgo",
  "svgr",
  "swc",
  "syncpack",
  "tailwind",
  "tanstack-router",
  "taskfile",
  "tauri",
  "temporal",
  "textlint",
  "travis",
  "ts-node",
  "tsd",
  "tsdown",
  "tsup",
  "tsx",
  "turbo",
  "typedoc",
  "typescript",
  "typescript-content-mapper",
  "unbuild",
  "unocss",
  "unplugin-icons",
  "unplugin-vue-components",
  "unplugin-vue-i18n",
  "unplugin-vue-markdown",
  "unplugin-vue-router",
  "varlock",
  "vercel",
  "vercel-og",
  "vike",
  "vite-plugin-pages",
  "vite-plugin-pwa",
  "vite-plugin-vue-layouts-next",
  "vite-plus",
  "vite-pwa-assets-generator",
  "vitepress",
  "vue",
  "webdriver-io",
  "wireit",
  "wrangler",
  "wxt",
  "xo",
  "yarn",
  "yorkie",
  "zx",
];

/** The conventions declined for a tool some of whose conventions are entered. */
const PARTLY_ENTERED: readonly DeclinedConvention[] = [
  {
    tool: "eslint",
    convention: "a legacy configuration written in YAML or in JSON with comments",
    reason:
      "Only a configuration module and a strict JSON configuration file are read, so a " +
      "dependency only such a file names is reported as unused.",
  },
  {
    tool: "eslint",
    convention: "a plugin or shareable configuration named without its package's prefix",
    reason:
      "A string uses a dependency only where it spells the dependency's name, so a " +
      "dependency only a shortened name loads is reported as unused.",
  },
  {
    tool: "playwright",
    convention: "a testMatch written as a regular expression",
    reason:
      "A testMatch that is not a string literal leaves the test-file set unknown, and an " +
      "unknown set enters nothing.",
  },
  {
    tool: "playwright",
    convention: "the testDir and testMatch of an entry in projects",
    reason:
      "Only the configuration object's own testDir and testMatch are read, so a test " +
      "directory a project entry moves is not entered.",
  },
  {
    tool: "expo",
    convention: "an app directory the expo-router entry of an app configuration moves",
    reason:
      "The convention row reads the app directory at its default places only, so a route " +
      "below a moved directory is reported as never imported unless ts.entry_files names it.",
  },
  {
    tool: "next",
    convention: "a page extension next.config adds through pageExtensions",
    reason:
      "The convention row roots the default extensions only, so a route file of another " +
      "extension is reported as never imported unless ts.entry_files names it.",
  },
  {
    tool: "nuxt",
    convention: "the files of a layer below layers/ beyond its nuxt.config",
    reason:
      "The convention row reads the project's own directories, so a layer's pages, plugins " +
      "and server routes are reported as never imported unless ts.entry_files names them.",
  },
  {
    tool: "qwik",
    convention: "the routes of @qwik.dev/router",
    reason:
      "No convention row holds for that package, so its route files are reported as " +
      "never imported unless ts.entry_files names them.",
  },
  {
    tool: "react-router",
    convention: "a route module app/routes.ts names outside the routes directory",
    reason:
      "The convention row roots the routes directory, and a string of routes.ts names no " +
      "file, so a route module elsewhere is reported as never imported unless " +
      "ts.entry_files names it.",
  },
  {
    tool: "storybook",
    convention: "a story the stories member of .storybook/main names outside *.stories.* files",
    reason:
      "The convention row roots *.stories.* files, so a story file named otherwise is " +
      "reported as never imported unless ts.entry_files names it.",
  },
  {
    tool: "stryker",
    convention: "a configuration file named on a command line no package.json script writes",
    reason:
      "Only the file names the tool looks for by default and the files a script names are entered.",
  },
  {
    tool: "unplugin-auto-import",
    convention: "an import its generated declarations add for a component's template alone",
    reason:
      "Only a global declared as an alias of an export is read, so an export the generated " +
      "declarations name only for templates is reported as unused.",
  },
  {
    tool: "vite",
    convention: "an entry point its configuration computes",
    reason: NOT_LITERAL,
  },
  {
    tool: "vitest",
    convention: "the benchmark files",
    reason:
      "A test file is one ts.test_files classifies, so a *.bench.* file is entered only " +
      "where a configured pattern names it.",
  },
  {
    tool: "vitest",
    convention: "the setup files of a configuration that moves its root",
    reason:
      "A string is read against the configuration file's directory, so a setup file named " +
      "against a root the configuration moves is not entered.",
  },
  {
    tool: "vitest",
    convention: "the test files a configuration's include member names",
    reason:
      "A test file is one ts.test_files classifies rather than one the runner's include " +
      "reads, so the two are kept equal by configuration.",
  },
  {
    tool: "webpack",
    convention: "an entry point its configuration computes",
    reason: NOT_LITERAL,
  },
];

/** Two strings ordered bytewise. */
function compare(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
}

/** Every declined entry-point convention, ordered by tool and then by convention. */
export const DECLINED_CONVENTIONS: readonly DeclinedConvention[] = [
  ...UNREAD_TOOLS.map((tool) => ({ tool, convention: EVERY_CONVENTION, reason: UNREAD })),
  ...PARTLY_ENTERED,
].sort((a, b) => compare(a.tool, b.tool) || compare(a.convention, b.convention));

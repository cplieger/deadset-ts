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

/** What is declined for a tool none of whose conventions is entered. */
const EVERY_CONVENTION = "its configuration and every file it loads by its own convention";

/** Why a tool none of whose conventions is entered declines them. */
const UNREAD =
  "No rule reads it, so a file only it loads is reported as never imported unless " +
  "ts.entry_files or roots.patterns names it.";

/** The tools none of whose conventions is entered. */
const UNREAD_TOOLS: readonly string[] = [
  "angular",
  "astro",
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
  "expo",
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
  "next",
  "next-intl",
  "next-mdx",
  "nitro",
  "node",
  "node-modules-inspector",
  "nodemon",
  "npm-package-json-lint",
  "nuxt",
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
  "qwik",
  "railway",
  "raycast",
  "react-cosmos",
  "react-email",
  "react-native",
  "react-router",
  "relay",
  "release-it",
  "remark",
  "remix",
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
  "storybook",
  "stylelint",
  "svelte",
  "sveltejs-package",
  "sveltekit",
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
  "unplugin-auto-import",
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
    convention: "the legacy .eslintrc configuration files",
    reason:
      "Only the flat configuration's file names are entered, so a legacy configuration " +
      "file the program holds is reported as never imported.",
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
    convention: "the globalSetup and globalTeardown files",
    reason:
      "No rule enters them, so a setup file only the runner loads is reported as never imported.",
  },
  {
    tool: "playwright",
    convention: "the testDir and testMatch of an entry in projects",
    reason:
      "Only the configuration object's own testDir and testMatch are read, so a test " +
      "directory a project entry moves is not entered.",
  },
  {
    tool: "stryker",
    convention: "a configuration file named on the command line",
    reason: "Only the file names the tool looks for by default are entered.",
  },
  {
    tool: "vite",
    convention: "its configuration and every entry point it names",
    reason:
      "Only a worker a call addresses by a literal is entered. No rule reads the " +
      "configuration, so a file only it names is reported as never imported.",
  },
  {
    tool: "vitest",
    convention: "the benchmark and type-test files",
    reason:
      "A test file is one ts.test_files classifies, so a *.bench.* or *.test-d.* file is " +
      "entered only where a configured pattern names it.",
  },
  {
    tool: "vitest",
    convention: "the mock files below a __mocks__ directory",
    reason:
      "No rule enters a file by its directory, so a mock only the runner's module mocking " +
      "loads is reported as never imported.",
  },
  {
    tool: "vitest",
    convention: "the setup files of a configuration that moves its root",
    reason:
      "A configuration writing root reads its setup files against a directory its text " +
      "may not state, so none of them is entered.",
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
    convention: "its configuration and every entry point it names",
    reason:
      "Only a worker a call addresses by a literal is entered. No rule reads the " +
      "configuration, so a file only it names is reported as never imported.",
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

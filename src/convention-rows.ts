/**
 * The convention rows this analyzer carries: the file-system conventions of one
 * framework or tool each, as data. Nothing outside the table names a framework.
 *
 * A row's globs are matched against the directory of the manifest that declares its
 * enabling package. A glob may hold `<id>` placeholders, each standing for the
 * directory one of the row's moves resolves to.
 */

/** A call whose first argument is the object a property is read from. */
export interface OptionsCall {
  /** The module specifier the configuration file imports the callee from. */
  readonly module: string;
  /** The name the module exports the callee as. */
  readonly export: string;
}

/** One configuration property, and the configuration files it is read from. */
export interface MoveReading {
  /** The property's path through nested object literals, its keys joined by `.`. */
  readonly property: string;
  /** Globs naming the configuration files, matched in the manifest's directory alone. */
  readonly files: readonly string[];
  /** The call whose options hold the property; absent, the file's default export holds it. */
  readonly call?: OptionsCall;
}

/** One configuration property whose value names a package by a short name. */
export interface ShortNameReading extends MoveReading {
  /** The package name a value stands for, written with `{}` where the value goes. */
  readonly package: string;
}

/**
 * One configuration property whose values name packages by the tool's prefix convention:
 * `x` stands for `<prefix>-x`, `@s` for `@s/<prefix>` and `@s/x` for `@s/<prefix>-x`, and
 * a name already holding the prefix for itself.
 */
export interface PrefixedNameReading extends MoveReading {
  /** The prefix the convention puts before a short name. */
  readonly prefix: string;
  /**
   * The text a value starts with to name a package, the name ending at its last `/`.
   * Absent, every value without a `:` names one, the name ending at its first `/` past
   * a scope.
   */
  readonly marker?: string;
}

/**
 * One configuration property whose value makes the tool's output import a runtime helper
 * package, so the package is used where the property holds that value.
 */
export interface HelperReading extends MoveReading {
  /**
   * The value: `true`, or a string the property holds, alone, as an element of an array,
   * or as the first element of an array that is such an element.
   */
  readonly value: true | string;
  /** The package the output imports its helpers from. */
  readonly package: string;
}

/** One member of a configuration file whose strings name the packages its tool loads. */
export interface PackageKey {
  /** The member's name, matched at any depth of the objects the row reads. */
  readonly key: string;
  /** Globs naming the configuration files, matched in the manifest's directory alone. */
  readonly files: readonly string[];
}

/** One configuration property whose strings name files the test runner loads beside the tests. */
export interface TestFileReading extends MoveReading {
  /**
   * The properties that move the directory the strings are read against, the first one the
   * file writes deciding, read against the manifest's directory, which stands where none is
   * written. A value that is not one string literal leaves the file's strings unread.
   */
  readonly roots: readonly string[];
}

/** One member of the declaring `package.json` whose strings name the tool's entries. */
export interface ManifestEntryKey {
  /** The member's path through nested objects, its keys joined by `.`, a `*` key standing for every member. */
  readonly key: string;
  /** Whether each string names a directory of entries, or one entry, its extension optional. */
  readonly directory: boolean;
}

/** One directory a row's globs name that a configuration property moves. */
export interface DirectoryMove {
  /** The placeholder the row's globs and later moves write as `<id>`. */
  readonly id: string;
  /**
   * The directory a value and a default are read against, below the manifest's
   * directory; it may hold an earlier move's placeholder. Absent, the manifest's
   * directory itself.
   */
  readonly base?: string;
  /** The directories the globs read where no configuration file sets the property, each read. */
  readonly defaults: readonly string[];
  readonly readings: readonly MoveReading[];
}

/** One row: one framework's or tool's file-system conventions over one range of its versions. */
export interface ConventionRow {
  /** Lowercase words joined by hyphens; rows of one name cover disjoint ranges. */
  readonly name: string;
  /** The package whose declaration as a dependency enables the row. */
  readonly package: string;
  /** The installed versions the row holds for, in the semantic-versioning range syntax. */
  readonly range: string;
  /** The globs of the files the row roots. */
  readonly entries: readonly string[];
  /** The globs of the files the row does not root, though an entry glob names them. */
  readonly excludes?: readonly string[];
  /** The directories the framework generates, each of whose files is a generated file. */
  readonly generated?: readonly string[];
  /** The directories configuration moves, in the order their placeholders depend on each other. */
  readonly moves: readonly DirectoryMove[];
  /** The properties that name a package the configuration uses by a short name. */
  readonly shortNames?: readonly ShortNameReading[];
  /** The properties that name a package the configuration uses by its prefix convention. */
  readonly prefixedNames?: readonly PrefixedNameReading[];
  /**
   * The properties whose value only selects files to test, mutate, cover or ignore, so a
   * string there names no file the tool runs or loads.
   */
  readonly selections?: readonly MoveReading[];
  /** The properties whose strings name a file the test runner loads beside the tests, a test file. */
  readonly testFiles?: readonly TestFileReading[];
  /**
   * The members whose strings name a package the tool loads: the package itself, a
   * subpath of it, or the package followed by `:` and a name.
   */
  readonly packageKeys?: readonly PackageKey[];
  /** The members of a `package.json` the tool reads its configuration from. */
  readonly manifestKeys?: readonly string[];
  /** The members of the declaring `package.json` whose strings name entries, as an entry glob does. */
  readonly manifestEntries?: readonly ManifestEntryKey[];
  /** The settings that make the tool's output import a runtime helper package. */
  readonly helpers?: readonly HelperReading[];
}

const SCRIPT = "{js,jsx,ts,tsx}";
const MODULE = "{js,mjs,ts,mts}";
const ANY_MODULE = "{js,mjs,cjs,ts,mts,cts}";
const VITE_CONFIG = `vite.config.${ANY_MODULE}`;
/** The legacy configuration files of ESLint that hold JSON or a CommonJS module. */
const ESLINTRC = [".eslintrc", ".eslintrc.json", ".eslintrc.{js,cjs}"];

const SVELTEKIT_ROUTE_FILES = "+{page,layout,server,page.server,layout.server,error}";

/** SvelteKit's entries other than its parameter matchers. */
const SVELTEKIT_ENTRIES = [
  `<routes>/**/${SVELTEKIT_ROUTE_FILES}.{js,ts,svelte}`,
  `<routes>/**/${SVELTEKIT_ROUTE_FILES}@*.{js,ts,svelte}`,
  "<hooksClient>{,/index}.{js,ts}",
  "<hooksServer>{,/index}.{js,ts}",
  "<hooksUniversal>{,/index}.{js,ts}",
  "<serviceWorker>{,/index}.{js,ts}",
  "<src>/instrumentation.server.{js,ts}",
];

const SVELTEKIT_PLUGIN = { module: "@sveltejs/kit/vite", export: "sveltekit" };

/** The entries React Router's framework mode and Remix share below their app directory. */
const APP_DIRECTORY_ENTRIES = [
  `<app>/root.${SCRIPT}`,
  `<app>/routes.${MODULE}`,
  `<app>/entry.{client,server}.${SCRIPT}`,
  `<app>/routes/**/*.${SCRIPT}`,
];

const SOLIDSTART_PLUGIN = { module: "@solidjs/start/config", export: "solidStart" };

const NUXT_CONFIG = [`nuxt.config.${ANY_MODULE}`];

const BABEL_CONFIG = [
  "babel.config.{json,js,cjs,mjs,cts,mts,ts}",
  ".babelrc",
  ".babelrc.{json,js,cjs,mjs,cts}",
];

const STRYKER_CONFIG = "{stryker,.stryker}.{conf,config}.{json,js,mjs,cjs}";
const STRYKER_MODULE = "{stryker,.stryker}.{conf,config}.{js,mjs,cjs}";
const VITEST_CONFIG = `{vitest,vite}.config.${ANY_MODULE}`;

/**
 * The properties Vitest takes its project root from, `test.root` before Vite's `root`; it
 * resolves `setupFiles` and `globalSetup` against that root
 * (https://vitest.dev/config/setupfiles, https://vitest.dev/config/globalsetup).
 */
const VITEST_ROOTS = ["test.root", "root"] as const;

/** The entry files of an Angular CLI project, at the workspace root or below `projects`. */
const ANGULAR_ENTRIES = [
  "src/{main,main.server,server,polyfills,test}.ts",
  "server.ts",
  "projects/*/src/{main,main.server,server,polyfills,test,public-api}.ts",
  "projects/*/server.ts",
];

/** The `angular.json` members whose strings name the packages a build loads. */
const ANGULAR_PACKAGE_KEYS: readonly PackageKey[] = [
  "builder",
  "polyfills",
  "styles",
  "scripts",
].map((key) => ({ key, files: ["angular.json"] }));

/**
 * The test runners and the assertion, mock and runner libraries whose import is test
 * evidence beside each runner a row reads test files for. Each applies whether or not a
 * manifest declares it, so none is a row.
 */
export const TEST_LIBRARIES: readonly string[] = [
  "@jest/globals",
  "@playwright/test",
  "ava",
  "chai",
  "expect",
  "jasmine",
  "jest",
  "mocha",
  "msw",
  "nock",
  "node:test",
  "sinon",
  "tap",
  "uvu",
];

/** The scopes every package of which is a test library. */
export const TEST_LIBRARY_SCOPES: readonly string[] = ["@testing-library/"];

/** Every row, ordered by name and then by range. */
export const CONVENTION_ROWS: readonly ConventionRow[] = [
  {
    name: "angular",
    package: "@angular/build",
    range: ">=17.0.0 <22.0.0",
    entries: ANGULAR_ENTRIES,
    moves: [],
    packageKeys: ANGULAR_PACKAGE_KEYS,
  },
  {
    name: "angular-devkit",
    package: "@angular-devkit/build-angular",
    range: ">=12.0.0 <22.0.0",
    entries: ANGULAR_ENTRIES,
    moves: [],
    packageKeys: ANGULAR_PACKAGE_KEYS,
  },
  {
    name: "astro",
    package: "astro",
    range: ">=5.0.0 <8.0.0",
    entries: [
      "<src>/pages/**/*.{astro,js,ts}",
      "<src>/middleware{,/index}.{js,ts}",
      "<src>/actions/index.{js,ts}",
      `<src>/{content,live}.config.${MODULE}`,
      `<src>/content/config.${MODULE}`,
    ],
    excludes: ["<src>/pages/**/_*", "<src>/pages/**/_*/**"],
    generated: [".astro"],
    moves: [
      {
        id: "src",
        defaults: ["src"],
        readings: [{ property: "srcDir", files: [`astro.config.${ANY_MODULE}`] }],
      },
    ],
  },
  {
    name: "babel",
    package: "@babel/core",
    range: ">=7.0.0 <9.0.0",
    entries: [],
    moves: [],
    helpers: ["@babel/plugin-transform-runtime", "@babel/transform-runtime"].map((value) => ({
      property: "plugins",
      files: BABEL_CONFIG,
      value,
      package: "@babel/runtime",
    })),
  },
  {
    name: "docusaurus",
    package: "@docusaurus/core",
    range: ">=2.0.0 <4.0.0",
    entries: [`src/pages/**/*.${SCRIPT}`, `src/theme/**/*.${SCRIPT}`],
    moves: [],
  },
  {
    name: "eslint",
    package: "eslint",
    range: ">=4.0.0 <10.0.0",
    entries: [],
    moves: [],
    prefixedNames: [
      { property: "plugins", files: ESLINTRC, prefix: "eslint-plugin" },
      { property: "extends", files: ESLINTRC, prefix: "eslint-plugin", marker: "plugin:" },
      { property: "extends", files: ESLINTRC, prefix: "eslint-config" },
    ],
  },
  {
    name: "eslint",
    package: "eslint",
    range: ">=10.0.0 <11.0.0",
    entries: [`**/eslint.config.${ANY_MODULE}`],
    moves: [],
  },
  {
    name: "expo",
    package: "expo",
    range: ">=44.0.0 <60.0.0",
    entries: [`{index,App}.${SCRIPT}`],
    moves: [],
  },
  {
    name: "expo-router",
    package: "expo-router",
    range: ">=3.0.0 <58.0.0",
    entries: [`{,src/}app/**/*.${SCRIPT}`],
    moves: [],
  },
  {
    name: "next",
    package: "next",
    range: ">=13.4.0 <17.0.0",
    generated: [".next"],
    entries: [
      `{,src/}app/**/{layout,page,loading,not-found,error,route,template,default,forbidden,unauthorized}.${SCRIPT}`,
      `{,src/}app/global-{error,not-found}.${SCRIPT}`,
      `{,src/}app/**/{icon,apple-icon,opengraph-image,twitter-image}.${SCRIPT}`,
      "{,src/}app/**/sitemap.{js,ts}",
      "{,src/}app/{robots,manifest}.{js,ts}",
      "{,src/}app/(*)/{robots,manifest}.{js,ts}",
      `{,src/}pages/**/*.${SCRIPT}`,
      `{,src/}{proxy,middleware,instrumentation,instrumentation-client,mdx-components}.${SCRIPT}`,
    ],
    moves: [],
  },
  {
    name: "nuxt",
    package: "nuxt",
    range: ">=3.0.0 <5.0.0",
    generated: [".nuxt"],
    entries: [
      "<srcDir>/{app,error}.{vue,jsx,tsx}",
      `<srcDir>/app.config.${MODULE}`,
      "<srcDir>/router.options.{js,ts}",
      "<pages>/**/*.{vue,js,jsx,ts,tsx}",
      "<layouts>/**/*.{vue,jsx,tsx}",
      "<middleware>/**/*.{js,ts}",
      "<plugins>/**/*.{js,ts}",
      "<modules>/*.{js,ts}",
      "<modules>/*/index.{js,ts}",
      `<serverDir>/{api,routes,middleware,plugins,tasks}/**/*.${MODULE}`,
      `layers/*/nuxt.config.${MODULE}`,
    ],
    moves: [
      {
        id: "srcDir",
        defaults: ["app", "."],
        readings: [{ property: "srcDir", files: NUXT_CONFIG }],
      },
      {
        id: "pages",
        base: "<srcDir>",
        defaults: ["pages"],
        readings: [{ property: "dir.pages", files: NUXT_CONFIG }],
      },
      {
        id: "layouts",
        base: "<srcDir>",
        defaults: ["layouts"],
        readings: [{ property: "dir.layouts", files: NUXT_CONFIG }],
      },
      {
        id: "middleware",
        base: "<srcDir>",
        defaults: ["middleware"],
        readings: [{ property: "dir.middleware", files: NUXT_CONFIG }],
      },
      {
        id: "plugins",
        base: "<srcDir>",
        defaults: ["plugins"],
        readings: [{ property: "dir.plugins", files: NUXT_CONFIG }],
      },
      {
        id: "modules",
        defaults: ["modules"],
        readings: [{ property: "dir.modules", files: NUXT_CONFIG }],
      },
      {
        id: "serverDir",
        defaults: ["server"],
        readings: [{ property: "serverDir", files: NUXT_CONFIG }],
      },
    ],
  },
  {
    name: "oclif",
    package: "@oclif/core",
    range: ">=1.0.0 <5.0.0",
    entries: [`src/{commands,hooks}/**/*.${SCRIPT}`],
    moves: [],
    manifestEntries: [
      { key: "oclif.commands", directory: true },
      { key: "oclif.hooks", directory: false },
    ],
  },
  {
    name: "parcel",
    package: "parcel",
    range: ">=2.0.0 <3.0.0",
    entries: [],
    moves: [],
    manifestEntries: [
      { key: "source", directory: false },
      { key: "targets.*.source", directory: false },
    ],
  },
  {
    name: "prettier",
    package: "prettier",
    range: ">=3.0.0 <4.0.0",
    entries: [`{prettier.config,.prettierrc}.${ANY_MODULE}`],
    moves: [],
    manifestKeys: ["prettier"],
  },
  {
    name: "qwik-city",
    package: "@builder.io/qwik-city",
    range: ">=1.0.0 <2.0.0",
    entries: [
      "<srcDir>/root.{jsx,tsx}",
      `<srcDir>/entry.*.${SCRIPT}`,
      `<routesDir>/**/*.${SCRIPT}`,
    ],
    moves: [
      {
        id: "srcDir",
        defaults: ["src"],
        readings: [
          {
            property: "srcDir",
            files: [VITE_CONFIG],
            call: { module: "@builder.io/qwik/optimizer", export: "qwikVite" },
          },
        ],
      },
      {
        id: "routesDir",
        defaults: ["<srcDir>/routes"],
        readings: [
          {
            property: "routesDir",
            files: [VITE_CONFIG],
            call: { module: "@builder.io/qwik-city/vite", export: "qwikCity" },
          },
        ],
      },
    ],
  },
  {
    name: "react-router",
    package: "@react-router/dev",
    range: ">=7.0.0 <9.0.0",
    entries: APP_DIRECTORY_ENTRIES,
    generated: [".react-router"],
    moves: [
      {
        id: "app",
        defaults: ["app"],
        readings: [{ property: "appDirectory", files: [`react-router.config.${MODULE}`] }],
      },
    ],
  },
  {
    name: "remix",
    package: "@remix-run/dev",
    range: ">=2.0.0 <3.0.0",
    entries: APP_DIRECTORY_ENTRIES,
    moves: [
      {
        id: "app",
        defaults: ["app"],
        readings: [
          { property: "appDirectory", files: ["remix.config.{js,cjs,mjs}"] },
          {
            property: "appDirectory",
            files: [VITE_CONFIG],
            call: { module: "@remix-run/dev", export: "vitePlugin" },
          },
          {
            property: "appDirectory",
            files: [VITE_CONFIG],
            call: { module: "@remix-run/dev", export: "unstable_vitePlugin" },
          },
        ],
      },
    ],
  },
  {
    name: "rolldown",
    package: "rolldown",
    range: ">=1.0.0 <2.0.0",
    entries: [],
    moves: [],
    helpers: [
      {
        property: "transform.helpers.mode",
        files: [`rolldown.config.${ANY_MODULE}`],
        value: "Runtime",
        package: "@oxc-project/runtime",
      },
    ],
  },
  {
    name: "solidstart",
    package: "@solidjs/start",
    range: ">=1.0.0 <3.0.0",
    entries: [
      `<appRoot>/app.${SCRIPT}`,
      `<appRoot>/entry-{client,server}.${SCRIPT}`,
      "<appRoot>/middleware{,/index}.{js,ts}",
      `<routeDir>/**/*.${SCRIPT}`,
    ],
    moves: [
      {
        id: "appRoot",
        defaults: ["src"],
        readings: [
          { property: "appRoot", files: [`app.config.${MODULE}`] },
          { property: "appRoot", files: [VITE_CONFIG], call: SOLIDSTART_PLUGIN },
        ],
      },
      {
        id: "routeDir",
        base: "<appRoot>",
        defaults: ["routes"],
        readings: [
          { property: "routeDir", files: [`app.config.${MODULE}`] },
          { property: "routeDir", files: [VITE_CONFIG], call: SOLIDSTART_PLUGIN },
        ],
      },
    ],
  },
  {
    name: "storybook",
    package: "storybook",
    range: ">=7.0.0 <11.0.0",
    entries: [
      `.storybook/{main,preview,manager,test-runner,vitest.setup}.{js,jsx,mjs,cjs,ts,tsx,mts,cts}`,
      "**/*.stories.{js,jsx,mjs,ts,tsx,mts,svelte,vue}",
    ],
    moves: [],
  },
  {
    name: "stryker",
    package: "@stryker-mutator/core",
    range: ">=7.0.0 <11.0.0",
    entries: [STRYKER_MODULE],
    moves: [],
    selections: [
      { property: "mutate", files: [STRYKER_CONFIG] },
      { property: "ignorePatterns", files: [STRYKER_CONFIG] },
    ],
    shortNames: [
      {
        property: "testRunner",
        files: [STRYKER_CONFIG],
        package: "@stryker-mutator/{}-runner",
      },
      {
        property: "checkers",
        files: [STRYKER_CONFIG],
        package: "@stryker-mutator/{}-checker",
      },
    ],
  },
  {
    name: "sveltekit",
    package: "@sveltejs/kit",
    range: ">=2.0.0 <3.0.0",
    entries: [...SVELTEKIT_ENTRIES, "<params>/*.{js,ts}"],
    generated: [".svelte-kit"],
    moves: [
      {
        id: "src",
        defaults: ["src"],
        readings: [
          { property: "kit.files.src", files: ["svelte.config.{js,mjs,ts}"] },
          { property: "files.src", files: [VITE_CONFIG], call: SVELTEKIT_PLUGIN },
        ],
      },
      {
        id: "routes",
        defaults: ["<src>/routes"],
        readings: [
          { property: "kit.files.routes", files: ["svelte.config.{js,mjs,ts}"] },
          { property: "files.routes", files: [VITE_CONFIG], call: SVELTEKIT_PLUGIN },
        ],
      },
      {
        id: "params",
        defaults: ["<src>/params"],
        readings: [
          { property: "kit.files.params", files: ["svelte.config.{js,mjs,ts}"] },
          { property: "files.params", files: [VITE_CONFIG], call: SVELTEKIT_PLUGIN },
        ],
      },
      {
        id: "hooksClient",
        defaults: ["<src>/hooks.client"],
        readings: [
          { property: "kit.files.hooks.client", files: ["svelte.config.{js,mjs,ts}"] },
          { property: "files.hooks.client", files: [VITE_CONFIG], call: SVELTEKIT_PLUGIN },
        ],
      },
      {
        id: "hooksServer",
        defaults: ["<src>/hooks.server"],
        readings: [
          { property: "kit.files.hooks.server", files: ["svelte.config.{js,mjs,ts}"] },
          { property: "files.hooks.server", files: [VITE_CONFIG], call: SVELTEKIT_PLUGIN },
        ],
      },
      {
        id: "hooksUniversal",
        defaults: ["<src>/hooks"],
        readings: [
          { property: "kit.files.hooks.universal", files: ["svelte.config.{js,mjs,ts}"] },
          { property: "files.hooks.universal", files: [VITE_CONFIG], call: SVELTEKIT_PLUGIN },
        ],
      },
      {
        id: "serviceWorker",
        defaults: ["<src>/service-worker"],
        readings: [
          { property: "kit.files.serviceWorker", files: ["svelte.config.{js,mjs,ts}"] },
          { property: "files.serviceWorker", files: [VITE_CONFIG], call: SVELTEKIT_PLUGIN },
        ],
      },
    ],
  },
  {
    name: "sveltekit",
    package: "@sveltejs/kit",
    range: ">=3.0.0 <4.0.0",
    entries: [...SVELTEKIT_ENTRIES, "<params>.{js,ts}"],
    generated: [".svelte-kit"],
    moves: [
      {
        id: "src",
        defaults: ["src"],
        readings: [{ property: "files.src", files: [VITE_CONFIG], call: SVELTEKIT_PLUGIN }],
      },
      {
        id: "routes",
        defaults: ["<src>/routes"],
        readings: [{ property: "files.routes", files: [VITE_CONFIG], call: SVELTEKIT_PLUGIN }],
      },
      {
        id: "params",
        defaults: ["<src>/params"],
        readings: [{ property: "files.params", files: [VITE_CONFIG], call: SVELTEKIT_PLUGIN }],
      },
      {
        id: "hooksClient",
        defaults: ["<src>/hooks.client"],
        readings: [
          { property: "files.hooks.client", files: [VITE_CONFIG], call: SVELTEKIT_PLUGIN },
        ],
      },
      {
        id: "hooksServer",
        defaults: ["<src>/hooks.server"],
        readings: [
          { property: "files.hooks.server", files: [VITE_CONFIG], call: SVELTEKIT_PLUGIN },
        ],
      },
      {
        id: "hooksUniversal",
        defaults: ["<src>/hooks"],
        readings: [
          { property: "files.hooks.universal", files: [VITE_CONFIG], call: SVELTEKIT_PLUGIN },
        ],
      },
      {
        id: "serviceWorker",
        defaults: ["<src>/service-worker"],
        readings: [
          { property: "files.serviceWorker", files: [VITE_CONFIG], call: SVELTEKIT_PLUGIN },
        ],
      },
    ],
  },
  {
    name: "swc",
    package: "@swc/core",
    range: ">=1.0.0 <2.0.0",
    entries: [],
    moves: [],
    helpers: [
      {
        property: "jsc.externalHelpers",
        files: [".swcrc"],
        value: true,
        package: "@swc/helpers",
      },
    ],
  },
  {
    name: "tanstack-router",
    package: "@tanstack/router-plugin",
    range: ">=1.0.0 <2.0.0",
    entries: [`<routes>/**/*.${SCRIPT}`],
    moves: [
      {
        id: "routes",
        defaults: ["src/routes"],
        readings: [
          { property: "routesDirectory", files: ["tsr.config.json"] },
          {
            property: "routesDirectory",
            files: [VITE_CONFIG],
            call: { module: "@tanstack/router-plugin/vite", export: "tanstackRouter" },
          },
          {
            property: "routesDirectory",
            files: [VITE_CONFIG],
            call: { module: "@tanstack/router-plugin/vite", export: "TanStackRouterVite" },
          },
        ],
      },
    ],
  },
  {
    name: "vite",
    package: "vite",
    range: ">=8.0.0 <9.0.0",
    entries: [],
    moves: [],
    helpers: [
      {
        property: "oxc.helpers.mode",
        files: [VITE_CONFIG],
        value: "Runtime",
        package: "@oxc-project/runtime",
      },
    ],
  },
  {
    name: "vitepress",
    package: "vitepress",
    range: ">=1.0.0 <2.0.0-0 || >=2.0.0-alpha.0 <3.0.0",
    entries: [
      `.vitepress/config.${ANY_MODULE}`,
      `.vitepress/theme/index.${ANY_MODULE}`,
      `**/*.data.${ANY_MODULE}`,
      "**/*.vue",
    ],
    moves: [],
  },
  {
    name: "vitest",
    package: "vitest",
    range: ">=3.2.0 <6.0.0",
    entries: [
      `**/{vitest,vite}.config.${ANY_MODULE}`,
      `**/{vitest,vite}.config.*.${ANY_MODULE}`,
      `**/{vitest,vite}.*.config.${ANY_MODULE}`,
    ],
    moves: [],
    shortNames: [
      {
        property: "test.coverage.provider",
        files: [VITEST_CONFIG],
        package: "@vitest/coverage-{}",
      },
    ],
    selections: [
      { property: "test.coverage.include", files: [VITEST_CONFIG] },
      { property: "test.coverage.exclude", files: [VITEST_CONFIG] },
    ],
    testFiles: [
      { property: "test.setupFiles", files: [VITEST_CONFIG], roots: VITEST_ROOTS },
      { property: "test.globalSetup", files: [VITEST_CONFIG], roots: VITEST_ROOTS },
    ],
  },
];

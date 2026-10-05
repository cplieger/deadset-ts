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
interface MoveReading {
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
}

const SCRIPT = "{js,jsx,ts,tsx}";
const MODULE = "{js,mjs,ts,mts}";
const ANY_MODULE = "{js,mjs,cjs,ts,mts,cts}";
const VITE_CONFIG = `vite.config.${ANY_MODULE}`;

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

/** Every row, ordered by name and then by range. */
export const CONVENTION_ROWS: readonly ConventionRow[] = [
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
    name: "eslint",
    package: "eslint",
    range: ">=10.0.0 <11.0.0",
    entries: [`**/eslint.config.${ANY_MODULE}`],
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
        files: [`{vitest,vite}.config.${ANY_MODULE}`],
        package: "@vitest/coverage-{}",
      },
    ],
  },
];

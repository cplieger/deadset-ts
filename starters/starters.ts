/**
 * The official starter project each convention row is checked against: how to generate
 * it, which of its files the framework's documentation calls an entry, and the pins in
 * this directory's `package.json` that name the generator and the enabling package.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** One starter, generated into the directory `<project>` names in `create`. */
export interface Starter {
  /** The convention row the starter checks. */
  readonly row: string;
  /** The enabling package the row names. */
  readonly package: string;
  /** The `devDependencies` key that pins the generator, an npm alias where one name needs two pins. */
  readonly generator: string;
  /** The `devDependencies` key that pins the enabling package. */
  readonly framework: string;
  /** The npm version spec the latest run installs the enabling package at. */
  readonly latest: string;
  /** The npm version spec of the generator the latest run uses, where it is not the newest release. */
  readonly latestGenerator?: string;
  /** A project the starter's generator is added to, generated first. */
  readonly host?: { readonly generator: string; readonly create: readonly string[] };
  /** The generator's arguments; `<project>` is the project directory's name. */
  readonly create: readonly string[];
  /** Whether the generator runs inside the project directory rather than beside it. */
  readonly inside?: boolean;
  /** A command the project's own scripts run before type-checking, run after the install. */
  readonly prepare?: readonly string[];
  /** The files below the project the framework's documentation calls entries. */
  readonly entries: readonly string[];
}

const PROJECT = "<project>";

export const STARTERS: readonly Starter[] = [
  {
    row: "astro",
    package: "astro",
    generator: "create-astro",
    framework: "astro",
    latest: "latest",
    create: [PROJECT, "--template", "blog", "--no-install", "--no-git", "--yes"],
    entries: [
      "src/pages/index.astro",
      "src/pages/about.astro",
      "src/pages/blog/index.astro",
      "src/pages/blog/[...slug].astro",
      "src/pages/rss.xml.js",
      "src/content.config.ts",
    ],
  },
  {
    row: "expo-router",
    package: "expo-router",
    generator: "create-expo-app",
    framework: "expo-router",
    latest: "latest",
    create: [PROJECT, "--template", "default", "--no-install", "--no-agents-md"],
    entries: ["src/app/_layout.tsx", "src/app/index.tsx", "src/app/explore.tsx"],
  },
  {
    row: "next",
    package: "next",
    generator: "create-next-app",
    framework: "next",
    latest: "latest",
    create: [
      PROJECT,
      "--ts",
      "--app",
      "--eslint",
      "--no-tailwind",
      "--no-src-dir",
      "--import-alias",
      "@/*",
      "--use-npm",
      "--skip-install",
      "--disable-git",
      "--yes",
    ],
    entries: ["app/layout.tsx", "app/page.tsx"],
  },
  {
    row: "nuxt",
    package: "nuxt",
    generator: "create-nuxt",
    framework: "nuxt",
    latest: "latest",
    create: [
      PROJECT,
      "--template",
      "ui",
      "--no-install",
      "--gitInit=false",
      "--packageManager=npm",
    ],
    entries: ["app/app.vue", "app/app.config.ts", "app/pages/index.vue"],
  },
  {
    row: "qwik-city",
    package: "@builder.io/qwik-city",
    generator: "create-qwik",
    framework: "@builder.io/qwik-city",
    latest: "latest",
    create: ["playground", PROJECT],
    entries: [
      "src/root.tsx",
      "src/entry.ssr.tsx",
      "src/entry.dev.tsx",
      "src/entry.preview.tsx",
      "src/routes/index.tsx",
      "src/routes/layout.tsx",
      "src/routes/demo/flower/index.tsx",
      "src/routes/demo/todolist/index.tsx",
    ],
  },
  {
    row: "react-router",
    package: "@react-router/dev",
    generator: "create-react-router",
    framework: "@react-router/dev",
    latest: "latest",
    create: [PROJECT, "--yes", "--no-git-init", "--no-install"],
    prepare: ["npx", "--no-install", "react-router", "typegen"],
    entries: ["app/root.tsx", "app/routes.ts", "app/routes/home.tsx"],
  },
  {
    row: "remix",
    package: "@remix-run/dev",
    generator: "create-remix",
    framework: "@remix-run/dev",
    latest: "latest",
    latestGenerator: "2.16.8",
    create: [
      PROJECT,
      "--template",
      "https://github.com/remix-run/remix/tree/v2/templates/remix",
      "--yes",
      "--no-git-init",
      "--no-install",
    ],
    entries: [
      "app/root.tsx",
      "app/entry.client.tsx",
      "app/entry.server.tsx",
      "app/routes/_index.tsx",
    ],
  },
  {
    row: "solidstart",
    package: "@solidjs/start",
    generator: "create-solid",
    framework: "@solidjs/start",
    latest: "latest",
    create: [PROJECT, "basic", "--solidstart", "--v2", "--ts"],
    entries: [
      "src/app.tsx",
      "src/entry-client.tsx",
      "src/entry-server.tsx",
      "src/routes/index.tsx",
      "src/routes/about.tsx",
      "src/routes/[...404].tsx",
    ],
  },
  {
    row: "storybook",
    package: "storybook",
    generator: "create-storybook",
    framework: "storybook",
    latest: "latest",
    host: {
      generator: "create-vite",
      create: [PROJECT, "--template", "react-ts", "--no-interactive"],
    },
    create: [
      "--yes",
      "--no-dev",
      "--skip-install",
      "--no-features",
      "--package-manager",
      "npm",
      "--disable-telemetry",
      "--no-agent",
    ],
    inside: true,
    entries: [
      "src/stories/Button.stories.ts",
      "src/stories/Header.stories.ts",
      "src/stories/Page.stories.ts",
    ],
  },
  {
    row: "sveltekit",
    package: "@sveltejs/kit",
    generator: "sv-sveltekit-2",
    framework: "sveltekit-2",
    latest: "2",
    latestGenerator: "0",
    create: [
      "create",
      PROJECT,
      "--template",
      "demo",
      "--types",
      "ts",
      "--no-add-ons",
      "--no-install",
    ],
    entries: [
      "src/routes/+layout.svelte",
      "src/routes/+page.svelte",
      "src/routes/+page.ts",
      "src/routes/about/+page.ts",
      "src/routes/sverdle/+page.server.ts",
      "src/routes/sverdle/how-to-play/+page.ts",
    ],
  },
  {
    row: "sveltekit",
    package: "@sveltejs/kit",
    generator: "sv",
    framework: "@sveltejs/kit",
    latest: "latest",
    create: [
      "create",
      PROJECT,
      "--template",
      "demo",
      "--types",
      "ts",
      "--no-add-ons",
      "--no-install",
    ],
    entries: [
      "src/routes/+layout.svelte",
      "src/routes/+page.svelte",
      "src/routes/+page.ts",
      "src/routes/about/+page.ts",
      "src/routes/sverdle/+page.server.ts",
      "src/routes/sverdle/how-to-play/+page.ts",
    ],
  },
];

const HERE = dirname(fileURLToPath(import.meta.url));

/** The pins this directory's manifest records, by key. */
export function pins(): Readonly<Record<string, string>> {
  const manifest = JSON.parse(readFileSync(join(HERE, "package.json"), "utf8")) as {
    devDependencies: Record<string, string>;
  };
  return manifest.devDependencies;
}

/** A pin as `npx` names it: the package, then the version, an alias read through. */
function pinned(spec: string, key: string): { readonly name: string; readonly version: string } {
  const alias = /^npm:(.+)@([^@]+)$/u.exec(spec);
  return alias === null
    ? { name: key, version: spec }
    : { name: alias[1] ?? key, version: alias[2] ?? "" };
}

/** Which versions a run checks: the pinned ones, or each row's latest release. */
export type Mode = "pinned" | "latest";

/** The generator and the enabling package's version one run of one starter uses. */
export function versionsFor(
  starter: Starter,
  mode: Mode,
): { readonly generator: string; readonly framework: string } {
  const all = pins();
  const generator = pinned(all[starter.generator] ?? "", starter.generator);
  const framework = pinned(all[starter.framework] ?? "", starter.framework);
  if (mode === "pinned") {
    return { generator: `${generator.name}@${generator.version}`, framework: framework.version };
  }
  return {
    generator: `${generator.name}@${starter.latestGenerator ?? "latest"}`,
    framework: starter.latest,
  };
}

const SECTIONS = ["dependencies", "devDependencies", "peerDependencies"] as const;

function sh(command: string, args: readonly string[], cwd: string): void {
  execFileSync(command, args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, CI: "1", npm_config_yes: "true" },
    maxBuffer: 64 * 1024 * 1024,
  });
}

/**
 * Generates one starter below `dir`, sets its enabling package to the version given and
 * installs it, its scripts included, because a framework writes the generated
 * configurations its compiler configuration extends from an install script. Answers the
 * project's directory.
 */
export function generate(
  starter: Starter,
  dir: string,
  versions: { readonly generator: string; readonly framework: string },
): string {
  const name = "starter-project";
  const project = join(dir, name);
  mkdirSync(dir, { recursive: true });
  const fill = (args: readonly string[]) => args.map((one) => (one === PROJECT ? name : one));
  if (starter.host !== undefined) {
    const host = pins()[starter.host.generator] ?? "";
    sh("npx", ["--yes", `${starter.host.generator}@${host}`, ...fill(starter.host.create)], dir);
  }
  sh(
    "npx",
    ["--yes", versions.generator, ...fill(starter.create)],
    starter.inside === true ? project : dir,
  );
  const manifestPath = join(project, "package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<
    string,
    Record<string, string> | undefined
  >;
  const section = SECTIONS.find((one) => manifest[one]?.[starter.package] !== undefined);
  const held = manifest[section ?? "devDependencies"] ?? {};
  held[starter.package] = versions.framework;
  manifest[section ?? "devDependencies"] = held;
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  for (const lock of ["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock"]) {
    rmSync(join(project, lock), { force: true });
  }
  sh("npm", ["install", "--no-audit", "--no-fund", "--loglevel=error"], project);
  if (starter.prepare !== undefined) {
    const [command = "", ...args] = starter.prepare;
    sh(command, args, project);
  }
  return project;
}

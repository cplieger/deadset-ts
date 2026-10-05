# How deadset-ts works

This page explains which projects deadset-ts loads, how it decides a declaration is live, and what it holds back from a report, for readers who want to judge a finding or tune the analysis.

## The projects it loads

A run opens one compiler session over the project entries of `analysis.configurations`, in the order it lists them. Each one names a compiler configuration file below the target, and the platform entries the Go analyzer reads are left alone. When the array holds no project entry, the run takes every `tsconfig` project it finds under the target, through the explicit scope, every `tsconfig*.json` and each project's `references`. `print-projects` lists them.

JavaScript files are analyzed too, in a project that sets `allowJs`.

A file whose extension `ts.component_extensions` lists is a component file, `.vue`, `.svelte` and `.astro` by default. Its `<script>` elements that start a line outside every other element are its blocks. So is a frontmatter block fenced by `---` lines at the start of the file. The blocks are analyzed as one module, in the strongest language any of them names, and an import of the file resolves to that module. A project that reads one workspace import as two files reads no component file, and standard error names it.

The markup of a component file is not parsed. Every binding a block declares or imports at the top level is kept while the file is live. A member whose name an expression or attribute of the markup writes is kept by the `template-field` exemption while the file is live. A `<script src>` element imports the file it names. A line-start `<script>` tag not read as a block is named on standard error, and the file is analyzed without it.

The run reads every project's diagnostics and fails closed for the projects you name. A project that `analysis.configurations` or the scope names and that does not load ends the run with exit code 3. A discovered project is dropped instead when it meets a setup failure or its configuration names no input, carries a refused option or is unreadable. The report names it in `configurations_not_built` with its error, standard error names it too, and the other projects are analyzed. Configuration is decoded against the Contract's closed key list, and `print-config` shows each setting with its source.

A target can sit in a workspace that `pnpm-workspace.yaml` or the `workspaces` field of a `package.json` declares. An import of another workspace package is then read from that package's TypeScript source, so a monorepo needs no build before a run.

A workspace package can have no file to read, such as a bundler's `dist/` that is not built yet. A discovered project that imports one is dropped, and its error names the package and the fix. When `analysis.configurations` names that project, the run ends with exit code 3 instead.

Every question the analysis asks the compiler is guarded. A question the compiler server fails on is answered as unknown. Every declaration that answer could have kept live is kept live and reported by nothing, as is every declaration only those keep live or whose own references went unanswered. Standard error counts the unanswered questions by project.

A declaration is reported only when it is dead in every project that holds it.

## How it finds references

The analysis takes an inventory of every declaration a project's own files hold, down to class and type members. It then resolves every reference over that inventory in one pass, through the compiler's type information rather than a text search. The pass resolves each file's identifiers in batches, and [Batch-cap calibration](batch-cap-calibration.md) is the measurement behind the batch size.

The same tree always gives the same report, and the analysis keeps no cache between runs.

## The roots

A root is a declaration the analysis keeps live without a reference. `print-roots` lists each one with the rule that made it a root. The roots are:

- What a file exports when the target's manifest, or another workspace package's manifest, names it through `main`, `module`, `types`, `bin` or `exports`, or when `ts.entry_files` matches it
- A library target's published API
- What a file exports when an applied convention row names it, such as a Next.js page, a SvelteKit route or a Storybook story
- A configuration file beside a `package.json` whose name is `<stem>.config.<ext>`, `<stem>.<qualifier>.config.<ext>` or `.<stem>rc.<ext>`
- A file that a string starting with `./` or `../` names, in such a configuration file or in its JSON form, like `<stem>.config.json` or `.<stem>rc`
- A file that a token of a `package.json` script names, such as `node ./scripts/seed.ts`
- The test files, Vitest's workspace configuration, Stryker's other configuration names and the test files in Playwright's test directory
- A global that a declaration file declares as `typeof import("<module>")["<name>"]`, which stands for that export, so using the global uses the export
- A worker or service worker that a call addresses by a string literal
- Every declaration a `roots.patterns` entry names

A string in such a configuration file that spells a dependency its `package.json` declares, alone or followed by a subpath, keeps that dependency from `DS1601`. So does a string in a module such a configuration file imports by a relative specifier. A data file it imports, such as `./package.json`, is not read for strings. Both kinds of module are read whether or not a compiler configuration includes the file.

A `roots.patterns` entry that names nothing is reported as `DS1704` and fails the run. Other entry-point conventions are not read, and the `DECLINED_CONVENTIONS` export lists each one with the reason.

A convention row holds the file-system conventions of one framework or tool. It applies when a `package.json` the analysis reads declares the row's package and the installed version is in the row's range. Its globs are matched below that manifest's directory. The report lists each applied row in `conventions_applied`, and `print-roots` names the row beside each file it roots. A package declared and not installed is the setup failure `missing-module` when `dependencies` or `devDependencies` declares it, and applies no row otherwise.

Some rows read a directory that the framework's configuration file moves, such as `srcDir` in `nuxt.config.ts`. The value is read from the default export, or from the options of the framework's Vite plugin, without running the file. The plugin may be imported or bound by a top-level `require`. A string literal or a template literal with no substitution moves the directory, and an unset property leaves the default.

Any other value is the setup failure `convention-not-literal`. So is an object on the way to the property that is not written out, that spreads another object in, or that computes a key from anything but a literal. Write the value as a literal, or name the row in `ts.disabled_conventions` and its files in `ts.entry_files`.

| Row            | Package                 | Versions           | What it roots                                                                                                                                                          |
| -------------- | ----------------------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `astro`        | `astro`                 | `>=5.0.0 <8.0.0`   | Pages other than `_`-prefixed files and directories, middleware, actions and the content configuration below `src`, which `srcDir` moves                               |
| `eslint`       | `eslint`                | `>=10.0.0 <11.0.0` | Every `eslint.config.*` file                                                                                                                                           |
| `expo-router`  | `expo-router`           | `>=3.0.0 <58.0.0`  | Every module below `app` or `src/app`                                                                                                                                  |
| `next`         | `next`                  | `>=13.4.0 <17.0.0` | The App Router's special and metadata files, `pages`, and `proxy`, `middleware`, `instrumentation` and `mdx-components`, at the root or below `src`                    |
| `nuxt`         | `nuxt`                  | `>=3.0.0 <5.0.0`   | The app, error, app configuration and router options files, pages, layouts, middleware, plugins, modules and server routes, which `srcDir`, `serverDir` and `dir` move |
| `qwik-city`    | `@builder.io/qwik-city` | `>=1.0.0 <2.0.0`   | `root`, the `entry.*` files and the routes, which `srcDir` and `routesDir` move                                                                                        |
| `react-router` | `@react-router/dev`     | `>=7.0.0 <9.0.0`   | `root`, `routes`, `entry.client`, `entry.server` and the `routes` directory below `app`, which `appDirectory` moves                                                    |
| `remix`        | `@remix-run/dev`        | `>=2.0.0 <3.0.0`   | The same files as `react-router`, which `appDirectory` moves                                                                                                           |
| `solidstart`   | `@solidjs/start`        | `>=1.0.0 <3.0.0`   | `app`, `entry-client`, `entry-server`, the middleware and the routes below `src`, which `appRoot` and `routeDir` move                                                  |
| `storybook`    | `storybook`             | `>=7.0.0 <11.0.0`  | The `.storybook` configuration files and every `*.stories.*` file                                                                                                      |
| `sveltekit`    | `@sveltejs/kit`         | `>=2.0.0 <4.0.0`   | Route files, hooks, params, the service worker and `instrumentation.server` below `src`, which the `files` options move                                                |
| `vitest`       | `vitest`                | `>=3.2.0 <6.0.0`   | Every `vitest.config.*` and `vite.config.*` file, with or without a qualifier                                                                                          |

## What an exemption holds back

An exemption holds a declaration back from the report when something the compiler cannot follow uses it. `print-retained` lists every declaration an exemption held back, with its class, site and detail. Nine classes run on TypeScript:

| Class                    | What it holds back                                                                                                                                                                                         |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `interface-satisfaction` | A member an interface requires of a class whose value reaches that interface                                                                                                                               |
| `enum-group`             | Every member of an enum whose value arrives by conversion, such as a number asserted to the enum type, rather than by a member's name                                                                      |
| `decorator`              | A decorated member, and every member of a decorated class                                                                                                                                                  |
| `injection-container`    | A decorated property of a class a dependency-injection container constructs: one passed to a call `ts.injection_registrations` names, or one with a decorated constructor parameter                        |
| `framework-lifecycle`    | A member a `ts.lifecycle_contracts` entry lists, on a class the entry's decorator, call or base class makes a component                                                                                    |
| `serialization-contract` | The properties of a class whose values reach `JSON.stringify` or a `ts.serializers` declaration, and its `toJSON` and `toString` when a value reaches an `unknown` or `any` parameter outside the analysis |
| `generated-file`         | Every declaration in a file below a directory an applied convention row names as generated, such as `.nuxt` or `.svelte-kit`                                                                               |
| `template-field`         | A member that an action of a template under `analysis.template_dirs`, or a live component file's markup, names                                                                                             |
| `reflective-lookup`      | A member that a literal key of an element access, or of `Reflect.get`, `Reflect.set` or `Reflect.has`, names                                                                                               |

`template-field` and `reflective-lookup` hold back at the lowest confidence, `possible`. The others hold back at `certain`. No class holds back a `#private` member. `exemptions.disabled` switches a class off.

## Libraries and their consumers

A library's published API has callers outside the target. A scope document passed with `--scope` names the consumers loaded beside it, each a directory whose compiler configurations open in the same session. A reference from a consumer keeps a target declaration live, and the report names every consumer it loaded. A consumer that is absent or does not load ends the run with exit code 3.

The published API is reported at confidence `certain` once every declared consumer loads, and `possible` when the scope declares none. In that second case the default `analysis.min_confidence`, `probable`, withholds those findings, and the visibility-narrowing kinds report only in files no manifest export reaches. Every other declaration has all its references in the loaded program and is `certain`, unless it is dead in a group with a published member, as the next section says.

## Groups that keep each other alive

Declarations that reference only each other, with no path from a root, are dead together. The report counts each group as one component with its deletable lines. `reporters.cascade` decides whether a rendering lists only the group's root members or every member. Every finding of a group carries the lowest confidence among the group's root members, so `analysis.min_confidence` reports or withholds a group whole.

## Explaining one declaration

`explain` answers why one declaration is reported, retained, held by an unanswered question, live or dead, from the same analysis the report is built from. For a live declaration it prints the shortest reference path from a root or a loaded consumer.

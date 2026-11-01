# How deadset-ts works

This page explains which projects deadset-ts loads, how it decides a declaration is live, and what it holds back from a report, for readers who want to judge a finding or tune the analysis.

## The projects it loads

A run opens one compiler session over the project entries of `analysis.configurations`, in the order it lists them. Each one names a compiler configuration file below the target, or a `package.json` whose directory's JavaScript files form one program. The platform entries the Go analyzer reads are left alone. When the array holds no project entry, the run takes every project it finds under the target, through the explicit scope, every `tsconfig*.json` and `jsconfig*.json` and each project's `references`. A `jsconfig.json` beside a `tsconfig.json` is not opened, as an editor does not open it. `print-projects` lists them.

A JavaScript file (`.js`, `.jsx`, `.mjs`, `.cjs`) that none of those projects lists joins a program the run forms for its package, the nearest directory above it that holds a `package.json`, or the target itself. The run leaves out files in `node_modules` or `.git`, files git ignores, test files a project joins, files below a project's `outDir` or `declarationDir`, files below a directory a convention row names as generated, and minified files. A minified file a program imports anyway is a generated file. An ignore file the run cannot read ignores nothing, and standard error names it. A `package.json` that does not parse, or that the run cannot read, still bounds its package: the run reads no dependency or entry point from it, counts it under `unanswered_questions` and names it on standard error, with the read's error for one it cannot read. The program reads its files unchecked. A package resolves its imports as a bundler does when a bundler's convention row applies to it or to the target. Otherwise it resolves them as Node does when its manifest names `main`, `exports`, `bin`, `type` or `engines.node`, or when one of its scripts runs a file with `node`, as the command reading below reads it. A file's extension and the manifest's `type` then decide whether the file is an ES module or a CommonJS one, as Node decides. Any other package resolves them as a bundler does. A workspace member's program is that member's source to the members that import it. A declared consumer with no compiler configuration loads its JavaScript files the same way, by its own manifests and convention rows, its workspace members read from source as the target's are.

The run reads a package's commands without running them: its scripts and nodemon's `exec`, and for the target's own package also its workflow steps, git hooks, hook manager commands and makefile recipes. Each command runs in the directory it is set to run in: a workflow step's or its job's `working-directory`, a lefthook command's `root`, or the one a `cd` or `pushd` before it in the same shell moves to. A workflow file and a hook manager file are read as YAML, anchors, aliases and flow mappings included, and a step's command and directory are the values YAML decodes, escapes and folded lines included. A file written with YAML the run does not read, such as a tag, or whose aliases would expand it past 100,000 nodes and characters, gives no command, and its whole text is searched as below. Where the run cannot tell which directory that is, as after a `cd` or `pushd` that may not have run, a `popd`, `source` or `eval`, or under a `working-directory` written with a `${{ }}` expression, it reads the command as text only, and so it does after an `exit` or an `exec`, which end the shell. It reads them in three layers.

- A shell parser (unbash, included in the package's source, see `THIRD_PARTY_NOTICES.md`) splits each command line into simple commands and their words. A word that holds a variable, a command substitution, arithmetic, a glob, a brace expansion or a leading `~` has no value the run knows, and a line that does not parse is not read at all. Each word of a line that parses also names a file in the directory the line starts in, even in a command the run does not read.
- A reader per tool reads the words of `node`, `tsx`, `ts-node`, `env`, `cross-env`, `npx`, `npm exec`, `npm x`, `npm run`, `pnpm exec`, `pnpm dlx`, `yarn node`, `yarn dlx` and `bunx`, with only the options the tool documents for choosing the file it runs, a file or package it preloads, or the command it hands on. Such a file is a root, and such a package is used. A path `--import` or a loader preloads is read as Node reads a module URL, so `%20` in it is a space. A command with any other option, or with a word of unknown value where the reader needs one, is not read. A command names a configuration file only by the option its tool documents for it: `-c` or `--config` of `eslint`, `stylelint`, `jest`, `vitest`, `vite` and `webpack`, `--config` of `prettier` and `mocha`, and `npx -c`. Another tool's option, such as `node -c`, names none.
- The whole text of every command is searched as well, whatever the first two layers read of it, so they only add roots and uses. So is the whole text of each workflow file, git hook, hook manager file and makefile, and of nodemon's configuration, so a file a part no command is read from names, such as a job's `env`, a makefile variable or a comment, is named too. A file of the package is named wherever its name, without the extension, appears in that text, whatever stands around it, and an `index` file is also named by its directory's name. A file named only by an extension, such as `.ts`, is named by that extension. So every way of writing a file's path, in its own letter case, names it, and a file no command runs may be named too. A named file and the names it exports are held as an unanswered question's declarations are, so nothing is reported about the file itself or those names, unless a root already enters the file with everything it exports. The rest of the file is reported as it would be if a root entered it with everything it exports: a declaration it neither exports nor uses, and an unused member of a class it exports. The report then carries one `unread-command` note for the package, naming the held files. A dependency whose name or command appears in that text is used. Since a command such as `eslint .` names the package's own directory, it holds the package's `index` file too.

A relative import or `require` (`./` or `../`) of a JavaScript file that resolves to no file is no failure, in a file `// @ts-check` checks too. It references nothing, and the report carries an `unresolved-specifier` note naming it. A load inside a `try` block, or one an `||` or `??` falls back from, notes nothing. A project whose JavaScript files import declared dependencies, none of which are installed, ends the run with `setup failure: missing-module`, because its program is not the one the project runs. A declared consumer whose JavaScript does so ends it with `setup failure: missing-consumer`.

A file whose extension `ts.component_extensions` lists is a component file, `.vue`, `.svelte` and `.astro` by default. Its `<script>` elements that start a line outside every other element are its blocks. So is a frontmatter block fenced by `---` lines at the start of the file. The blocks are analyzed as one module, in the strongest language any of them names, and an import of the file resolves to that module. A project that reads one workspace import as two files reads no component file, and standard error names it.

The markup of a component file is not parsed. Every binding a block declares or imports at the top level is kept while the file is live. A member whose name an expression or attribute of the markup writes is kept by the `template-field` exemption while the file is live. A `<script src>` element imports the file it names. A line-start `<script>` tag not read as a block is named on standard error, and the file is analyzed without it.

The run reads every project's diagnostics and fails closed for the projects you name. A project that `analysis.configurations` or the scope names and that does not load ends the run with exit code 3, its errors printed, then a `setup failure: no-program` line. A target that holds no compiler configuration and no JavaScript file ends the same way. A discovered project is dropped instead when it meets a setup failure or its configuration names no input, carries a refused option or is unreadable. The report names it in `configurations_not_built` with its error, standard error names it too, and the other projects are analyzed. Configuration is decoded against the Contract's closed key list, and `print-config` shows each setting with its source.

A target can sit in a workspace that `pnpm-workspace.yaml` or the `workspaces` field of a `package.json` declares. An import of another workspace package is then read from that package's TypeScript source, so a monorepo needs no build before a run.

A workspace package can have no file to read, such as a bundler's `dist/` that is not built yet. A discovered project that imports one is dropped, and its error names the package and the fix. When `analysis.configurations` names that project, the run ends with exit code 3 instead.

Every question the analysis asks the compiler is guarded. A question the compiler server fails on is answered as unknown. Every declaration that answer could have kept live is kept live and reported by nothing, as is every declaration only those keep live or whose own references went unanswered. Standard error counts the unanswered questions by project.

A declaration is reported only when it is dead in every project that holds it.

## How it finds references

The analysis takes an inventory of every declaration a project's own files hold, down to class and type members. It then resolves every reference over that inventory in one pass, through the compiler's type information rather than a text search. The pass resolves each file's identifiers in batches, and [Batch-cap calibration](batch-cap-calibration.md) is the measurement behind the batch size.

A test file that no discovered compiler configuration includes joins the nearest one at or above it, `tsconfig.json` first, and is analyzed with its options. It joins none when a `package.json` sits below that configuration's directory, in the test file's directory or one between them. Such a file belongs to another package. A test file with no such configuration, or outside every project `analysis.configurations` names, is still read for the modules it imports, without type information. A helper only such a test imports is then not reported as unused.

The same tree always gives the same report, and the analysis keeps no cache between runs.

## The roots

A root is a declaration the analysis keeps live without a reference. `print-roots` lists each one with the rule that made it a root. The roots are:

- What a file exports when the target's manifest, or another workspace package's manifest, names it through `main`, `module`, `types`, `browser`, `bin` or `exports`, or when `ts.entry_files` matches it. A `package.json` in a directory between the target and one of its compiler configurations counts here too. A build output it names, such as `dist/cli/main.js`, is read back to the rooted source file of the same name.
- A library target's published API, which includes an exported declaration whose documentation comment holds `@public`, `@beta` or `@alpha`. In an application, a workspace package whose `package.json` is not private has a published API too, reported at the confidence a library's carries.
- What a file exports when an applied convention row names it, such as a Next.js page, a SvelteKit route or a Storybook story
- A configuration file beside a `package.json` whose name is `<stem>.config.<ext>`, `<stem>.<qualifier>.config.<ext>` or `.<stem>rc.<ext>`, and a JSON file or module a script of it names by the configuration option of its tool, as above
- A file that a string names, read against the directory of such a configuration file or of its JSON form, like `<stem>.config.json` or `.<stem>rc`. A string that starts with `/` or holds a glob character names no file. Nor does a string at a key that only selects files, such as Stryker's `mutate` or Vitest's `test.coverage.include`.
- A file that a word of a `package.json` script names, such as `node ./scripts/seed.ts`, read against the directory the command runs in, and a file a script's `node`, `tsx` or `ts-node` runs or preloads, such as `./setup` in `node -r ./setup main.js`, with each extension tried
- What a file exports when a build script a `package.json` script runs names it as an entry of an `esbuild`, `webpack` or `rollup` build call the script runs, written as literals. In a library, such a file is published API too
- A file that a `run:` step of a workflow in `.github/workflows`, a git hook or a makefile recipe names or runs the same way, read against the directory the step runs in
- The test files, Vitest's workspace configuration and the setup and global setup files it names, and the test files in Playwright's test directory
- A global that a declaration file declares as `typeof import("<module>")["<name>"]`, which stands for that export, so using the global uses the export
- A worker or service worker that a call addresses by a string literal. A module URL, `new URL("./x.ts", import.meta.url)` or `import.meta.resolve("./x.ts")`, imports its file for its effects.
- A file that a script of an HTML file below the target loads, through the `src` attribute of a module or a classic script or an import in an inline module script. A `src` that names compiled output, such as `./app.js`, is read back to the source file that emits it.
- Every declaration a `roots.patterns` entry names

A string in such a configuration file that spells a dependency its `package.json` declares, alone or followed by a subpath, keeps that dependency from `DS1701`. So does a string in a module such a configuration file imports by a relative specifier. A data file it imports, such as `./package.json`, is not read for strings. Both kinds of module are read whether or not a compiler configuration includes the file.

A dependency is used where a command string of the `package.json` that declares it runs its command, or loads it through a preload option the command reading reads (`--loader`, `--import`, `--require` or `-r` of `node`, and the preloads of `tsx` and `ts-node`), or names it anywhere in its text, and so is one that a workflow `run:` step, a git hook or a recipe of the target runs or names. So is a package that `import.meta.resolve` or `require.resolve` names by a literal specifier. A declared dependency that the installed `package.json` of a needed dependency names in its `peerDependencies`, optional or not, is used too, and so on through the peers of that peer, because the declaration is what keeps the package the needed dependency expects beside it present.

`DS1701` also checks each workspace member's `package.json` once a built project holds a file below the member. It also checks each nested package's `package.json`, in a directory below the target at or above a source file or a compiler configuration. Each `package.json` is read against its own directory: an import keeps the dependency of that name in each `package.json` at or above the importing file, so a dependency a nested package declares and only a file outside it imports is reported there. A nested package's dependency that nothing installs is not checked. A dependency of a member whose source sits only in dropped configurations is reported at confidence `possible`.

A `roots.patterns` entry that names nothing is reported as `DS9004` and fails the run. Other entry-point conventions are not read, and the `DECLINED_CONVENTIONS` export lists each one with the reason.

A convention row holds the file-system conventions of one framework or tool. It applies when a `package.json` the analysis reads declares the row's package and the installed version is in the row's range. Its globs are matched below that manifest's directory. The report lists each applied row in `conventions_applied`, and `print-roots` names the row beside each file it roots. A package declared and not installed is the setup failure `missing-module` when `dependencies` or `devDependencies` declares it, and applies no row otherwise.

Some rows read a directory that the framework's configuration file moves, such as `srcDir` in `nuxt.config.ts`. The value is read from the default export, or from the options of the framework's Vite plugin, without running the file. The plugin may be imported or bound by a top-level `require`. A string literal or a template literal with no substitution moves the directory, and an unset property leaves the default.

Any other value is the setup failure `convention-not-literal`. So is an object on the way to the property that is not written out, that spreads another object in, or that computes a key from anything but a literal. Write the value as a literal, or name the row in `ts.disabled_conventions` and its files in `ts.entry_files`.

A row's glob, and a path a `package.json` key gives the `oclif` and `parcel` rows, may name the build output of a configuration with an `outDir`. It then roots the source file that output is compiled from.

The `angular` and `angular-devkit` rows also read `angular.json`. A package that a `builder`, `polyfills`, `styles` or `scripts` string there names counts as used.

| Row | Package | Versions | What it roots |
| --- | --- | --- | --- |
| `angular` | `@angular/build` | `>=17.0.0 <22.0.0` | `main`, `main.server`, `server`, `polyfills` and `test` below `src`, `server` at the root, the same below each `projects/*` directory, and each project's `src/public-api` |
| `angular-devkit` | `@angular-devkit/build-angular` | `>=12.0.0 <22.0.0` | The same files as `angular` |
| `astro` | `astro` | `>=5.0.0 <8.0.0` | Pages other than `_`-prefixed files and directories, middleware, actions and the content configuration below `src`, which `srcDir` moves |
| `babel` | `@babel/core` | `>=7.0.0 <9.0.0` | Nothing. `@babel/runtime` counts as used where a Babel configuration file lists `@babel/plugin-transform-runtime` in `plugins` |
| `docusaurus` | `@docusaurus/core` | `>=2.0.0 <4.0.0` | Every module below `src/pages` and `src/theme` |
| `eslint` | `eslint` | `>=4.0.0 <10.0.0` | Nothing. A plugin or shareable configuration that `plugins` or `extends` of `.eslintrc`, `.eslintrc.json`, `.eslintrc.js`, `.eslintrc.cjs`, `.eslintrc.yml` or `.eslintrc.yaml` names by its short name, such as `plugin:react/recommended` or `airbnb`, counts as used, and so does the package `parser` names |
| `eslint` | `eslint` | `>=10.0.0 <11.0.0` | Every `eslint.config.*` file |
| `expo` | `expo` | `>=44.0.0 <60.0.0` | The `index` and `App` modules beside the manifest |
| `expo-router` | `expo-router` | `>=3.0.0 <59.0.0` | Every module below `app` or `src/app` |
| `next` | `next` | `>=13.4.0 <17.0.0` | The App Router's special and metadata files, `pages`, and `proxy`, `middleware`, `instrumentation` and `mdx-components`, at the root or below `src` |
| `nuxt` | `nuxt` | `>=3.0.0 <5.0.0` | The app, error, app configuration and router options files, pages, layouts, middleware, plugins, modules and server routes, which `srcDir`, `serverDir` and `dir` move |
| `oclif` | `@oclif/core` | `>=1.0.0 <5.0.0` | Every module below `src/commands` and `src/hooks`, every module below the directory `oclif.commands` in `package.json` names, and each file `oclif.hooks` names |
| `panda` | `@pandacss/dev` | `>=0.1.0 <2.0.0` | Nothing. Every file below `styled-system`, which `outdir` in `panda.config.*` moves, is generated |
| `parcel` | `parcel` | `>=2.0.0 <3.0.0` | Each file `source` or `targets.*.source` in `package.json` names |
| `qwik-city` | `@builder.io/qwik-city` | `>=1.0.0 <2.0.0` | `root`, the `entry.*` files and the routes, which `srcDir` and `routesDir` move |
| `react-router` | `@react-router/dev` | `>=7.0.0 <9.0.0` | `root`, `routes`, `entry.client`, `entry.server` and the `routes` directory below `app`, which `appDirectory` moves |
| `react-scripts` | `react-scripts` | `>=1.0.0 <6.0.0` | `src/index`, `src/setupProxy.js` and `src/setupTests` |
| `remix` | `@remix-run/dev` | `>=2.0.0 <3.0.0` | The same files as `react-router`, which `appDirectory` moves |
| `rolldown` | `rolldown` | `>=1.0.0 <2.0.0` | Nothing. `@oxc-project/runtime` counts as used where `rolldown.config.*` sets `transform.helpers.mode` to `Runtime` |
| `solidstart` | `@solidjs/start` | `>=1.0.0 <3.0.0` | `app`, `entry-client`, `entry-server`, the middleware and the routes below `src`, which `appRoot` and `routeDir` move |
| `storybook` | `storybook` | `>=7.0.0 <11.0.0` | The `.storybook` configuration files and every `*.stories.*` file |
| `prettier` | `prettier` | `>=3.0.0 <4.0.0` | Every `prettier.config.*` and `.prettierrc.*` module. A package that the `prettier` key of the declaring `package.json` names counts as used |
| `stryker` | `@stryker-mutator/core` | `>=7.0.0 <11.0.0` | Every `stryker.conf.*` and `stryker.config.*` module, with or without a leading dot. The runner and checker packages `testRunner` and `checkers` name count as used |
| `sveltekit` | `@sveltejs/kit` | `>=2.0.0 <4.0.0` | Route files, hooks, params, the service worker and `instrumentation.server` below `src`, which the `files` options move |
| `swc` | `@swc/core` | `>=1.0.0 <2.0.0` | Nothing. `@swc/helpers` counts as used where `.swcrc` sets `jsc.externalHelpers` to `true` |
| `tanstack-router` | `@tanstack/router-plugin` | `>=1.0.0 <2.0.0` | Every module below `src/routes`, which `routesDirectory` moves |
| `vite` | `vite` | `>=8.0.0 <9.0.0` | Nothing. `@oxc-project/runtime` counts as used where `vite.config.*` sets `oxc.helpers.mode` to `Runtime` |
| `vitepress` | `vitepress` | `>=1.0.0 <2.0.0-0 \|\| >=2.0.0-alpha.0 <3.0.0` | The `.vitepress` configuration and theme entry, every `*.data.*` loader and every `.vue` component, which Markdown pages load |
| `vitest` | `vitest` | `>=3.2.0 <6.0.0` | Every `vitest.config.*` and `vite.config.*` file, with or without a qualifier |

## What an exemption holds back

An exemption holds a declaration back from the report when something the compiler cannot follow uses it. `print-retained` lists every declaration an exemption held back, with its position and its class, site and detail. Nine classes run on TypeScript:

| Class | What it holds back |
| --- | --- |
| `interface-satisfaction` | A member an interface requires of a class whose value reaches that interface, unless the member only implements interface methods nothing calls |
| `enum-group` | Every member of an enum whose value arrives by conversion, such as a number asserted to the enum type, rather than by a member's name |
| `decorator` | A decorated member, and every member of a decorated class |
| `injection-container` | A decorated property, and every parameter property, of a class a dependency-injection container constructs: one passed to a call `ts.injection_registrations` names, or one with a decorated constructor parameter |
| `framework-lifecycle` | A member a `ts.lifecycle_contracts` entry lists, on a class the entry's decorator, call or base class makes a component |
| `serialization-contract` | The properties of a class whose values reach `JSON.stringify` or a `ts.serializers` declaration, where the program writes or copies them or a decode fills them, such as `JSON.parse(text) as T` or an untyped value returned or assigned where the type is expected, and its `toJSON` and `toString` when a value reaches an `unknown` or `any` parameter outside the analysis |
| `generated-file` | Every declaration in a file whose leading comments mark it generated: `@generated`, `Code generated ... DO NOT EDIT.`, a notice that says it is generated and not to edit it, or a first line `// Generated by <tool>`. Also every declaration below a directory an applied convention row names as generated |
| `template-field` | A member that an action of a template under `analysis.template_dirs`, or a live component file's markup, names |
| `reflective-lookup` | A member that a literal key of an element access, or of `Reflect.get`, `Reflect.set` or `Reflect.has`, names |

`template-field` and `reflective-lookup` hold back at the lowest confidence, `possible`. The others hold back at `certain`. No class holds back a `#private` member. `exemptions.disabled` switches a class off.

## Libraries and their consumers

A library's published API has callers outside the target. A scope document passed with `--scope` names the consumers loaded beside it, each a directory whose compiler configurations open in the same session. A reference from a consumer keeps a target declaration live, and the report names every consumer it loaded. A consumer that is absent or does not load ends the run with exit code 3.

The published API is reported at confidence `certain` once every declared consumer loads, and `possible` when the scope declares none. In that second case the default `analysis.min_confidence`, `probable`, withholds those findings, and the too-visible kinds report only in files no manifest export reaches. Every other declaration is `certain`, unless it is dead in a group with a published member, as the next section says, or the paragraph below makes it `possible`. A file only tests reach is test-support code when it imports a test runner or a test library, or imports only devDependencies that only tests and the files only tests reach import. Test-support code is test code, which a test reference keeps live. A file only tests reach with no such import is production code, so a declaration of it that only tests reference is reported under `DS1102`. That finding is `possible`, and so is every finding that exists only because of it: the dead declarations it reaches, the tests of dead code that test only those, and the file itself. The file may be a test helper that imports no test library, which only its maintainer can tell, so the default withholds these findings. Each is withheld on its own, so a dead declaration that shares a dead callee with them keeps its own confidence. A declaration of the file that nothing references stays `certain`. A member whose name a production file tests with `in`, as in `"uploaded" in value`, is `possible`, because the value is read back by that name where no type links the read to the member. The default withholds those `possible` findings too.

## Groups that keep each other alive

Declarations that reference only each other, with no path from a root, are dead together. The report counts each group as one component with its deletable lines. `reporters.cascade` decides whether a rendering lists only the group's root members or every member. Every finding of a group carries the lowest confidence among the group's root members, so `analysis.min_confidence` reports or withholds a group whole. The one exception is the `possible` of production code only tests use, described above, which stays on its own findings.

Deleting an enum member moves the value of each later member with no initializer. A dead member that a live one follows that way carries fixability `manual` and deletes no line: give the next member an initializer holding its value instead. A dead member such a member names, or one before it, is held the same way. Dead members whose deletion moves only other dead members fall in one group.

## Explaining one declaration

`explain` answers why one declaration is reported, retained, held by an unanswered question, live or dead, from the same analysis the report is built from. For a live declaration it prints the shortest reference path from a root or a loaded consumer.

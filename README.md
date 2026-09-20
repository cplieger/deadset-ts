# deadset-ts

[![npm](https://img.shields.io/npm/v/@cplieger/deadset-ts)](https://www.npmjs.com/package/@cplieger/deadset-ts) [![JSR](https://jsr.io/badges/@cplieger/deadset-ts)](https://jsr.io/@cplieger/deadset-ts)

> Deterministic dead-code analysis for TypeScript, class and type members included.

deadset-ts is a command-line analyzer for TypeScript and JavaScript projects. It builds the program from your `tsconfig.json` files through the TypeScript 7 compiler API, resolves every reference in one pass, and reports the declarations nothing reaches: unused exports, type-only exports without a consumer, unused class members (private, protected, static and accessors), unused interface, type-alias, enum and namespace members, exports that can be narrowed to a smaller visibility, and whole groups of declarations that only keep each other alive. Every finding carries an issue code, a confidence and a stable symbol reference from the [deadset Contract](https://github.com/cplieger/deadset-spec), so the same report shape works for a Go analyzer and for a merged multi-language report. The analysis is deterministic: the same tree gives the same report, with no cache and no text search.

deadset-ts is report-only. It never edits source, and it refuses any `--fix` flag.

**Status: pre-release.** This version implements contract 1.7.0 and ships the analyzer's foundation: one compiler session per run over every `tsconfig` project discovered under the target (the explicit scope, every `tsconfig*.json`, each project's `references`), a fail-closed read of every project's diagnostics, configuration decoding against the contract's closed key list with `print-config` and its provenance, `print-projects`, the report-only guard, the symbol inventory of every declaration a project's own files hold down to its class and type members, and the one-pass reference resolution over that inventory. The inventory and the reference pass are library functions the package exports; no verb reports findings yet, so `analyze`, `explain`, `print-roots`, `print-retained` and `describe` exit with a usage message. The one runtime dependency is the `typescript` package at exactly 7.0.2, installed under the `@typescript/native` name until TypeScript 7.1 ships a compiler API the tooling can share.

## Install

```sh
npm i -D @cplieger/deadset-ts
# or
npx jsr add -D @cplieger/deadset-ts
# or run the command without installing it
npx @cplieger/deadset-ts version
```

The npm package carries the command and the library as JavaScript that the compiler emits at publish, so `npx deadset-ts` and `import("@cplieger/deadset-ts")` both run on plain Node.js 24 or later, with no loader and no flag. It carries the TypeScript source as well, which is what a TypeScript consumer's own compiler resolves. That consumer sets `allowImportingTsExtensions`, because the source names each import with its `.ts` extension. The JSR package ships source only, and Deno compiles it.

## Usage

```sh
npx deadset-ts version
```

`version` prints the analyzer version and the Contract version it implements, and exits 0. Any other invocation, including no arguments, prints the usage line and exits 2.

| Verb             | Job                                                                             |
| ---------------- | ------------------------------------------------------------------------------- |
| `analyze`        | Analyze a project and print the findings                                        |
| `explain`        | Explain one finding: the relation, the roots and the references that decided it |
| `print-config`   | Print the resolved configuration and where each setting came from               |
| `print-roots`    | Print the resolved set of entry points                                          |
| `print-retained` | Print every symbol an exemption class held back, with the class                 |
| `describe`       | Describe the analyzer: version, Contract version, supported issue kinds         |
| `version`        | Print the analyzer and Contract versions                                        |

## Requirements

- Node.js 24 or later. The npm command is JavaScript the compiler emits at publish, so it runs with no loader and no flag; a clone of this repository runs the same command from its TypeScript sources through Node's own type stripping, which is what needs the version.
- TypeScript 7. The analyzer is written against the `typescript` package at exactly version 7.0.2 and its `unstable/*` API. It does not run on TypeScript 6, whose compiler API TypeScript 7 removed, and it does not fall back to it.
- Linux. Other platforms are untested.

## API

The package exports the command line and the analyzer's own stages, for callers that embed them. Every one of them reads the platform through a `Host`: the filesystem, the directory relative paths resolve against, and the version of the package the analyzer was installed from. `bin/node-host.ts` is the Node one the command line binds; a caller embedding the analyzer, or running it on another platform, supplies its own and supplies its own version with it.

The command line:

- `run(args, out, err, host, openClient?)`: runs the command line over `args` (the arguments after the program name), writing to the two `Writer` streams, and returns the exit code. It never exits the process.
- `SETTING_OPTIONS`: the configuration setting each command-line option supplies, by option name.
- `Writer`: `{ write(text: string): void }`. `process.stdout` and `process.stderr` satisfy it.

The platform:

- `Host`: the filesystem a run reads, the directory it reads relative paths against, and the analyzer's own version.
- `DirectoryEntry`, `PathKind`: one entry of a directory read, and what one path names.

The symbol inventory:

- `inventory(project, host, targetRoot)`: every declaration one project's own files hold, in position order, down to class and type members.
- `nodeKey(file, node)`: the key one declaration is recorded under.
- `Inventory`, `InventorySymbol`, `InventoryCost`, `SymbolKind`, `Visibility`: one project's inventory, one declaration of it, what reading it cost, and the two vocabularies a declaration is described by.

The reference pass:

- `references(project, held, targetRoot, options)`: every reference from one project's own files to a declaration of its inventory, in position order, with the rules that classified files as test files.
- `DEFAULT_BATCH_CAP`: the batch size a run takes when the configuration names none.
- `Reference`, `References`, `ReferenceOptions`, `ReferenceCost`, `TestFileRule`, `Resolution`, `Use`: one reference, one project's set of them, how a run resolves them, what that cost, one test-file rule, which accessor answered a reference, and whether it reads or writes.

Positions:

- `renderPosition(file, root, offset)`: one compiler offset as a path, a line and a column, the column counting UTF-16 code units.
- `positionKey(position)`, `byPosition(a, b)`: the string one position is keyed by, and the order positions are reported in.
- `PositionError`: the refusal for a position that cannot be rendered against the target root.
- `Position`: one rendered position.

Stable symbol references:

- `renderRef(module, fragment)`: one symbol's stable reference, in the canonical spelling the contract's grammar fixes.
- `nameComponent(name)`, `computedComponent(text)`: the canonical spelling of one component of that reference, from a declared name or from a computed key.
- `isRef(value)`: whether one string is a reference of this language's grammar.
- `REF_EXPRESSIONS`: one regular expression per form the grammar defines.
- `Module`, `Component`, `Fragment`, `DependencySection`: the module half of a reference, one component of its fragment, what the fragment names, and the manifest section a dependency was declared in.

Versions:

- `CONTRACT_VERSION`: the contract version this analyzer implements.

## Contributing

See [CONTRIBUTING.md](https://github.com/cplieger/.github/blob/main/CONTRIBUTING.md).

## Disclaimer

This project is built with care and follows security best practices, but it is intended for personal / self-hosted use. No guarantees of fitness for production environments. Use at your own risk.

This project was built with AI-assisted tooling using [Claude](https://claude.com), [GPT](https://openai.com), and [Kiro](https://kiro.dev). The human maintainer defines architecture, supervises implementation, and makes all final decisions.

## License

GPL-3.0-or-later. See [LICENSE](LICENSE).

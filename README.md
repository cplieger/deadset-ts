# deadset-ts

[![npm](https://img.shields.io/npm/v/@cplieger/deadset-ts)](https://www.npmjs.com/package/@cplieger/deadset-ts)
[![JSR](https://jsr.io/badges/@cplieger/deadset-ts)](https://jsr.io/@cplieger/deadset-ts)

> Deterministic dead-code analysis for TypeScript, class and type members included.

deadset-ts is a command-line analyzer for TypeScript and JavaScript projects. It builds the program from your `tsconfig.json` files through the TypeScript 7 compiler API, resolves every reference in one pass, and reports the declarations nothing reaches: unused exports, type-only exports without a consumer, unused class members (private, protected, static and accessors), unused interface, type-alias, enum and namespace members, exports that can be narrowed to a smaller visibility, and whole groups of declarations that only keep each other alive. Every finding carries an issue code, a confidence and a stable symbol reference from the [deadset Contract](https://github.com/cplieger/deadset-spec), so the same report shape works for a Go analyzer and for a merged multi-language report. The analysis is deterministic: the same tree gives the same report, with no cache and no text search.

deadset-ts is report-only. It never edits source, and it refuses any `--fix` flag.

**Status: pre-release.** This version implements Contract 0.1.0 and ships the command-line skeleton only: `version` runs, the other verbs are reserved and exit with a usage message. One runtime dependency is planned, the `typescript` package at one exact version; the skeleton has none.

## Install

```sh
npm i -D @cplieger/deadset-ts
# or
npx jsr add -D @cplieger/deadset-ts
```

The package ships TypeScript source, not compiled JavaScript: the `deadset-ts` command is a `.ts` file that Node.js 24 or later runs directly through its built-in type stripping, and the exported API is imported as source by the consumer's own compiler. There is no build step on either side.

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

- Node.js 24 or later, for the type stripping that runs the shipped source.
- TypeScript 7. The analyzer is written against the `typescript` package at exactly version 7.0.2 and its `unstable/*` API. It does not run on TypeScript 6, whose compiler API TypeScript 7 removed, and it does not fall back to it.
- Linux. Other platforms are untested.

## API

The package also exports the command line as a function, for callers that embed it:

- `run(args, out, err)`: runs the command line over `args` (the arguments after the program name), writing to the two `Writer` streams, and returns the exit code. It never exits the process.
- `Writer`: `{ write(text: string): void }`. `process.stdout` and `process.stderr` satisfy it.

## Contributing

See [CONTRIBUTING.md](https://github.com/cplieger/.github/blob/main/CONTRIBUTING.md).

## Disclaimer

This project is built with care and follows security best practices, but it is intended for personal / self-hosted use. No guarantees of fitness for production environments. Use at your own risk.

This project was built with AI-assisted tooling using [Claude](https://claude.com), [GPT](https://openai.com), and [Kiro](https://kiro.dev). The human maintainer defines architecture, supervises implementation, and makes all final decisions.

## License

GPL-3.0-or-later. See [LICENSE](LICENSE).

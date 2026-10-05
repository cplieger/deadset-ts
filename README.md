# deadset-ts

[![npm](https://img.shields.io/npm/v/@cplieger/deadset-ts)](https://www.npmjs.com/package/@cplieger/deadset-ts) [![JSR](https://jsr.io/badges/@cplieger/deadset-ts)](https://jsr.io/@cplieger/deadset-ts)

deadset-ts finds dead code in TypeScript projects, down to class members, type members and dead stores inside functions, and writes a report your CI can fail on.

It reads your `tsconfig.json` projects, `allowJs` JavaScript and Vue, Svelte and Astro scripts included, with the type information of TypeScript 7.1.0-dev.20261003.1, its one dependency. Your project keeps its own TypeScript version. A type error under that version skips the function or statement that holds it. deadset-ts reports and never edits your code. It is pre-release, tested only on Linux, needs Node.js 24 or later and is licensed under GPL-3.0-or-later.

## Why use it

deadset-ts is built for a CI gate on dead code. Each finding names code to delete, an `export` to drop or a setting to fix.

- It reports unused exports, files and dependencies, and unused members of classes, interfaces, type aliases, enums and namespaces, private and static included.
- Inside a function, it reports unused parameters and results, unreachable statements and cases, and dead stores.
- It reports an `export` only its own file uses, and declarations that only reference each other.
- It keeps what decorators, reflective lookups, `JSON.stringify` and the frameworks, containers, serializers and templates you name in `deadset.json` use.
- The same tree gives the same report, and a baseline keyed on code and symbol survives moved lines.
- It writes text, JSON, GitHub annotations, SARIF 2.1.0 or a custom template.

Consider [Knip](https://knip.dev) if you want issues fixed with `--fix`, plugins for over 100 tools, or MDX files checked.

## Install

```sh
npm i -D @cplieger/deadset-ts
# or
npx jsr add -D @cplieger/deadset-ts
# or run the command without installing it
npx @cplieger/deadset-ts version
```

## Usage

Create a `deadset.json` at the project root that says whether the project is an `application` or a `library`, then run `analyze`. A run reads every `tsconfig` project under that folder, project references included, and reports a declaration only when it is dead in all of them.

```sh
echo '{ "target": { "kind": "application" } }' > deadset.json
npx @cplieger/deadset-ts analyze --report=deadset-report.json
```

`analyze` writes the JSON report to `deadset-report.json` and a text rendering beside it as `deadset-report.json.txt`. Take this `src/greet.ts`, where the rest of the project calls only `greet` and `Counter.increment`:

```ts
export function greet(name: string): string {
  return `hello ${name}`;
}
export function farewell(name: string): string {
  return `bye ${name}`;
}
export class Counter {
  private count = 0;
  increment(): void {
    this.count += 1;
  }
  reset(): void {
    this.count = 0;
  }
}
```

The text rendering lists three findings:

```text
src/greet.ts:4:17: function farewell: exported function has no reference in the target and none from any loaded consumer [certain] (DS1001)
src/greet.ts:8:11: class-member Counter.count: member Counter.count is written at 2 positions and never read [certain] (DS1301)
src/greet.ts:12:3: method Counter.reset: method has no reference in the target [certain] (DS1003)
summary: 3 findings (0 allow, 0 warn, 3 deny), 6 deletable lines, 0 suppressions in effect, 0 reasons recorded, 0 stale suppressions, 0 pending, 0 omitted
```

The run exits 1 because the report holds a finding at `deny` severity, and 0 when it holds none. Three common next steps:

- Add `--format=sarif` or `--format=github` for a SARIF file or GitHub workflow annotations. Naming any format turns off the default text rendering, so add `--format=text` as well to keep it.
- Run `npx @cplieger/deadset-ts explain --why=farewell` to see why one declaration is reported, retained, held by an unanswered question, live or dead.
- Add `--baseline-write=deadset-baseline.json` to record today's findings. Later runs fail on a new finding and on a baseline row whose finding has gone. To keep one declaration, put `// deadset:ignore DS1001 -- <reason>` on the line above it.

[Commands and exit codes](docs/commands.md) covers every verb and option, and [Configuration](docs/configuration.md) covers every setting.

## API

The package exports the command line as a function, and the helpers that spell the positions and symbol references in a report.

- `run` runs the command line and returns its exit code, without exiting the process. `Writer` is its output stream, and `SETTING_OPTIONS` maps each option to the setting it sets.
- `Host`, `DirectoryEntry` and `PathKind` describe the filesystem, working directory and version a run reads.
- `renderPosition`, `positionKey`, `byPosition`, `PositionError` and `Position` render and order positions.
- `renderRef`, `nameComponent`, `computedComponent`, `isRef`, `REF_EXPRESSIONS`, `Module`, `Component`, `Fragment` and `DependencySection` spell stable symbol references.
- `DECLINED_CONVENTIONS` and `DeclinedConvention` list the entry-point conventions of other tools the analysis does not read.
- `CONTRACT_VERSION` is the version of the [deadset Contract](https://github.com/cplieger/deadset-spec) this analyzer implements.

A TypeScript caller that imports the source sets `allowImportingTsExtensions`, because each import in it ends in `.ts`. [Using deadset-ts as a library](docs/library.md) covers the packages and in-process runs, and [JSR](https://jsr.io/@cplieger/deadset-ts/doc) has the full reference.

## Related projects

deadset-ts implements the [deadset Contract](https://github.com/cplieger/deadset-spec), which fixes the issue codes, the report schema and the exit codes. It passes every fixture of the Contract's conformance corpus.

- [deadset-go](https://github.com/cplieger/deadset-go) is the same analysis for Go modules.
- [deadset](https://github.com/cplieger/deadset) runs both analyzers as one command and merges their reports, resolving the edges between Go and TypeScript code.

## Documentation

- [Commands and exit codes](docs/commands.md) lists every verb, option, rendering and exit code.
- [Configuration](docs/configuration.md) lists every setting, the suppression files and the scope document.
- [How deadset-ts works](docs/how-it-works.md) explains the projects it loads, the roots it starts from and what it holds back.
- [Using deadset-ts as a library](docs/library.md) covers the npm and JSR packages and running the analyzer in-process.
- [Batch-cap calibration](docs/batch-cap-calibration.md) is the measurement behind the batch size of the reference pass.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Disclaimer

This project is built with care and follows security best practices, but it is intended for personal / self-hosted use. No guarantees of fitness for production environments. Use at your own risk.

This project was built with AI-assisted tooling using [Claude](https://claude.com), [GPT](https://openai.com), and [Kiro](https://kiro.dev). The human maintainer defines architecture, supervises implementation, and makes all final decisions.

## License

GPL-3.0-or-later. See [LICENSE](LICENSE).

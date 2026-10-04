# Configuration

This page lists where deadset-ts reads its settings, every setting it reads, the suppression files and the scope document, for readers who want more than the one setting the README example writes.

## Where settings live

deadset-ts reads up to three JSON documents. A command-line option wins over `deadset.json` at the target root, which wins over a central configuration that `--central=FILE` names. `--config=FILE` reads another file in place of `deadset.json`. A key the Contract does not declare, or a value of the wrong type, is refused with exit code 2. So is an `exemptions.disabled` entry that names no exemption class, and an `analysis.template_dirs` entry that is not a directory below the target.

`print-config` prints the resolved configuration and the source of each setting.

`target.kind` is the one required setting, and it has no default. Write `application` when every caller is inside the analyzed projects, and `library` when the published API has callers outside them.

```json
{ "target": { "kind": "library" } }
```

## Every setting

| Key                            | Default                                                                               | Description                                                                                                                                              |
| ------------------------------ | ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `target.kind`                  | required                                                                              | `application` or `library`                                                                                                                               |
| `contract_version`             | `5.1.0`                                                                               | The Contract version the file is written against                                                                                                         |
| `analysis.configurations`      | `[]`                                                                                  | Entries shaped `{id, project}`, each naming a `tsconfig`. With none, every `tsconfig` project under the target. Platform entries are for the Go analyzer |
| `analysis.matrix.complete`     | `false`                                                                               | Declares that `configurations` lists every build, so a file no configuration builds is reported as `DS1501`                                              |
| `analysis.min_confidence`      | `probable`                                                                            | The lowest confidence reported: `certain`, `probable` or `possible`                                                                                      |
| `analysis.consumer_tests`      | `test`                                                                                | How a reference from a consumer's test file counts: `test` or `production`                                                                               |
| `analysis.template_dirs`       | `[]`                                                                                  | Directories below the target whose templates the `template-field` exemption reads for member names                                                       |
| `analysis.template_delimiters` | `{{` and `}}`                                                                         | The action delimiters those templates use, as `left` and `right`                                                                                         |
| `consumers.complete`           | `false`                                                                               | Declares that the scope document lists every consumer of a library's published API                                                                       |
| `roots.patterns`               | `[]`                                                                                  | Symbol references, or patterns over them, kept live without a reference. An entry that matches nothing is `DS1704` and fails the run                     |
| `severity`                     | `{}`                                                                                  | A severity per code (`DS1101`) or family (`DS18`): `allow`, `warn` or `deny`                                                                             |
| `exemptions.disabled`          | `[]`                                                                                  | Exemption classes switched off, to test whether one hides a defect                                                                                       |
| `reporters.formats`            | `["text"]`                                                                            | The renderings `analyze` writes beside the report                                                                                                        |
| `reporters.sort`               | `position`                                                                            | `position` for path, line and column order, or `size` for deletable lines                                                                                |
| `reporters.cascade`            | `roots`                                                                               | `roots` lists the root members of a dead group with a count, `full` lists every member                                                                   |
| `reporters.max_findings`       | `0`                                                                                   | The most findings a rendering prints. `0` prints every finding                                                                                           |
| `reporters.fail_on`            | `deny`                                                                                | The lowest severity that fails the run: `allow`, `warn` or `deny`                                                                                        |
| `ts.test_files`                | `["**/*.test.{ts,tsx,mts,cts}", "**/*.spec.*", "**/__tests__/**", "**/__mocks__/**"]` | Globs naming the test files                                                                                                                              |
| `ts.entry_files`               | `[]`                                                                                  | Globs naming files whose exports are roots, beside the entry points the manifest names                                                                   |
| `ts.injection_registrations`   | `[]`                                                                                  | Declarations whose call registers a class with a dependency-injection container                                                                          |
| `ts.lifecycle_contracts`       | `[]`                                                                                  | Per framework, the decorators, calls or base classes that make a component, and the members the framework calls                                          |
| `ts.serializers`               | `[]`                                                                                  | Declarations whose call reads its arguments' data members by name, such as a schema validator's `parse`                                                  |

`analysis.languages`, `analysis.generated_files`, `providers` and `go` are accepted and printed, and deadset-ts reads nothing else from them. The [deadset](https://github.com/cplieger/deadset) command and the Go analyzer read them.

The Contract's [configuration schema](https://github.com/cplieger/deadset-spec) defines every key in full.

## Suppressions and the baseline

Three mechanisms keep a finding out of a run. Each one needs a reason.

- An inline directive on the line above the declaration: `// deadset:ignore DS1001 -- kept for the next release`. Several codes are written `DS1001,DS1003`. A directive with no reason is reported as `DS1701`.
- `deadset-ignore.json` at the target root, whose `ignore` array a maintainer writes. Each entry names `code`, `symbol`, `path` and `reason`. An entry that names no path is reported as `DS1702`.
- `deadset-baseline.json` at the target root, whose `baseline` rows `analyze --baseline-write` writes. A row has the same four members, so it moves into the ignore file by gaining a maintainer's reason.

```json
{
  "ignore": [
    {
      "code": "DS1003",
      "symbol": "ts://demo/src/greet.ts#Counter.reset",
      "path": "src/greet.ts",
      "reason": "called by a plugin loaded at run time"
    }
  ]
}
```

A suppression that matches nothing is stale. It is reported as `DS1703` and fails the run with exit code 1, so a suppression is removed when the code it covered goes.

## The scope document

A library's published API has callers outside the target. `--scope=FILE` names a JSON document that lists them, so their references keep target declarations live. `target.path` is required, and each entry of `consumers` names a `path`. Both paths are absolute or relative to the directory that holds the document.

```json
{
  "target": { "path": "." },
  "consumers": [{ "path": "../my-app" }]
}
```

Each consumer's compiler configurations open in the same session as the target's, and the report names every consumer it loaded. A consumer that is absent or does not load ends the run with exit code 3. [How deadset-ts works](how-it-works.md#libraries-and-their-consumers) explains how consumers change the confidence of a finding.

## Cross-language edges

`deadset-edges.json` at the target root declares edges between a TypeScript declaration and a declaration in another language, such as a generated client type and the Go server type it stands for. Each edge names `id`, `provides` and `used_by`, and an optional `because`. deadset-ts never decides the other side. When the TypeScript side of an edge is dead, its finding is pending, and the run exits 4 until the [deadset](https://github.com/cplieger/deadset) merge reads both sides.

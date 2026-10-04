# How deadset-ts works

This page explains which projects deadset-ts loads, how it decides a declaration is live, and what it holds back from a report, for readers who want to judge a finding or tune the analysis.

## The projects it loads

A run opens one compiler session over the project entries of `analysis.configurations`, in the order it lists them. Each one names a compiler configuration file below the target, and the platform entries the Go analyzer reads are left alone. When the array holds no project entry, the run takes every `tsconfig` project it finds under the target, through the explicit scope, every `tsconfig*.json` and each project's `references`. `print-projects` lists them.

JavaScript files are analyzed too, in a project that sets `allowJs`.

The run reads every project's diagnostics and fails closed for the projects you name. A project that `analysis.configurations` or the scope names and that does not load ends the run with exit code 3. A discovered project whose configuration names no input, carries an option the compiler refuses or cannot be read is dropped instead. The report names it in `configurations_not_built` with its error, standard error names it too, and the other projects are analyzed. Configuration is decoded against the Contract's closed key list, and `print-config` shows each setting with its source.

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
- The configuration, setup and test files of Vitest, Stryker and Playwright, and the flat configuration of ESLint
- A worker or service worker that a call addresses by a string literal
- Every declaration a `roots.patterns` entry names

A `roots.patterns` entry that names nothing is reported as `DS1704` and fails the run. The entry-point conventions of other tools are not read, and the `DECLINED_CONVENTIONS` export lists each one with the reason.

## What an exemption holds back

An exemption holds a declaration back from the report when something the compiler cannot follow uses it. `print-retained` lists every declaration an exemption held back, with its class, site and detail. Eight classes run on TypeScript:

| Class                    | What it holds back                                                                                                                                                                                         |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `interface-satisfaction` | A member an interface requires of a class whose value reaches that interface                                                                                                                               |
| `enum-group`             | Every member of an enum whose value arrives by conversion, such as a number asserted to the enum type, rather than by a member's name                                                                      |
| `decorator`              | A decorated member, and every member of a decorated class                                                                                                                                                  |
| `injection-container`    | A decorated property of a class a dependency-injection container constructs: one passed to a call `ts.injection_registrations` names, or one with a decorated constructor parameter                        |
| `framework-lifecycle`    | A member a `ts.lifecycle_contracts` entry lists, on a class the entry's decorator, call or base class makes a component                                                                                    |
| `serialization-contract` | The properties of a class whose values reach `JSON.stringify` or a `ts.serializers` declaration, and its `toJSON` and `toString` when a value reaches an `unknown` or `any` parameter outside the analysis |
| `template-field`         | A member that an action of a template under `analysis.template_dirs` names                                                                                                                                 |
| `reflective-lookup`      | A member that a literal key of an element access, or of `Reflect.get`, `Reflect.set` or `Reflect.has`, names                                                                                               |

`template-field` and `reflective-lookup` hold back at the lowest confidence, `possible`. The others hold back at `certain`. No class holds back a `#private` member. `exemptions.disabled` switches a class off.

## Libraries and their consumers

A library's published API has callers outside the target. A scope document passed with `--scope` names the consumers loaded beside it, each a directory whose compiler configurations open in the same session. A reference from a consumer keeps a target declaration live, and the report names every consumer it loaded. A consumer that is absent or does not load ends the run with exit code 3.

The published API is reported at confidence `certain` once every declared consumer loads, and `possible` when the scope declares none. In that second case, `DS1001` defaults to `allow` and the visibility-narrowing kinds report only in files no manifest export reaches. Every other declaration has all its references in the loaded program and is `certain`.

## Groups that keep each other alive

Declarations that reference only each other, with no path from a root, are dead together. The report counts each group as one component with its deletable lines. `reporters.cascade` decides whether a rendering lists only the group's root members or every member.

## Explaining one declaration

`explain` answers why one declaration is reported, retained, held by an unanswered question, live or dead, from the same analysis the report is built from. For a live declaration it prints the shortest reference path from a root or a loaded consumer.

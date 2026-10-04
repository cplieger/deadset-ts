# Commands and exit codes

This page lists every verb of the `deadset-ts` command, the options each one takes and the exit codes it returns, for readers who run it in CI or a script.

## Verbs

| Verb             | Job                                                                                |
| ---------------- | ---------------------------------------------------------------------------------- |
| `analyze`        | Analyze a project and write the report, its renderings and a baseline              |
| `explain`        | Explain one declaration: the relation, the roots and the references that decide it |
| `print-config`   | Print the resolved configuration and where each setting came from                  |
| `print-projects` | Print the identifier of every project a run analyzes                               |
| `print-roots`    | Print every declaration the analysis keeps live without a reference, and why       |
| `print-retained` | Print every declaration an exemption held back: each class, its site and detail    |
| `describe`       | Describe the analyzer: versions, accepted report schemas, languages, conformance   |
| `version`        | Print the analyzer and Contract versions                                           |

Any other invocation, and no arguments at all, prints the usage line and exits 2. deadset-ts reports and never edits a source file. An option whose name contains `fix`, `edit`, `delete` or `rewrite` is refused with exit code 2 before anything runs.

## Options every verb takes

Each option is written `--name=value`.

| Option             | Description                                                             | Default                 |
| ------------------ | ----------------------------------------------------------------------- | ----------------------- |
| `--target`         | The directory to analyze                                                | `.`                     |
| `--config`         | The configuration file to read in place of `deadset.json` at the target | `<target>/deadset.json` |
| `--central`        | A central configuration, read beneath the repository one                | _(unset)_               |
| `--scope`          | A scope document naming the target and the consumers loaded beside it   | _(unset)_               |
| `--min-confidence` | Sets `analysis.min_confidence`                                          | from the configuration  |
| `--sort`           | Sets `reporters.sort`                                                   | from the configuration  |
| `--cascade`        | Sets `reporters.cascade`                                                | from the configuration  |
| `--max-findings`   | Sets `reporters.max_findings`                                           | from the configuration  |
| `--fail-on`        | Sets `reporters.fail_on`                                                | from the configuration  |

An option that sets a setting wins over `deadset.json`, which wins over the central configuration. [Configuration](configuration.md) describes each setting.

## analyze

`analyze --report=PATH` writes the JSON report to `PATH` through a temporary file renamed into place, so a run that stops partway leaves no truncated report. It writes nothing to standard output. Diagnostics go to standard error, and the verdict is the exit code.

Each rendering is written beside the report, at `PATH` with the format's suffix appended:

| Format     | Suffix         | Content                                                        |
| ---------- | -------------- | -------------------------------------------------------------- |
| `text`     | `.txt`         | One finding per line, position first, then a summary line      |
| `json`     | `.json`        | The report document                                            |
| `github`   | `.annotations` | One GitHub workflow command per finding                        |
| `sarif`    | `.sarif`       | A SARIF 2.1.0 log                                              |
| `template` | `.tmpl`        | The template `--template=FILE` names, rendered over the report |

`--format` is repeatable. The formats you name replace `reporters.formats`, which is `text` by default, and a format named twice is refused with exit code 2.

A template is written in a subset of Go's `text/template` action grammar over the report's JSON member names. It supports text, comments, trim markers, pipelines, variables, `if`, `else if`, `with`, and `range` with `break` and `continue`. Its functions are `and`, `or`, `not`, `len`, `index`, `eq`, `ne`, `lt`, `le`, `gt`, `ge`, `print`, `printf` and `println`. Any other function, `define`, `template` and `block` are refused when the template is read, which ends the run with exit code 2 before any analysis.

`--baseline-write=FILE` also writes a baseline of every finding to `FILE`. A run reads `deadset-baseline.json` at the target root, so write the baseline under that name. The run fails on a finding the baseline does not hold, and on a baseline row that matches no current finding.

`--exit-code=off` exits 0 whatever the verdict and names the verdict on standard error.

The report names the target relative to the directory the run is invoked from. Run it from the target or a directory above it, because a target outside that directory fails with exit code 3.

## explain

`explain --why=SYM` prints why one declaration is reported, retained, held by an unanswered question, live or dead. `--why-live=SYM` and `--why-not=SYM` are the same request. For a live declaration it prints the shortest reference path from a root or a loaded consumer, and it exits 0.

`SYM` is a stable symbol reference such as `ts://demo/src/greet.ts#Counter.reset`, the part after its `#`, or a declaration's name, each matched exactly. A request that names no single declaration exits 2 and lists up to 20 declarations it partially matches.

## The print verbs, describe and version

`print-config`, `print-projects`, `print-roots` and `print-retained` print what their row of the verb table says and exit 0. The last three read the projects as `analyze` does, so a setup failure or a named project that does not load ends them with exit code 3. `print-roots` exits 1 when it reports a `DS1704`, a `roots.patterns` entry that matches nothing.

`describe` writes its JSON document to standard output and exits 0. It names the analyzer and Contract versions, the report schema versions it accepts, its language and its result over the Contract's conformance corpus. The gaps that result allows for are listed in [`conformance.json`](../conformance.json).

`version` prints the analyzer version and the Contract version it implements, and exits 0.

## Exit codes

| Code | Meaning                                                                                                                                            |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | No finding at or above `reporters.fail_on`, no stale suppression and no pending finding. Under `--exit-code=off`, every run with a verdict exits 0 |
| 1    | The report holds a finding at or above `reporters.fail_on`, which is `deny` by default, or a stale suppression                                     |
| 2    | A usage error: a malformed invocation, a refused setting, no `target.kind`, an unreadable or unparsable template, or a request to edit source      |
| 3    | A failure: a named project or a consumer that does not load, a setup failure, a target the report cannot name, or an unwritable rendering          |
| 4    | The report holds a pending finding, one a declared cross-language edge holds until a merge resolves it                                             |

Codes 2 and 3 end a run before any verdict exists, and no finding list is printed. When a rendering cannot be written, the report itself is already written. When more than one verdict holds, the highest code wins, so 4 outranks 1 and 1 outranks 0.

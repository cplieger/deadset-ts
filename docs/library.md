# Using deadset-ts as a library

This page covers what the npm and JSR packages carry, the TypeScript dependency, and running the analyzer in-process, for developers who import `@cplieger/deadset-ts` rather than run its command.

## What the packages carry

The npm package carries the command and the library as JavaScript that the compiler emits at publish. So `npx deadset-ts` and `import("@cplieger/deadset-ts")` both run on plain Node.js 24 or later, with no loader and no flag.

It carries the TypeScript source as well, which is what a TypeScript consumer's own compiler resolves. That consumer sets `allowImportingTsExtensions`, because the source names each import with its `.ts` extension.

The JSR package ships the TypeScript source only.

## The TypeScript dependency

The one runtime dependency is the `typescript` package at exactly 7.1.0-dev.20261003.1, installed under the `@typescript/native` name. The analyzer is written against its `unstable/*` API. It does not run on TypeScript 6, whose compiler API TypeScript 7 removed, and it does not fall back to it.

The projects you analyze need no TypeScript install of their own. deadset-ts type-checks them with its own TypeScript 7.1.0-dev.20261003.1, so a project must compile cleanly under that version.

## Running the analyzer in-process

`run(args, out, err, host, openClient?)` runs the command line over `args`, the arguments after the program name. It writes to the two `Writer` streams and returns the exit code. It never exits the process. `process.stdout` and `process.stderr` satisfy `Writer`.

A `Host` gives the command line the filesystem, the directory relative paths resolve against, and the version of the package the analyzer was installed from. `bin/node-host.ts` is the Node.js host the command binds. A caller embedding the analyzer, or running it on another platform, supplies its own host and its own version with it. `openClient` opens the compiler client, and a caller that watches what a run reads may supply its own.

`SETTING_OPTIONS` maps each command-line option to the configuration setting it supplies.

## Running from a clone

A clone of this repository runs the same command from its TypeScript sources through Node.js's own type stripping, which is what needs Node.js 24. Install the dependencies first:

```sh
npm ci
node bin/deadset-ts.ts version
```

deadset-ts is tested on Linux. Other platforms are untested.

## The reference

Every export carries a doc comment, and [JSR](https://jsr.io/@cplieger/deadset-ts/doc) renders the full reference from them.

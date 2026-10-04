# Contributing to deadset-ts

The [shared rules](https://github.com/cplieger/.github/blob/main/CONTRIBUTING.md) for commits, releases, synced files and checks apply here.

## Rules

- Everything under `fixtures/` except `golden/` and `projects/` is a copy of one [deadset-spec](https://github.com/cplieger/deadset-spec) release. Never edit those files, or their digests in `corpus.lock.json`, by hand. The suite would then pass against a Contract nobody published.
- A change to the issue kinds, schemas, exit codes or corpus lands in deadset-spec first. Take its release here by copying the tagged trees again, as `corpus.lock.json` describes, and recording the new tag, commit and digests.

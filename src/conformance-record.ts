// Written by the conformance run from conformance.json and conformance-results.json.
// Regenerate it with `UPDATE_GOLDEN=1 npx vitest --run src/conformance.corpus.test.ts`.
export const RECORD = {
  conformance: {
    corpusVersion: "1.9.0",
    result: "pass",
    digest: "sha256:3e9e40876551faa2c196311bf06d47d220ab5127a9fb8921969aae552c42e824",
  },
  gaps: [
    {
      fixture: "private-member-unread",
      capability: "reflective-lookup",
      reason:
        "The reference pass resolves a string-literal element access to the member it names, so the member is live by that reference and the retained listing names no class for it.",
    },
  ],
} as const;

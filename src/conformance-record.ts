// Written by the conformance run from conformance.json and conformance-results.json.
// Regenerate it with `UPDATE_GOLDEN=1 npx vitest --run src/conformance.corpus.test.ts`.
export const RECORD = {
  conformance: {
    corpusVersion: "2.1.1",
    result: "fail",
    digest: "sha256:9d5e77a076e71be09d3f9bc2154eedfc7e97f56a94785bbcecd8ecb88cb455ed",
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

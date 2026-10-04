// Written by the conformance run from conformance.json and conformance-results.json.
// Regenerate it with `UPDATE_GOLDEN=1 npx vitest --run src/conformance.corpus.test.ts`.
export const RECORD = {
  conformance: {
    corpusVersion: "2.1.1",
    result: "pass",
    digest: "sha256:e5e456bf3a706f1fa9f906ae71e10ea98a78da52d7d99a5ed59dca8a72bbe927",
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

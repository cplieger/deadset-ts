// Written by the conformance run from conformance.json and conformance-results.json.
// Regenerate it with `UPDATE_GOLDEN=1 npx vitest --run src/conformance.corpus.test.ts`.
export const RECORD = {
  conformance: {
    corpusVersion: "1.9.0",
    result: "fail",
    digest: "sha256:8c29f19fc189f4f5d9ea210d556b62d12c3701c221eb7a8adde499b7060bec0d",
  },
  gaps: [
    {
      fixture: "private-member-unread",
      capability: "reflective-lookup",
      reason:
        "The reference pass resolves a string-literal element access to the member it names, so the member is live by that reference and the retained listing names no class for it.",
    },
    {
      fixture: "redundant-export-keyword",
      capability: "DS1104",
      reason:
        "No consumer is loaded beside the target, so the published surface is unknown and no export is narrowed; review an export only the target uses by hand.",
    },
    {
      fixture: "unused-exported-consumer",
      capability: "DS1001",
      reason:
        "No consumer is loaded beside the target, so an export nothing in the target references is reported at the possible class rather than the certain one.",
    },
  ],
} as const;

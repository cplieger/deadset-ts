// The shared ruleset is eslint.config.base.mjs, synced from cplieger/ci; edit it there.
import base from "./eslint.config.base.mjs";

// Third-party source, kept byte for byte as scripts/vendor-unbash.ts writes it.
export default [{ ignores: ["src/vendor/**"] }, ...base];

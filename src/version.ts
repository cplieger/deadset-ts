import manifest from "../package.json" with { type: "json" };

/**
 * The Contract version this analyzer implements. It is the resolved value of
 * `contract_version` when no configuration source supplies one, and it moves
 * independently of {@link version}.
 */
export const CONTRACT_VERSION = "1.5.0";

/**
 * This analyzer's own version, which the published package carries rather than
 * the source: the release pipeline writes the released version into the manifest
 * of the artifact it publishes, so an installed package reports the release it
 * came from while a checkout reports the version the manifest holds in git.
 *
 * It is one function because a version written in more than one place is two
 * facts that can disagree: the version verb, the report envelope and anything
 * else that names this analyzer read this one.
 */
export function version(): string {
  return manifest.version;
}

const PLACE = String.raw`[A-Za-z_][\w-]*(?:\.[\w-]+|\[\d+\])*`;
const NAMED = new RegExp(
  String.raw`^[^:]+: key "(?<key>[^"]*)" is not implemented|^[^:]+: (?<at>${PLACE}): |^(?<unset>${PLACE}) is not set, `,
  "u",
);

/**
 * The dotted place a configuration refusal's message names, in each form resolution
 * writes one: `<label>: <place>: …`, `<label>: key "<place>" is not implemented…` and
 * `<place> is not set, …`. Empty for a fault in the whole document.
 */
export function refusedPlace(message: string): string {
  const groups = NAMED.exec(message)?.groups;
  return groups?.["key"] ?? groups?.["at"] ?? groups?.["unset"] ?? "";
}

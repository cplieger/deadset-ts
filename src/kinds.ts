/**
 * The issue-kind codes whose severity the Contract fixes. A severity key naming
 * one, or a family prefix whose range holds one, is an unimplemented key rather
 * than a setting.
 *
 * The codes are written out rather than read from the Contract at run time: the
 * Contract is data a reader outside this program consults, and a product that
 * read it while running would need it installed beside itself. A test compares
 * this list against the Contract release the analyzer is written against, so a
 * code the Contract fixes arrives here as a failing test.
 */
export const FIXED_SEVERITY_CODES: readonly string[] = ["DS1703", "DS1704"];

/**
 * The code of every live issue kind, in ascending order. A severity key names one of
 * them or a family prefix whose range holds one; a key naming a retired code, an
 * unassigned code or a range holding no live kind is an unimplemented key, so every
 * severity a configuration sets is one some analyzer reports under. A test compares
 * this list against the Contract release the analyzer is written against.
 */
export const LIVE_CODES: readonly string[] = [
  "DS1001",
  "DS1002",
  "DS1003",
  "DS1004",
  "DS1005",
  "DS1006",
  "DS1101",
  "DS1102",
  "DS1103",
  "DS1104",
  "DS1201",
  "DS1203",
  "DS1204",
  "DS1301",
  "DS1302",
  "DS1303",
  "DS1501",
  "DS1502",
  "DS1601",
  "DS1605",
  "DS1701",
  "DS1702",
  "DS1703",
  "DS1704",
  "DS1705",
  "DS1801",
  "DS1802",
  "DS1803",
  "DS1805",
  "DS1807",
  "DS1809",
];

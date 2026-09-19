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

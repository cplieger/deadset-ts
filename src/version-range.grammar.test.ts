import { describe, expect, it } from "vitest";
import { satisfies } from "./version-range.ts";

describe("satisfies, reading a version", () => {
  it.each([
    [" 1.2.3 ", "1.2.3", true],
    ["1.2.3-alpha.", ">=1.2.3-alpha", false],
  ])("%s against %s is %s", (version, range, expected) => {
    expect(satisfies(version, range)).toBe(expected);
  });
});

describe("satisfies, reading a range", () => {
  it.each([
    ["1.2.3", "+*", false],
    ["1.2.3", "1.2.3+", false],
    ["1.5.3", "1.x.3", false],
    ["1.2.4", "1.2.3", false],
    ["2.0.0", "1.x", false],
    ["1.3.0", "1.2.x", false],
    ["1.2.3", ">=  1.2.3", true],
    ["1.5.0", ">=1.2.3  <2", true],
    ["2.0.0", "1.2  - 2.3", true],
    ["2.0.0", "1.2 -  2.3", true],
    ["2.0.0", ">=1.0.0 1.2 - 2.3", false],
    ["2.2.0", "1.2 - 2.3 <2.1", false],
  ])("%s against %s is %s", (version, range, expected) => {
    expect(satisfies(version, range)).toBe(expected);
  });
});

describe("satisfies, a comparison with missing parts", () => {
  it.each([
    ["1.2.3", "<*", false],
    ["1.2.3", ">*", false],
    ["1.2.3", ">=*", true],
    ["1.2.3", "<=*", true],
    ["1.5.0", ">1", false],
    ["1.1.0", ">=1.2", false],
    ["1.2.5", "<1.2", false],
  ])("%s against %s is %s", (version, range, expected) => {
    expect(satisfies(version, range)).toBe(expected);
  });
});

describe("satisfies, an exact comparison", () => {
  it.each([
    ["1.2.4", "<=1.2.3", false],
    ["1.2.3", ">1.2.3", false],
  ])("%s against %s is %s", (version, range, expected) => {
    expect(satisfies(version, range)).toBe(expected);
  });
});

describe("satisfies, prerelease precedence", () => {
  it.each([
    ["1.2.3-alpha", "1.2.3-alpha", true],
    ["1.2.3-alpha.1", ">1.2.3-alpha", true],
    ["1.2.3-alpha", "<1.2.3-alpha.1", true],
    ["1.2.3-beta", ">1.2.3-alpha", true],
    ["1.2.3-alpha", ">1.2.3-beta", false],
    ["1.2.3-alpha", ">=1.2.3-1", true],
    ["1.2.3-1", ">1.2.3-alpha", false],
    ["1.2.3--x", ">1.2.3-9", true],
  ])("%s against %s is %s", (version, range, expected) => {
    expect(satisfies(version, range)).toBe(expected);
  });
});

describe("satisfies, a prerelease admitted only beside a comparator naming one of its version", () => {
  it.each([
    ["1.2.4-beta", ">=1.2.3-alpha", false],
    ["1.3.3-beta", ">=1.2.3-alpha", false],
    ["2.2.3-beta", ">=1.2.3-alpha", false],
    ["1.2.3-beta", "<=1.2.3", false],
    ["1.0.0-beta", "1", false],
    ["2.0.0-beta", ">=2.0.0-alpha <2", false],
    ["0.0.0-b", "0.0.0-a - *", true],
  ])("%s against %s is %s", (version, range, expected) => {
    expect(satisfies(version, range)).toBe(expected);
  });
});

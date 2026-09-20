import { describe, expect, it } from "vitest";

import { median, medianSample, readOptions, type Sample } from "./calibrate-batch-cap.ts";

/**
 * The harness's reading of its own measurements. A round trip's wall clock varies,
 * so the record reports the middle measurement rather than the first, and these pin
 * that: a harness reporting the first sample would agree with every case whose
 * samples are already in order, so each case below is written out of order.
 */

function sample(wallMs: number): Sample {
  return {
    wallMs,
    requestCount: 100,
    roundTripMs: wallMs / 2,
    bytesSent: 1000,
    bytesReceived: 2000,
    serverTimeMs: wallMs / 4,
  };
}

describe("median", () => {
  it("answers the middle value of an odd count, whatever order it was measured in", () => {
    expect(median([300, 100, 200])).toBe(200);
  });

  it("answers the lower of the two middles of an even count, so the number is one a run took", () => {
    expect(median([400, 100, 300, 200])).toBe(200);
  });

  it("answers the one value of a single measurement", () => {
    expect(median([42])).toBe(42);
  });

  it("has no answer for no measurement", () => {
    expect(() => median([])).toThrow("median of no values");
  });
});

describe("medianSample", () => {
  it("takes the median of each measurement, not the first sample", () => {
    const samples = [sample(300), sample(100), sample(200)];

    expect(medianSample(samples)).toStrictEqual({
      wallMs: 200,
      requestCount: 100,
      roundTripMs: 100,
      bytesSent: 1000,
      bytesReceived: 2000,
      serverTimeMs: 50,
    });
  });

  it("reads each measurement on its own, so one field's order does not decide another's", () => {
    const samples: Sample[] = [
      { ...sample(300), bytesReceived: 10 },
      { ...sample(100), bytesReceived: 30 },
      { ...sample(200), bytesReceived: 20 },
    ];

    expect(medianSample(samples).wallMs).toBe(200);
    expect(medianSample(samples).bytesReceived).toBe(20);
  });
});

describe("readOptions", () => {
  it("sweeps the caps named, uncapped among them, in the order they were written", () => {
    const options = readOptions(["--target", ".", "--caps", "4096,256,uncapped"]);

    expect(options.caps).toStrictEqual([4096, 256, "uncapped"]);
  });

  it("reports the cap the caller chose as the default, not the first one swept", () => {
    const options = readOptions([
      "--target",
      ".",
      "--caps",
      "256,4096",
      "--chosen-default",
      "4096",
    ]);

    expect(options.chosenDefault).toBe(4096);
  });

  it("refuses a sweep with no package to measure", () => {
    expect(() => readOptions(["--caps", "256"])).toThrow("--target");
  });

  it("refuses a cap that is not a count of name nodes", () => {
    expect(() => readOptions(["--target", ".", "--caps", "256,-1"])).toThrow("is not a cap");
  });

  it("refuses a default the pass could not take", () => {
    expect(() => readOptions(["--target", ".", "--chosen-default", "uncapped"])).toThrow(
      "the pass option's default is a number",
    );
  });
});

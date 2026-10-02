// A test file the default pattern classifies. It is the only file that names Probe, it
// declares an interface nothing names, and it is the only caller of Gauge.measure.

import type { Gauge, Probe } from "./contracts.ts";

export interface TestDouble {
  check(): boolean;
}

export function testProbe(probe: Probe): boolean {
  return probe.check();
}

export function testGauge(gauge: Gauge): number {
  return gauge.measure();
}

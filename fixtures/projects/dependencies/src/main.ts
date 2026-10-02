import { bundled } from "bundled";
import { attach } from "host-plugin";
import { pad } from "left-pad";
import { peer } from "peer-used";
import { typed } from "typed-only";
import { run } from "used-runtime";

export function start(): number {
  return run() + typed() + bundled() + peer() + attach() + fixtureGlobal;
}

function padded(): string {
  return pad(String(run()));
}

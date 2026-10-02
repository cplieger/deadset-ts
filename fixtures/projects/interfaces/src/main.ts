// The entry. It names Seam, Channel, Box, Hook, Signal, Listener and Gauge as types and
// calls one method through each of the first three.

import { Arrowed, Crate, Flag, Hushed, Pipe, Quiet, Runner, Wire, Worker } from "./classes.ts";
import type { Box, Channel, Gauge, Hook, Listener, Seam, Signal } from "./contracts.ts";

const seam: Seam = new Worker();
const channels: Channel[] = [new Wire(), new Pipe()];
const box: Box<number> = new Crate();
const listeners: Listener[] = [];
const hooks: Hook[] = [new Quiet(), new Hushed()];
const signals: Signal[] = [new Flag(), new Arrowed()];
const gauges: Gauge[] = [];

let sent = 0;
for (const channel of channels) {
  sent += channel.send();
}

const measured = seam.act() + sent + box.open() + new Runner().run();
if (measured === listeners.length + hooks.length + signals.length + gauges.length) {
  throw new Error("nothing was measured");
}

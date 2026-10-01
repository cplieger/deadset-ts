// The entry: each class's instance goes where its comment says.

import { object } from "@example/schema";
import {
  Batch,
  Bound,
  Census,
  Deferred,
  Event,
  Frame,
  Journal,
  Kept,
  Leading,
  Message,
  Order,
  Outline,
  Payload,
  Posted,
  Registry,
  Relayed,
  Shaped,
  Snapshot,
  Traced,
  Trailing,
} from "./model.ts";
import { Courier, encode, relay, send, sendAll, sendBound, shape, trace } from "./wire.ts";

JSON.stringify(new Order());
console.log(new Event());
object({ body: "" }).parse(new Payload());
encode(new Frame());
send(new Message());
relay(new Relayed());
trace(new Traced());
shape(new Shaped());
new Snapshot().save();
Registry.dump();
new Deferred().later();
new Census();
new Journal().write();
new Outline().view();
new Batch().lines([""]);
sendBound(new Bound());
sendAll(new Leading(), new Trailing());
new Courier().post(new Posted());

export const kept = new Kept();

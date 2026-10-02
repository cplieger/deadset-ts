// The entry: each class's instance goes where its comment says.

import { object } from "@example/schema";
import {
  Applied,
  Batch,
  Bound,
  Called,
  Census,
  Deferred,
  Dispatched,
  Event,
  Frame,
  Journal,
  Kept,
  Leading,
  Logged,
  Message,
  Order,
  Outline,
  Payload,
  Posted,
  Prebound,
  Rebound,
  Registry,
  Relayed,
  Shaped,
  Snapshot,
  Traced,
  Trailing,
  VarBound,
} from "./model.ts";
import {
  Courier,
  encode,
  relay,
  send,
  sendAll,
  sendBound,
  sendVar,
  shape,
  trace,
} from "./wire.ts";

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
JSON.stringify.call(JSON, new Called());
JSON.stringify.apply(JSON, [new Applied()]);
JSON.stringify.bind(JSON)(new Rebound());
JSON.stringify.bind(JSON, new Prebound())();
console.log.call(console, new Logged());
send.call(undefined, new Dispatched());
sendVar(new VarBound());

export const kept = new Kept();

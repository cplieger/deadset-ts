import { assign, failure, invoke, keysOf, sizeOf, slotOf, storesOf, total, type Reader } from "./readers.ts";
import { Holder, type Inner, type Invocation, type Row } from "./shapes.ts";

// The entry file: every reader is called once, so what a reader destructures is read.
const inner: Inner = { deep: "deep", untouched: "untouched" };
const invocation: Invocation = {
  name: "entry",
  stores: 1,
  nested: inner,
  "quoted-key": true,
  copied: 2,
  typedOnly: 3,
  unread: 4,
};
const row: Row = { key: "key", value: 1, pair: [inner, inner] };
const reader: Reader = () => 0;
const read = [
  invoke(invocation),
  String(sizeOf({ kind: "circle", size: 1 })),
  String(storesOf(invocation)),
  String(slotOf(new Holder())),
  ...keysOf([row]),
  String(total([row])),
  failure(() => undefined),
  assign(row, [row], invocation),
  String(reader(invocation)),
];
if (read.length === 0) {
  throw new Error("no reader ran");
}

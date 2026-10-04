import { describe, expect, it } from "vitest";
import { mapperConnection } from "../bin/mapper-connection.ts";

/** One message framed as the compiler frames it. */
function framed(message: unknown): Uint8Array {
  const body = new TextEncoder().encode(JSON.stringify(message));
  const header = new TextEncoder().encode(`Content-Length: ${String(body.length)}\r\n\r\n`);
  const bytes = new Uint8Array(header.length + body.length);
  bytes.set(header);
  bytes.set(body, header.length);
  return bytes;
}

/** Every answer one connection wrote, each read back from its frame. */
function answers(written: readonly Uint8Array[]): unknown[] {
  const text = new TextDecoder().decode(
    written.reduce((all, one) => {
      const joined = new Uint8Array(all.length + one.length);
      joined.set(all);
      joined.set(one, all.length);
      return joined;
    }, new Uint8Array(0)),
  );
  return text
    .split(/Content-Length: \d+\r\n\r\n/u)
    .filter((one) => one !== "")
    .map((one) => JSON.parse(one) as unknown);
}

describe("the component mapper", () => {
  it("answers the protocol's requests, a frame split anywhere across chunks", () => {
    const written: Uint8Array[] = [];
    const connection = mapperConnection((bytes) => written.push(bytes));
    const stream = new Uint8Array([
      ...framed({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
      ...framed({ jsonrpc: "2.0", method: "initialized" }),
      ...framed({ jsonrpc: "2.0", id: 2, method: "openProject", params: {} }),
      ...framed({
        jsonrpc: "2.0",
        id: 3,
        method: "transform",
        params: { fileName: "/a/B.vue", content: "<script>é</script>", projectHandle: "1" },
      }),
      ...framed({ jsonrpc: "2.0", id: 4, method: "closeProject", params: {} }),
      ...framed({ jsonrpc: "2.0", id: 5, method: "unknown" }),
    ]);
    for (let at = 0; at < stream.length; at += 7) {
      connection.receive(stream.subarray(at, at + 7));
    }
    expect(answers(written)).toEqual([
      {
        jsonrpc: "2.0",
        id: 1,
        result: { positionEncoding: "utf-16", diagnosticSource: "deadset-ts" },
      },
      { jsonrpc: "2.0", id: 2, result: {} },
      {
        jsonrpc: "2.0",
        id: 3,
        result: {
          text: "        é         \nexport default {};\n",
          extension: ".js",
          mappings: [[8, 1, 8, 1, 0]],
        },
      },
      { jsonrpc: "2.0", id: 4, result: null },
      { jsonrpc: "2.0", id: 5, error: { code: -32601, message: 'no method "unknown"' } },
    ]);
  });

  it("refuses a transform that carries no content", () => {
    const written: Uint8Array[] = [];
    mapperConnection((bytes) => written.push(bytes)).receive(
      framed({ jsonrpc: "2.0", id: 9, method: "transform", params: {} }),
    );
    expect(answers(written)).toEqual([
      {
        jsonrpc: "2.0",
        id: 9,
        error: { code: -32602, message: "transform: params.content is not a string" },
      },
    ]);
  });
});

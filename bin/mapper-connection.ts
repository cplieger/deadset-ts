/**
 * The content mapper the compiler runs for component files: JSON-RPC 2.0 messages, each
 * framed by a `Content-Length` header, over the process's standard streams. It answers
 * `transform` with {@link componentModule} and keeps no state between requests.
 * The protocol is the compiler's own:
 * https://github.com/microsoft/TypeScript/blob/f9f8d01292562242b6e7c7142e46ed7e470926f9/tsc/internal/contentmapper/hostimpl.go
 */

import { componentModule } from "../src/component-files.ts";

/** One request or notification the compiler sends. */
interface Message {
  readonly id?: unknown;
  readonly method?: unknown;
  readonly params?: unknown;
}

/** The JSON-RPC code of a method this mapper does not serve. */
const METHOD_NOT_FOUND = -32601;
/** The JSON-RPC code of a request whose parameters are not the protocol's. */
const INVALID_PARAMS = -32602;

const HEADER_END = new Uint8Array([0x0d, 0x0a, 0x0d, 0x0a]);

/** The offset of `needle` in `bytes` at or after `from`, or -1. */
function indexOf(bytes: Uint8Array, needle: Uint8Array, from: number): number {
  outer: for (let at = from; at + needle.length <= bytes.length; at += 1) {
    for (let index = 0; index < needle.length; index += 1) {
      if (bytes[at + index] !== needle[index]) {
        continue outer;
      }
    }
    return at;
  }
  return -1;
}

/** The answer to one message, or undefined for a notification, which takes none. */
function answer(message: Message): object | undefined {
  if (message.id === undefined) {
    return undefined;
  }
  const reply = (result: unknown): object => ({ jsonrpc: "2.0", id: message.id, result });
  const fail = (code: number, text: string): object => ({
    jsonrpc: "2.0",
    id: message.id,
    error: { code, message: text },
  });
  switch (message.method) {
    case "initialize":
      return reply({ positionEncoding: "utf-16", diagnosticSource: "deadset-ts" });
    case "openProject":
      return reply({});
    case "closeProject":
      return reply(null);
    case "transform": {
      const content: unknown =
        typeof message.params === "object" && message.params !== null
          ? (message.params as { content?: unknown }).content
          : undefined;
      if (typeof content !== "string") {
        return fail(INVALID_PARAMS, "transform: params.content is not a string");
      }
      const module = componentModule(content);
      return reply({ text: module.text, extension: module.extension, mappings: module.mappings });
    }
    default:
      return fail(METHOD_NOT_FOUND, `no method ${JSON.stringify(message.method)}`);
  }
}

/** One mapper connection: bytes in, and every framed answer handed to `write`. */
export interface MapperConnection {
  /** Reads one chunk of the input stream, answering every message it completes. */
  receive(chunk: Uint8Array): void;
}

/**
 * A connection over one byte stream. A message whose body is not JSON is answered with
 * nothing, because it carries no id to answer to.
 */
export function mapperConnection(write: (bytes: Uint8Array) => void): MapperConnection {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let pending = new Uint8Array(0);
  return {
    receive(chunk) {
      const joined = new Uint8Array(pending.length + chunk.length);
      joined.set(pending);
      joined.set(chunk, pending.length);
      pending = joined;
      for (;;) {
        const headerEnd = indexOf(pending, HEADER_END, 0);
        if (headerEnd < 0) {
          return;
        }
        const header = decoder.decode(pending.subarray(0, headerEnd));
        const length = Number(/content-length:\s*(\d+)/iu.exec(header)?.[1] ?? "0");
        const bodyStart = headerEnd + HEADER_END.length;
        if (pending.length < bodyStart + length) {
          return;
        }
        const body = decoder.decode(pending.subarray(bodyStart, bodyStart + length));
        pending = pending.slice(bodyStart + length);
        let message: Message;
        try {
          message = JSON.parse(body) as Message;
        } catch {
          continue;
        }
        const reply = answer(message);
        if (reply !== undefined) {
          const bytes = encoder.encode(JSON.stringify(reply));
          write(encoder.encode(`Content-Length: ${String(bytes.length)}\r\n\r\n`));
          write(bytes);
        }
      }
    },
  };
}

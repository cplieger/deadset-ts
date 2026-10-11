// A declaration file merges a member into a platform interface and declares a function, neither
// with an implementation the analysis sees, and declares interfaces the project implements.

interface BroadcastChannel {
  postMessage(message: unknown): void;
}

declare function relay(message: unknown): void;

interface Sink {
  put(message: unknown): void;
}

interface Port {
  send(message: unknown): void;
}

interface Tap {
  pour(message: unknown): void;
}

interface Outlet {
  drain(message: unknown): void;
}

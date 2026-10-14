// Both blocks spell one reference, and only a member of the second one is read; the
// first declares an interface of its own, which nothing outside the target names.
export {};

declare global {
  interface Probe {
    unread: number;
  }
}

declare global {
  interface Window {
    read: number;
  }
}

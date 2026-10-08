// Both blocks spell one reference, and only a member of the second one is read.
export {};

declare global {
  interface Window {
    unread: number;
  }
}

declare global {
  interface Window {
    read: number;
  }
}

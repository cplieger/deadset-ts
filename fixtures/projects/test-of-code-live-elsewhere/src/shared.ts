// The module both configurations compile. Only the build script uses one function, so the
// application's configuration alone finds it dead; nothing uses the other.

export function usedByScript(): number {
  return 2;
}

export function deadEverywhere(): number {
  return 3;
}

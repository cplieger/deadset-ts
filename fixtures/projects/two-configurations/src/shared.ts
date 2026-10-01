// The module both configurations compile. The application uses one of its functions
// and the build script another; the rest neither uses.

export function usedByMain(): number {
  return 1;
}

export function usedByScript(): number {
  return 2;
}

export function deadEverywhere(): number {
  return 3;
}

export function deadCaller(): number {
  return deadCallee();
}

function deadCallee(): number {
  return 4;
}

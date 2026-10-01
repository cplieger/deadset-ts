// The file the manifest's `main` names, written as the emitted `dist/main.js`.

export function runMain(): number {
  return 1;
}

function unexported(): number {
  return runMain();
}

export const mainCount = unexported();

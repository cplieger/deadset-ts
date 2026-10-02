export function used(): void {}

export const banner = "// deadset:ignore DS1002 -- written inside a string, so not a comment";

export const pattern = `/* ${String(1)} //deadset:disable inside a template */`;

// deadset:ignore DS1002 -- Called by name from the plugin loader.
function adjudicated(): void {
  callee();
}

function callee(): void {}

// deadset:ignore DS1002 -- Kept for the next release.
export function stillUsed(): void {}

//deadset:ignore DS1001 -- Kept for the next release.
function wrongCode(): void {}

// deadset:ignore DS1002 -- A blank line separates it from the declaration.

function separated(): void {}

// deadset:ignore DS1002
function reasonless(): void {}

/* deadset:ignore DS1002 -- A block comment is not a directive. */
function inBlock(): void {}

export function entryHeld(): void {
  stillUsed();
}

function entryNamed(): void {}

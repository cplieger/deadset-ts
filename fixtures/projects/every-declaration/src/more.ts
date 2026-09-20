// A local declaration and the export alias that names it, which are two symbols of
// one name, plus a default export written as a statement.

export const alsoExported = true;

const localOnly = false;

function defaultCandidate(): void {}

export { localOnly as renamedLocal };

export default defaultCandidate;

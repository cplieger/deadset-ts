// A module that imports its dependency through an import-equals declaration. The one
// function reading the import is called by nothing, and the import is evaluated with
// the module all the same.

import loaded = require("./loaded.cts");

export function legacy(): number {
  return 11;
}

export function uncalled(): number {
  return loaded.count;
}

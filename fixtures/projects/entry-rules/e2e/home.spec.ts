// A Playwright test in a package that declares no Playwright, so no row reads it.

import { helper } from "./helper.ts";

export const checked = helper();

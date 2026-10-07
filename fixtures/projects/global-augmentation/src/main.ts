import { mode } from "./env.js";
import { pages } from "./pages.js";
import "./plugins.js";
import { probed } from "./probe.js";

import.meta.hot?.accept();

export const all = [Object.keys(pages), buildId, probed, mode];

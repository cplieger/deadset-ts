#!/usr/bin/env node
import { run } from "../src/run.ts";
import { nodeHost } from "./node-host.ts";

process.exitCode = run(process.argv.slice(2), process.stdout, process.stderr, nodeHost());

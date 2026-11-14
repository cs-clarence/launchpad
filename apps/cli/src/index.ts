#!/usr/bin/env bun
import { realIo } from "./io";
import { run } from "./program";

process.exitCode = await run(process.argv.slice(2), realIo());

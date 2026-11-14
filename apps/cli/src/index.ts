#!/usr/bin/env bun
import { Command } from "commander";

const program = new Command()
    .name("launchpad")
    .description("Launchpad CLI scaffold; deployment commands are not implemented")
    .version("0.0.0");

program.parse();

#!/usr/bin/env node

import { runCli } from './cli/main.js';

runCli().catch((error) => {
  console.error(`\nError: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});

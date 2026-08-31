#!/usr/bin/env node

import { runCli } from './cli/main.js';

runCli().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\nError: ${message}`);

  if (error instanceof Error && error.cause) {
    const cause = error.cause;
    if (cause instanceof Error) {
      const details = [cause.code, cause.message].filter(Boolean).join(': ');
      if (details) console.error(`Cause: ${details}`);
    } else {
      console.error(`Cause: ${String(cause)}`);
    }
  }

  process.exitCode = 1;
});

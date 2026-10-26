#!/usr/bin/env node
import { main } from './cli.js';
import { redact } from './redact.js';

main(process.argv.slice(2)).then(
  (code) => {
    if (code !== 0) process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(
      `fse-mcp: fatal error: ${redact(error instanceof Error ? error.message : String(error))}\n`,
    );
    process.exitCode = 1;
  },
);

#!/usr/bin/env node
import { argv, env, exit, stderr, stdout } from 'node:process';
import { runCli } from './cli.js';
import { nodeAsker } from './node-asker.js';
import { nodeFileSystem } from './node-fs.js';
import { nodePrompter } from './node-prompter.js';

const code = await runCli(argv.slice(2), {
  fs: nodeFileSystem,
  prompter: nodePrompter,
  asker: nodeAsker,
  env,
  out: (message) => stdout.write(`${message}\n`),
  err: (message) => stderr.write(`${message}\n`),
});

exit(code);

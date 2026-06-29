#!/usr/bin/env node
import { cwd, env, exit, stderr } from 'node:process';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadPorts } from './load.js';
import { createMcpServer } from './server.js';

// stdout carries the JSON-RPC stream — all logging MUST go to stderr or it corrupts the protocol.
async function main(): Promise<void> {
  // BARON_ROOT lets a client (e.g. Claude Code) point the server at a project that isn't the
  // server's own working directory — the server reads <root>/.baron/policy.json + credentials.
  const root = env.BARON_ROOT ?? cwd();
  const ports = loadPorts(root, env);
  const server = createMcpServer(ports);
  await server.connect(new StdioServerTransport());
  stderr.write(`baron mcp-server running on stdio (root: ${root})\n`);
}

main().catch((error) => {
  stderr.write(
    `baron mcp-server failed to start: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  exit(1);
});

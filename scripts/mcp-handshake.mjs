// Smoke-test any way of launching the MCP server by speaking the protocol to it.
//
//   node scripts/mcp-handshake.mjs docker run -i --rm baron-mcp:ci
//   node scripts/mcp-handshake.mjs node packages/mcp-server/dist/bin.js
//
// This is the exact exchange an indexer performs: initialize, then `tools/list`. Glama builds every
// open-source server in a sandbox and withholds distribution when the build does not answer it, so
// the question "does the container still work?" has a real cost attached and belongs in CI rather
// than in someone's memory of having tried it once.
//
// It also covers the invariant that makes stdio servers fragile: stdout carries JSON-RPC and nothing
// else. A stray console.log anywhere in startup shows up here as unparseable output, not as a subtle
// client-side failure weeks later.
import { spawn } from 'node:child_process';

const argv = process.argv.slice(2);
if (argv.length === 0) {
  console.error('usage: mcp-handshake.mjs <command> [args...]');
  process.exit(2);
}

const TIMEOUT_MS = 60_000;
const child = spawn(argv[0], argv.slice(1), { stdio: ['pipe', 'pipe', 'inherit'] });

const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
send({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'baron-smoke', version: '0' },
  },
});
send({ jsonrpc: '2.0', method: 'notifications/initialized' });
send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });

const fail = (reason) => {
  console.error(`handshake FAILED: ${reason}`);
  child.kill();
  process.exit(1);
};

const timer = setTimeout(() => fail(`no tools/list response within ${TIMEOUT_MS}ms`), TIMEOUT_MS);

let buffered = '';
let serverInfo;
child.stdout.on('data', (chunk) => {
  buffered += chunk;
  let newline = buffered.indexOf('\n');
  for (; newline !== -1; newline = buffered.indexOf('\n')) {
    const line = buffered.slice(0, newline).trim();
    buffered = buffered.slice(newline + 1);
    if (line.length === 0) continue;

    let message;
    try {
      message = JSON.parse(line);
    } catch {
      fail(`non-JSON on stdout, which corrupts the protocol stream: ${line.slice(0, 200)}`);
      return;
    }

    if (message.error !== undefined)
      fail(`server returned an error: ${JSON.stringify(message.error)}`);
    if (message.id === 1) serverInfo = message.result?.serverInfo;
    if (message.id !== 2) continue;

    clearTimeout(timer);
    const tools = message.result?.tools ?? [];
    if (tools.length === 0) fail('tools/list returned no tools');
    console.log(`${serverInfo?.name ?? '?'} ${serverInfo?.version ?? '?'} — ${tools.length} tools`);
    console.log(tools.map((tool) => `  ${tool.name}`).join('\n'));
    child.kill();
    process.exit(0);
  }
});

child.on('error', (error) => fail(`could not launch: ${error.message}`));
child.on('exit', (code) => {
  // Reaching here means the process ended before answering — the "builds clean, dies on start"
  // failure, which is the one worth naming explicitly because the build log looks perfect.
  clearTimeout(timer);
  fail(`server exited with code ${code} before completing the handshake`);
});

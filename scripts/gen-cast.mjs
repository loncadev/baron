#!/usr/bin/env node
// Generates an asciicast v2 recording of the Baron workflow demo (render to GIF with `agg`). The
// command output mirrors what `baron run` actually prints (the recipe `message` templates verbatim);
// ids/urls are representative, and the gray `#` lines are captions that carry the pitch. Kept as a
// generator (not a hand-written .cast) so the demo is easy to re-time or re-word. No Date/random —
// timestamps are deterministic.
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const OUT = fileURLToPath(new URL('../docs/demo/baron-demo.cast', import.meta.url));

const GREEN = '\x1b[92m';
const CYAN = '\x1b[1;96m';
const GRAY = '\x1b[90m';
const RESET = '\x1b[0m';

let t = 0;
const events = [];
const at = (dt, data) => {
  t = Number((t + dt).toFixed(3));
  events.push([t, 'o', data]);
};
const type = (s, per = 0.05) => {
  for (const ch of s) at(per, ch);
};
const nl = (dt = 0.15, s = '') => at(dt, `${s}\r\n`);
const prompt = () => at(0.5, `${GREEN}$${RESET} `);

// Intro
nl(0.3, `${CYAN}Baron — one pane of glass from backlog to deploy${RESET}`);
nl(0.5, '');

// Recipe 1: start a task from one prompt
prompt();
type('baron run --recipe task-start.yaml');
nl(0.3, '');
at(0.5, 'Task title? ');
type('Add rate limiting to the login endpoint');
nl(0.35, '');
nl(0.35, 'Task #142 is in progress on feature/142.');
nl(0.15, 'Recipe task-start.yaml finished.');
nl(0.6, '');
nl(
  0.15,
  `${GRAY}# "in_progress" is a role — Baron maps it to each provider's native state:${RESET}`,
);
nl(
  0.15,
  `${GRAY}#   GitHub -> "in-progress" label   Azure DevOps -> "Active".  Same prompt, any stack.${RESET}`,
);
nl(1.1, '');

// Recipe 2: finish it — open the PR and move to review
prompt();
type('baron run --recipe task-finish.yaml');
nl(0.3, '');
at(0.5, 'Issue id? ');
type('142');
nl(0.3, '');
at(0.4, 'Source branch? ');
type('feature/142');
nl(0.3, '');
at(0.4, 'Pull request title? ');
type('Rate limit the login endpoint');
nl(0.35, '');
nl(0.35, 'Opened PR https://github.com/acme/store/pull/23; moved 142 to review.');
nl(0.15, 'Recipe task-finish.yaml finished.');
nl(0.6, '');
nl(
  0.15,
  `${GRAY}# One recipe, the right ports in order — the engine enforces it, not the agent.${RESET}`,
);
nl(2.0, '');

const header = { version: 2, width: 92, height: 20, env: { TERM: 'xterm-256color' } };
const body = events.map((e) => JSON.stringify(e)).join('\n');
mkdirSync(fileURLToPath(new URL('../docs/demo/', import.meta.url)), { recursive: true });
writeFileSync(OUT, `${JSON.stringify(header)}\n${body}\n`);
console.log(`Wrote ${OUT} (${events.length} events, ${t}s).`);

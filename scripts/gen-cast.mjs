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
nl(0.3, `${CYAN}Baron — your agent writes to your work tracker${RESET}`);
nl(0.5, '');

// Recipe 1: create the work item. task-new CREATES; task-start starts an EXISTING item (#21).
prompt();
type('baron run --recipe task-new.yaml');
nl(0.3, '');
at(0.5, 'Work item title? ');
type('Add rate limiting to the login endpoint');
nl(0.3, '');
at(0.4, 'Type role? ');
type('task');
nl(0.35, '');
nl(0.35, 'Created #1 (issue): Add rate limiting to the login endpoint');
nl(0.6, '');

// Recipe 2: start it — branch, role, assignee, in one call.
prompt();
type('baron run --recipe task-start.yaml');
nl(0.3, '');
at(0.5, 'Work item id? ');
type('mem-1');
nl(0.35, '');
nl(
  0.35,
  '#1 is in progress on task/mem-1-add-rate-limiting-to-the-login-endpoint, assigned to you.',
);
nl(0.6, '');
nl(
  0.15,
  `${GRAY}# The branch name is Baron's, derived from the item's type role — never invented.${RESET}`,
);
nl(
  0.15,
  `${GRAY}# "in_progress" is a role: GitHub -> "in-progress" label, Azure DevOps -> "Active".${RESET}`,
);
nl(1.1, '');

// Recipe 3: finish it — open the PR. Deliberately does NOT move the role (#21).
prompt();
type('baron run --recipe task-finish.yaml');
nl(0.3, '');
at(0.5, 'Issue id? ');
type('mem-1');
nl(0.3, '');
at(0.4, 'Source branch? ');
type('task/mem-1-add-rate-limiting-to-the-login-endpoint');
nl(0.3, '');
at(0.4, 'Pull request title? ');
type('Rate limit the login endpoint');
nl(0.35, '');
nl(0.35, 'Opened PR mem://pr/1 for mem-1. Role unchanged — the merge outcome is the');
nl(0.15, "provider's; task-move or task-sync settles the rest.");
nl(0.6, '');
nl(
  0.15,
  `${GRAY}# Baron does not pretend the merge already happened. What closing means is the${RESET}`,
);
nl(0.15, `${GRAY}# provider's rule, so Baron reports rather than guesses.${RESET}`);
nl(2.0, '');

const header = { version: 2, width: 92, height: 20, env: { TERM: 'xterm-256color' } };
const body = events.map((e) => JSON.stringify(e)).join('\n');
mkdirSync(fileURLToPath(new URL('../docs/demo/', import.meta.url)), { recursive: true });
writeFileSync(OUT, `${JSON.stringify(header)}\n${body}\n`);
console.log(`Wrote ${OUT} (${events.length} events, ${t}s).`);

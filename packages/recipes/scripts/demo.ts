// Drives the REAL recipe engine over in-memory providers (no network, no live project) so we can
// capture genuine `baron run` output for the demo recording. The output is real — same engine, same
// recipes, same role→native translation — only the provider I/O is in-memory. Prompts are pre-scripted
// and echoed inline so the transcript reads like a live session.
//
// Run:  pnpm --filter @baron/recipes exec tsx scripts/demo.ts
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  defineGithubIssuesAdapter,
  defineGithubScmAdapter,
  exampleGithubRoleMap,
  exampleGithubTypeMap,
  recommendedGithubGapPolicy,
} from '@baron/adapter-github';
// Deep-import the pure in-memory transports directly: @baron/conformance's index also re-exports the
// conformance suites, which import vitest and blow up outside a test runner.
import { createMemoryScmTransport } from '../../conformance/src/memory-scm-transport.js';
import { createMemoryTransport } from '../../conformance/src/memory-transport.js';
import { type RecipeAsker, loadRecipe, runRecipe } from '../src/index.js';

const recipesDir = fileURLToPath(new URL('../recipes/', import.meta.url));
const read = (file: string): string => readFileSync(`${recipesDir}${file}`, 'utf8');
const write = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

function ports() {
  return {
    issues: defineGithubIssuesAdapter(
      {
        roleMap: exampleGithubRoleMap,
        typeMap: exampleGithubTypeMap,
        gapPolicy: recommendedGithubGapPolicy,
      },
      createMemoryTransport({
        stateKey: exampleGithubRoleMap.stateKey,
        defaultDiscriminator: 'open',
      }),
    ),
    scm: defineGithubScmAdapter(createMemoryScmTransport()),
  };
}

/** Answers the `ask` steps from a pre-scripted queue, echoing each prompt+answer like a real terminal. */
function scriptedAsker(answers: string[]): RecipeAsker {
  const queue = [...answers];
  return {
    async text(message) {
      const answer = queue.shift() ?? '';
      write(`${message} ${answer}`);
      return answer;
    },
    async confirm(message) {
      const answer = queue.shift();
      write(`${message} (y/N) ${answer ? 'y' : 'N'}`);
      return answer === 'y';
    },
    async choice(message, _choices) {
      const answer = queue.shift() ?? '';
      write(`${message} ${answer}`);
      return answer;
    },
    note(message) {
      write(message);
    },
  };
}

const p = ports();

write('$ pnpm baron run --recipe packages/recipes/recipes/task-start.yaml');
const started = await runRecipe(loadRecipe(read('task-start.yaml')), {
  ports: p,
  asker: scriptedAsker(['Add rate limiting to the login endpoint']),
});
write('Recipe packages/recipes/recipes/task-start.yaml finished.');
write('');

const issue = started.context.issue as { id: string; key?: string };
const branch = `feature/${issue.id}`;

write('$ pnpm baron run --recipe packages/recipes/recipes/task-finish.yaml');
await runRecipe(loadRecipe(read('task-finish.yaml')), {
  ports: p,
  asker: scriptedAsker([issue.id, branch, 'Rate limit the login endpoint']),
});
write('Recipe packages/recipes/recipes/task-finish.yaml finished.');

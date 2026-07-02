import { stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline/promises';
import type { RecipeAsker } from '@lonca/baron-recipes';

async function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

/** The real, Node-backed {@link RecipeAsker} for `baron run`: stdin prompts, stdout notes. */
export const nodeAsker: RecipeAsker = {
  async text(message, optional) {
    const answer = await prompt(`${message} `);
    return answer.length === 0 && optional ? undefined : answer;
  },
  async confirm(message) {
    const answer = (await prompt(`${message} (y/N) `)).toLowerCase();
    return answer === 'y' || answer === 'yes';
  },
  async choice(message, choices) {
    stdout.write(`${message}\n`);
    choices.forEach((choice, index) => stdout.write(`  ${index + 1}) ${choice}\n`));
    for (;;) {
      const answer = await prompt('Choice (number or value): ');
      const byIndex = choices[Number(answer) - 1];
      if (byIndex !== undefined) return byIndex;
      if (choices.includes(answer)) return answer;
      stdout.write('Not a valid choice; try again.\n');
    }
  },
  note(message) {
    stdout.write(`${message}\n`);
  },
};
